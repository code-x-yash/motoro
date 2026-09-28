import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser, requirePermission, assertOwnership } from '../lib/auth';
import { parseInput } from '../lib/validate';
import { dispatchRespondSchema } from '@rr/validation';
import { acceptAttempt, declineAttempt } from '../dispatch/service';
import { requireRequest, assertDispatchAccess } from '../lib/requests';
import { audit } from '../lib/audit';
import { requireMechanic } from '../lib/mechanics';
import { nowIso } from '../lib/ids';

const routes = new Hono<{ Bindings: Env }>();

/**
 * Accepts either an attempt id (from /offers) or a request id and returns the
 * request id, so clients can use whichever identifier they have.
 */
async function resolveRequestId(env: Env, param: string): Promise<string> {
  const attempt = await env.DB.prepare('SELECT request_id FROM dispatch_attempts WHERE id = ?')
    .bind(param)
    .first<{ request_id: string }>();
  return attempt?.request_id ?? param;
}

/** Mechanic accepts an offered emergency (atomic — never double assigned). */
routes.post('/:id/accept', requirePermission('DISPATCH_RESPOND'), async (c) => {
  const user = await requireUser(c);
  const requestIdParam = await resolveRequestId(c.env, c.req.param('id'));
  const request = await requireRequest(c.env, requestIdParam);
  await assertDispatchAccess(c.env, user, request);

  if (user.role !== 'MECHANIC' && user.role !== 'WORKSHOP') {
    throw errors.forbidden('Only mechanics can accept dispatch offers.');
  }
  await requireMechanic(c.env, user.id);

  const result = await acceptAttempt(c.env, requestIdParam, user.id);

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'DISPATCH_ACCEPTED',
    entityType: 'emergency_request',
    entityId: requestIdParam,
    requestId: c.get('requestId'),
  });

  return ok({ jobId: result.jobId, requestId: result.requestId, idempotent: result.idempotent }, c.get('requestId'));
});

/** Mechanic declines — the engine immediately tries the next candidate. */
routes.post('/:id/decline', requirePermission('DISPATCH_RESPOND'), async (c) => {
  const user = await requireUser(c);
  const input = parseInput(dispatchRespondSchema, await c.req.json().catch(() => ({})));
  const requestIdParam = await resolveRequestId(c.env, c.req.param('id'));
  await requireRequest(c.env, requestIdParam);

  const result = await declineAttempt(c.env, requestIdParam, user.id, input.reason);

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'DISPATCH_DECLINED',
    entityType: 'emergency_request',
    entityId: requestIdParam,
    data: { reason: input.reason ?? null },
    requestId: c.get('requestId'),
  });

  return ok({ declined: true, advanced: result.advanced }, c.get('requestId'));
});

/** Pending offers for the signed-in mechanic (with response countdown). */
routes.get('/offers', async (c) => {
  const user = await requireUser(c);
  if (!['MECHANIC', 'WORKSHOP', 'OPERATIONS', 'ADMIN'].includes(user.role)) {
    throw errors.forbidden();
  }
  const rows = await c.env.DB.prepare(
    `SELECT d.*, e.reference, e.issue_type, e.urgency, e.latitude, e.longitude, e.address,
            e.required_skills, e.required_equipment, e.created_at
     FROM dispatch_attempts d
     JOIN emergency_requests e ON e.id = d.request_id
     WHERE d.mechanic_user_id = ? AND d.status = 'PENDING' AND e.deleted_at IS NULL
       AND e.status IN ('SEARCHING','DISPATCHING','ESCALATED','CREATED')
     ORDER BY d.offered_at ASC LIMIT 20`,
  )
    .bind(user.id)
    .all<{
      id: string;
      request_id: string;
      attempt_no: number;
      timeout_at: string | null;
      distance_km: number | null;
      eta_minutes: number | null;
      offered_at: string;
      reference: string;
      issue_type: string;
      urgency: string;
      latitude: number;
      longitude: number;
      address: string | null;
      required_skills: string;
      required_equipment: string;
    }>();

  const items = rows.results.map((r) => ({
    attemptId: r.id,
    requestId: r.request_id,
    reference: r.reference,
    issueType: r.issue_type,
    urgency: r.urgency,
    distanceKm: r.distance_km,
    etaMinutes: r.eta_minutes,
    offeredAt: r.offered_at,
    timeoutAt: r.timeout_at,
    secondsLeft: r.timeout_at
      ? Math.max(0, Math.floor((new Date(r.timeout_at).getTime() - Date.now()) / 1000))
      : null,
    latitude: r.latitude,
    longitude: r.longitude,
    address: r.address,
    requiredSkills: JSON.parse(r.required_skills || '[]') as string[],
    requiredEquipment: JSON.parse(r.required_equipment || '[]') as string[],
  }));

  return ok({ items }, c.get('requestId'));
});

/** Mechanic marks a specific offer as seen (analytics / reliability). */
routes.post('/:id/viewed', requirePermission('DISPATCH_RESPOND'), async (c) => {
  const user = await requireUser(c);
  const requestIdParam = await resolveRequestId(c.env, c.req.param('id'));
  await c.env.DB.prepare(
    `UPDATE dispatch_attempts SET updated_at = ? WHERE request_id = ? AND mechanic_user_id = ? AND status = 'PENDING'`,
  )
    .bind(nowIso(), requestIdParam, user.id)
    .run();
  return ok({ viewed: true }, c.get('requestId'));
});

export { assertOwnership };
export default routes;
