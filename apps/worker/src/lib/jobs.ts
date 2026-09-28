import type { JobStatus, MechanicStatus, RequestStatus, Role } from '@rr/types';
import type { Env } from '../env';
import { errors } from './errors';
import { assertJobTransition, assertRequestTransition } from './state-machine';
import { nowIso } from './ids';
import { recordEvent } from './events';
import { getRequest, setRequestStatus, type RequestRow } from './requests';
import { setMechanicStatus } from './mechanics';
import { broadcastRequestState } from './requests';

export interface JobRowFull {
  id: string;
  request_id: string;
  mechanic_user_id: string;
  status: JobStatus;
  otp_code_hash: string | null;
  otp_expires_at: string | null;
  otp_attempts: number;
  otp_verified_at: string | null;
  earnings_cents: number;
  accepted_at: string;
  en_route_at: string | null;
  arrived_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  stall_warned_at: string | null;
  created_at: string;
  updated_at: string;
  mechanic_name?: string;
}

export async function getJob(env: Env, jobId: string): Promise<JobRowFull | null> {
  const row = await env.DB.prepare(
    `SELECT j.*, u.full_name AS mechanic_name FROM jobs j
     JOIN users u ON u.id = j.mechanic_user_id
     WHERE j.id = ? AND j.deleted_at IS NULL`,
  )
    .bind(jobId)
    .first<JobRowFull>();
  return row ?? null;
}

export async function requireJob(env: Env, jobId: string): Promise<JobRowFull> {
  const row = await getJob(env, jobId);
  if (!row) throw errors.notFound('Job not found.');
  return row;
}

export async function getActiveJobByRequest(env: Env, requestId: string): Promise<JobRowFull | null> {
  const row = await env.DB.prepare(
    `SELECT j.*, u.full_name AS mechanic_name FROM jobs j
     JOIN users u ON u.id = j.mechanic_user_id
     WHERE j.request_id = ? AND j.deleted_at IS NULL
     ORDER BY j.created_at DESC LIMIT 1`,
  )
    .bind(requestId)
    .first<JobRowFull>();
  return row ?? null;
}

export function assertJobAccess(
  user: { id: string; role: Role },
  job: JobRowFull,
  request: RequestRow,
): void {
  const isMechanic = job.mechanic_user_id === user.id;
  const isDriver = request.driver_user_id === user.id;
  const isStaff = user.role === 'ADMIN' || user.role === 'OPERATIONS';
  if (!isMechanic && !isDriver && !isStaff) {
    throw errors.forbidden('You do not have access to this job.');
  }
}

const JOB_TO_REQUEST_STATUS: Partial<Record<JobStatus, RequestStatus>> = {
  EN_ROUTE: 'MECHANIC_EN_ROUTE',
  ARRIVED: 'ARRIVED',
  DIAGNOSING: 'DIAGNOSING',
  QUOTE_PENDING: 'QUOTE_PENDING',
  QUOTE_APPROVED: 'QUOTE_APPROVED',
  REPAIRING: 'REPAIRING',
  COMPLETED: 'COMPLETED',
};

const JOB_TO_MECHANIC_STATUS: Partial<Record<JobStatus, MechanicStatus>> = {
  EN_ROUTE: 'EN_ROUTE',
  ARRIVED: 'ON_JOB',
  VERIFIED: 'ON_JOB',
  DIAGNOSING: 'ON_JOB',
  QUOTE_PENDING: 'ON_JOB',
  QUOTE_APPROVED: 'ON_JOB',
  REPAIRING: 'ON_JOB',
  COMPLETED: 'AVAILABLE',
};

const TIMESTAMP_COLUMN: Partial<Record<JobStatus, string>> = {
  EN_ROUTE: 'en_route_at',
  ARRIVED: 'arrived_at',
  REPAIRING: 'started_at',
  COMPLETED: 'completed_at',
};

const JOB_MESSAGES: Partial<Record<JobStatus, string>> = {
  EN_ROUTE: 'Mechanic is on the way',
  ARRIVED: 'Mechanic has arrived at your location',
  VERIFIED: 'Arrival verified with OTP',
  DIAGNOSING: 'Diagnosis in progress',
  QUOTE_PENDING: 'Quote sent for approval',
  QUOTE_APPROVED: 'Quote approved — starting repair',
  REPAIRING: 'Repair in progress',
  COMPLETED: 'Service completed',
};

export interface TransitionJobOptions {
  actorRole?: Role | 'SYSTEM';
  actorUserId?: string;
  note?: string;
  latitude?: number;
  longitude?: number;
  extra?: Record<string, string | number | null>;
  /** Skip the corresponding request status update (used for approvals). */
  skipRequestUpdate?: boolean;
  message?: string;
}

/**
 * Server-authoritative job transition: validates the state machine, persists
 * atomically, writes history, updates request + mechanic status, appends the
 * emergency timeline and broadcasts to everyone watching.
 */
export async function transitionJob(
  env: Env,
  job: JobRowFull,
  to: JobStatus,
  opts: TransitionJobOptions = {},
): Promise<JobRowFull> {
  assertJobTransition(job.status, to);
  const now = nowIso();

  const sets = ['status = ?', 'updated_at = ?'];
  const binds: Array<string | number | null> = [to, now];
  const tsColumn = TIMESTAMP_COLUMN[to];
  if (tsColumn && !job[tsColumn as keyof JobRowFull]) {
    sets.push(`${tsColumn} = ?`);
    binds.push(now);
  }
  for (const [key, value] of Object.entries(opts.extra ?? {})) {
    sets.push(`${key} = ?`);
    binds.push(value);
  }
  binds.push(job.id, job.status);

  const result = await env.DB.prepare(
    `UPDATE jobs SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
  )
    .bind(...binds)
    .run();

  if (result.meta.changes === 0) {
    const fresh = await getJob(env, job.id);
    if (fresh && fresh.status === to) return fresh;
    throw errors.conflict(
      'JOB_STATUS_CONFLICT',
      `Job is currently ${fresh?.status ?? 'unknown'}; cannot move to ${to}.`,
    );
  }

  await env.DB.prepare(
    `INSERT INTO job_status_history (id, job_id, from_status, to_status, actor_user_id, note, latitude, longitude, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      job.id,
      job.status,
      to,
      opts.actorUserId ?? null,
      opts.note ?? null,
      opts.latitude ?? null,
      opts.longitude ?? null,
      now,
    )
    .run();

  const requestTarget = JOB_TO_REQUEST_STATUS[to];
  if (requestTarget && !opts.skipRequestUpdate) {
    const request = await getRequest(env, job.request_id);
    if (request && request.status !== requestTarget) {
      try {
        assertRequestTransition(request.status, requestTarget);
        await setRequestStatus(env, request, requestTarget, {
          actorRole: opts.actorRole ?? 'MECHANIC',
          actorUserId: opts.actorUserId ?? job.mechanic_user_id,
          message: opts.message ?? JOB_MESSAGES[to] ?? `Job status: ${to}`,
          data: { jobId: job.id },
        });
      } catch {
        // Request may be in a state where this is not applicable (e.g. already
        // escalated). Job history still records the truth.
      }
    }
  }

  const mechanicTarget = JOB_TO_MECHANIC_STATUS[to];
  if (mechanicTarget) {
    const mechanic = await env.DB.prepare('SELECT status, verification_status FROM mechanics WHERE user_id = ?')
      .bind(job.mechanic_user_id)
      .first<{ status: MechanicStatus; verification_status: string }>();
    if (
      mechanic &&
      mechanic.verification_status === 'VERIFIED' &&
      mechanic.status !== 'SUSPENDED' &&
      mechanic.status !== mechanicTarget
    ) {
      await setMechanicStatus(env, job.mechanic_user_id, mechanicTarget, {
        actorRole: opts.actorRole ?? 'MECHANIC',
        actorUserId: opts.actorUserId ?? job.mechanic_user_id,
      }).catch(() => undefined);
    }
  }

  await recordEvent(env, {
    requestId: job.request_id,
    type: `JOB_${to}`,
    message: opts.message ?? JOB_MESSAGES[to] ?? `Job status: ${to}`,
    actorRole: opts.actorRole ?? 'MECHANIC',
    actorUserId: opts.actorUserId ?? job.mechanic_user_id,
    data: { jobId: job.id, ...(opts.note ? { note: opts.note } : {}) },
  });

  const request = await getRequest(env, job.request_id);
  if (request) await broadcastRequestState(env, request);

  return (await getJob(env, job.id)) ?? job;
}
