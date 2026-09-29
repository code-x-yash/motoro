import { createApp } from './app';
import type { Env } from './env';
import { runDispatchSweeps } from './dispatch/service';
import { reconcilePendingPayments } from './lib/payment-service';
import { logger } from './lib/logger';
import { deliver } from './lib/delivery';
import { EmergencyRoom } from './do/emergency-room';

const app = createApp();

export { EmergencyRoom };

export interface QueueMessage {
  kind: string;
  [key: string]: unknown;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleMessage(env, message.body);
        message.ack();
      } catch (err) {
        logger.error('queue', 'message_failed', {
          kind: message.body?.kind,
          error: String(err),
        });
        if (message.attempts >= 3) message.retry({ delaySeconds: 60 });
        else message.retry();
      }
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        logger.info('cron', 'dispatch_sweep_start', { cron: event.cron });
        try {
          await runDispatchSweeps(env);
        } catch (err) {
          logger.error('cron', 'dispatch_sweep_failed', { error: String(err) });
        }
        await reconcilePendingPayments(env).catch((err) =>
          logger.error('cron', 'payment_reconcile_failed', { error: String(err) }),
        );
      })(),
    );
  },
};

/**
 * Background tasks. Notifications, analytics and file processing never block
 * the customer-facing request path.
 */
async function handleMessage(env: Env, body: QueueMessage): Promise<void> {
  switch (body.kind) {
    case 'notification.dispatch': {
      await deliver(env, body as unknown as Parameters<typeof deliver>[1]);
      return;
    }
    case 'analytics.event': {
      logger.info('queue', 'analytics_event', { event: body.event });
      return;
    }
    case 'file.process': {
      logger.info('queue', 'file_process', { key: body.key });
      return;
    }
    case 'dispatch.retry': {
      await runDispatchSweeps(env);
      return;
    }
    default:
      logger.warn('queue', 'unknown_message_kind', { kind: body.kind });
  }
}
