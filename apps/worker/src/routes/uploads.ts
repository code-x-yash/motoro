import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser, type AuthUser } from '../lib/auth';
import { parseInput } from '../lib/validate';
import { presignUploadSchema } from '@rr/validation';
import { buildObjectKey, presignDownload, presignUpload, recordFile, verifyRelaySignature } from '../lib/r2';
import { DEFAULT_CONFIG } from '@rr/config';

const routes = new Hono<{ Bindings: Env }>();

/**
 * Object storage access.
 *  - POST /presign  -> short-lived signed PUT URL (private by default)
 *  - PUT  /object   -> Worker relay upload (used when no S3 credentials)
 *  - GET  /object   -> Worker relay download with a signed, expiring URL
 *  - POST /sign-read-> short-lived signed GET URL for an existing object
 */

routes.post('/presign', async (c) => {
  const user = await requireUser(c);
  const input = parseInput(presignUploadSchema, await c.req.json().catch(() => ({})));

  if (input.sizeBytes > DEFAULT_CONFIG.uploads.maxFileBytes) {
    throw errors.validation('File is too large (max 8 MB).');
  }

  const objectKey = buildObjectKey({
    purpose: input.purpose,
    ownerId: user.id,
    requestId: input.entityId,
    jobId: input.entityId,
    vehicleId: input.purpose === 'vehicle' ? input.entityId : undefined,
    mechanicId: user.id,
    invoiceId: input.entityId,
    fileName: input.fileName,
  }, input.contentType);

  const origin = new URL(c.req.url).origin;
  const signed = await presignUpload(c.env, origin, {
    objectKey,
    contentType: input.contentType,
    expiresIn: DEFAULT_CONFIG.uploads.signedUrlTtlSeconds,
  });

  await recordFile(c.env, {
    objectKey,
    ownerUserId: user.id,
    purpose: input.purpose,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
  });

  return ok(signed, c.get('requestId'));
});

/** Signed read URL for a private object (ownership checked). */
routes.post('/sign-read', async (c) => {
  const user = await requireUser(c);
  const body = (await c.req.json().catch(() => ({}))) as { objectKey?: string };
  if (!body.objectKey || typeof body.objectKey !== 'string') {
    throw errors.validation('objectKey is required.');
  }
  await assertCanReadObject(c.env, user, body.objectKey);
  const origin = new URL(c.req.url).origin;
  const signed = await presignDownload(c.env, origin, body.objectKey, 600);
  return ok(signed, c.get('requestId'));
});

/** Relay PUT: streams the request body into R2 (private bucket). */
routes.put('/object', async (c) => {
  const url = new URL(c.req.url);
  const key = url.searchParams.get('key') ?? '';
  const exp = url.searchParams.get('exp') ?? '';
  const sig = url.searchParams.get('sig') ?? '';
  if (!key || !exp || !sig) throw errors.validation('Missing signature parameters.');
  await verifyRelaySignature(c.env, { key, exp, sig, method: 'PUT' });

  const contentType =
    (c.req.header('content-type') ?? '').split(';')[0].trim() || 'application/octet-stream';
  const allowed = DEFAULT_CONFIG.uploads.allowedTypes as readonly string[];
  if (!allowed.includes(contentType)) {
    throw errors.validation('Unsupported file type.');
  }
  const declaredLength = Number(c.req.header('content-length') ?? '0');
  if (declaredLength > DEFAULT_CONFIG.uploads.maxFileBytes) {
    throw errors.validation('File is too large (max 8 MB).');
  }

  const body = c.req.raw.body;
  if (!body) throw errors.validation('Empty body.');
  await c.env.FILES.put(key, body, { httpMetadata: { contentType } });

  return ok({ key, stored: true }, c.get('requestId'));
});

/** Relay GET: streams a private object when the signature is valid. */
routes.get('/object', async (c) => {
  const url = new URL(c.req.url);
  const key = url.searchParams.get('key') ?? '';
  const exp = url.searchParams.get('exp') ?? '';
  const sig = url.searchParams.get('sig') ?? '';
  if (!key || !exp || !sig) throw errors.validation('Missing signature parameters.');
  await verifyRelaySignature(c.env, { key, exp, sig, method: 'GET' });

  const object = await c.env.FILES.get(key);
  if (!object) throw errors.notFound('File not found.');
  const headers = new Headers();
  const metadata = object.httpMetadata;
  headers.set('content-type', metadata?.contentType ?? 'application/octet-stream');
  headers.set('cache-control', 'private, max-age=300');
  headers.set('content-disposition', 'inline');
  return new Response(object.body, { headers });
});

async function assertCanReadObject(env: Env, user: AuthUser, key: string): Promise<void> {
  if (['ADMIN', 'OPERATIONS'].includes(user.role)) return;

  const parts = key.split('/');
  if (parts[0] === 'users' && parts[1] === user.id) return;
  if (parts[0] === 'mechanics' && parts[1] === user.id) return;

  if (parts[0] === 'vehicles') {
    const row = await env.DB.prepare('SELECT user_id FROM vehicles WHERE id = ?')
      .bind(parts[1])
      .first<{ user_id: string }>();
    if (row?.user_id === user.id) return;
  }

  if (parts[0] === 'requests' || parts[0] === 'jobs' || parts[0] === 'invoices') {
    const requestId = parts[0] === 'jobs' ? parts[1] : parts[1];
    const row = await env.DB.prepare(
      'SELECT driver_user_id, assigned_mechanic_user_id FROM emergency_requests WHERE id = ? OR reference = ?',
    )
      .bind(requestId, requestId)
      .first<{ driver_user_id: string; assigned_mechanic_user_id: string | null }>();
    if (row && (row.driver_user_id === user.id || row.assigned_mechanic_user_id === user.id)) return;
  }

  // Fall back to the file owner record.
  const file = await env.DB.prepare('SELECT owner_user_id FROM files WHERE object_key = ?')
    .bind(key)
    .first<{ owner_user_id: string | null }>();
  if (file?.owner_user_id === user.id) return;

  throw errors.forbidden('You do not have access to this file.');
}

export default routes;
