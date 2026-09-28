import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser, type AuthUser } from '../lib/auth';
import { randomToken } from '../lib/crypto';

const routes = new Hono<{ Bindings: Env }>();

async function assertRoomAccess(env: Env, user: AuthUser, room: string): Promise<void> {
  if (room === 'ops') {
    if (user.role !== 'OPERATIONS' && user.role !== 'ADMIN') throw errors.forbidden();
    return;
  }
  if (room.startsWith('user:')) {
    if (room !== `user:${user.id}` && user.role !== 'ADMIN') throw errors.forbidden();
    return;
  }
  if (room.startsWith('mechanic:')) {
    if (room !== `mechanic:${user.id}` && !['ADMIN', 'OPERATIONS'].includes(user.role)) {
      throw errors.forbidden();
    }
    return;
  }
  if (room.startsWith('request:')) {
    const requestId = room.slice('request:'.length);
    const row = await env.DB.prepare(
      'SELECT driver_user_id, assigned_mechanic_user_id FROM emergency_requests WHERE id = ?',
    )
      .bind(requestId)
      .first<{ driver_user_id: string; assigned_mechanic_user_id: string | null }>();
    if (!row) throw errors.notFound('Request not found.');
    if (
      row.driver_user_id === user.id ||
      row.assigned_mechanic_user_id === user.id ||
      ['ADMIN', 'OPERATIONS'].includes(user.role)
    ) {
      return;
    }
    throw errors.forbidden('You cannot subscribe to this session.');
  }
  throw errors.validation('Unknown room.');
}

/**
 * One-time-ish WebSocket tickets. The session cookie is never sent over the
 * socket URL; the ticket expires quickly and is bound to a room + user.
 */
routes.get('/ticket', async (c) => {
  const user = await requireUser(c);
  const room = c.req.query('room') ?? '';
  if (!room) throw errors.validation('room query parameter is required.');
  await assertRoomAccess(c.env, user, room);

  const ticket = randomToken(24);
  const ttlSeconds = 120;
  await c.env.KV.put(
    `ws_ticket:${ticket}`,
    JSON.stringify({ room, userId: user.id, role: user.role, exp: Date.now() + ttlSeconds * 1000 }),
    { expirationTtl: ttlSeconds },
  );

  const url = new URL(c.req.url);
  const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const connectUrl = `${wsProtocol}//${url.host}/api/realtime/connect?ticket=${encodeURIComponent(ticket)}`;

  return ok({ ticket, connectUrl, expiresIn: ttlSeconds }, c.get('requestId'));
});

/** WebSocket upgrade proxy to the Emergency Room Durable Object. */
routes.get('/connect', async (c) => {
  const upgrade = c.req.header('Upgrade') ?? c.req.header('upgrade');
  if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
    throw errors.validation('WebSocket upgrade required.');
  }
  const room = c.req.query('room');
  const url = new URL(c.req.url);
  const doUrl = new URL(`/connect?ticket=${encodeURIComponent(c.req.query('ticket') ?? '')}`, url.origin);
  if (room) doUrl.searchParams.set('room', room);

  // Route to the Durable Object instance named after the room.
  const ticket = c.req.query('ticket') ?? '';
  const roomFromTicket = await roomForTicket(c.env, ticket);
  if (!roomFromTicket) return errors.unauthorized('Invalid ticket.') as unknown as Response;

  const id = c.env.EMERGENCY_ROOM.idFromName(roomFromTicket);
  const stub = c.env.EMERGENCY_ROOM.get(id);
  const response = await stub.fetch(
    new Request(doUrl.toString(), {
      headers: c.req.raw.headers,
      method: 'GET',
    }),
  );
  return response;
});

async function roomForTicket(env: Env, ticket: string): Promise<string | null> {
  if (!ticket) return null;
  const raw = await env.KV.get(`ws_ticket:${ticket}`, 'json');
  if (!raw) return null;
  return (raw as { room: string }).room;
}

export default routes;
