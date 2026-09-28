import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser } from '../lib/auth';
import { parseInput } from '../lib/validate';
import { paginationSchema } from '@rr/validation';
import { mapNotification } from '../lib/mappers';
import { nowIso } from '../lib/ids';

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

export default routes;
