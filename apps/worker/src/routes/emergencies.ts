import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser } from '../lib/auth';
import { parseInput } from '../lib/validate';
import {
  cancelEmergencySchema,
  createEmergencySchema,
  emergencyListQuerySchema,
  escalateEmergencySchema,
  shareEmergencySchema,
  sendMessageSchema,
  updateEmergencyLocationSchema,
} from '@rr/validation';
import { newId, newReference, nowIso } from '../lib/ids';
import { audit } from '../lib/audit';
import { recordEvent } from '../lib/events';
import {
  appendLocation,
  assertRequestAccess,
  assertDispatchAccess,
  loadRequestDto,
  mapRequestRow,
  requireRequest,
  setRequestStatus,
  type RequestRow,
} from '../lib/requests';
import { ACTIVE_REQUEST_STATUSES } from '../lib/state-machine';
import { startDispatch } from '../dispatch/service';
import { notify } from '../lib/notify';
import { mapInvoice, mapPayment } from '../lib/mappers';
import { createPayment as createPaymentService, verifyPaymentCheckout, ensureInvoice, computeRequestTotal } from '../lib/payment-service';
import { applyCoupon } from '../lib/coupons';
import { getConfig } from '../lib/config';
import { requirementsForIssue } from '../lib/categories';
import { ensureInvoicePdf } from '../lib/invoice-pdf';
import { ISSUE_LABELS } from '@rr/config';
import { enforceRateLimit } from '../lib/rate-limit';
import { broadcast, requestRoom } from '../lib/realtime';

const routes = new Hono<{ Bindings: Env }>();

/** Create a new emergency request (all channels converge here). */
routes.post('/', async (c) => {
  const user = await requireUser(c);
  const requestId = c.get('requestId');
  if (!['DRIVER', 'OPERATIONS', 'ADMIN'].includes(user.role)) {
    throw errors.forbidden('Only drivers can request roadside assistance.');
  }
  await enforceRateLimit(c.env, 'emergency_create', user.id, 5, 300, 'You are already creating requests. Please wait.');

  const input = parseInput(createEmergencySchema, await c.req.json().catch(() => ({})));

  // Duplicate emergency detection (anti-fraud + UX).
  const active = await c.env.DB.prepare(
    `SELECT id, reference, status FROM emergency_requests
     WHERE driver_user_id = ? AND deleted_at IS NULL
       AND status IN (${ACTIVE_REQUEST_STATUSES.map(() => '?').join(',')})
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(user.id, ...ACTIVE_REQUEST_STATUSES)
    .first<{ id: string; reference: string; status: string }>();

  if (active) {
    throw errors.conflict(
      'ACTIVE_REQUEST_EXISTS',
      'You already have an active assistance request. Opening it now instead.',
    );
  }

  let vehicleId: string | null = input.vehicleId ?? null;
  if (vehicleId) {
    const vehicle = await c.env.DB.prepare(
      'SELECT id FROM vehicles WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
      .bind(vehicleId, user.id)
      .first<{ id: string }>();
    if (!vehicle) throw errors.notFound('Vehicle not found in your garage.');
  } else {
    const fallback = await c.env.DB.prepare(
      'SELECT id FROM vehicles WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1',
    )
      .bind(user.id)
      .first<{ id: string }>();
    vehicleId = fallback?.id ?? null;
  }

  const id = newId();
  const now = nowIso();
  const accident = input.accidentMode ?? null;
  const isAccident = input.issueType === 'ACCIDENT' || accident !== null;
  // Active admin-managed service category wins over built-in defaults.
  const requirements = await requirementsForIssue(c.env, input.issueType);
  const requiredSkills = requirements.requiredSkills;
  const requiredEquipment = requirements.requiredEquipment;

  // Accident triage: intake stays in CREATED (the dispatch state machine owns
  // transitions) but accidents are weighted up so they surface first.
  const effectiveUrgency = !isAccident
    ? input.urgency
    : accident && (accident.anyoneInjured || accident.driverInjured || accident.medicalAssistance)
      ? 'CRITICAL'
      : input.urgency === 'LOW' || input.urgency === 'NORMAL'
        ? 'HIGH'
        : input.urgency;
  const wantsTowing = input.issueType === 'ACCIDENT' || Boolean(accident?.needsTowing);
  if (wantsTowing) {
    if (!requiredSkills.includes('towing')) requiredSkills.push('towing');
    if (!requiredEquipment.includes('tow_hook')) requiredEquipment.push('tow_hook');
  }

  const initialStatus = 'CREATED';

  await c.env.DB.prepare(
    `INSERT INTO emergency_requests
      (id, reference, driver_user_id, vehicle_id, channel, category_code, issue_type, description,
       urgency, status, accident_json, latitude, longitude, accuracy, address,
       required_skills, required_equipment, created_by_role, source_meta_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      newReference(),
      user.id,
      vehicleId,
      input.channel,
      input.issueType,
      input.issueType,
      input.description ?? null,
      effectiveUrgency,
      initialStatus,
      input.accidentMode ? JSON.stringify(input.accidentMode) : null,
      input.latitude,
      input.longitude,
      input.accuracy ?? null,
      input.address ?? null,
      JSON.stringify(requiredSkills),
      JSON.stringify(requiredEquipment),
      user.role,
      JSON.stringify({ isAccident, userAgent: c.req.header('user-agent') ?? null }),
      now,
      now,
    )
    .run();

  await appendLocation(c.env, {
    requestId: id,
    source: input.channel === 'OPS' ? 'OPS' : 'DRIVER',
    actorUserId: user.id,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracy: input.accuracy ?? null,
  });

  await recordEvent(c.env, {
    requestId: id,
    type: 'REQUEST_CREATED',
    message: `New request: ${ISSUE_LABELS[input.issueType] ?? input.issueType.replace(/_/g, ' ').toLowerCase()}`,
    actorRole: user.role,
    actorUserId: user.id,
    data: { channel: input.channel, urgency: effectiveUrgency, accident: isAccident, towing: wantsTowing },
  });

  // Attach any pre-uploaded breakdown photos.
  for (const key of (input.photoKeys ?? []).slice(0, 10)) {
    await c.env.DB.prepare(
      `INSERT INTO job_photos (id, request_id, stage, object_key, uploaded_by, created_at)
       VALUES (?, ?, 'BEFORE', ?, ?, ?)`,
    )
      .bind(newId(), id, key, user.id, now)
      .run()
      .catch(() => undefined);
  }

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'EMERGENCY_CREATED',
    entityType: 'emergency_request',
    entityId: id,
    data: { issueType: input.issueType, urgency: effectiveUrgency, accident: isAccident, towing: wantsTowing },
    requestId,
  });

  const request = await requireRequest(c.env, id);

  await notify(c.env, {
    userId: user.id,
    type: 'EMERGENCY_CREATED',
    title: 'Help is on the way',
    body: `Your request ${request.reference} was created. We are finding a nearby mechanic.`,
    data: { requestId: id, reference: request.reference, issueType: input.issueType },
    requestId: id,
  });

  if (input.accidentMode?.medicalAssistance || input.accidentMode?.anyoneInjured) {
    await notify(c.env, {
      userId: user.id,
      type: 'ACCIDENT_MODE',
      title: 'Please call emergency services',
      body: 'If anyone is injured, call 112 immediately. Motoro is not a replacement for emergency services.',
      data: { requestId: id },
      requestId: id,
    });
  }

  // Kick off dispatch (never-stranded engine). Failures fall back to the cron
  // sweep, so the request keeps progressing even if this call fails.
  try {
    await startDispatch(c.env, request);
  } catch {
    await recordEvent(c.env, {
      requestId: id,
      type: 'DISPATCH_RETRY_SCHEDULED',
      message: 'Dispatch will retry automatically in a moment',
    });
  }

  const dto = await loadRequestDto(c.env, id, { withTimeline: true });
  return ok({ request: dto }, c.get('requestId'), 201);
});

/** List requests visible to the current user. */
routes.get('/', async (c) => {
  const user = await requireUser(c);
  const query = parseInput(emergencyListQuerySchema, c.req.query());
  const statuses = query.status
    ? query.status.split(',').map((s) => s.trim()).filter(Boolean)
    : null;

  let sql = '';
  const binds: Array<string | number> = [];

  if (user.role === 'DRIVER') {
    sql = 'SELECT e.*, u.full_name AS driver_name, u.phone AS driver_phone, v.registration_number AS vehicle_registration, (v.make || \' \' || v.model) AS vehicle_label FROM emergency_requests e JOIN users u ON u.id = e.driver_user_id LEFT JOIN vehicles v ON v.id = e.vehicle_id WHERE e.driver_user_id = ? AND e.deleted_at IS NULL';
    binds.push(user.id);
  } else if (user.role === 'MECHANIC') {
    sql = `SELECT e.*, u.full_name AS driver_name, u.phone AS driver_phone, v.registration_number AS vehicle_registration, (v.make || ' ' || v.model) AS vehicle_label
           FROM emergency_requests e
           JOIN users u ON u.id = e.driver_user_id
           LEFT JOIN vehicles v ON v.id = e.vehicle_id
           WHERE e.deleted_at IS NULL
             AND (e.assigned_mechanic_user_id = ?
                  OR EXISTS (SELECT 1 FROM dispatch_attempts d WHERE d.request_id = e.id AND d.mechanic_user_id = ?))`;
    binds.push(user.id, user.id);
  } else {
    sql = `SELECT e.*, u.full_name AS driver_name, u.phone AS driver_phone, v.registration_number AS vehicle_registration, (v.make || ' ' || v.model) AS vehicle_label
           FROM emergency_requests e
           JOIN users u ON u.id = e.driver_user_id
           LEFT JOIN vehicles v ON v.id = e.vehicle_id
           WHERE e.deleted_at IS NULL`;
  }

  if (statuses && statuses.length > 0) {
    sql += ` AND e.status IN (${statuses.map(() => '?').join(',')})`;
    binds.push(...statuses);
  }

  const countSql = `SELECT COUNT(*) AS c FROM (${sql})`;
  const countRow = await c.env.DB.prepare(countSql).bind(...binds).first<{ c: number }>();
  sql += ' ORDER BY e.created_at DESC LIMIT ? OFFSET ?';
  binds.push(query.limit ?? 20, query.offset ?? 0);

  const rows = await c.env.DB.prepare(sql).bind(...binds).all<RequestRow>();
  const items = [];
  for (const row of rows.results) items.push(mapRequestRow(row));

  return ok(
    { items, total: countRow?.c ?? items.length, limit: query.limit, offset: query.offset },
    c.get('requestId'),
  );
});

/** Public, minimal tracking view (share with trusted contacts). */
routes.get('/track/:reference', async (c) => {
  const reference = c.req.param('reference').toUpperCase();
  const row = await c.env.DB.prepare(
    `SELECT e.id, e.reference, e.status, e.issue_type, e.urgency, e.address, e.created_at, e.updated_at,
            e.assigned_mechanic_user_id, u.full_name AS mechanic_name, m.rating_sum, m.rating_count, m.verification_status
     FROM emergency_requests e
     LEFT JOIN mechanics m ON m.user_id = e.assigned_mechanic_user_id
     LEFT JOIN users u ON u.id = e.assigned_mechanic_user_id
     WHERE e.reference = ? AND e.deleted_at IS NULL`,
  )
    .bind(reference)
    .first<{
      id: string;
      reference: string;
      status: string;
      issue_type: string;
      urgency: string;
      address: string | null;
      created_at: string;
      updated_at: string;
      mechanic_name: string | null;
      rating_sum: number | null;
      rating_count: number | null;
      verification_status: string | null;
    }>();

  if (!row) throw errors.notFound('Request not found.');

  return ok(
    {
      tracking: {
        reference: row.reference,
        status: row.status,
        issueType: row.issue_type,
        urgency: row.urgency,
        address: row.address,
        updatedAt: row.updated_at,
        mechanic: row.mechanic_name
          ? {
              name: row.mechanic_name.split(' ')[0],
              verified: row.verification_status === 'VERIFIED',
              rating: row.rating_count
                ? Math.round(((row.rating_sum ?? 0) / (row.rating_count || 1)) * 10) / 10
                : null,
            }
          : null,
      },
    },
    c.get('requestId'),
  );
});

/** Full detail with timeline (access controlled). */
routes.get('/:id', async (c) => {
  const user = await requireUser(c);
  const request = await requireRequest(c.env, c.req.param('id'));
  // Dispatch-aware: a mechanic holding a pending offer can preview the request.
  await assertDispatchAccess(c.env, user, request);
  const dto = await loadRequestDto(c.env, request.id, { withTimeline: true });
  // The arrival OTP is the driver's to share; the mechanic must type what the
  // customer reads out, so it is never returned to workshop roles.
  if (user.role === 'MECHANIC' || user.role === 'WORKSHOP') {
    dto.arrivalOtp = null;
    dto.arrivalOtpExpiresAt = null;
  }
  return ok({ request: dto }, c.get('requestId'));
});

routes.get('/:id/timeline', async (c) => {
  const user = await requireUser(c);
  const request = await requireRequest(c.env, c.req.param('id'));
  await assertDispatchAccess(c.env, user, request);
  const rows = await c.env.DB.prepare(
    'SELECT * FROM emergency_events WHERE request_id = ? ORDER BY created_at ASC, id ASC LIMIT 500',
  )
    .bind(request.id)
    .all();
  const items = rows.results.map((e) => {
    const r = e as unknown as {
      id: string;
      type: string;
      message: string;
      actor_role: string | null;
      actor_user_id: string | null;
      data_json: string | null;
      created_at: string;
    };
    return {
      id: r.id,
      requestId: request.id,
      type: r.type,
      message: r.message,
      actorRole: r.actor_role,
      actorUserId: r.actor_user_id,
      data: r.data_json ? (JSON.parse(r.data_json) as Record<string, unknown>) : null,
      createdAt: r.created_at,
    };
  });
  return ok({ items }, c.get('requestId'));
});

/** Dispatch attempt history (immutable). */
routes.get('/:id/attempts', async (c) => {
  const user = await requireUser(c);
  const request = await requireRequest(c.env, c.req.param('id'));
  assertRequestAccess(user, request);
  const rows = await c.env.DB.prepare(
    `SELECT d.*, u.full_name AS mechanic_name FROM dispatch_attempts d
     JOIN users u ON u.id = d.mechanic_user_id
     WHERE d.request_id = ? ORDER BY d.attempt_no ASC`,
  )
    .bind(request.id)
    .all();
  const { mapDispatchAttempt } = await import('../lib/mappers');
  return ok({ items: rows.results.map((r) => mapDispatchAttempt(r as never)) }, c.get('requestId'));
});

/** Chat history between driver and assigned mechanic (newest last). */
routes.get('/:id/messages', async (c) => {
  const user = await requireUser(c);
  const request = await requireRequest(c.env, c.req.param('id'));
  assertRequestAccess(user, request);
  const rows = await c.env.DB.prepare(
    `SELECT m.*, u.full_name AS sender_name FROM messages m
     JOIN users u ON u.id = m.sender_user_id
     WHERE m.request_id = ? ORDER BY m.created_at ASC LIMIT 500`,
  )
    .bind(request.id)
    .all<{
      id: string;
      request_id: string;
      sender_user_id: string;
      sender_name: string;
      body: string;
      created_at: string;
      read_at: string | null;
    }>();
  return ok(
    {
      items: rows.results.map((m) => ({
        id: m.id,
        requestId: m.request_id,
        senderUserId: m.sender_user_id,
        senderName: m.sender_name,
        body: m.body,
        createdAt: m.created_at,
        readAt: m.read_at,
      })),
    },
    c.get('requestId'),
  );
});

/** Send a chat message on an active request. */
routes.post('/:id/messages', async (c) => {
  const user = await requireUser(c);
  const request = await requireRequest(c.env, c.req.param('id'));
  assertRequestAccess(user, request);
  if (request.status === 'CANCELLED' || request.status === 'FAILED') {
    throw errors.conflict('CHAT_CLOSED', 'Chat is closed for this request.');
  }
  await enforceRateLimit(c.env, 'chat', user.id, 60, 60, 'You are sending messages too fast.');
  const input = parseInput(sendMessageSchema, await c.req.json().catch(() => ({})));
  const message = {
    id: newId(),
    requestId: request.id,
    senderUserId: user.id,
    senderName: user.fullName,
    body: input.body,
    createdAt: nowIso(),
    readAt: null as string | null,
  };
  await c.env.DB.prepare(
    'INSERT INTO messages (id, request_id, sender_user_id, body, created_at) VALUES (?, ?, ?, ?, ?)',
  )
    .bind(message.id, request.id, user.id, input.body, message.createdAt)
    .run();
  await broadcast(c.env, requestRoom(request.id), {
    type: 'chat.message',
    requestId: request.id,
    payload: { message },
  });
  return ok({ message }, c.get('requestId'), 201);
});

routes.get('/:id/diagnosis', async (c) => {
  const user = await requireUser(c);
  const request = await requireRequest(c.env, c.req.param('id'));
  assertRequestAccess(user, request);
  const diagnosis = await c.env.DB.prepare(
    'SELECT * FROM diagnoses WHERE request_id = ? ORDER BY created_at DESC LIMIT 1',
  )
    .bind(request.id)
    .first<{ id: string; request_id: string; mechanic_user_id: string; notes: string; created_at: string }>();
  if (!diagnosis) return ok({ diagnosis: null }, c.get('requestId'));
  const items = await c.env.DB.prepare('SELECT * FROM diagnosis_items WHERE diagnosis_id = ? ORDER BY sort')
    .bind(diagnosis.id)
    .all<{ id: string; code: string; label: string; result: string; notes: string | null }>();
  return ok(
    {
      diagnosis: {
        id: diagnosis.id,
        requestId: diagnosis.request_id,
        mechanicUserId: diagnosis.mechanic_user_id,
        notes: diagnosis.notes,
        items: items.results.map((i) => ({
          id: i.id,
          code: i.code,
          label: i.label,
          result: i.result as 'OK' | 'FAIL' | 'NA' | 'UNCERTAIN',
          notes: i.notes,
        })),
        createdAt: diagnosis.created_at,
      },
    },
    c.get('requestId'),
  );
});

/** Cancel (driver or operations). Never loses history. */
routes.post('/:id/cancel', async (c) => {
  const user = await requireUser(c);
  const input = parseInput(cancelEmergencySchema, await c.req.json().catch(() => ({})));
  const request = await requireRequest(c.env, c.req.param('id'));
  assertRequestAccess(user, request);
  if (['COMPLETED', 'PAID', 'CANCELLED', 'FAILED'].includes(request.status)) {
    throw errors.conflict('REQUEST_CLOSED', 'This request can no longer be cancelled.');
  }

  await setRequestStatus(c.env, request, 'CANCELLED', {
    actorRole: user.role,
    actorUserId: user.id,
    message: `Request cancelled: ${input.reason}`,
    extra: { cancel_reason: input.reason, cancelled_by: user.id },
  });

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE dispatch_attempts SET status = 'CANCELLED', responded_at = ?, decline_reason = 'REQUEST_CANCELLED', updated_at = ?
       WHERE request_id = ? AND status = 'PENDING'`,
    )
      .bind(nowIso(), nowIso(), request.id),
    c.env.DB.prepare(
      `UPDATE jobs SET status = 'CANCELLED', updated_at = ?, deleted_at = ? WHERE request_id = ? AND deleted_at IS NULL AND status != 'COMPLETED'`,
    )
      .bind(nowIso(), nowIso(), request.id),
    c.env.DB.prepare(
      `UPDATE mechanic_assignments SET status = 'CANCELLED', ended_at = ?, end_reason = 'DRIVER_CANCELLED'
       WHERE request_id = ? AND status = 'ACTIVE'`,
    )
      .bind(nowIso(), request.id),
  ]);

  if (request.assigned_mechanic_user_id) {
    await notify(c.env, {
      userId: request.assigned_mechanic_user_id,
      type: 'REQUEST_CANCELLED',
      title: 'Job cancelled by customer',
      body: `Request ${request.reference} was cancelled: ${input.reason}`,
      data: { requestId: request.id },
      requestId: request.id,
    });
  }

  // Cancellation fee: free inside the grace window; after that a mechanic may
  // already be en route. Only driver-initiated cancellations are charged.
  const config = await getConfig(c.env);
  const elapsedMs = Date.now() - Date.parse(request.created_at);
  const chargeable =
    user.role === 'DRIVER' &&
    elapsedMs > config.cancellation.freeWindowSeconds * 1000 &&
    (Boolean(request.assigned_mechanic_user_id) || request.dispatch_round > 0);
  const cancellationFeeCents = chargeable ? config.cancellation.feeCents : 0;

  if (cancellationFeeCents > 0) {
    await c.env.DB.prepare(
      `UPDATE emergency_requests SET payment_status = 'PENDING', total_amount_cents = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(cancellationFeeCents, nowIso(), request.id)
      .run();
    const fresh = await requireRequest(c.env, request.id);
    await ensureInvoice(c.env, fresh, cancellationFeeCents, { taxCents: 0 });
    await recordEvent(c.env, {
      requestId: request.id,
      type: 'CANCELLATION_FEE_APPLIED',
      message: `Cancellation fee of ₹${Math.round(cancellationFeeCents / 100)} applied`,
      actorRole: user.role,
      actorUserId: user.id,
      data: { amountCents: cancellationFeeCents },
    });
    await notify(c.env, {
      userId: request.driver_user_id,
      type: 'CANCELLATION_FEE_APPLIED',
      title: 'Cancellation fee applied',
      body: `A ₹${Math.round(cancellationFeeCents / 100)} cancellation fee applies because a mechanic was already on the way. You can pay it from your request page.`,
      data: { requestId: request.id, amountCents: cancellationFeeCents },
      requestId: request.id,
    });
  }

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'EMERGENCY_CANCELLED',
    entityType: 'emergency_request',
    entityId: request.id,
    data: { reason: input.reason, cancellationFeeCents },
    requestId: c.get('requestId'),
  });

  return ok(
    {
      request: await loadRequestDto(c.env, request.id, { withTimeline: true }),
      cancellationFeeCents,
    },
    c.get('requestId'),
  );
});

/** Escalate to operations (driver-initiated or automatic). */
routes.post('/:id/escalate', async (c) => {
  const user = await requireUser(c);
  const input = parseInput(escalateEmergencySchema, await c.req.json().catch(() => ({})));
  const request = await requireRequest(c.env, c.req.param('id'));
  assertRequestAccess(user, request);

  const { escalateRequest } = await import('../dispatch/service');
  const updated = await escalateRequest(
    c.env,
    request,
    input.reason ?? 'CUSTOMER_REQUESTED',
    'Our operations team has been alerted and is finding help for you.',
  );
  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'EMERGENCY_ESCALATED',
    entityType: 'emergency_request',
    entityId: request.id,
    requestId: c.get('requestId'),
  });
  return ok({ request: await loadRequestDto(c.env, updated.id, { withTimeline: true }) }, c.get('requestId'));
});

/** Driver shares live location during the emergency. */
routes.post('/:id/location', async (c) => {
  const user = await requireUser(c);
  const input = parseInput(updateEmergencyLocationSchema, await c.req.json().catch(() => ({})));
  const request = await requireRequest(c.env, c.req.param('id'));
  assertRequestAccess(user, request);
  await appendLocation(c.env, {
    requestId: request.id,
    source: user.role === 'MECHANIC' ? 'MECHANIC' : 'DRIVER',
    actorUserId: user.id,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracy: input.accuracy ?? null,
  });
  return ok({ shared: true }, c.get('requestId'));
});

/** Share status with trusted emergency contacts. */
routes.post('/:id/share', async (c) => {
  const user = await requireUser(c);
  const input = parseInput(shareEmergencySchema, await c.req.json().catch(() => ({})));
  const request = await requireRequest(c.env, c.req.param('id'));
  assertRequestAccess(user, request);

  const contacts = await c.env.DB.prepare(
    `SELECT id, name, phone FROM emergency_contacts WHERE user_id = ? AND deleted_at IS NULL`,
  )
    .bind(user.id)
    .all<{ id: string; name: string; phone: string }>();
  const byId = new Map(contacts.results.map((x) => [x.id, x]));
  const selected = input.contactIds.map((id) => byId.get(id)).filter(Boolean) as Array<{
    id: string;
    name: string;
    phone: string;
  }>;
  if (selected.length === 0) throw errors.validation('Select at least one valid contact.');
  await enforceRateLimit(c.env, 'share', user.id, 10, 300, 'You are sharing too often. Please wait.');

  await recordEvent(c.env, {
    requestId: request.id,
    type: 'STATUS_SHARED',
    message: `Status shared with ${selected.length} contact(s)`,
    actorRole: user.role,
    actorUserId: user.id,
    data: { contacts: selected.map((s) => s.name) },
  });

  // Absolute URL so the link is tappable from an SMS on any device.
  const trackUrl = `${new URL(c.req.url).origin}/track?ref=${request.reference}`;
  for (const contact of selected) {
    await c.env.TASKS.send({
      kind: 'notification.dispatch',
      channels: ['SMS'],
      type: 'STATUS_SHARED',
      userId: user.id,
      smsTo: contact.phone,
      title: 'Live assistance status',
      body: `${user.fullName} is receiving roadside help. Track: ${trackUrl}`,
      data: { reference: request.reference, contact: contact.name },
    }).catch(() => undefined);
  }

  return ok({ shared: true, trackUrl, contacts: selected.map((s) => s.name) }, c.get('requestId'));
});

/** Payment creation for a completed request. */
routes.post('/:id/payment', async (c) => {
  const user = await requireUser(c);
  const request = await requireRequest(c.env, c.req.param('id'));
  assertRequestAccess(user, request);
  if (request.driver_user_id !== user.id && user.role !== 'ADMIN') {
    throw errors.forbidden('Only the requesting driver can pay.');
  }
  const feeDue =
    request.status === 'CANCELLED' &&
    request.payment_status === 'PENDING' &&
    (request.total_amount_cents ?? 0) > 0;
  if (!['COMPLETED', 'PAYMENT_PENDING'].includes(request.status) && !feeDue) {
    throw errors.conflict('PAYMENT_NOT_DUE', 'Payment is not due yet.');
  }
  const body = (await c.req.json().catch(() => ({}))) as { method?: string; couponCode?: string };
  const method = body.method ?? 'UPI';
  if (!['CARD', 'UPI', 'NETBANKING', 'WALLET', 'CASH'].includes(method)) {
    throw errors.validation('Unsupported payment method.');
  }
  await enforceRateLimit(
    c.env,
    'payment',
    user.id,
    10,
    60,
    'Too many payment attempts. Please wait a moment and try again.',
  );

  const payment = await createPaymentService(c.env, request, {
    method: method as 'CARD' | 'UPI' | 'NETBANKING' | 'WALLET' | 'CASH',
    actorUserId: user.id,
    couponCode: body.couponCode?.trim() || null,
  });

  const fresh = await requireRequest(c.env, request.id);
  return ok(
    { payment, request: await loadRequestDto(c.env, fresh.id, { withTimeline: false }) },
    c.get('requestId'),
  );
});

/** Previews a coupon's discount without committing it (used before paying). */
routes.post('/:id/coupon/preview', async (c) => {
  const user = await requireUser(c);
  await enforceRateLimit(c.env, 'coupon', user.id, 20, 60, 'Too many coupon checks. Please wait.');
  const request = await requireRequest(c.env, c.req.param('id'));
  assertRequestAccess(user, request);
  if (request.driver_user_id !== user.id && user.role !== 'ADMIN') {
    throw errors.forbidden('Only the requesting driver can apply a coupon.');
  }
  const body = (await c.req.json().catch(() => ({}))) as { code?: string };
  if (!body.code?.trim()) throw errors.validation('Enter a coupon code.');
  const totalCents = request.total_amount_cents ?? (await computeRequestTotal(c.env, request));
  const applied = await applyCoupon(c.env, body.code, totalCents);
  return ok({ coupon: applied, totalCents, discountedTotalCents: totalCents - applied.discountCents }, c.get('requestId'));
});

/** Confirms an online checkout (Razorpay signature verification). */
routes.post('/:id/payment/verify', async (c) => {
  const user = await requireUser(c);
  const request = await requireRequest(c.env, c.req.param('id'));
  assertRequestAccess(user, request);
  if (request.driver_user_id !== user.id && user.role !== 'ADMIN') {
    throw errors.forbidden('Only the requesting driver can verify this payment.');
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    orderId?: string;
    paymentId?: string;
    signature?: string;
  };
  if (!body.orderId || !body.paymentId || !body.signature) {
    throw errors.validation('Missing payment verification details.');
  }

  const result = await verifyPaymentCheckout(c.env, request, {
    orderId: body.orderId,
    paymentId: body.paymentId,
    signature: body.signature,
    actorUserId: user.id,
  });

  const fresh = await requireRequest(c.env, request.id);
  return ok(
    { payment: result, request: await loadRequestDto(c.env, fresh.id, { withTimeline: false }) },
    c.get('requestId'),
  );
});

/**
 * Customer claims a direct-UPI payment was made (optional UPI reference).
 * The payment stays PENDING until ops settles it from the admin console
 * after verifying the bank credit.
 */
routes.post('/:id/payment/confirm', async (c) => {
  const user = await requireUser(c);
  const request = await requireRequest(c.env, c.req.param('id'));
  assertRequestAccess(user, request);
  if (request.driver_user_id !== user.id && user.role !== 'ADMIN') {
    throw errors.forbidden('Only the requesting driver can confirm this payment.');
  }
  await enforceRateLimit(c.env, 'payment_confirm', user.id, 10, 300, 'Too many confirmation attempts.');

  const body = (await c.req.json().catch(() => ({}))) as { utr?: string };
  const utr = body.utr?.trim().slice(0, 40) || null;
  if (utr && !/^[A-Za-z0-9-]{6,40}$/.test(utr)) {
    throw errors.validation('Enter a valid UPI reference (6-40 letters/digits).');
  }

  const payment = await c.env.DB.prepare(
    `SELECT id, status, amount_cents FROM payments
     WHERE request_id = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(request.id)
    .first<{ id: string; status: string; amount_cents: number }>();
  if (!payment) {
    throw errors.conflict('NO_PENDING_PAYMENT', 'There is no pending online payment for this request.');
  }
  if (utr) {
    await c.env.DB.prepare(
      'UPDATE payments SET provider_payment_id = ?, updated_at = ? WHERE id = ? AND provider_payment_id IS NULL',
    ).bind(utr, nowIso(), payment.id).run();
  }

  const reviewers = await c.env.DB.prepare(
    `SELECT id FROM users WHERE role IN ('ADMIN', 'OPERATIONS') AND status = 'ACTIVE' AND deleted_at IS NULL`,
  ).all<{ id: string }>();
  const amount = Math.round(payment.amount_cents / 100);
  for (const reviewer of reviewers.results) {
    await notify(c.env, {
      userId: reviewer.id,
      type: 'PAYMENT_TO_CONFIRM',
      title: 'UPI payment to confirm',
      body: `₹${amount} claimed for ${request.reference}${utr ? ` (ref ${utr})` : ''}. Verify the bank credit and settle.`,
      data: { requestId: request.id, paymentId: payment.id, utr },
      requestId: request.id,
    }).catch(() => undefined);
  }

  await recordEvent(c.env, {
    requestId: request.id,
    type: 'PAYMENT_CLAIMED',
    message: `Customer confirmed UPI payment of ₹${amount}${utr ? ` (ref ${utr})` : ''}`,
    actorRole: user.role,
    actorUserId: user.id,
    data: { paymentId: payment.id, utr },
  });

  return ok({ confirmed: true, status: payment.status }, c.get('requestId'));
});

routes.get('/:id/invoice', async (c) => {
  const user = await requireUser(c);
  const request = await requireRequest(c.env, c.req.param('id'));
  assertRequestAccess(user, request);
  const origin = new URL(c.req.url).origin;
  let invoice = await c.env.DB.prepare(
    'SELECT * FROM invoices WHERE request_id = ? ORDER BY created_at DESC LIMIT 1',
  )
    .bind(request.id)
    .first<Parameters<typeof mapInvoice>[1]>();
  if (invoice) {
    invoice = await ensureInvoicePdf(c.env, invoice);
  }
  const payments = await c.env.DB.prepare(
    'SELECT * FROM payments WHERE request_id = ? ORDER BY created_at DESC',
  )
    .bind(request.id)
    .all<Parameters<typeof mapPayment>[0]>();
  return ok(
    {
      invoice: invoice ? await mapInvoice(c.env, invoice, origin) : null,
      payments: payments.results.map((p) => ({
        id: p.id,
        requestId: p.request_id,
        provider: p.provider,
        status: p.status,
        amountCents: p.amount_cents,
        currency: p.currency,
        method: p.method,
        createdAt: p.created_at,
        paidAt: p.paid_at,
      })),
    },
    c.get('requestId'),
  );
});

export default routes;
