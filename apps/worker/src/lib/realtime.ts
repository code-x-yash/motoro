import type { RealtimeServerMessage } from '@rr/types';
import type { Env } from '../env';
import { logger } from './logger';

/**
 * Real-time fan-out through Durable Objects.
 *
 * Room names:
 *   requestId            -> active emergency session (driver + mechanic + ops)
 *   ops                  -> operations command centre
 *   user:{userId}        -> per-user notification channel
 *   mechanic:{userId}    -> per-mechanic dispatch feed
 */

export function requestRoom(requestId: string): string {
  return `request:${requestId}`;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function mechanicRoom(userId: string): string {
  return `mechanic:${userId}`;
}

export const OPS_ROOM = 'ops';

function stubFor(env: Env, room: string): DurableObjectStub {
  const id = env.EMERGENCY_ROOM.idFromName(room);
  return env.EMERGENCY_ROOM.get(id);
}

export async function broadcast(
  env: Env,
  room: string,
  message: Omit<RealtimeServerMessage, 'at'>,
): Promise<void> {
  try {
    const stub = stubFor(env, room);
    const payload: RealtimeServerMessage = { ...message, at: new Date().toISOString() };
    await stub.fetch(
      new Request('https://room.internal/broadcast', {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json' },
      }),
    );
  } catch (err) {
    logger.warn('realtime', 'broadcast_failed', { room, error: String(err) });
  }
}

export async function setRoomAlarm(
  env: Env,
  room: string,
  epochMs: number,
): Promise<void> {
  try {
    const stub = stubFor(env, room);
    await stub.fetch(
      new Request(`https://room.internal/alarm?at=${epochMs}`, { method: 'POST' }),
    );
  } catch (err) {
    logger.warn('realtime', 'set_alarm_failed', { room, error: String(err) });
  }
}

export async function clearRoomAlarm(env: Env, room: string): Promise<void> {
  try {
    const stub = stubFor(env, room);
    await stub.fetch(new Request('https://room.internal/alarm?clear=1', { method: 'POST' }));
  } catch (err) {
    logger.warn('realtime', 'clear_alarm_failed', { room, error: String(err) });
  }
}

/** Ask a room to push its current state snapshot to a newly connected client. */
export async function requestRoomSync(env: Env, room: string): Promise<void> {
  try {
    const stub = stubFor(env, room);
    await stub.fetch(new Request('https://room.internal/sync', { method: 'POST' }));
  } catch (err) {
    logger.warn('realtime', 'room_sync_failed', { room, error: String(err) });
  }
}
