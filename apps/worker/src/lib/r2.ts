import type { Env } from '../env';
import { AppError } from './errors';
import { hmacHex } from './crypto';
import { nowIso } from './ids';

/**
 * R2 object storage helpers.
 *
 * Files are always private. Access is granted through short-lived signed URLs:
 *  - with R2 S3 credentials: real SigV4 presigned URLs (browser-direct)
 *  - without: signed relay URLs through the Worker (still private + expiring)
 */

export type UploadPurpose =
  | 'breakdown'
  | 'diagnosis'
  | 'completion'
  | 'verification'
  | 'profile'
  | 'vehicle'
  | 'invoice';

export interface ObjectKeyParts {
  purpose: UploadPurpose;
  ownerId: string;
  requestId?: string;
  jobId?: string;
  vehicleId?: string;
  mechanicId?: string;
  invoiceId?: string;
  entityId?: string;
  fileName?: string;
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

function safeExt(fileName: string | undefined, contentType?: string): string {
  if (fileName && fileName.includes('.')) {
    const ext = fileName.split('.').pop()!.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (ext && ext.length <= 5) return ext;
  }
  if (contentType && EXT_BY_TYPE[contentType]) return EXT_BY_TYPE[contentType];
  return 'bin';
}

/** Logical object key layout required by the product spec. */
export function buildObjectKey(parts: ObjectKeyParts, contentType?: string): string {
  const ext = safeExt(parts.fileName, contentType);
  const id = crypto.randomUUID();
  const owner = parts.ownerId.replace(/[^A-Za-z0-9_-]/g, '');
  switch (parts.purpose) {
    case 'breakdown':
      return `requests/${parts.requestId ?? 'unknown'}/breakdown/${id}.${ext}`;
    case 'diagnosis':
      return `jobs/${parts.jobId ?? parts.requestId ?? 'unknown'}/diagnosis/${id}.${ext}`;
    case 'completion':
      return `jobs/${parts.jobId ?? parts.requestId ?? 'unknown'}/completion/${id}.${ext}`;
    case 'verification':
      return `mechanics/${parts.mechanicId ?? owner}/verification/${id}.${ext}`;
    case 'profile':
      return `users/${owner}/profile/${id}.${ext}`;
    case 'vehicle':
      return `vehicles/${parts.vehicleId ?? parts.entityId ?? 'unknown'}/${id}.${ext}`;
    case 'invoice':
      return `invoices/${parts.invoiceId ?? parts.requestId ?? 'unknown'}/${id}.${ext}`;
    default:
      return `misc/${owner}/${id}.${ext}`;
  }
}

export interface SignedUpload {
  uploadUrl: string;
  objectKey: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
}

export interface SignedDownload {
  url: string;
  objectKey: string;
  expiresAt: string;
}

function hasS3Credentials(env: Env): boolean {
  return Boolean(
    env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.CLOUDFLARE_ACCOUNT_ID && env.R2_BUCKET_NAME,
  );
}

/**
 * Secret used to sign worker-relay upload/download URLs. Production must set
 * SESSION_SECRET (wrangler secret put SESSION_SECRET); development falls back
 * to a well-known local value so the API works out of the box.
 */
function relaySecret(env: Env): string {
  const secret = env.SESSION_SECRET?.trim();
  if (secret && secret.length >= 16) return secret;
  if (env.ENVIRONMENT === 'production') {
    throw new AppError(
      'CONFIG_ERROR',
      'SESSION_SECRET is not configured for this environment.',
      500,
    );
  }
  return 'motoro-dev-relay-secret';
}

async function sigv4Presign(
  env: Env,
  method: 'PUT' | 'GET',
  key: string,
  expiresIn: number,
  contentType?: string,
): Promise<string> {
  const accessKeyId = env.R2_ACCESS_KEY_ID!;
  const secret = env.R2_SECRET_ACCESS_KEY!;
  const account = env.CLOUDFLARE_ACCOUNT_ID!;
  const bucket = env.R2_BUCKET_NAME!;
  const host = `${account}.r2.cloudflarestorage.com`;
  const region = 'auto';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const canonicalUri = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': contentType ? 'content-type;host' : 'host',
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join('&');
  const signedHeaderNames = contentType ? 'content-type;host' : 'host';
  const canonicalHeaders = contentType
    ? `content-type:${contentType}\nhost:${host}\n`
    : `host:${host}\n`;
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const { sha256HexAsync } = await import('./crypto');
  const hashedRequest = await sha256HexAsync(canonicalRequest);
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    hashedRequest,
  ].join('\n');

  const kDate = await hmacRaw(`AWS4${secret}`, dateStamp);
  const kRegion = await hmacRaw(kDate, region);
  const kService = await hmacRaw(kRegion, 's3');
  const kSigning = await hmacRaw(kService, 'aws4_request');
  const signature = await hmacHexRaw(kSigning, stringToSign);

  const url = new URL(`https://${host}${canonicalUri}`);
  url.search = canonicalQuery;
  url.searchParams.set('X-Amz-Signature', signature);
  return url.toString();
}

async function hmacRaw(key: string | Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : (key as BufferSource),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

async function hmacHexRaw(key: string | Uint8Array, data: string): Promise<string> {
  const bytes = await hmacRaw(key, data);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Worker-relay signed URL (development / no S3 credentials). */
async function relayUrl(
  env: Env,
  origin: string,
  method: 'PUT' | 'GET',
  key: string,
  expiresIn: number,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const sig = await hmacHex(relaySecret(env), `${method}:${key}:${exp}`);
  const params = new URLSearchParams({ key, exp: String(exp), sig, method });
  const path = method === 'PUT' ? '/api/uploads/object' : '/api/uploads/object';
  return `${origin}${path}?${params.toString()}`;
}

export async function presignUpload(
  env: Env,
  origin: string,
  input: { objectKey: string; contentType: string; expiresIn?: number },
): Promise<SignedUpload> {
  const expiresIn = input.expiresIn ?? 600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  if (hasS3Credentials(env)) {
    const url = await sigv4Presign(env, 'PUT', input.objectKey, expiresIn, input.contentType);
    return {
      uploadUrl: url,
      objectKey: input.objectKey,
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      expiresAt,
    };
  }
  const url = await relayUrl(env, origin, 'PUT', input.objectKey, expiresIn);
  return {
    uploadUrl: url,
    objectKey: input.objectKey,
    method: 'PUT',
    headers: { 'content-type': input.contentType },
    expiresAt,
  };
}

export async function presignDownload(
  env: Env,
  origin: string,
  objectKey: string,
  expiresIn = 600,
): Promise<SignedDownload> {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  if (hasS3Credentials(env)) {
    return { url: await sigv4Presign(env, 'GET', objectKey, expiresIn), objectKey, expiresAt };
  }
  return {
    url: await relayUrl(env, origin, 'GET', objectKey, expiresIn),
    objectKey,
    expiresAt,
  };
}

export async function verifyRelaySignature(
  env: Env,
  params: { key: string; exp: string; sig: string; method: string },
): Promise<void> {
  const exp = Number(params.exp);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) {
    throw new AppError('SIGNED_URL_EXPIRED', 'This upload link has expired.', 403);
  }
  const expected = await hmacHex(relaySecret(env), `${params.method}:${params.key}:${params.exp}`);
  if (expected !== params.sig) {
    throw new AppError('INVALID_SIGNATURE', 'Invalid upload signature.', 403);
  }
}

export function recordFile(
  env: Env,
  file: {
    objectKey: string;
    ownerUserId: string | null;
    purpose: string;
    contentType: string;
    sizeBytes?: number;
  },
): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO files (id, object_key, owner_user_id, purpose, content_type, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(object_key) DO NOTHING`,
  )
    .bind(
      crypto.randomUUID(),
      file.objectKey,
      file.ownerUserId,
      file.purpose,
      file.contentType,
      file.sizeBytes ?? 0,
      nowIso(),
    )
    .run();
}
