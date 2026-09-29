import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser } from '../lib/auth';
import { parseInput } from '../lib/validate';
import { paginationSchema, pushSubscriptionSchema } from '@rr/validation';
import { mapNotification } from '../lib/mappers';
import { newId, nowIso } from '../lib/ids';
import { getVapidPublicKeyB64 } from '../lib/webpush';

const routes = new Hono<{ Bindings: Env }>();

routes.get('/', async (c) => {
  const user = await requireUser(c);
  const query = parseInput(paginationSchema, c.req.query());
  const rows = await c.env.DB.prepare(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
  )
    .bind(user.id, query.limit, query.offset)
    .all();
  const unread = await c.env.DB.prepare(
    'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL',
  )
    .bind(user.id)
    .first<{ c: number }>();
  return ok(
    {
      items: rows.results.map((r) => mapNotification(r as never)),
      unreadCount: unread?.c ?? 0,
      limit: query.limit,
      offset: query.offset,
    },
    c.get('requestId'),
  );
});

routes.get('/unread-count', async (c) => {
  const user = await requireUser(c);
  const row = await c.env.DB.prepare(
    'SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL',
  )
    .bind(user.id)
    .first<{ c: number }>();
  return ok({ unreadCount: row?.c ?? 0 }, c.get('requestId'));
});

routes.post('/:id/read', async (c) => {
  const user = await requireUser(c);
  const result = await c.env.DB.prepare(
    'UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL',
  )
    .bind(nowIso(), c.req.param('id'), user.id)
    .run();
  if (result.meta.changes === 0) {
    const exists = await c.env.DB.prepare('SELECT id FROM notifications WHERE id = ? AND user_id = ?')
      .bind(c.req.param('id'), user.id)
      .first();
    if (!exists) throw errors.notFound('Notification not found.');
  }
  return ok({ read: true }, c.get('requestId'));
});

routes.post('/read-all', async (c) => {
  const user = await requireUser(c);
  await c.env.DB.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
    .bind(nowIso(), user.id)
    .run();
  return ok({ read: true }, c.get('requestId'));
});

// ---------------------------------------------------------------------------
// Web Push subscriptions
// ---------------------------------------------------------------------------

/** VAPID public key for `PushManager.subscribe({ applicationServerKey })`. */
routes.get('/vapid-public-key', async (c) => {
  await requireUser(c);
  return ok({ publicKey: await getVapidPublicKeyB64(c.env) }, c.get('requestId'));
});

routes.post('/push-subscriptions', async (c) => {
  const user = await requireUser(c);
  const input = parseInput(pushSubscriptionSchema, await c.req.json().catch(() => ({})));
  const now = nowIso();
  const existing = await c.env.DB.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?')
    .bind(input.endpoint)
    .first<{ id: string }>();
  if (existing) {
    await c.env.DB.prepare(
      'UPDATE push_subscriptions SET user_id = ?, p256dh = ?, auth = ?, last_seen_at = ? WHERE id = ?',
    )
      .bind(user.id, input.keys.p256dh, input.keys.auth, now, existing.id)
      .run();
    return ok({ subscription: { id: existing.id, endpoint: input.endpoint } }, c.get('requestId'));
  }
  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      user.id,
      input.endpoint,
      input.keys.p256dh,
      input.keys.auth,
      (c.req.header('user-agent') ?? '').slice(0, 300),
      now,
      now,
    )
    .run();

  // Keep at most 10 endpoints per user (oldest dropped first).
  await c.env.DB.prepare(
    `DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
       SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 10)`,
  )
    .bind(user.id, user.id)
    .run();

  return ok({ subscription: { id, endpoint: input.endpoint } }, c.get('requestId'), 201);
});

routes.get('/push-subscriptions', async (c) => {
  const user = await requireUser(c);
  const rows = await c.env.DB.prepare(
    'SELECT id, endpoint, created_at, last_seen_at FROM push_subscriptions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 20',
  )
    .bind(user.id)
    .all<{ id: string; endpoint: string; created_at: string; last_seen_at: string }>();
  return ok(
    {
      items: rows.results.map((r) => ({
        id: r.id,
        endpoint: r.endpoint,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
      })),
    },
    c.get('requestId'),
  );
});

routes.delete('/push-subscriptions', async (c) => {
  const user = await requireUser(c);
  const body = (await c.req.json().catch(() => ({}))) as { endpoint?: string };
  if (!body.endpoint) throw errors.validation('endpoint is required.');
  const result = await c.env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .bind(body.endpoint, user.id)
    .run();
  return ok({ removed: result.meta.changes > 0 }, c.get('requestId'));
});

export default routes;
