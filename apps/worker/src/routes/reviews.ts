import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser } from '../lib/auth';
import { parseInput } from '../lib/validate';
import { createReviewSchema, paginationSchema } from '@rr/validation';
import { requireRequest, assertRequestAccess } from '../lib/requests';
import { newId, nowIso } from '../lib/ids';
import { audit } from '../lib/audit';
import { notify } from '../lib/notify';
import { enforceRateLimit } from '../lib/rate-limit';

const routes = new Hono<{ Bindings: Env }>();

/** Reviews are only allowed between parties of a completed job. */
routes.post('/', async (c) => {
  const user = await requireUser(c);
  await enforceRateLimit(c.env, 'review', user.id, 10, 300, 'You are submitting reviews too quickly. Please wait.');
  const input = parseInput(createReviewSchema, await c.req.json().catch(() => ({})));
  const request = await requireRequest(c.env, input.requestId);
  assertRequestAccess(user, request);

  const isDriver = request.driver_user_id === user.id;
  const isMechanic = request.assigned_mechanic_user_id === user.id;
  if (!isDriver && !isMechanic) {
    throw errors.forbidden('Only the customer and their mechanic can review this job.');
  }
  if (!['COMPLETED', 'PAYMENT_PENDING', 'PAID'].includes(request.status)) {
    throw errors.conflict(
      'REVIEW_NOT_ALLOWED',
      'Reviews can only be left after the job is completed.',
    );
  }

  const existing = await c.env.DB.prepare(
    'SELECT id FROM reviews WHERE request_id = ? AND reviewer_user_id = ?',
  )
    .bind(request.id, user.id)
    .first<{ id: string }>();
  if (existing) throw errors.conflict('REVIEW_EXISTS', 'You have already reviewed this job.');

  const job = await c.env.DB.prepare(
    'SELECT id FROM jobs WHERE request_id = ? AND deleted_at IS NULL LIMIT 1',
  )
    .bind(request.id)
    .first<{ id: string }>();

  const revieweeUserId = isDriver ? request.assigned_mechanic_user_id : request.driver_user_id;
  if (!revieweeUserId) throw errors.conflict('NO_REVIEWEE', 'There is no one to review for this job.');

  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO reviews (id, request_id, job_id, reviewer_user_id, reviewee_user_id, direction,
                          overall, arrival, diagnosis, pricing, professionalism, resolution, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      request.id,
      job?.id ?? null,
      user.id,
      revieweeUserId,
      isDriver ? 'DRIVER_TO_MECHANIC' : 'MECHANIC_TO_DRIVER',
      input.overall,
      input.arrival,
      input.diagnosis,
      input.pricing,
      input.professionalism,
      input.resolution,
      input.comment ?? null,
      nowIso(),
    )
    .run();

  // Aggregate rating (mechanics) — D1 is the system of record.
  const agg = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(overall), 0) AS s, COUNT(*) AS c FROM reviews WHERE reviewee_user_id = ?',
  )
    .bind(revieweeUserId)
    .first<{ s: number; c: number }>();

  await c.env.DB.prepare(
    `INSERT INTO ratings (user_id, average, count, sum, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET average = excluded.average, count = excluded.count,
       sum = excluded.sum, updated_at = excluded.updated_at`,
  )
    .bind(
      revieweeUserId,
      agg && agg.c > 0 ? agg.s / agg.c : 0,
      agg?.c ?? 0,
      agg?.s ?? 0,
      nowIso(),
    )
    .run();

  await c.env.DB.prepare(
    'UPDATE mechanics SET rating_sum = ?, rating_count = ?, updated_at = ? WHERE user_id = ?',
  )
    .bind(agg?.s ?? 0, agg?.c ?? 0, nowIso(), revieweeUserId)
    .run()
    .catch(() => undefined);

  // The driver's rating lives on the request too — it drives the "Rate this service" button.
  if (isDriver) {
    await c.env.DB.prepare('UPDATE emergency_requests SET rating = ? WHERE id = ?')
      .bind(input.overall, request.id)
      .run()
      .catch(() => undefined);
  }

  await notify(c.env, {
    userId: revieweeUserId,
    type: 'REVIEW_RECEIVED',
    title: 'You received a review',
    body: `${input.overall}/5 — ${input.comment ?? 'Thanks for your feedback!'}`,
    data: { requestId: request.id, reviewId: id },
    requestId: request.id,
  });

  await audit(c.env, {
    actorUserId: user.id,
    actorRole: user.role,
    action: 'REVIEW_CREATED',
    entityType: 'review',
    entityId: id,
    data: { requestId: request.id, overall: input.overall },
    requestId: c.get('requestId'),
  });

  return ok({ review: { id, overall: input.overall } }, c.get('requestId'), 201);
});

/** Reviews attached to a request (or the signed-in user's received reviews). */
routes.get('/', async (c) => {
  const user = await requireUser(c);
  const requestId = c.req.query('requestId');
  const scope = c.req.query('scope');

  if (requestId) {
    const request = await requireRequest(c.env, requestId);
    assertRequestAccess(user, request);
    const rows = await c.env.DB.prepare(
      `SELECT r.*, u.full_name AS reviewee_name FROM reviews r
       JOIN users u ON u.id = r.reviewer_user_id
       WHERE r.request_id = ? ORDER BY r.created_at DESC`,
    )
      .bind(requestId)
      .all();
    return ok({ items: rows.results.map(mapRow) }, c.get('requestId'));
  }

  if (scope === 'mine') {
    const query = parseInput(paginationSchema, c.req.query());
    const rows = await c.env.DB.prepare(
      `SELECT r.*, u.full_name AS reviewee_name FROM reviews r
       JOIN users u ON u.id = r.reviewer_user_id
       WHERE r.reviewee_user_id = ? ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    )
      .bind(user.id, query.limit, query.offset)
      .all();
    return ok({ items: rows.results.map(mapRow) }, c.get('requestId'));
  }

  return ok({ items: [] }, c.get('requestId'));
});

function mapRow(row: unknown) {
  const r = row as {
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
}

export default routes;
