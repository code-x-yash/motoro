import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { getPaymentProvider } from '../lib/payments';
import { markPaymentFailed, settlePaymentFromProvider } from '../lib/payment-service';
import { logger } from '../lib/logger';

const routes = new Hono<{ Bindings: Env }>();

interface RazorpayWebhook {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; error_description?: string } };
    order?: { entity?: { id?: string } };
  };
}

/**
 * Provider webhook (Razorpay). Signature is checked against the raw body
 * before any parsing; settling is idempotent (already-PAID payments no-op).
 */
routes.post('/webhook', async (c) => {
  const raw = await c.req.text();
  const signature = c.req.header('x-razorpay-signature') ?? '';
  const provider = getPaymentProvider(c.env);
  if (!provider.verifyWebhook) {
    throw errors.validation('Webhooks are not supported by the configured payment provider.');
  }
  if (!signature || !provider.verifyWebhook(raw, signature)) {
    logger.warn('webhook', 'invalid_signature', {});
    throw errors.validation('Invalid webhook signature.');
  }

  let event: RazorpayWebhook;
  try {
    event = JSON.parse(raw) as RazorpayWebhook;
  } catch {
    throw errors.validation('Malformed webhook body.');
  }

  const paymentEntity = event.payload?.payment?.entity;
  const orderId = paymentEntity?.order_id ?? event.payload?.order?.entity?.id;
  const paymentId = paymentEntity?.id;

  switch (event.event) {
    case 'payment.captured':
    case 'order.paid': {
      if (orderId) {
        const settled = await settlePaymentFromProvider(c.env, orderId, paymentId);
        logger.info('webhook', 'payment_settled', { orderId, settled });
      }
      break;
    }
    case 'payment.failed': {
      if (orderId) {
        const row = await c.env.DB.prepare(
          `SELECT id FROM payments WHERE provider_ref = ? AND status = 'PENDING' LIMIT 1`,
        )
          .bind(orderId)
          .first<{ id: string }>();
        if (row) {
          await markPaymentFailed(
            c.env,
            row.id,
            paymentEntity?.error_description || 'Payment failed at provider',
          );
        }
      }
      break;
    }
    default:
      logger.info('webhook', 'event_ignored', { event: event.event });
  }

  return ok({ received: true }, c.get('requestId'));
});

export default routes;
