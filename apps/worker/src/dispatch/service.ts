import { ISSUE_REQUIRED_EQUIPMENT, ISSUE_REQUIRED_SKILLS, ISSUE_TYPES, type IssueType } from '@rr/config';
import type { Role, Urgency } from '@rr/types';
import type { Env } from '../env';
import { errors } from '../lib/errors';
import { getConfig } from '../lib/config';
import { newId, nowIso, isoIn } from '../lib/ids';
import { logger } from '../lib/logger';
import { recordEvent } from '../lib/events';
import {
  broadcastRequestState,
  getRequest,
  requireRequest,
  setRequestStatus,
  type RequestRow,
} from '../lib/requests';
import { notify } from '../lib/notify';
import { clearRoomAlarm, requestRoom, setRoomAlarm } from '../lib/realtime';
import { distanceKm, roundKm } from '../lib/geo';
import { computeServiceFee } from '../lib/pricing';
import { setMechanicStatus } from '../lib/mechanics';
import {
  acceptanceRate,
  cancellationRate,
  rankCandidates,
  type CandidateSignal,
  type ScoredCandidate,
} from './engine';

/**
 * Dispatch service — the NEVER-STRANDED workflow.
 *
 * Every request keeps an immutable history of dispatch attempts. When a
 * mechanic declines, times out, cancels or stalls, the engine automatically
 * offers the SAME request to the next candidate, expands the radius, and
 * finally escalates to operations. The customer never has to create a new
 * request.
 */

export interface DispatchInput {
  requestId: string;
  latitude: number;
  longitude: number;
  issueType: string;
  urgency: Urgency;
  vehicleType: string | null;
  vehicleMake: string | null;
  vehicleModel: string | null;
  requiredSkills: string[];
  requiredEquipment: string[];
}

export function requiredSkillsFor(issueType: string): string[] {
  if ((ISSUE_TYPES as readonly string[]).includes(issueType)) {
    return [...ISSUE_REQUIRED_SKILLS[issueType as IssueType]];
  }
  return [...ISSUE_REQUIRED_SKILLS.GENERAL_BREAKDOWN];
}

export function requiredEquipmentFor(issueType: string): string[] {
  if ((ISSUE_TYPES as readonly string[]).includes(issueType)) {
    return [...ISSUE_REQUIRED_EQUIPMENT[issueType as IssueType]];
  }
  return [...ISSUE_REQUIRED_EQUIPMENT.GENERAL_BREAKDOWN];
}

export async function buildDispatchInput(env: Env, request: RequestRow): Promise<DispatchInput> {
  let vehicleType: string | null = null;
  let vehicleMake: string | null = null;
  let vehicleModel: string | null = null;
  if (request.vehicle_id) {
    const v = await env.DB.prepare(
      'SELECT vehicle_type, make, model FROM vehicles WHERE id = ?',
    )
      .bind(request.vehicle_id)
      .first<{ vehicle_type: string; make: string; model: string }>();
    if (v) {
      vehicleType = v.vehicle_type;
      vehicleMake = v.make;
      vehicleModel = v.model;
    }
  }
  return {
    requestId: request.id,
    latitude: request.latitude,
    longitude: request.longitude,
    issueType: request.issue_type,
    urgency: request.urgency as Urgency,
    vehicleType,
    vehicleMake,
    vehicleModel,
    requiredSkills: requiredSkillsFor(request.issue_type),
    requiredEquipment: requiredEquipmentFor(request.issue_type),
  };
}

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

interface MechanicCandidateRow {
  user_id: string;
  full_name: string;
  status: string;
  verification_status: string;
  latitude: number;
  longitude: number;
  service_radius_km: number;
  reliability_score: number;
  rating_sum: number;
  rating_count: number;
  jobs_completed: number;
  jobs_cancelled: number;
  offers_received: number;
  offers_accepted: number;
  workshop_id: string | null;
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(',');
}

export async function findCandidates(
  env: Env,
  input: DispatchInput,
  opts: { radiusKm: number; excludeMechanicIds?: string[] },
): Promise<ScoredCandidate[]> {
  const cfg = await getConfig(env);
  const rows = await env.DB.prepare(
    `SELECT m.user_id, u.full_name, m.status, m.verification_status, m.latitude, m.longitude,
            m.service_radius_km, m.reliability_score, m.rating_sum, m.rating_count,
            m.jobs_completed, m.jobs_cancelled, m.offers_received, m.offers_accepted, m.workshop_id
     FROM mechanics m
     JOIN users u ON u.id = m.user_id
     WHERE m.deleted_at IS NULL AND u.deleted_at IS NULL AND u.status = 'ACTIVE'
       AND m.verification_status = 'VERIFIED'
       AND m.status = 'AVAILABLE'
       AND m.latitude IS NOT NULL AND m.longitude IS NOT NULL`,
  ).all<MechanicCandidateRow>();

  const near = rows.results.filter((r) => {
    const d = distanceKm(input.latitude, input.longitude, r.latitude, r.longitude);
    return d <= opts.radiusKm && d <= r.service_radius_km;
  });
  if (near.length === 0) return [];

  const ids = near.map((r) => r.user_id);
  const ph = placeholders(ids.length);

  const [skillRows, equipmentRows, vehicleTypeRows, jobRows, availabilityRows] = await Promise.all([
    env.DB.prepare(
      `SELECT mechanic_user_id, skill FROM mechanic_skills WHERE mechanic_user_id IN (${ph})`,
    )
      .bind(...ids)
      .all<{ mechanic_user_id: string; skill: string }>(),
    env.DB.prepare(
      `SELECT mechanic_user_id, equipment FROM mechanic_equipment WHERE mechanic_user_id IN (${ph})`,
    )
      .bind(...ids)
      .all<{ mechanic_user_id: string; equipment: string }>(),
    env.DB.prepare(
      `SELECT mechanic_user_id, vehicle_type FROM mechanic_vehicle_types WHERE mechanic_user_id IN (${ph})`,
    )
      .bind(...ids)
      .all<{ mechanic_user_id: string; vehicle_type: string }>(),
    env.DB.prepare(
      `SELECT mechanic_user_id, COUNT(*) AS c FROM jobs
       WHERE mechanic_user_id IN (${ph}) AND deleted_at IS NULL
         AND status IN ('ACCEPTED','EN_ROUTE','ARRIVED','VERIFIED','DIAGNOSING','QUOTE_PENDING','QUOTE_APPROVED','REPAIRING')
       GROUP BY mechanic_user_id`,
    )
      .bind(...ids)
      .all<{ mechanic_user_id: string; c: number }>(),
    env.DB.prepare(
      `SELECT mechanic_user_id, day_of_week, start_minute, end_minute FROM mechanic_availability
       WHERE mechanic_user_id IN (${ph})`,
    )
      .bind(...ids)
      .all<{ mechanic_user_id: string; day_of_week: number; start_minute: number; end_minute: number }>(),
  ]);

  const skillsMap = new Map<string, string[]>();
  for (const s of skillRows.results) {
    const list = skillsMap.get(s.mechanic_user_id) ?? [];
    list.push(s.skill);
    skillsMap.set(s.mechanic_user_id, list);
  }
  const equipmentMap = new Map<string, string[]>();
  for (const e of equipmentRows.results) {
    const list = equipmentMap.get(e.mechanic_user_id) ?? [];
    list.push(e.equipment);
    equipmentMap.set(e.mechanic_user_id, list);
  }
  const vehicleTypeMap = new Map<string, string[]>();
  for (const v of vehicleTypeRows.results) {
    const list = vehicleTypeMap.get(v.mechanic_user_id) ?? [];
    list.push(v.vehicle_type);
    vehicleTypeMap.set(v.mechanic_user_id, list);
  }
  const activeJobsMap = new Map<string, number>();
  for (const j of jobRows.results) activeJobsMap.set(j.mechanic_user_id, j.c);

  // Availability windows: if a mechanic declared windows, at least one must match now.
  const now = new Date();
  const day = now.getDay();
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  const windowsByMechanic = new Map<string, Array<{ dow: number; start: number; end: number }>>();
  for (const a of availabilityRows.results) {
    const list = windowsByMechanic.get(a.mechanic_user_id) ?? [];
    list.push({ dow: a.day_of_week, start: a.start_minute, end: a.end_minute });
    windowsByMechanic.set(a.mechanic_user_id, list);
  }

  const signals: CandidateSignal[] = [];
  for (const r of near) {
    const windows = windowsByMechanic.get(r.user_id);
    if (windows && windows.length > 0) {
      const inWindow = windows.some((w) => w.dow === day && minuteOfDay >= w.start && minuteOfDay < w.end);
      if (!inWindow) continue;
    }
    const d = distanceKm(input.latitude, input.longitude, r.latitude, r.longitude);
    signals.push({
      userId: r.user_id,
      fullName: r.full_name,
      latitude: r.latitude,
      longitude: r.longitude,
      serviceRadiusKm: r.service_radius_km,
      status: r.status,
      verificationStatus: r.verification_status,
      distanceKm: roundKm(d),
      skills: skillsMap.get(r.user_id) ?? [],
      equipment: equipmentMap.get(r.user_id) ?? [],
      vehicleTypes: vehicleTypeMap.get(r.user_id) ?? [],
      reliabilityScore: r.reliability_score,
      acceptanceRate: acceptanceRate(r.offers_accepted, r.offers_received),
      cancellationRate: cancellationRate(r.jobs_cancelled, r.jobs_completed),
      activeJobs: activeJobsMap.get(r.user_id) ?? 0,
      ratingAverage: r.rating_count > 0 ? r.rating_sum / r.rating_count : 0,
      ratingCount: r.rating_count,
      workshopAffiliated: Boolean(r.workshop_id),
    });
  }

  const ranked = rankCandidates(signals, {
    requiredSkills: input.requiredSkills,
    requiredEquipment: input.requiredEquipment,
    vehicleType: input.vehicleType,
    radiusKm: opts.radiusKm,
    excludeMechanicIds: opts.excludeMechanicIds ?? [],
    maxActiveJobs: cfg.dispatch.maxActiveJobsPerMechanic,
  });
  return ranked.candidates;
}

// ---------------------------------------------------------------------------
// Radius / round helpers
// ---------------------------------------------------------------------------

export function radiusForRound(round: number, cfg: Awaited<ReturnType<typeof getConfig>>): number {
  const steps = cfg.dispatch.radiusStepsKm as readonly number[];
  if (round < steps.length) return steps[round];
  const last = steps[steps.length - 1] ?? 5;
  const extra = round - steps.length + 1;
  return Math.min(200, Math.round(last * Math.pow(cfg.dispatch.radiusExpansionFactor, extra)));
}

// ---------------------------------------------------------------------------
// Offering jobs
// ---------------------------------------------------------------------------

async function attemptedMechanicIds(env: Env, requestId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT DISTINCT mechanic_user_id FROM dispatch_attempts WHERE request_id = ?',
  )
    .bind(requestId)
    .all<{ mechanic_user_id: string }>();
  return rows.results.map((r) => r.mechanic_user_id);
}

async function pendingAttemptCount(env: Env, requestId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM dispatch_attempts WHERE request_id = ? AND status = 'PENDING'`,
  )
    .bind(requestId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export interface OfferResult {
  offered: Array<{ attemptId: string; mechanicUserId: string; distanceKm: number; etaMinutes: number }>;
  radiusUsedKm: number;
  round: number;
}

async function offerToCandidates(
  env: Env,
  request: RequestRow,
  candidates: ScoredCandidate[],
  radiusUsedKm: number,
  round: number,
): Promise<OfferResult> {
  const cfg = await getConfig(env);
  const pending = await pendingAttemptCount(env, request.id);
  const slots = Math.max(0, cfg.dispatch.parallelOffers - pending);
  const selected = candidates.filter((c) => c.status === 'AVAILABLE').slice(0, slots);

  const offered: OfferResult['offered'] = [];
  if (selected.length === 0) return { offered, radiusUsedKm, round };

  const attemptNoRow = await env.DB.prepare(
    'SELECT COALESCE(MAX(attempt_no), 0) AS n FROM dispatch_attempts WHERE request_id = ?',
  )
    .bind(request.id)
    .first<{ n: number }>();
  let attemptNo = attemptNoRow?.n ?? 0;

  const timeoutAt = isoIn(cfg.dispatch.attemptTimeoutSeconds);
  const fee = computeServiceFee(cfg, {
    distanceKm: 0,
    urgency: request.urgency as Urgency,
  });

  for (const candidate of selected) {
    attemptNo += 1;
    const attemptId = newId();
    await env.DB.prepare(
      `INSERT INTO dispatch_attempts
        (id, request_id, attempt_no, mechanic_user_id, status, score, distance_km, eta_minutes,
         offered_at, timeout_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        attemptId,
        request.id,
        attemptNo,
        candidate.userId,
        candidate.score,
        candidate.distanceKm,
        candidate.etaMinutes,
        nowIso(),
        timeoutAt,
        nowIso(),
        nowIso(),
      )
      .run();

    await env.DB.prepare(
      'UPDATE mechanics SET offers_received = offers_received + 1, updated_at = ? WHERE user_id = ?',
    )
      .bind(nowIso(), candidate.userId)
      .run();

    await notify(env, {
      userId: candidate.userId,
      type: 'JOB_OFFER',
      title: 'New emergency nearby',
      body: `${request.issue_type.replace(/_/g, ' ')} · ${candidate.distanceKm} km away · ETA ${candidate.etaMinutes} min · approx. ${Math.round(fee.totalCents / 100)}₹`,
      data: {
        requestId: request.id,
        reference: request.reference,
        issueType: request.issue_type,
        urgency: request.urgency,
        distanceKm: candidate.distanceKm,
        etaMinutes: candidate.etaMinutes,
        estimatedEarningsCents: fee.totalCents,
        timeoutSeconds: cfg.dispatch.attemptTimeoutSeconds,
        attemptNo,
      },
      channels: ['SMS'],
      requestId: request.id,
    });

    offered.push({
      attemptId,
      mechanicUserId: candidate.userId,
      distanceKm: candidate.distanceKm,
      etaMinutes: candidate.etaMinutes,
    });
  }

  if (offered.length > 0) {
    await recordEvent(env, {
      requestId: request.id,
      type: 'DISPATCH_OFFERED',
      message: `Notified ${offered.length} mechanic(s) within ${radiusUsedKm} km`,
      data: {
        radiusKm: radiusUsedKm,
        round,
        mechanics: offered.map((o) => o.mechanicUserId),
      },
    });
    await setRoomAlarm(env, requestRoom(request.id), new Date(timeoutAt).getTime());
  }

  return { offered, radiusUsedKm, round };
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

export async function escalateRequest(
  env: Env,
  request: RequestRow,
  reason: string,
  message?: string,
): Promise<RequestRow> {
  const fresh = await getRequest(env, request.id);
  if (!fresh) return request;
  if (fresh.status === 'ESCALATED' || fresh.status === 'CANCELLED' || fresh.status === 'FAILED' || fresh.status === 'PAID') {
    if (fresh.status === 'ESCALATED') {
      await env.DB.prepare(
        'UPDATE emergency_requests SET escalation_level = escalation_level + 1, updated_at = ? WHERE id = ?',
      )
        .bind(nowIso(), fresh.id)
        .run();
    }
    return fresh;
  }

  const updated = await setRequestStatus(env, fresh, 'ESCALATED', {
    message: message ?? 'Our operations team has been alerted and is finding help for you.',
    data: { reason },
    extra: { escalation_level: fresh.escalation_level + 1 },
  });

  await recordEvent(env, {
    requestId: fresh.id,
    type: 'ESCALATED',
    message: `Escalated to operations: ${reason}`,
    data: { reason },
  });

  const opsUsers = await env.DB.prepare(
    `SELECT id, full_name FROM users WHERE role IN ('OPERATIONS','ADMIN') AND status = 'ACTIVE' AND deleted_at IS NULL`,
  ).all<{ id: string; full_name: string }>();

  for (const op of opsUsers.results) {
    await notify(env, {
      userId: op.id,
      type: 'EMERGENCY_ESCALATED',
      title: 'Emergency escalated',
      body: `${fresh.reference} · ${fresh.issue_type} · no mechanic available (${reason})`,
      data: { requestId: fresh.id, reference: fresh.reference, reason },
      requestId: fresh.id,
    });
  }

  await notify(env, {
    userId: fresh.driver_user_id,
    type: 'EMERGENCY_ESCALATED',
    title: 'We are on it',
    body: message ?? 'We are expanding the search and our team is locating help for you now.',
    data: { requestId: fresh.id, reference: fresh.reference },
    channels: ['SMS'],
    requestId: fresh.id,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Advance (the never-stranded core)
// ---------------------------------------------------------------------------

export interface AdvanceOptions {
  excludeMechanicIds?: string[];
  reason?: string;
  actorRole?: Role | 'SYSTEM';
  actorUserId?: string | null;
}

export async function advanceDispatch(
  env: Env,
  request: RequestRow,
  opts: AdvanceOptions = {},
): Promise<OfferResult> {
  const cfg = await getConfig(env);
  const fresh = await getRequest(env, request.id);
  if (!fresh) return { offered: [], radiusUsedKm: 0, round: 0 };

  const terminal = ['CANCELLED', 'FAILED', 'PAID', 'COMPLETED', 'PAYMENT_PENDING', 'ASSIGNED', 'ARRIVED', 'DIAGNOSING', 'QUOTE_PENDING', 'QUOTE_APPROVED', 'REPAIRING', 'MECHANIC_EN_ROUTE', 'MECHANIC_NEARBY'];
  if (terminal.includes(fresh.status)) {
    return { offered: [], radiusUsedKm: fresh.dispatch_radius_km, round: fresh.dispatch_round };
  }

  const attempted = await attemptedMechanicIds(env, fresh.id);
  const exclude = new Set([...attempted, ...(opts.excludeMechanicIds ?? [])]);

  const totalAttempts = attempted.length;
  if (totalAttempts >= cfg.dispatch.maxAttempts) {
    await escalateRequest(env, fresh, 'MAX_ATTEMPTS_REACHED');
    return { offered: [], radiusUsedKm: fresh.dispatch_radius_km, round: fresh.dispatch_round };
  }

  const input = await buildDispatchInput(env, fresh);
  let round = fresh.dispatch_round;
  let radius = radiusForRound(round, cfg);
  const maxRounds = cfg.dispatch.radiusStepsKm.length + cfg.dispatch.maxEscalationRetries;

  while (round <= maxRounds) {
    radius = radiusForRound(round, cfg);
    const candidates = await findCandidates(env, input, {
      radiusKm: radius,
      excludeMechanicIds: [...exclude],
    });
    if (candidates.length > 0) {
      if (fresh.status !== 'DISPATCHING') {
        await setRequestStatus(env, fresh, 'DISPATCHING', {
          message: `Looking for mechanics within ${radius} km…`,
          actorRole: opts.actorRole ?? 'SYSTEM',
          extra: { dispatch_round: round, dispatch_radius_km: radius },
        });
      } else {
        await env.DB.prepare(
          'UPDATE emergency_requests SET dispatch_round = ?, dispatch_radius_km = ?, updated_at = ? WHERE id = ?',
        )
          .bind(round, radius, nowIso(), fresh.id)
          .run();
      }
      const reloaded = (await getRequest(env, fresh.id)) ?? fresh;
      return offerToCandidates(env, reloaded, candidates, radius, round);
    }
    round += 1;
  }

  await escalateRequest(env, fresh, opts.reason ?? 'NO_ELIGIBLE_MECHANIC');
  return { offered: [], radiusUsedKm: radius, round };
}

// ---------------------------------------------------------------------------
// Start dispatch
// ---------------------------------------------------------------------------

export async function startDispatch(env: Env, request: RequestRow): Promise<OfferResult> {
  const fresh = await getRequest(env, request.id);
  if (!fresh) return { offered: [], radiusUsedKm: 0, round: 0 };

  await recordEvent(env, {
    requestId: fresh.id,
    type: 'DISPATCH_STARTED',
    message: 'Location confirmed — starting dispatch',
    data: { latitude: fresh.latitude, longitude: fresh.longitude },
  });

  if (fresh.status === 'CREATED' || fresh.status === 'SEARCHING') {
    const updated = await setRequestStatus(env, fresh, 'SEARCHING', {
      message: 'Looking for a nearby mechanic…',
      extra: { dispatch_started_at: fresh.dispatch_started_at ?? nowIso() },
    });
    return advanceDispatch(env, updated, { reason: 'INITIAL' });
  }
  if (fresh.status === 'DISPATCHING') {
    return advanceDispatch(env, fresh, { reason: 'INITIAL' });
  }
  if (fresh.status === 'ESCALATED') {
    return advanceDispatch(env, fresh, { reason: 'RETRY' });
  }
  return { offered: [], radiusUsedKm: fresh.dispatch_radius_km, round: fresh.dispatch_round };
}

// ---------------------------------------------------------------------------
// Accept — atomic, race-safe
// ---------------------------------------------------------------------------

export interface AcceptResult {
  jobId: string;
  requestId: string;
  idempotent: boolean;
}

export async function acceptAttempt(
  env: Env,
  requestId: string,
  mechanicUserId: string,
): Promise<AcceptResult> {
  const request = await requireRequest(env, requestId);
  if (request.status === 'CANCELLED' || request.status === 'FAILED' || request.status === 'PAID') {
    throw errors.conflict('REQUEST_CLOSED', 'This request is no longer accepting mechanics.');
  }

  const attempt = await env.DB.prepare(
    `SELECT * FROM dispatch_attempts
     WHERE request_id = ? AND mechanic_user_id = ?
     ORDER BY attempt_no DESC LIMIT 1`,
  )
    .bind(requestId, mechanicUserId)
    .first<{ id: string; status: string }>();

  if (!attempt) {
    throw errors.conflict('NO_ACTIVE_OFFER', 'You do not have an offer for this request.');
  }

  const now = nowIso();

  if (attempt.status === 'ACCEPTED' && request.assigned_mechanic_user_id === mechanicUserId) {
    const existingJob = await env.DB.prepare(
      'SELECT id FROM jobs WHERE request_id = ? AND mechanic_user_id = ? AND deleted_at IS NULL',
    )
      .bind(requestId, mechanicUserId)
      .first<{ id: string }>();
    if (existingJob) return { jobId: existingJob.id, requestId, idempotent: true };
  }

  if (attempt.status !== 'PENDING') {
    throw errors.conflict('JOB_ALREADY_ASSIGNED', 'Another mechanic has already taken this job.');
  }

  // 1) claim the attempt, 2) claim the request — both compare-and-swap, in one
  // atomic batch. Only one mechanic can win the request claim.
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE dispatch_attempts SET status = 'ACCEPTED', responded_at = ?, updated_at = ?
       WHERE id = ? AND status = 'PENDING'`,
    )
      .bind(now, now, attempt.id),
    env.DB.prepare(
      `UPDATE emergency_requests
       SET status = 'ASSIGNED', assigned_mechanic_user_id = ?, assigned_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('CREATED','SEARCHING','DISPATCHING','ESCALATED')`,
    )
      .bind(mechanicUserId, now, now, requestId),
  ]);

  const attemptWon = results[0].meta.changes > 0;
  const requestWon = results[1].meta.changes > 0;

  if (!attemptWon) {
    throw errors.conflict('JOB_ALREADY_ASSIGNED', 'Another mechanic has already taken this job.');
  }

  if (!requestWon) {
    // Lost the race — roll our attempt back so history stays truthful.
    await env.DB.prepare(
      `UPDATE dispatch_attempts SET status = 'CANCELLED', responded_at = ?, decline_reason = 'REQUEST_ALREADY_ASSIGNED', updated_at = ?
       WHERE id = ?`,
    )
      .bind(now, now, attempt.id)
      .run();
    const fresh = await getRequest(env, requestId);
    if (fresh?.assigned_mechanic_user_id === mechanicUserId) {
      const job = await env.DB.prepare(
        'SELECT id FROM jobs WHERE request_id = ? AND deleted_at IS NULL',
      )
        .bind(requestId)
        .first<{ id: string }>();
      if (job) return { jobId: job.id, requestId, idempotent: true };
    }
    throw errors.conflict('JOB_ALREADY_ASSIGNED', 'Another mechanic has already taken this job.');
  }

  const jobId = newId();
  await env.DB.batch([
    // Cancel every other pending offer for this request.
    env.DB.prepare(
      `UPDATE dispatch_attempts SET status = 'CANCELLED', responded_at = ?, decline_reason = 'OTHER_MECHANIC_ACCEPTED', updated_at = ?
       WHERE request_id = ? AND status = 'PENDING' AND id != ?`,
    )
      .bind(now, now, requestId, attempt.id),
    env.DB.prepare(
      `INSERT INTO jobs (id, request_id, mechanic_user_id, status, accepted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'ACCEPTED', ?, ?, ?)`,
    )
      .bind(jobId, requestId, mechanicUserId, now, now, now),
    env.DB.prepare(
      `INSERT INTO job_status_history (id, job_id, from_status, to_status, actor_user_id, created_at)
       VALUES (?, ?, NULL, 'ACCEPTED', ?, ?)`,
    )
      .bind(newId(), jobId, mechanicUserId, now),
    env.DB.prepare(
      `INSERT INTO mechanic_assignments (id, request_id, mechanic_user_id, attempt_id, status, assigned_at)
       VALUES (?, ?, ?, ?, 'ACTIVE', ?)`,
    )
      .bind(newId(), requestId, mechanicUserId, attempt.id, now),
    env.DB.prepare(
      `UPDATE mechanics SET status = 'BUSY', offers_accepted = offers_accepted + 1, updated_at = ?
       WHERE user_id = ?`,
    )
      .bind(now, mechanicUserId),
  ]);

  await recordEvent(env, {
    requestId,
    type: 'MECHANIC_ACCEPTED',
    message: 'A mechanic accepted your request',
    actorRole: 'MECHANIC',
    actorUserId: mechanicUserId,
  });

  const mechanic = await env.DB.prepare('SELECT full_name FROM users WHERE id = ?')
    .bind(mechanicUserId)
    .first<{ full_name: string }>();

  await notify(env, {
    userId: request.driver_user_id,
    type: 'MECHANIC_ACCEPTED',
    title: 'Mechanic found',
    body: `${mechanic?.full_name ?? 'Your mechanic'} is on the way. Track live status in the app.`,
    data: { requestId, mechanicUserId, jobId },
    channels: ['SMS'],
    requestId,
  });

  await clearRoomAlarm(env, requestRoom(requestId));
  const reloaded = await getRequest(env, requestId);
  if (reloaded) await broadcastRequestState(env, reloaded);

  logger.info(requestId, 'dispatch_accepted', { mechanicUserId, jobId });
  return { jobId, requestId, idempotent: false };
}

// ---------------------------------------------------------------------------
// Decline / timeout
// ---------------------------------------------------------------------------

async function latestPendingAttempt(
  env: Env,
  requestId: string,
  mechanicUserId: string,
): Promise<{ id: string } | null> {
  const row = await env.DB.prepare(
    `SELECT id FROM dispatch_attempts
     WHERE request_id = ? AND mechanic_user_id = ? AND status = 'PENDING'
     ORDER BY attempt_no DESC LIMIT 1`,
  )
    .bind(requestId, mechanicUserId)
    .first<{ id: string }>();
  return row ?? null;
}

export async function declineAttempt(
  env: Env,
  requestId: string,
  mechanicUserId: string,
  reason?: string,
): Promise<{ advanced: boolean }> {
  const attempt = await latestPendingAttempt(env, requestId, mechanicUserId);
  if (!attempt) {
    throw errors.conflict('OFFER_CLOSED', 'This offer is no longer active.');
  }
  const now = nowIso();
  const result = await env.DB.prepare(
    `UPDATE dispatch_attempts SET status = 'DECLINED', responded_at = ?, decline_reason = ?, updated_at = ?
     WHERE id = ? AND status = 'PENDING'`,
  )
    .bind(now, reason ?? null, now, attempt.id)
    .run();
  if (result.meta.changes === 0) {
    throw errors.conflict('OFFER_CLOSED', 'This offer is no longer active.');
  }

  await recordEvent(env, {
    requestId,
    type: 'DISPATCH_DECLINED',
    message: 'A mechanic declined the job',
    actorRole: 'MECHANIC',
    actorUserId: mechanicUserId,
    data: { reason: reason ?? null },
  });

  const fresh = await getRequest(env, requestId);
  if (!fresh) return { advanced: false };
  if (['SEARCHING', 'DISPATCHING', 'ESCALATED'].includes(fresh.status)) {
    await advanceDispatch(env, fresh, {
      excludeMechanicIds: [mechanicUserId],
      reason: 'DECLINED',
    });
    return { advanced: true };
  }
  return { advanced: false };
}

export async function timeoutAttempt(env: Env, attemptId: string): Promise<{ timedOut: boolean }> {
  const now = nowIso();
  const attempt = await env.DB.prepare('SELECT * FROM dispatch_attempts WHERE id = ?')
    .bind(attemptId)
    .first<{ id: string; request_id: string; mechanic_user_id: string; status: string }>();
  if (!attempt || attempt.status !== 'PENDING') return { timedOut: false };

  const result = await env.DB.prepare(
    `UPDATE dispatch_attempts SET status = 'TIMEOUT', responded_at = ?, updated_at = ?
     WHERE id = ? AND status = 'PENDING'`,
  )
    .bind(now, now, attemptId)
    .run();
  if (result.meta.changes === 0) return { timedOut: false };

  await recordEvent(env, {
    requestId: attempt.request_id,
    type: 'DISPATCH_TIMEOUT',
    message: 'A mechanic did not respond in time',
    actorRole: 'SYSTEM',
    data: { mechanicUserId: attempt.mechanic_user_id },
  });

  const fresh = await getRequest(env, attempt.request_id);
  if (fresh && ['SEARCHING', 'DISPATCHING', 'ESCALATED'].includes(fresh.status)) {
    await advanceDispatch(env, fresh, {
      excludeMechanicIds: [attempt.mechanic_user_id],
      reason: 'TIMEOUT',
    });
  }
  logger.info(attempt.request_id, 'dispatch_timeout', { attemptId });
  return { timedOut: true };
}

// ---------------------------------------------------------------------------
// Reassignment (mechanic cancels / stalls)
// ---------------------------------------------------------------------------

export async function reassignRequest(
  env: Env,
  requestId: string,
  opts: {
    actorRole: Role | 'SYSTEM';
    actorUserId: string;
    reason: string;
    replaceMechanicUserId?: string;
  },
): Promise<{ reassigned: boolean }> {
  const request = await requireRequest(env, requestId);
  const previousMechanic = request.assigned_mechanic_user_id;
  if (!previousMechanic) return { reassigned: false };

  const now = nowIso();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE jobs SET status = 'CANCELLED', deleted_at = ?, updated_at = ? WHERE request_id = ? AND deleted_at IS NULL AND status != 'COMPLETED'`,
    )
      .bind(now, now, requestId),
    env.DB.prepare(
      `UPDATE mechanic_assignments SET status = 'REPLACED', ended_at = ?, end_reason = ?
       WHERE request_id = ? AND status = 'ACTIVE'`,
    )
      .bind(now, opts.reason, requestId),
    env.DB.prepare(
      `UPDATE dispatch_attempts SET status = 'CANCELLED', responded_at = ?, decline_reason = ?, updated_at = ?
       WHERE request_id = ? AND status = 'ACCEPTED'`,
    )
      .bind(now, opts.reason, now, requestId),
    env.DB.prepare(
      `UPDATE mechanics SET jobs_cancelled = jobs_cancelled + 1, updated_at = ? WHERE user_id = ?`,
    )
      .bind(now, previousMechanic),
  ]);

  const previous = await env.DB.prepare('SELECT status, verification_status FROM mechanics WHERE user_id = ?')
    .bind(previousMechanic)
    .first<{ status: string; verification_status: string }>();
  if (previous && previous.verification_status === 'VERIFIED' && previous.status !== 'SUSPENDED') {
    await setMechanicStatus(env, previousMechanic, 'AVAILABLE', {
      actorRole: opts.actorRole,
      actorUserId: opts.actorUserId,
    }).catch(() => undefined);
  }

  const fresh = await requireRequest(env, requestId);
  const updated = await setRequestStatus(env, fresh, 'DISPATCHING', {
    actorRole: opts.actorRole,
    actorUserId: opts.actorUserId,
    message: 'Finding a replacement mechanic…',
    data: { reason: opts.reason, previousMechanicUserId: previousMechanic },
    extra: { assigned_mechanic_user_id: null, assigned_at: null },
  });

  await recordEvent(env, {
    requestId,
    type: 'MECHANIC_REASSIGNED',
    message: `Replacement mechanic search started (${opts.reason})`,
    actorRole: opts.actorRole,
    actorUserId: opts.actorUserId,
    data: { previousMechanicUserId: previousMechanic, reason: opts.reason },
  });

  await notify(env, {
    userId: request.driver_user_id,
    type: 'MECHANIC_REASSIGNED',
    title: 'Finding you a new mechanic',
    body: 'Your mechanic could not continue. We are assigning another one right now — your request stays open.',
    data: { requestId, reason: opts.reason },
    channels: ['SMS'],
    requestId,
  });

  await advanceDispatch(env, updated, {
    excludeMechanicIds: [previousMechanic, ...(opts.replaceMechanicUserId ? [opts.replaceMechanicUserId] : [])],
    reason: opts.reason,
    actorRole: opts.actorRole,
    actorUserId: opts.actorUserId,
  });

  return { reassigned: true };
}

// ---------------------------------------------------------------------------
// Background sweeps (cron)
// ---------------------------------------------------------------------------

export async function sweepExpiredAttempts(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM dispatch_attempts
     WHERE status = 'PENDING' AND timeout_at IS NOT NULL AND timeout_at <= ?
     LIMIT 25`,
  )
    .bind(nowIso())
    .all<{ id: string }>();
  let count = 0;
  for (const row of rows.results) {
    const res = await timeoutAttempt(env, row.id);
    if (res.timedOut) count += 1;
  }
  return count;
}

export async function sweepStalledJobs(env: Env): Promise<number> {
  const cfg = await getConfig(env);
  const rows = await env.DB.prepare(
    `SELECT j.id, j.request_id, j.mechanic_user_id, j.en_route_at, j.stall_warned_at, j.status
     FROM jobs j
     WHERE j.deleted_at IS NULL AND j.status = 'EN_ROUTE' AND j.en_route_at IS NOT NULL`,
  ).all<{
    id: string;
    request_id: string;
    mechanic_user_id: string;
    en_route_at: string;
    stall_warned_at: string | null;
    status: string;
  }>();

  let acted = 0;
  for (const job of rows.results) {
    const lastLocation = await env.DB.prepare(
      `SELECT recorded_at FROM emergency_locations
       WHERE request_id = ? AND source = 'MECHANIC'
       ORDER BY recorded_at DESC LIMIT 1`,
    )
      .bind(job.request_id)
      .first<{ recorded_at: string }>();

    const lastMoveAt = new Date(
      lastLocation?.recorded_at ?? job.en_route_at,
    ).getTime();
    const elapsedSeconds = Math.floor((Date.now() - lastMoveAt) / 1000);

    if (elapsedSeconds >= cfg.dispatch.stallEscalateSeconds) {
      await recordEvent(env, {
        requestId: job.request_id,
        type: 'MECHANIC_STALLED',
        message: 'Mechanic has not moved towards you — escalating',
        data: { elapsedSeconds },
      });
      await notify(env, {
        userId: job.mechanic_user_id,
        type: 'MECHANIC_DELAYED',
        title: 'You seem delayed',
        body: 'Please update your status or the job will be reassigned.',
        data: { requestId: job.request_id, jobId: job.id },
      });
      await reassignRequest(env, job.request_id, {
        actorRole: 'SYSTEM',
        actorUserId: job.mechanic_user_id,
        reason: 'STALL_ESCALATED',
      });
      acted += 1;
    } else if (elapsedSeconds >= cfg.dispatch.stallWarningSeconds && !job.stall_warned_at) {
      await env.DB.prepare('UPDATE jobs SET stall_warned_at = ?, updated_at = ? WHERE id = ?')
        .bind(nowIso(), nowIso(), job.id)
        .run();
      await recordEvent(env, {
        requestId: job.request_id,
        type: 'MECHANIC_DELAY_WARNING',
        message: 'Mechanic travel is taking longer than expected',
        data: { elapsedSeconds },
      });
      await notify(env, {
        userId: job.mechanic_user_id,
        type: 'MECHANIC_DELAYED',
        title: 'Please update your progress',
        body: 'Your ETA looks stale. Share your location or update job status.',
        data: { requestId: job.request_id, jobId: job.id },
      });
      acted += 1;
    }
  }
  return acted;
}

export async function sweepStaleSearching(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id FROM emergency_requests
     WHERE deleted_at IS NULL AND status IN ('SEARCHING','DISPATCHING')
       AND updated_at <= ?
     LIMIT 10`,
  )
    .bind(isoIn(-30))
    .all<{ id: string }>();
  let count = 0;
  for (const row of rows.results) {
    const request = await getRequest(env, row.id);
    if (!request) continue;
    const pending = await pendingAttemptCount(env, request.id);
    if (pending > 0) continue;
    await advanceDispatch(env, request, { reason: 'SWEEP' });
    count += 1;
  }
  return count;
}

export async function sweepEscalatedRetries(env: Env): Promise<number> {
  const cfg = await getConfig(env);
  const rows = await env.DB.prepare(
    `SELECT id, escalation_level, updated_at FROM emergency_requests
     WHERE deleted_at IS NULL AND status = 'ESCALATED' AND escalation_level <= ?
       AND updated_at <= ?
     LIMIT 5`,
  )
    .bind(cfg.dispatch.maxEscalationRetries, isoIn(-60))
    .all<{ id: string; escalation_level: number; updated_at: string }>();
  let count = 0;
  for (const row of rows.results) {
    const request = await getRequest(env, row.id);
    if (!request) continue;
    const pending = await pendingAttemptCount(env, request.id);
    if (pending > 0) continue;
    await env.DB.prepare(
      'UPDATE emergency_requests SET escalation_level = escalation_level + 1, updated_at = ? WHERE id = ?',
    )
      .bind(nowIso(), request.id)
      .run();
    await advanceDispatch(env, request, { reason: 'ESCALATION_RETRY' });
    count += 1;
  }
  return count;
}

export async function runDispatchSweeps(env: Env): Promise<void> {
  try {
    await sweepExpiredAttempts(env);
    await sweepStaleSearching(env);
    await sweepEscalatedRetries(env);
    await sweepStalledJobs(env);
  } catch (err) {
    logger.error('sweep', 'dispatch_sweep_failed', { error: String(err) });
  }
}
