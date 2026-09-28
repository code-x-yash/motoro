import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser, requireRole } from '../lib/auth';
import { parseInput } from '../lib/validate';
import {
  assignMechanicSchema,
  emergencyListQuerySchema,
  operationsNoteSchema,
} from '@rr/validation';
import {
  loadRequestDto,
  mapRequestRow,
  requireRequest,
  setRequestStatus,
  type RequestRow,
} from '../lib/requests';
import { acceptAttempt, advanceDispatch, reassignRequest } from '../dispatch/service';
import { recordEvent } from '../lib/events';
import { notify } from '../lib/notify';
import { audit } from '../lib/audit';
import { isoIn, newId, nowIso } from '../lib/ids';
import { requireMechanic } from '../lib/mechanics';
import { mapDispatchAttempt } from '../lib/mappers';

const routes = new Hono<{ Bindings: Env }>();

routes.use('*', requireRole('OPERATIONS', 'ADMIN'));

/** Live command-centre KPIs. */
routes.get('/dashboard', async (c) => {
  const counts = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status IN ('CREATED','SEARCHING','DISPATCHING','ASSIGNED','MECHANIC_EN_ROUTE','MECHANIC_NEARBY','ARRIVED','DIAGNOSING','QUOTE_PENDING','QUOTE_APPROVED','REPAIRING') THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status IN ('CREATED','SEARCHING') THEN 1 ELSE 0 END) AS searching,
       SUM(CASE WHEN status = 'DISPATCHING' THEN 1 ELSE 0 END) AS dispatching,
       SUM(CASE WHEN status = 'ASSIGNED' THEN 1 ELSE 0 END) AS assigned,
       SUM(CASE WHEN status IN ('MECHANIC_EN_ROUTE','MECHANIC_NEARBY') THEN 1 ELSE 0 END) AS en_route,
       SUM(CASE WHEN status = 'ESCALATED' THEN 1 ELSE 0 END) AS escalated,
       SUM(CASE WHEN status = 'TOWING_REQUIRED' THEN 1 ELSE 0 END) AS towing,
       SUM(CASE WHEN status IN ('COMPLETED','PAYMENT_PENDING') AND date(created_at) = date('now') THEN 1 ELSE 0 END) AS completed_today,
       SUM(CASE WHEN status = 'FAILED' AND date(created_at) = date('now') THEN 1 ELSE 0 END) AS failed_today,
       SUM(CASE WHEN status IN ('ARRIVED','DIAGNOSING','QUOTE_PENDING','QUOTE_APPROVED','REPAIRING') AND updated_at <= datetime('now','-10 minutes') THEN 1 ELSE 0 END) AS delayed
     FROM emergency_requests WHERE deleted_at IS NULL`,
  ).first<{
    active: number | null;
    searching: number | null;
    dispatching: number | null;
    assigned: number | null;
    en_route: number | null;
    escalated: number | null;
    towing: number | null;
    completed_today: number | null;
    failed_today: number | null;
    delayed: number | null;
  }>();

  const activeMechanics = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM mechanics WHERE status IN ('AVAILABLE','BUSY','EN_ROUTE','ON_JOB') AND verification_status = 'VERIFIED'`,
  ).first<{ c: number }>();

  const pendingOffers = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM dispatch_attempts WHERE status = 'PENDING'`,
  ).first<{ c: number }>();

  const recentEscalations = await c.env.DB.prepare(
    `SELECT e.*, u.full_name AS driver_name, u.phone AS driver_phone,
            v.registration_number AS vehicle_registration,
            (v.make || ' ' || v.model) AS vehicle_label
     FROM emergency_requests e
     JOIN users u ON u.id = e.driver_user_id
     LEFT JOIN vehicles v ON v.id = e.vehicle_id
     WHERE e.deleted_at IS NULL AND e.status = 'ESCALATED'
     ORDER BY e.updated_at DESC LIMIT 5`,
  ).all<RequestRow>();

  return ok(
    {
      active: counts?.active ?? 0,
      searching: (counts?.searching ?? 0) + (counts?.dispatching ?? 0),
      assigned: counts?.assigned ?? 0,
      enRoute: counts?.en_route ?? 0,
      delayed: counts?.delayed ?? 0,
      escalated: counts?.escalated ?? 0,
      towing: counts?.towing ?? 0,
      completedToday: counts?.completed_today ?? 0,
      failedToday: counts?.failed_today ?? 0,
      activeMechanics: activeMechanics?.c ?? 0,
      pendingOffers: pendingOffers?.c ?? 0,
      recentEscalations: recentEscalations.results.map((r) => mapRequestRow(r)),
    },
    c.get('requestId'),
  );
});

/** All emergencies (filterable) for operations. */
routes.get('/emergencies', async (c) => {
  const query = parseInput(emergencyListQuerySchema, c.req.query());
  const statuses = query.status
    ? query.status.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  let sql = `SELECT e.*, u.full_name AS driver_name, u.phone AS driver_phone,
                    v.registration_number AS vehicle_registration,
                    (v.make || ' ' || v.model) AS vehicle_label
             FROM emergency_requests e
             JOIN users u ON u.id = e.driver_user_id
             LEFT JOIN vehicles v ON v.id = e.vehicle_id
             WHERE e.deleted_at IS NULL`;
  const binds: Array<string | number> = [];
  if (statuses && statuses.length > 0) {
    sql += ` AND e.status IN (${statuses.map(() => '?').join(',')})`;
    binds.push(...statuses);
  }
  if (query.q) {
    sql += ' AND (e.reference LIKE ? OR u.full_name LIKE ? OR v.registration_number LIKE ?)';
    binds.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`);
  }

  const countRow = await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM (${sql})`)
    .bind(...binds)
    .first<{ c: number }>();
  sql += ' ORDER BY e.created_at DESC LIMIT ? OFFSET ?';
  binds.push(query.limit ?? 20, query.offset ?? 0);

  const rows = await c.env.DB.prepare(sql).bind(...binds).all<RequestRow>();
  return ok(
    {
      items: rows.results.map((r) => mapRequestRow(r)),
      total: countRow?.c ?? 0,
      limit: query.limit,
      offset: query.offset,
    },
    c.get('requestId'),
  );
});

/** Full detail with timeline + dispatch attempts. */
routes.get('/emergencies/:id', async (c) => {
  const request = await requireRequest(c.env, c.req.param('id'));
  const dto = await loadRequestDto(c.env, request.id, { withTimeline: true });
  const attempts = await c.env.DB.prepare(
    `SELECT d.*, u.full_name AS mechanic_name FROM dispatch_attempts d
     JOIN users u ON u.id = d.mechanic_user_id
     WHERE d.request_id = ? ORDER BY d.attempt_no ASC`,
  )
    .bind(request.id)
    .all();
  return ok(
    { request: dto, attempts: attempts.results.map((r) => mapDispatchAttempt(r as never)) },
    c.get('requestId'),
  );
});

/** Manual assignment (dispatch fallback). */
routes.post('/emergencies/:id/assign', async (c) => {
  const user = await requireUser(c);
  const input = parseInput(assignMechanicSchema, await c.req.json().catch(() => ({})));
  const request = await requireRequest(c.env, c.req.param('id'));
  const mechanic = await requireMechanic(c.env, input.mechanicUserId);

  if (mechanic.verification_status !== 'VERIFIED') {
    throw errors.conflict('MECHANIC_NOT_VERIFIED', 'That mechanic is not verified.');
  }

  // Create a dispatch attempt so the manual assignment still has history, then
  // run the exact same atomic acceptance path the app uses.
  const attemptNoRow = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(attempt_no), 0) AS n FROM dispatch_attempts WHERE request_id = ?',
  )
    .bind(request.id)
    .first<{ n: number }>();
  const attemptId = newId();
  await c.env.DB.prepare(
    `INSERT INTO dispatch_attempts (id, request_id, attempt_no, mechanic_user_id, status, distance_km,
                                    offered_at, timeout_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?, ?, ?)
     ON CONFLICT(request_id, attempt_no) DO NOTHING`,
  )
    .bind(
      attemptId,
      request.id,
      (attemptNoRow?.n ?? 0) + 1,
      input.mechanicUserId,
      nowIso(),
      nowIso(),
      nowIso(),
      nowIso(),
    )
    .run();

  await recordEvent(c.env, {
    requestId: request.id,
    type: 'OPS_MANUAL_ASSIGN',
    message: `Operations assigned ${mechanic.full_name ?? 'a mechanic'}`,
    actorRole: user.role,
    actorUserId: user.id,
    data: { mechanicUserId: input.mechanicUserId, note: input.note ?? null },
  });

  const result = await acceptAttempt(c.env, request.id, input.mechanicUserId);

  await notify(c.env, {
    userId: input.mechanicUserId,
    type: 'OPS_ASSIGNED_JOB',
    title: 'Operations assigned you a job',
    body: `Emergency ${request.reference} has been assigned to you.`,
    data: { requestId: request.id, jobId: result.jobId },
    requestId: request.id,
  });

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'OPS_ASSIGN',
    entityType: 'emergency_request',
    entityId: request.id,
    data: { mechanicUserId: input.mechanicUserId },
    requestId: c.get('requestId'),
  });

  return ok({ jobId: result.jobId, request: await loadRequestDto(c.env, request.id) }, c.get('requestId'));
});

/** Replace the current mechanic (keeps the same emergency request open). */
routes.post('/emergencies/:id/reassign', async (c) => {
  const user = await requireUser(c);
  const input = parseInput(assignMechanicSchema, await c.req.json().catch(() => ({})));
  const request = await requireRequest(c.env, c.req.param('id'));

  const result = await reassignRequest(c.env, request.id, {
    actorRole: user.role,
    actorUserId: user.id,
    reason: 'OPS_REASSIGN',
    replaceMechanicUserId: input.mechanicUserId,
  });

  // If operations picked a specific mechanic, offer it to them directly.
  if (input.mechanicUserId) {
    const attemptNoRow = await c.env.DB.prepare(
      'SELECT COALESCE(MAX(attempt_no), 0) AS n FROM dispatch_attempts WHERE request_id = ?',
    )
      .bind(request.id)
      .first<{ n: number }>();
    await c.env.DB.prepare(
      `INSERT INTO dispatch_attempts (id, request_id, attempt_no, mechanic_user_id, status, distance_km,
                                      offered_at, timeout_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?, ?, ?)`,
    )
      .bind(
        newId(),
        request.id,
        (attemptNoRow?.n ?? 0) + 1,
        input.mechanicUserId,
        nowIso(),
        isoIn(300),
        nowIso(),
        nowIso(),
      )
      .run();
    await advanceDispatch(c.env, await requireRequest(c.env, request.id), {
      reason: 'OPS_REASSIGN',
      actorRole: user.role,
      actorUserId: user.id,
    });
  }

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'OPS_REASSIGN',
    entityType: 'emergency_request',
    entityId: request.id,
    data: { mechanicUserId: input.mechanicUserId ?? null },
    requestId: c.get('requestId'),
  });

  return ok({ reassigned: result.reassigned, request: await loadRequestDto(c.env, request.id) }, c.get('requestId'));
});

/** Escalate / internal note / cancel from the command centre. */
routes.post('/emergencies/:id/escalate', async (c) => {
  const user = await requireUser(c);
  const request = await requireRequest(c.env, c.req.param('id'));
  const { escalateRequest } = await import('../dispatch/service');
  await escalateRequest(c.env, request, 'OPS_ESCALATED', 'Operations escalated this emergency.');
  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'OPS_ESCALATE',
    entityType: 'emergency_request',
    entityId: request.id,
    requestId: c.get('requestId'),
  });
  return ok({ request: await loadRequestDto(c.env, request.id) }, c.get('requestId'));
});

routes.post('/emergencies/:id/note', async (c) => {
  const user = await requireUser(c);
  const input = parseInput(operationsNoteSchema, await c.req.json().catch(() => ({})));
  const request = await requireRequest(c.env, c.req.param('id'));
  await recordEvent(c.env, {
    requestId: request.id,
    type: 'INTERNAL_NOTE',
    message: input.note,
    actorRole: user.role,
    actorUserId: user.id,
    toOps: false,
  });
  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'OPS_NOTE',
    entityType: 'emergency_request',
    entityId: request.id,
    data: { note: input.note },
    requestId: c.get('requestId'),
  });
  return ok({ noted: true }, c.get('requestId'));
});

routes.post('/emergencies/:id/cancel', async (c) => {
  const user = await requireUser(c);
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const request = await requireRequest(c.env, c.req.param('id'));
  const updated = await setRequestStatus(c.env, request, 'CANCELLED', {
    actorRole: user.role,
    actorUserId: user.id,
    message: `Cancelled by operations: ${body.reason ?? 'no reason given'}`,
    extra: { cancel_reason: body.reason ?? 'OPS_CANCEL', cancelled_by: user.id },
  });
  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'OPS_CANCEL',
    entityType: 'emergency_request',
    entityId: request.id,
    data: { reason: body.reason ?? null },
    requestId: c.get('requestId'),
  });
  return ok({ request: await loadRequestDto(c.env, updated.id) }, c.get('requestId'));
});

/** Map payload: active requests + mechanic presence. */
routes.get('/map', async (c) => {
  const requests = await c.env.DB.prepare(
    `SELECT e.id, e.reference, e.status, e.urgency, e.latitude, e.longitude, e.address, e.issue_type,
            e.assigned_mechanic_user_id, u.full_name AS driver_name
     FROM emergency_requests e
     JOIN users u ON u.id = e.driver_user_id
     WHERE e.deleted_at IS NULL
       AND e.status NOT IN ('PAID','CANCELLED','FAILED')
     ORDER BY e.created_at DESC LIMIT 200`,
  ).all<{
    id: string;
    reference: string;
    status: string;
    urgency: string;
    latitude: number;
    longitude: number;
    address: string | null;
    issue_type: string;
    assigned_mechanic_user_id: string | null;
    driver_name: string;
  }>();

  const mechanics = await c.env.DB.prepare(
    `SELECT m.user_id, m.status, m.last_known_latitude, m.last_known_longitude, m.latitude, m.longitude,
            m.service_radius_km, m.verification_status, u.full_name
     FROM mechanics m JOIN users u ON u.id = m.user_id
     WHERE m.deleted_at IS NULL AND m.verification_status = 'VERIFIED'
       AND m.status IN ('AVAILABLE','BUSY','EN_ROUTE','ON_JOB')
     LIMIT 200`,
  ).all<{
    user_id: string;
    status: string;
    last_known_latitude: number | null;
    last_known_longitude: number | null;
    latitude: number | null;
    longitude: number | null;
    service_radius_km: number;
    verification_status: string;
    full_name: string;
  }>();

  return ok(
    {
      requests: requests.results.map((r) => ({
        id: r.id,
        reference: r.reference,
        status: r.status,
        urgency: r.urgency,
        latitude: r.latitude,
        longitude: r.longitude,
        address: r.address,
        issueType: r.issue_type,
        driverName: r.driver_name,
        assignedMechanicUserId: r.assigned_mechanic_user_id,
      })),
      mechanics: mechanics.results.map((m) => ({
        userId: m.user_id,
        fullName: m.full_name,
        status: m.status,
        latitude: m.last_known_latitude ?? m.latitude,
        longitude: m.last_known_longitude ?? m.longitude,
        serviceRadiusKm: m.service_radius_km,
      })),
    },
    c.get('requestId'),
  );
});

/** All mechanics with live status (operations view). */
routes.get('/mechanics', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.user_id, m.status, m.verification_status, m.latitude, m.longitude,
            m.last_known_latitude, m.last_known_longitude, m.rating_sum, m.rating_count,
            m.jobs_completed, m.offers_received, m.offers_accepted, m.earnings_cents, m.service_radius_km,
            u.full_name, u.email, u.phone, u.status AS user_status
     FROM mechanics m JOIN users u ON u.id = m.user_id
     WHERE m.deleted_at IS NULL
     ORDER BY m.updated_at DESC LIMIT 300`,
  ).all();

  const activeJobs = await c.env.DB.prepare(
    `SELECT mechanic_user_id, COUNT(*) AS c FROM jobs
     WHERE deleted_at IS NULL AND status IN ('ACCEPTED','EN_ROUTE','ARRIVED','VERIFIED','DIAGNOSING','QUOTE_PENDING','QUOTE_APPROVED','REPAIRING')
     GROUP BY mechanic_user_id`,
  ).all<{ mechanic_user_id: string; c: number }>();
  const activeMap = new Map(activeJobs.results.map((r) => [r.mechanic_user_id, r.c]));

  return ok(
    {
      items: rows.results.map((row) => {
        const r = row as never as {
          user_id: string;
          status: string;
          verification_status: string;
          last_known_latitude: number | null;
          last_known_longitude: number | null;
          latitude: number | null;
          longitude: number | null;
          rating_sum: number;
          rating_count: number;
          jobs_completed: number;
          offers_received: number;
          offers_accepted: number;
          earnings_cents: number;
          service_radius_km: number;
          full_name: string;
          email: string;
          phone: string | null;
          user_status: string;
        };
        return {
          userId: r.user_id,
          fullName: r.full_name,
          email: r.email,
          phone: r.phone,
          status: r.status,
          userStatus: r.user_status,
          verificationStatus: r.verification_status,
          latitude: r.last_known_latitude ?? r.latitude,
          longitude: r.last_known_longitude ?? r.longitude,
          serviceRadiusKm: r.service_radius_km,
          ratingAverage: r.rating_count > 0 ? Math.round((r.rating_sum / r.rating_count) * 10) / 10 : 0,
          ratingCount: r.rating_count,
          jobsCompleted: r.jobs_completed,
          activeJobs: activeMap.get(r.user_id) ?? 0,
          acceptanceRate:
            r.offers_received > 0 ? Math.round((r.offers_accepted / r.offers_received) * 100) : 100,
          earningsCents: r.earnings_cents,
        };
      }),
    },
    c.get('requestId'),
  );
});

/** Failed dispatch attempts (reliability debugging). */
routes.get('/failed-dispatches', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT d.*, u.full_name AS mechanic_name, e.reference, e.issue_type, e.status AS request_status
     FROM dispatch_attempts d
     JOIN users u ON u.id = d.mechanic_user_id
     JOIN emergency_requests e ON e.id = d.request_id
     WHERE d.status IN ('DECLINED','TIMEOUT','FAILED','EXPIRED','CANCELLED','REASSIGNED')
     ORDER BY d.updated_at DESC LIMIT 100`,
  ).all();
  return ok(
    {
      items: rows.results.map((row) => {
        const r = row as never as Record<string, unknown> & {
          d?: unknown;
        };
        const flat = r as unknown as {
          id: string;
          request_id: string;
          attempt_no: number;
          mechanic_user_id: string;
          status: string;
          score: number | null;
          distance_km: number | null;
          eta_minutes: number | null;
          offered_at: string;
          responded_at: string | null;
          timeout_at: string | null;
          decline_reason: string | null;
          mechanic_name: string;
          reference: string;
          issue_type: string;
          request_status: string;
        };
        return {
          ...mapDispatchAttempt(flat),
          reference: flat.reference,
          issueType: flat.issue_type,
          requestStatus: flat.request_status,
        };
      }),
    },
    c.get('requestId'),
  );
});

export default routes;
