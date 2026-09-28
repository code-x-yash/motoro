import type { Role } from '@rr/types';
import type { Env } from '../env';
import { newId, nowIso } from './ids';
import { logger } from './logger';
import { broadcast, requestRoom, OPS_ROOM } from './realtime';

export interface EventInput {
  requestId: string;
  type: string;
  message: string;
  actorRole?: Role | 'SYSTEM' | null;
  actorUserId?: string | null;
  data?: Record<string, unknown> | null;
  /** Push the event to the operations room as well (default true). */
  toOps?: boolean;
}

/** Append to the immutable emergency timeline and fan out over realtime. */
export async function recordEvent(env: Env, input: EventInput): Promise<string> {
  const id = newId();
  const createdAt = nowIso();
  try {
    await env.DB.prepare(
      `INSERT INTO emergency_events (id, request_id, type, message, actor_role, actor_user_id, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        input.requestId,
        input.type,
        input.message,
        input.actorRole ?? null,
        input.actorUserId ?? null,
        input.data ? JSON.stringify(input.data) : null,
        createdAt,
      )
      .run();
  } catch (err) {
    logger.error('event', 'event_insert_failed', { requestId: input.requestId, error: String(err) });
  }

  const payload = {
    id,
    requestId: input.requestId,
    type: input.type,
    message: input.message,
    actorRole: input.actorRole ?? null,
    actorUserId: input.actorUserId ?? null,
    data: input.data ?? null,
    createdAt,
  };

  await broadcast(env, requestRoom(input.requestId), { type: 'request.event', payload });
  if (input.toOps !== false) {
    await broadcast(env, OPS_ROOM, { type: 'request.event', payload });
  }
  return id;
}
