import type { MechanicStatus, Role } from '@rr/types';
import type { Env } from '../env';
import { errors } from './errors';
import { assertMechanicTransition } from './state-machine';
import { nowIso } from './ids';
import { broadcast, OPS_ROOM, mechanicRoom } from './realtime';

export interface MechanicRow {
  user_id: string;
  verification_status: string;
  status: MechanicStatus;
  bio: string | null;
  experience_years: number;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  last_known_latitude: number | null;
  last_known_longitude: number | null;
  last_location_at: string | null;
  service_radius_km: number;
  workshop_id: string | null;
  document_key: string | null;
  rating_sum: number;
  rating_count: number;
  jobs_completed: number;
  jobs_cancelled: number;
  offers_received: number;
  offers_accepted: number;
  earnings_cents: number;
  reliability_score: number;
  full_name?: string;
}

export async function getMechanic(env: Env, userId: string): Promise<MechanicRow | null> {
  const row = await env.DB.prepare(
    `SELECT m.*, u.full_name FROM mechanics m JOIN users u ON u.id = m.user_id WHERE m.user_id = ?`,
  )
    .bind(userId)
    .first<MechanicRow>();
  return row ?? null;
}

export async function requireMechanic(env: Env, userId: string): Promise<MechanicRow> {
  const row = await getMechanic(env, userId);
  if (!row) throw errors.notFound('Mechanic profile not found.');
  return row;
}

export interface SetMechanicStatusOptions {
  actorRole?: Role | 'SYSTEM';
  actorUserId?: string | null;
  skipValidation?: boolean;
  reason?: string;
}

/**
 * Server-authoritative mechanic availability state machine.
 * A mechanic that is not AVAILABLE never receives normal dispatch offers.
 */
export async function setMechanicStatus(
  env: Env,
  userId: string,
  to: MechanicStatus,
  opts: SetMechanicStatusOptions = {},
): Promise<MechanicRow> {
  const current = await requireMechanic(env, userId);
  if (current.status === to) return current;
  if (!opts.skipValidation) assertMechanicTransition(current.status, to);

  await env.DB.prepare('UPDATE mechanics SET status = ?, updated_at = ? WHERE user_id = ?')
    .bind(to, nowIso(), userId)
    .run();

  const updated = { ...current, status: to };
  await broadcast(env, mechanicRoom(userId), {
    type: 'request.state',
    payload: { mechanicStatus: to, userId },
  });
  await broadcast(env, OPS_ROOM, {
    type: 'presence',
    payload: { userId, role: 'MECHANIC', status: to, at: nowIso() },
  });
  if (opts.reason && opts.actorUserId) {
    await recordEventToOps(env, userId, to, opts);
  }
  return updated;
}

async function recordEventToOps(
  env: Env,
  userId: string,
  to: MechanicStatus,
  opts: SetMechanicStatusOptions,
): Promise<void> {
  // Mechanic status changes are tracked in audit logs (operations timeline).
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_user_id, actor_role, action, entity_type, entity_id, data_json, request_id, created_at)
     VALUES (?, ?, ?, 'MECHANIC_STATUS_CHANGED', 'mechanic', ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      opts.actorUserId ?? userId,
      opts.actorRole ?? 'MECHANIC',
      userId,
      JSON.stringify({ status: to, reason: opts.reason ?? null }),
      null,
      nowIso(),
    )
    .run();
}

export async function recordMechanicLocation(
  env: Env,
  userId: string,
  latitude: number,
  longitude: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE mechanics SET last_known_latitude = ?, last_known_longitude = ?, last_location_at = ?, updated_at = ?
     WHERE user_id = ?`,
  )
    .bind(latitude, longitude, nowIso(), nowIso(), userId).run();
}

export async function activeJobCount(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM jobs
     WHERE mechanic_user_id = ? AND deleted_at IS NULL
       AND status IN ('ACCEPTED','EN_ROUTE','ARRIVED','VERIFIED','DIAGNOSING','QUOTE_PENDING','QUOTE_APPROVED','REPAIRING')`,
  )
    .bind(userId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function isAvailableForWork(env: Env, userId: string): Promise<boolean> {
  const mechanic = await getMechanic(env, userId);
  if (!mechanic) return false;
  if (mechanic.verification_status !== 'VERIFIED') return false;
  if (mechanic.status !== 'AVAILABLE') return false;
  const active = await activeJobCount(env, userId);
  return active === 0;
}
