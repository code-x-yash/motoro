import type { NotificationChannel } from '@rr/types';
import type { Env } from '../env';
import { newId, nowIso } from './ids';
import { logger } from './logger';
import { broadcast, userRoom } from './realtime';

export interface NotificationInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown> | null;
  /** Extra channels to attempt after IN_APP (provider optional). */
  channels?: NotificationChannel[];
  requestId?: string;
}

export const IMPORTANT_EVENTS = [
  'EMERGENCY_CREATED',
  'MECHANIC_FOUND',
  'MECHANIC_ACCEPTED',
  'MECHANIC_DELAYED',
  'MECHANIC_ARRIVED',
  'QUOTE_CREATED',
  'QUOTE_APPROVED',
  'REPAIR_COMPLETED',
  'PAYMENT_COMPLETED',
  'MECHANIC_REASSIGNED',
  'EMERGENCY_ESCALATED',
  'JOB_OFFER',
  'DISPATCH_TIMEOUT',
  'OTP_CREATED',
] as const;

export type ImportantEvent = (typeof IMPORTANT_EVENTS)[number];

/**
 * Notification abstraction. IN_APP is always persisted and pushed over the
 * realtime user room; EMAIL / SMS / WHATSAPP are queued and delivered only
 * when a provider is configured (clean provider interface, no fake sends).
 */
export async function notify(env: Env, input: NotificationInput): Promise<string> {
  const id = newId();
  try {
    await env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, title, body, data_json, channel, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'IN_APP', ?)`,
    )
      .bind(
        id,
        input.userId,
        input.type,
        input.title,
        input.body,
        input.data ? JSON.stringify(input.data) : null,
        nowIso(),
      )
      .run();
  } catch (err) {
    logger.warn(input.requestId ?? 'notify', 'notification_insert_failed', {
      type: input.type,
      error: String(err),
    });
  }

  await broadcast(env, userRoom(input.userId), {
    type: 'notification',
    payload: {
      id,
      type: input.type,
      title: input.title,
      body: input.body,
      data: input.data ?? null,
      createdAt: nowIso(),
    },
  });

  const channels = (input.channels ?? []).filter((c) => c !== 'IN_APP');
  if (channels.length > 0) {
    try {
      await env.TASKS.send({
        kind: 'notification.dispatch',
        notificationId: id,
        userId: input.userId,
        type: input.type,
        title: input.title,
        body: input.body,
        channels,
        data: input.data ?? null,
      });
    } catch (err) {
      logger.warn(input.requestId ?? 'notify', 'notification_enqueue_failed', {
        type: input.type,
        error: String(err),
      });
    }
  }

  return id;
}
