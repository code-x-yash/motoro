import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser } from '../lib/auth';
import { parseInput } from '../lib/validate';
import { createDisputeSchema, paginationSchema } from '@rr/validation';
import { requireRequest, assertRequestAccess } from '../lib/requests';
import { newId, nowIso } from '../lib/ids';
import { recordEvent } from '../lib/events';
import { audit } from '../lib/audit';
import { notify } from '../lib/notify';

const routes = new Hono<{ Bindings: Env }>();

interface DisputeRow {
  id: string;
  request_id: string;
  raised_by: string;
  reason: string;
  category: string;
  status: string;
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
}

const DISPUTE_COLUMNS = 'd.id, d.request_id, d.raised_by, d.reason, d.category, d.status, d.resolution, d.resolved_at, d.created_at';

function mapDispute(row: DisputeRow, reference?: string) {
  return {
    id: row.id,
    requestId: row.request_id,
    reference: reference ?? null,
    raisedBy: row.raised_by,
    category: row.category,
    reason: row.reason,
    status: row.status,
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

/** Raise a dispute about a request (driver or the assigned mechanic). */
routes.post('/', async (c) => {
  const user = await requireUser(c);
  const input = parseInput(createDisputeSchema, await c.req.json().catch(() => ({})));
  const request = await requireRequest(c.env, input.requestId);
  assertRequestAccess(user, request);

  const isDriver = request.driver_user_id === user.id;
  const isMechanic = request.assigned_mechanic_user_id === user.id;
  if (!isDriver && !isMechanic) {
    throw errors.forbidden('Only the customer or their mechanic can raise a dispute.');
  }

  const existing = await c.env.DB.prepare(
    `SELECT id FROM disputes
     WHERE request_id = ? AND raised_by = ? AND status IN ('OPEN','IN_REVIEW')
     LIMIT 1`,
  )
    .bind(request.id, user.id)
    .first<{ id: string }>();
  if (existing) {
    throw errors.conflict('DISPUTE_EXISTS', 'You already have an open dispute for this request.');
  }

  const id = newId();
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO disputes (id, request_id, raised_by, reason, category, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
  )
    .bind(id, request.id, user.id, input.reason, input.category, now, now)
    .run();

  await recordEvent(c.env, {
    requestId: request.id,
    type: 'DISPUTE_RAISED',
    message: `Dispute raised (${input.category.replace(/_/g, ' ')}): ${input.reason.slice(0, 120)}`,
    actorRole: user.role,
    actorUserId: user.id,
    data: { disputeId: id, category: input.category },
  });

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'DISPUTE_RAISED',
    entityType: 'dispute',
    entityId: id,
    data: { requestId: request.id, category: input.category },
    requestId: c.get('requestId'),
  });

  // Ops needs to know a dispute exists — nothing else surfaces it to them.
  const ops = await c.env.DB.prepare(
    "SELECT id FROM users WHERE role IN ('OPERATIONS','ADMIN') AND status = 'ACTIVE'",
  ).all<{ id: string }>();
  await Promise.all(
    ops.results.map((u) =>
      notify(c.env, {
        userId: u.id,
        type: 'DISPUTE_RAISED',
        title: 'New dispute to review',
        body: `${request.reference} · ${input.category.replace(/_/g, ' ')}: ${input.reason.slice(0, 120)}`,
        data: { disputeId: id, requestId: request.id, reference: request.reference },
      }).catch(() => undefined),
    ),
  );

  return ok(
    {
      dispute: mapDispute(
        {
          id,
          request_id: request.id,
          raised_by: user.id,
          reason: input.reason,
          category: input.category,
          status: 'OPEN',
          resolution: null,
          resolved_at: null,
          created_at: now,
        },
        request.reference,
      ),
    },
    c.get('requestId'),
    201,
  );
});

/** Disputes for one request (participants / ops only). */
routes.get('/', async (c) => {
  const user = await requireUser(c);
  const requestId = c.req.query('requestId');

  if (requestId) {
    const request = await requireRequest(c.env, requestId);
    assertRequestAccess(user, request);
    const rows = await c.env.DB.prepare(
      `SELECT ${DISPUTE_COLUMNS}, e.reference
       FROM disputes d
       JOIN emergency_requests e ON e.id = d.request_id
       WHERE d.request_id = ? ORDER BY d.created_at DESC`,
    )
      .bind(request.id)
      .all<DisputeRow & { reference: string }>();
    return ok({ items: rows.results.map((r) => mapDispute(r, r.reference)) }, c.get('requestId'));
  }

  const { limit, offset } = parseInput(paginationSchema, {
    limit: c.req.query('limit') ?? undefined,
    offset: c.req.query('offset') ?? undefined,
  });
  const total = await c.env.DB.prepare(
    'SELECT COUNT(*) AS c FROM disputes WHERE raised_by = ?',
  )
    .bind(user.id)
    .first<{ c: number }>();
  const rows = await c.env.DB.prepare(
    `SELECT ${DISPUTE_COLUMNS}, e.reference
     FROM disputes d
     JOIN emergency_requests e ON e.id = d.request_id
     WHERE d.raised_by = ?
     ORDER BY d.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(user.id, limit, offset)
    .all<DisputeRow & { reference: string }>();
  return ok(
    {
      items: rows.results.map((r) => mapDispute(r, r.reference)),
      total: total?.c ?? 0,
      limit,
      offset,
    },
    c.get('requestId'),
  );
});

export default routes;
