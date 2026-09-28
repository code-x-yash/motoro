import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser, requirePermission } from '../lib/auth';
import { parseInput } from '../lib/validate';
import {
  mechanicAvailabilitySchema,
  nearbyMechanicsSchema,
  paginationSchema,
  setMechanicStatusSchema,
  submitVerificationSchema,
  updateMechanicProfileSchema,
} from '@rr/validation';
import { mapMechanicProfile } from '../lib/mappers';
import { getMechanic, requireMechanic, setMechanicStatus, recordMechanicLocation } from '../lib/mechanics';
import { findCandidates, requiredEquipmentFor, requiredSkillsFor } from '../dispatch/service';
import { newId, nowIso } from '../lib/ids';
import { audit } from '../lib/audit';
import { errors as appErrors } from '../lib/errors';

const routes = new Hono<{ Bindings: Env }>();

/** Current mechanic profile + KPIs. */
routes.get('/me', async (c) => {
  const user = await requireUser(c);
  if (!['MECHANIC', 'WORKSHOP'].includes(user.role)) throw errors.forbidden();
  const mechanic = await requireMechanic(c.env, user.id);
  const profile = await mapMechanicProfile(c.env, mechanic, new URL(c.req.url).origin);
  return ok({ profile }, c.get('requestId'));
});

/** Dashboard KPIs for the mechanic home screen. */
routes.get('/me/stats', async (c) => {
  const user = await requireUser(c);
  if (!['MECHANIC', 'WORKSHOP'].includes(user.role)) throw errors.forbidden();
  const mechanic = await requireMechanic(c.env, user.id);

  const today = new Date().toISOString().slice(0, 10);
  const [todayJobs, activeJobs, pendingOffers] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS c FROM jobs WHERE mechanic_user_id = ? AND deleted_at IS NULL
         AND date(completed_at) = date('now')`,
    )
      .bind(user.id)
      .first<{ c: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS c FROM jobs WHERE mechanic_user_id = ? AND deleted_at IS NULL
         AND status IN ('ACCEPTED','EN_ROUTE','ARRIVED','VERIFIED','DIAGNOSING','QUOTE_PENDING','QUOTE_APPROVED','REPAIRING')`,
    )
      .bind(user.id)
      .first<{ c: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS c FROM dispatch_attempts WHERE mechanic_user_id = ? AND status = 'PENDING'`,
    )
      .bind(user.id)
      .first<{ c: number }>(),
  ]);

  const acceptanceRate =
    mechanic.offers_received > 0
      ? Math.round((mechanic.offers_accepted / mechanic.offers_received) * 100)
      : 100;
  const completionRate =
    mechanic.jobs_completed + mechanic.jobs_cancelled > 0
      ? Math.round((mechanic.jobs_completed / (mechanic.jobs_completed + mechanic.jobs_cancelled)) * 100)
      : 100;

  return ok(
    {
      status: mechanic.status,
      verificationStatus: mechanic.verification_status,
      todayJobs: todayJobs?.c ?? 0,
      activeJobs: activeJobs?.c ?? 0,
      pendingOffers: pendingOffers?.c ?? 0,
      earningsCents: mechanic.earnings_cents,
      today,
      ratingAverage: mechanic.rating_count > 0 ? Math.round((mechanic.rating_sum / mechanic.rating_count) * 10) / 10 : 0,
      ratingCount: mechanic.rating_count,
      acceptanceRate,
      completionRate,
      jobsCompleted: mechanic.jobs_completed,
      jobsCancelled: mechanic.jobs_cancelled,
      reliabilityScore: mechanic.reliability_score,
    },
    c.get('requestId'),
  );
});

/** Update mechanic profile (skills, equipment, radius, location). */
routes.patch('/me', requirePermission('PROFILE_MANAGE'), async (c) => {
  const user = await requireUser(c);
  if (!['MECHANIC', 'WORKSHOP'].includes(user.role)) throw errors.forbidden();
  const input = parseInput(updateMechanicProfileSchema, await c.req.json().catch(() => ({})));
  await requireMechanic(c.env, user.id);

  const sets: string[] = [];
  const binds: Array<string | number | null> = [];
  if (input.experienceYears !== undefined) {
    sets.push('experience_years = ?');
    binds.push(input.experienceYears);
  }
  if (input.address !== undefined) {
    sets.push('address = ?');
    binds.push(input.address);
  }
  if (input.latitude !== undefined) {
    sets.push('latitude = ?');
    binds.push(input.latitude);
  }
  if (input.longitude !== undefined) {
    sets.push('longitude = ?');
    binds.push(input.longitude);
  }
  if (input.serviceRadiusKm !== undefined) {
    sets.push('service_radius_km = ?');
    binds.push(input.serviceRadiusKm);
  }
  if (input.bio !== undefined) {
    sets.push('bio = ?');
    binds.push(input.bio);
  }

  if (sets.length > 0) {
    sets.push('updated_at = ?');
    binds.push(nowIso(), user.id);
    await c.env.DB.prepare(`UPDATE mechanics SET ${sets.join(', ')} WHERE user_id = ?`)
      .bind(...binds)
      .run();
  }

  if (input.skills) {
    await c.env.DB.prepare('DELETE FROM mechanic_skills WHERE mechanic_user_id = ?').bind(user.id).run();
    for (const skill of input.skills.slice(0, 30)) {
      await c.env.DB.prepare(
        `INSERT INTO mechanic_skills (id, mechanic_user_id, skill, level, created_at)
         VALUES (?, ?, ?, 'INTERMEDIATE', ?) ON CONFLICT DO NOTHING`,
      ).bind(newId(), user.id, skill, nowIso()).run();
    }
  }
  if (input.equipment) {
    await c.env.DB.prepare('DELETE FROM mechanic_equipment WHERE mechanic_user_id = ?').bind(user.id).run();
    for (const item of input.equipment.slice(0, 30)) {
      await c.env.DB.prepare(
        `INSERT INTO mechanic_equipment (id, mechanic_user_id, equipment, created_at)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(newId(), user.id, item, nowIso()).run();
    }
  }

  const fresh = await requireMechanic(c.env, user.id);
  return ok({ profile: await mapMechanicProfile(c.env, fresh) }, c.get('requestId'));
});

/** Prominent OFFLINE / AVAILABLE / PAUSED switch. */
routes.post('/me/status', requirePermission('MECHANIC_AVAILABILITY'), async (c) => {
  const user = await requireUser(c);
  if (!['MECHANIC', 'WORKSHOP'].includes(user.role)) throw errors.forbidden();
  const input = parseInput(setMechanicStatusSchema, await c.req.json().catch(() => ({})));
  const mechanic = await requireMechanic(c.env, user.id);

  if (input.status !== 'OFFLINE' && mechanic.verification_status !== 'VERIFIED') {
    throw appErrors.conflict(
      'NOT_VERIFIED',
      'Your profile must be verified by an administrator before you can go online.',
    );
  }

  const updated = await setMechanicStatus(c.env, user.id, input.status, {
    actorRole: user.role,
    actorUserId: user.id,
    reason: 'MANUAL_TOGGLE',
  });

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'MECHANIC_STATUS_CHANGED',
    entityType: 'mechanic',
    entityId: user.id,
    data: { status: input.status },
    requestId: c.get('requestId'),
  });

  return ok({ status: updated.status }, c.get('requestId'));
});

/** Mechanic shares location (also used for presence on the ops map). */
routes.post('/me/location', requirePermission('MECHANIC_AVAILABILITY'), async (c) => {
  const user = await requireUser(c);
  const body = (await c.req.json().catch(() => ({}))) as { latitude?: number; longitude?: number };
  if (typeof body.latitude !== 'number' || typeof body.longitude !== 'number') {
    throw errors.validation('latitude and longitude are required.');
  }
  const input = parseInput(nearbyMechanicsSchema.pick({ latitude: true, longitude: true }), body);
  await recordMechanicLocation(c.env, user.id, input.latitude, input.longitude);
  return ok({ updated: true }, c.get('requestId'));
});

/** Submit verification documents (admin reviews them). */
routes.post('/me/verification', requirePermission('MECHANIC_AVAILABILITY'), async (c) => {
  const user = await requireUser(c);
  if (!['MECHANIC', 'WORKSHOP'].includes(user.role)) throw errors.forbidden();
  const input = parseInput(submitVerificationSchema, await c.req.json().catch(() => ({})));
  await requireMechanic(c.env, user.id);

  await c.env.DB.prepare(
    `UPDATE mechanics
     SET verification_status = 'UNDER_REVIEW', experience_years = ?, address = ?,
         document_key = COALESCE(?, document_key), submitted_at = ?, review_note = ?, updated_at = ?
     WHERE user_id = ?`,
  )
    .bind(
      input.experienceYears,
      input.address,
      input.documentKey ?? null,
      nowIso(),
      input.notes ?? null,
      nowIso(),
      user.id,
    )
    .run();

  const admins = await c.env.DB.prepare(
    `SELECT id FROM users WHERE role IN ('ADMIN','OPERATIONS') AND status = 'ACTIVE'`,
  ).all<{ id: string }>();
  for (const admin of admins.results) {
    const { notify } = await import('../lib/notify');
    await notify(c.env, {
      userId: admin.id,
      type: 'VERIFICATION_SUBMITTED',
      title: 'Mechanic verification submitted',
      body: `${user.fullName} submitted verification documents.`,
      data: { mechanicUserId: user.id },
    });
  }

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'VERIFICATION_SUBMITTED',
    entityType: 'mechanic',
    entityId: user.id,
    requestId: c.get('requestId'),
  });

  const fresh = await requireMechanic(c.env, user.id);
  return ok({ profile: await mapMechanicProfile(c.env, fresh) }, c.get('requestId'));
});

/** Availability windows. */
routes.get('/me/availability', async (c) => {
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    'SELECT id, day_of_week, start_minute, end_minute FROM mechanic_availability WHERE mechanic_user_id = ? ORDER BY day_of_week, start_minute',
  )
    .bind(user.id)
    .all<{ id: string; day_of_week: number; start_minute: number; end_minute: number }>();
  return ok(
    {
      items: rows.results.map((r) => ({
        id: r.id,
        dayOfWeek: r.day_of_week,
        startMinute: r.start_minute,
        endMinute: r.end_minute,
      })),
    },
    c.get('requestId'),
  );
});

routes.post('/me/availability', requirePermission('MECHANIC_AVAILABILITY'), async (c) => {
  const user = await requireUser(c);
  const input = parseInput(mechanicAvailabilitySchema, await c.req.json().catch(() => ({})));
  if (input.endMinute <= input.startMinute) {
    throw errors.validation('End time must be after start time.');
  }
  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO mechanic_availability (id, mechanic_user_id, day_of_week, start_minute, end_minute, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  )
    .bind(id, user.id, input.dayOfWeek, input.startMinute, input.endMinute, nowIso())
    .run();
  return ok({ id, ...input }, c.get('requestId'), 201);
});

routes.delete('/me/availability/:id', requirePermission('MECHANIC_AVAILABILITY'), async (c) => {
  const user = await requireUser(c);
  const result = await c.env.DB.prepare(
    'DELETE FROM mechanic_availability WHERE id = ? AND mechanic_user_id = ?',
  )
    .bind(c.req.param('id'), user.id)
    .run();
  if (result.meta.changes === 0) throw errors.notFound('Availability window not found.');
  return ok({ deleted: true }, c.get('requestId'));
});

/** Earnings history. */
routes.get('/me/earnings', async (c) => {
  const user = await requireUser(c);
  const query = parseInput(paginationSchema, c.req.query());
  const rows = await c.env.DB.prepare(
    `SELECT j.id, j.request_id, j.earnings_cents, j.completed_at, e.reference, e.issue_type
     FROM jobs j JOIN emergency_requests e ON e.id = j.request_id
     WHERE j.mechanic_user_id = ? AND j.deleted_at IS NULL
     ORDER BY j.completed_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(user.id, query.limit, query.offset)
    .all<{ id: string; request_id: string; earnings_cents: number; completed_at: string | null; reference: string; issue_type: string }>();

  const total = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(earnings_cents), 0) AS total, COUNT(*) AS c FROM jobs WHERE mechanic_user_id = ? AND deleted_at IS NULL',
  )
    .bind(user.id)
    .first<{ total: number; c: number }>();

  return ok(
    {
      items: rows.results.map((r) => ({
        jobId: r.id,
        requestId: r.request_id,
        reference: r.reference,
        issueType: r.issue_type,
        earningsCents: r.earnings_cents,
        completedAt: r.completed_at,
      })),
      totalCents: total?.total ?? 0,
      jobCount: total?.c ?? 0,
      limit: query.limit,
      offset: query.offset,
    },
    c.get('requestId'),
  );
});

/**
 * Ranked nearby mechanics (used by operations + demo tooling).
 * Internal scores are not exposed.
 */
routes.get('/nearby', async (c) => {
  const user = await requireUser(c);
  if (!['DRIVER', 'OPERATIONS', 'ADMIN', 'MECHANIC'].includes(user.role)) throw errors.forbidden();
  const query = parseInput(nearbyMechanicsSchema, c.req.query());

  const signals = await findCandidates(
    c.env,
    {
      requestId: '',
      latitude: query.latitude,
      longitude: query.longitude,
      issueType: query.issueType ?? 'GENERAL_BREAKDOWN',
      urgency: 'NORMAL',
      vehicleType: null,
      vehicleMake: null,
      vehicleModel: null,
      requiredSkills: requiredSkillsFor(query.issueType ?? 'GENERAL_BREAKDOWN'),
      requiredEquipment: requiredEquipmentFor(query.issueType ?? 'GENERAL_BREAKDOWN'),
    },
    { radiusKm: query.radiusKm },
  );

  return ok(
    {
      items: signals.map((s) => ({
        userId: s.userId,
        fullName: s.fullName,
        distanceKm: s.distanceKm,
        etaMinutes: s.etaMinutes,
        ratingAverage: Math.round(s.ratingAverage * 10) / 10,
        ratingCount: s.ratingCount,
        status: s.status,
        skills: s.skills,
        supportsVehicleType: s.supportsVehicleType,
      })),
    },
    c.get('requestId'),
  );
});

/** Public mechanic profile (reviews for a completed job, etc.). */
routes.get('/:id', async (c) => {
  const mechanic = await getMechanic(c.env, c.req.param('id'));
  if (!mechanic) throw errors.notFound('Mechanic not found.');
  const profile = await mapMechanicProfile(c.env, mechanic, new URL(c.req.url).origin);
  const reviews = await c.env.DB.prepare(
    `SELECT r.*, u.full_name AS reviewee_name FROM reviews r
     JOIN users u ON u.id = r.reviewer_user_id
     WHERE r.reviewee_user_id = ? ORDER BY r.created_at DESC LIMIT 20`,
  )
    .bind(c.req.param('id'))
    .all();
  return ok(
    {
      profile,
      reviews: reviews.results.map((row) => {
        const r = row as never as {
          id: string;
          request_id: string;
          reviewer_user_id: string;
          reviewee_user_id: string;
          overall: number;
          arrival: number;
          diagnosis: number;
          pricing: number;
          professionalism: number;
          resolution: number;
          comment: string | null;
          created_at: string;
          reviewee_name: string;
        };
        return {
          id: r.id,
          requestId: r.request_id,
          reviewerUserId: r.reviewer_user_id,
          revieweeUserId: r.reviewee_user_id,
          revieweeName: r.reviewee_name,
          overall: r.overall,
          categories: {
            arrival: r.arrival,
            diagnosis: r.diagnosis,
            pricing: r.pricing,
            professionalism: r.professionalism,
            resolution: r.resolution,
          },
          comment: r.comment,
          createdAt: r.created_at,
        };
      }),
    },
    c.get('requestId'),
  );
});

export default routes;
