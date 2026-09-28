import type {
  AccidentModeDto,
  EmergencyRequestDto,
  JobDto,
  MechanicPublicDto,
  QuoteDto,
  RequestStatus,
  Role,
} from '@rr/types';
import type { Env } from '../env';
import { AppError, errors } from './errors';
import { assertRequestTransition } from './state-machine';
import { nowIso } from './ids';
import { recordEvent } from './events';
import { broadcast, requestRoom, OPS_ROOM } from './realtime';
import { mapJobRow, mapQuoteRow, mapPublicMechanic } from './mappers';

export interface RequestRow {
  id: string;
  reference: string;
  driver_user_id: string;
  vehicle_id: string | null;
  channel: string;
  category_code: string;
  issue_type: string;
  description: string | null;
  urgency: string;
  status: RequestStatus;
  accident_json: string | null;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  address: string | null;
  required_skills: string;
  required_equipment: string;
  assigned_mechanic_user_id: string | null;
  workshop_id: string | null;
  towing_partner_id: string | null;
  dispatch_radius_km: number;
  dispatch_round: number;
  escalation_level: number;
  dispatch_started_at: string | null;
  assigned_at: string | null;
  completed_at: string | null;
  payment_status: string | null;
  total_amount_cents: number | null;
  rating: number | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  created_by_role: string;
  created_at: string;
  updated_at: string;
  driver_name?: string;
  driver_phone?: string | null;
  vehicle_label?: string | null;
  vehicle_registration?: string | null;
}

const BASE_SELECT = `
  SELECT e.*,
         u.full_name AS driver_name,
         u.phone     AS driver_phone,
         (v.make || ' ' || v.model) AS vehicle_label,
         v.registration_number      AS vehicle_registration
  FROM emergency_requests e
  JOIN users u ON u.id = e.driver_user_id
  LEFT JOIN vehicles v ON v.id = e.vehicle_id
`;

export async function getRequest(env: Env, id: string): Promise<RequestRow | null> {
  const row = await env.DB.prepare(`${BASE_SELECT} WHERE e.id = ?`).bind(id).first<RequestRow>();
  return row ?? null;
}

export async function requireRequest(env: Env, id: string): Promise<RequestRow> {
  const row = await getRequest(env, id);
  if (!row) throw errors.notFound('Emergency request not found.');
  return row;
}

export async function getRequestByReference(env: Env, reference: string): Promise<RequestRow | null> {
  const row = await env.DB.prepare(`${BASE_SELECT} WHERE e.reference = ?`).bind(reference).first<RequestRow>();
  return row ?? null;
}

export interface SetStatusOptions {
  actorRole?: Role | 'SYSTEM';
  actorUserId?: string | null;
  message?: string;
  data?: Record<string, unknown> | null;
  /** Extra columns to update in the same statement. */
  extra?: Record<string, string | number | null>;
  /** Skip transition validation (only for internal recovery paths). */
  skipValidation?: boolean;
}

const STATUS_MESSAGES: Partial<Record<RequestStatus, string>> = {
  SEARCHING: 'Looking for a nearby mechanic…',
  DISPATCHING: 'Dispatching to nearby mechanics…',
  ASSIGNED: 'A mechanic accepted your request',
  MECHANIC_EN_ROUTE: 'Mechanic is on the way',
  MECHANIC_NEARBY: 'Mechanic is nearby',
  ARRIVED: 'Mechanic has arrived',
  DIAGNOSING: 'Diagnosis in progress',
  QUOTE_PENDING: 'Quote sent for your approval',
  QUOTE_APPROVED: 'Quote approved — repair starting',
  REPAIRING: 'Repair in progress',
  COMPLETED: 'Service completed',
  PAYMENT_PENDING: 'Payment pending',
  PAID: 'Payment completed',
  CANCELLED: 'Request cancelled',
  ESCALATED: 'Escalated to operations',
  TOWING_REQUIRED: 'Towing required',
  FAILED: 'Request failed',
  CREATED: 'Request created',
};

/**
 * Server-authoritative status transition. Validates against the state machine,
 * performs a compare-and-swap update, appends a timeline event and broadcasts.
 */
export async function setRequestStatus(
  env: Env,
  request: RequestRow,
  to: RequestStatus,
  opts: SetStatusOptions = {},
): Promise<RequestRow> {
  if (!opts.skipValidation) assertRequestTransition(request.status, to);

  const extraKeys = Object.keys(opts.extra ?? {});
  const sets = ['status = ?', 'updated_at = ?'];
  const binds: Array<string | number | null> = [to, nowIso()];
  for (const key of extraKeys) {
    sets.push(`${key} = ?`);
    binds.push((opts.extra as Record<string, string | number | null>)[key] ?? null);
  }
  binds.push(request.id, request.status);

  const result = await env.DB.prepare(
    `UPDATE emergency_requests SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
  )
    .bind(...binds)
    .run();

  if (result.meta.changes === 0) {
    const fresh = await getRequest(env, request.id);
    if (fresh && fresh.status === to) return fresh; // idempotent
    throw errors.conflict(
      'STATUS_CONFLICT',
      `Request is currently ${fresh?.status ?? 'unknown'}; cannot move to ${to}.`,
    );
  }

  const updated: RequestRow = { ...request, status: to, updated_at: nowIso(), ...(opts.extra ?? {}) };
  await recordEvent(env, {
    requestId: request.id,
    type: `STATUS_${to}`,
    message: opts.message ?? STATUS_MESSAGES[to] ?? `Status changed to ${to}`,
    actorRole: opts.actorRole ?? 'SYSTEM',
    actorUserId: opts.actorUserId ?? null,
    data: opts.data ?? null,
  });
  await broadcastRequestState(env, updated);
  return updated;
}

export async function broadcastRequestState(env: Env, request: RequestRow): Promise<void> {
  const payload = await loadRequestDto(env, request.id, { withTimeline: false });
  // Never push the arrival OTP over the shared room (mechanics subscribe too);
  // drivers pick it up from their own GET /emergencies/:id poll.
  const safe = { ...payload, arrivalOtp: undefined, arrivalOtpExpiresAt: undefined };
  await broadcast(env, requestRoom(request.id), { type: 'request.state', requestId: request.id, payload: safe as unknown as Record<string, unknown> });
  await broadcast(env, OPS_ROOM, { type: 'request.state', requestId: request.id, payload: safe as unknown as Record<string, unknown> });
}

export async function appendLocation(
  env: Env,
  input: {
    requestId: string;
    source: 'DRIVER' | 'MECHANIC' | 'OPS';
    actorUserId?: string | null;
    latitude: number;
    longitude: number;
    accuracy?: number | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO emergency_locations (id, request_id, source, actor_user_id, latitude, longitude, accuracy, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      input.requestId,
      input.source,
      input.actorUserId ?? null,
      input.latitude,
      input.longitude,
      input.accuracy ?? null,
      nowIso(),
    )
    .run();
  await broadcast(env, requestRoom(input.requestId), {
    type: input.source === 'MECHANIC' ? 'mechanic.location' : 'request.location',
    requestId: input.requestId,
    payload: {
      source: input.source,
      latitude: input.latitude,
      longitude: input.longitude,
      accuracy: input.accuracy ?? null,
      at: nowIso(),
    },
  });
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function mapRequestRow(
  row: RequestRow,
  extras: {
    assignedMechanic?: MechanicPublicDto | null;
    job?: JobDto | null;
    quote?: QuoteDto | null;
    timeline?: unknown[];
  } = {},
): EmergencyRequestDto {
  return {
    id: row.id,
    reference: row.reference,
    driverUserId: row.driver_user_id,
    driverName: row.driver_name ?? '',
    driverPhone: row.driver_phone ?? null,
    vehicleId: row.vehicle_id,
    vehicleLabel: row.vehicle_label ?? null,
    vehicleRegistration: row.vehicle_registration ?? null,
    issueType: row.issue_type,
    categoryCode: row.category_code,
    description: row.description,
    urgency: row.urgency as EmergencyRequestDto['urgency'],
    status: row.status,
    channel: row.channel as EmergencyRequestDto['channel'],
    accidentMode: parseJson<AccidentModeDto>(row.accident_json),
    latitude: row.latitude,
    longitude: row.longitude,
    address: row.address,
    assignedMechanicUserId: row.assigned_mechanic_user_id,
    assignedMechanic: extras.assignedMechanic ?? null,
    job: extras.job ?? null,
    quote: extras.quote ?? null,
    paymentStatus: (row.payment_status as EmergencyRequestDto['paymentStatus']) ?? null,
    totalAmountCents: row.total_amount_cents,
    escalationLevel: row.escalation_level,
    dispatchRadiusKm: row.dispatch_radius_km,
    rating: row.rating,
    cancelReason: row.cancel_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface LoadOptions {
  withTimeline?: boolean;
}

export async function loadRequestDto(
  env: Env,
  requestId: string,
  opts: LoadOptions = {},
): Promise<EmergencyRequestDto> {
  const row = await requireRequest(env, requestId);

  let assignedMechanic: MechanicPublicDto | null = null;
  if (row.assigned_mechanic_user_id) {
    assignedMechanic = await mapPublicMechanic(env, row.assigned_mechanic_user_id, row.latitude, row.longitude);
  }

  const jobRow = await env.DB.prepare(
    `SELECT j.*, u.full_name AS mechanic_name FROM jobs j
     JOIN users u ON u.id = j.mechanic_user_id
     WHERE j.request_id = ? AND j.deleted_at IS NULL
     ORDER BY j.created_at DESC LIMIT 1`,
  )
    .bind(requestId)
    .first<Parameters<typeof mapJobRow>[1]>();

  const job = jobRow ? await mapJobRow(env, jobRow) : null;

  const quoteRow = await env.DB.prepare(
    `SELECT * FROM quotes WHERE request_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(requestId)
    .first<Parameters<typeof mapQuoteRow>[1]>();

  const quote = quoteRow ? await mapQuoteRow(env, quoteRow) : null;

  const dto = mapRequestRow(row, { assignedMechanic, job, quote });

  // Job-start OTP for the driver: only while pending (hash set, not verified,
  // not expired). The plaintext lives in the driver's MECHANIC_ARRIVED
  // notification; mechanics never read this field (stripped at the route).
  if (
    jobRow &&
    jobRow.otp_code_hash &&
    !jobRow.otp_verified_at &&
    jobRow.otp_expires_at &&
    new Date(jobRow.otp_expires_at).getTime() > Date.now()
  ) {
    const notes = await env.DB.prepare(
      `SELECT data_json FROM notifications
       WHERE user_id = ? AND type = 'MECHANIC_ARRIVED' AND data_json LIKE ?
       ORDER BY created_at DESC LIMIT 5`,
    )
      .bind(row.driver_user_id, `%${requestId}%`)
      .all();
    for (const n of notes.results) {
      const record = n as unknown as { data_json: string | null };
      const data = parseJson<{ requestId?: string; otp?: string } | null>(record.data_json);
      if (data?.otp && data.requestId === requestId) {
        (dto as EmergencyRequestDto).arrivalOtp = data.otp;
        (dto as EmergencyRequestDto).arrivalOtpExpiresAt = jobRow.otp_expires_at;
        break;
      }
    }
  }

  if (opts.withTimeline) {
    const events = await env.DB.prepare(
      'SELECT * FROM emergency_events WHERE request_id = ? ORDER BY created_at ASC, id ASC LIMIT 500',
    )
      .bind(requestId)
      .all();
    (dto as EmergencyRequestDto & { timeline: unknown[] }).timeline = events.results.map((e) => {
      const record = e as unknown as {
        id: string;
        type: string;
        message: string;
        actor_role: string | null;
        actor_user_id: string | null;
        data_json: string | null;
        created_at: string;
      };
      return {
        id: record.id,
        requestId,
        type: record.type,
        message: record.message,
        actorRole: record.actor_role as Role | null,
        actorUserId: record.actor_user_id,
        data: parseJson<Record<string, unknown>>(record.data_json),
        createdAt: record.created_at,
      };
    });
  }

  return dto;
}

export function assertRequestAccess(user: { id: string; role: Role }, request: RequestRow): void {
  if (request.driver_user_id === user.id) return;
  if (user.role === 'ADMIN' || user.role === 'OPERATIONS') return;
  if (request.assigned_mechanic_user_id && request.assigned_mechanic_user_id === user.id) return;
  throw errors.forbidden('You do not have access to this emergency request.');
}

/**
 * Like assertRequestAccess, but also allows a mechanic who holds a PENDING
 * dispatch offer for this request to act on it (accept / decline / view).
 */
export async function assertDispatchAccess(
  env: Env,
  user: { id: string; role: Role },
  request: RequestRow,
): Promise<void> {
  if (request.driver_user_id === user.id) return;
  if (user.role === 'ADMIN' || user.role === 'OPERATIONS') return;
  if (request.assigned_mechanic_user_id === user.id) return;
  if (user.role === 'MECHANIC' || user.role === 'WORKSHOP') {
    const attempt = await env.DB.prepare(
      `SELECT id FROM dispatch_attempts
       WHERE request_id = ? AND mechanic_user_id = ? AND status = 'PENDING' LIMIT 1`,
    )
      .bind(request.id, user.id)
      .first<{ id: string }>();
    if (attempt) return;
  }
  throw errors.forbidden('You do not have access to this emergency request.');
}

export function assertDriverOwns(user: { id: string; role: Role }, request: RequestRow): void {
  if (request.driver_user_id !== user.id) {
    if (user.role === 'ADMIN' || user.role === 'OPERATIONS') return;
    throw errors.forbidden('You do not have access to this emergency request.');
  }
}

export function ensureNotTerminal(request: RequestRow): void {
  if (request.status === 'CANCELLED' || request.status === 'FAILED' || request.status === 'PAID') {
    throw new AppError('REQUEST_CLOSED', 'This request is already closed.', 409, {
      status: request.status,
    });
  }
}
