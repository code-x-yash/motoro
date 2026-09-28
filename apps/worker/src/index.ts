import { createApp } from './app';
import type { Env } from './env';
import { runDispatchSweeps } from './dispatch/service';
import { logger } from './lib/logger';
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
        await runDispatchSweeps(env);
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
      const channels = (body.channels as string[]) ?? [];
      const configured = channels.filter((c) => providerConfigured(env, c));
      if (configured.length === 0) {
        logger.info('queue', 'notification_dev_adapter', {
          channel: channels.join(','),
          type: body.type,
        });
        return;
      }
      // Real provider adapters (email/SMS/WhatsApp) plug in here. Credentials
      // are read from environment variables only — never from the client.
      logger.info('queue', 'notification_provider_dispatch', {
        channels: configured.join(','),
        type: body.type,
      });
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

function providerConfigured(env: Env, channel: string): boolean {
  const map: Record<string, undefined | string> = {
    EMAIL: (env as unknown as { EMAIL_PROVIDER_KEY?: string }).EMAIL_PROVIDER_KEY,
    SMS: (env as unknown as { SMS_PROVIDER_KEY?: string }).SMS_PROVIDER_KEY,
    WHATSAPP: (env as unknown as { WHATSAPP_PROVIDER_KEY?: string }).WHATSAPP_PROVIDER_KEY,
  };
  return Boolean(map[channel]);
}
