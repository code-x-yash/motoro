import type { Env } from '../env';
import { errors } from './errors';
import { newId, newReference, nowIso } from './ids';
import { logger } from './logger';
import { recordEvent } from './events';
import { notify } from './notify';
import { getRequest, loadRequestDto, setRequestStatus, type RequestRow } from './requests';
import { getPaymentProvider, buildUpiUrl } from './payments';
import { applyCoupon, redeemCoupon } from './coupons';
import { computeMechanicPayout, computeServiceFee } from './pricing';
import { getConfig } from './config';

/**
 * Payment orchestration. Provider details stay behind the PaymentProvider
 * interface; state transitions and audit trail live here.
 */

export async function acceptedAttemptDistanceKm(env: Env, requestId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT distance_km FROM dispatch_attempts
     WHERE request_id = ? AND status = 'ACCEPTED'
     ORDER BY responded_at DESC LIMIT 1`,
  )
    .bind(requestId)
    .first<{ distance_km: number | null }>();
  return row?.distance_km ?? 5;
}

/** Customer-facing total: approved quote (if any) + transparent service fee. */
export async function computeRequestTotal(env: Env, request: RequestRow): Promise<number> {
  const cfg = await getConfig(env);
  const distanceKm = await acceptedAttemptDistanceKm(env, request.id);
  const fee = computeServiceFee(cfg, { distanceKm, urgency: request.urgency as 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL' });
  const quote = await env.DB.prepare(
    `SELECT total_cents FROM quotes WHERE request_id = ? AND status = 'APPROVED'
     ORDER BY decided_at DESC LIMIT 1`,
  )
    .bind(request.id)
    .first<{ total_cents: number }>();
  return (quote?.total_cents ?? 0) + fee.totalCents;
}

export async function ensureInvoice(
  env: Env,
  request: RequestRow,
  totalCents: number,
  opts?: { taxCents?: number; discountCents?: number },
) {
  const existing = await env.DB.prepare(
    'SELECT * FROM invoices WHERE request_id = ? ORDER BY created_at DESC LIMIT 1',
  )
    .bind(request.id)
    .first<Record<string, unknown>>();
  if (existing) return existing;

  // GST is embedded in the approved quote total; the service fee is untaxed.
  const quote = await env.DB.prepare(
    `SELECT tax_cents FROM quotes WHERE request_id = ? AND status = 'APPROVED'
     ORDER BY decided_at DESC LIMIT 1`,
  )
    .bind(request.id)
    .first<{ tax_cents: number }>();
  const discountCents = Math.max(0, opts?.discountCents ?? 0);
  const taxCents = Math.min(opts?.taxCents ?? (quote?.tax_cents ?? 0), totalCents + discountCents);
  // subtotal + tax = the pre-discount base; total = base - discount.
  const subtotalCents = Math.max(0, totalCents + discountCents - taxCents);

  const id = newId();
  const number = `INV-${newReference('').replace('-', '')}`;
  await env.DB.prepare(
    `INSERT INTO invoices (id, number, request_id, subtotal_cents, tax_cents, discount_cents, total_cents, status, issued_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ISSUED', ?, ?)`,
  )
    .bind(id, number, request.id, subtotalCents, taxCents, discountCents, totalCents, nowIso(), nowIso()).run();
  return env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first<Record<string, unknown>>();
}

export interface CreatePaymentOptions {
  method: 'CARD' | 'UPI' | 'NETBANKING' | 'WALLET' | 'CASH';
  actorUserId: string;
  couponCode?: string | null;
}

export interface CheckoutPayload {
  /** Absent = razorpay (legacy shape kept for older clients). */
  kind?: 'razorpay' | 'upi';
  // Razorpay hosted checkout
  key?: string;
  orderId?: string;
  currency?: string;
  name?: string;
  // Direct UPI intent
  upiUrl?: string;
  vpa?: string;
  payeeName?: string;
  amountCents: number;
}

/** Builds the client checkout payload for the configured provider, if any. */
export function buildCheckout(
  env: Env,
  providerName: string,
  providerRef: string | null,
  amountCents: number,
  requestId: string,
): CheckoutPayload | null {
  if (!providerRef) return null;
  if (providerName === 'razorpay' && env.PAYMENT_PROVIDER_KEY) {
    return {
      kind: 'razorpay',
      key: env.PAYMENT_PROVIDER_KEY,
      orderId: providerRef,
      amountCents,
      currency: 'INR',
      name: 'Motoro',
    };
  }
  if (providerName === 'upi') {
    const vpa = env.PAYMENT_UPI_VPA?.trim();
    if (!vpa) return null;
    const payeeName = env.PAYMENT_UPI_NAME?.trim() || 'Motoro';
    return {
      kind: 'upi',
      amountCents,
      vpa,
      payeeName,
      upiUrl: buildUpiUrl({ vpa, payeeName, amountCents, reference: requestId }),
    };
  }
  return null;
}

export async function createPayment(
  env: Env,
  request: RequestRow,
  opts: CreatePaymentOptions,
): Promise<{
  id: string;
  status: string;
  amountCents: number;
  provider: string;
  checkout: CheckoutPayload | null;
}> {
  const fresh = (await getRequest(env, request.id)) ?? request;
  const baseTotalCents = fresh.total_amount_cents ?? (await computeRequestTotal(env, fresh));
  if (baseTotalCents <= 0) throw errors.conflict('NOTHING_TO_PAY', 'There is nothing to pay for this request.');

  // Idempotency: a double-tap or retried request reuses the in-flight payment
  // instead of creating a second order at the provider.
  const wantCoupon = opts.couponCode?.trim() || null;
  const inFlight = await env.DB.prepare(
    `SELECT id, status, amount_cents, provider, provider_ref, method, coupon_code
     FROM payments WHERE request_id = ? AND status IN ('PENDING','AUTHORIZED')
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(fresh.id)
    .first<{
      id: string;
      status: string;
      amount_cents: number;
      provider: string;
      provider_ref: string | null;
      method: string;
      coupon_code: string | null;
    }>();
  if (inFlight && inFlight.method === opts.method && (inFlight.coupon_code ?? null) === wantCoupon) {
    logger.info(fresh.id, 'payment_reused', { paymentId: inFlight.id, status: inFlight.status });
    return {
      id: inFlight.id,
      status: inFlight.status,
      amountCents: inFlight.amount_cents,
      provider: inFlight.provider,
      checkout:
        inFlight.status === 'PENDING'
          ? buildCheckout(env, inFlight.provider, inFlight.provider_ref, inFlight.amount_cents, fresh.id)
          : null,
    };
  }

  // Optional coupon: discount comes off the grand total.
  let couponCode: string | null = null;
  let discountCents = 0;
  if (opts.couponCode?.trim()) {
    const applied = await applyCoupon(env, opts.couponCode, baseTotalCents);
    couponCode = applied.code;
    discountCents = applied.discountCents;
  }
  const totalCents = baseTotalCents - discountCents;

  let invoice = await ensureInvoice(env, fresh, totalCents, { discountCents });
  if (discountCents > 0 && (invoice?.discount_cents as number | undefined) !== discountCents) {
    // Invoice may have been issued before the coupon was applied - update it.
    await env.DB.prepare(
      'UPDATE invoices SET discount_cents = ?, total_cents = ? WHERE id = ?',
    )
      .bind(discountCents, totalCents, invoice?.id as string)
      .run();
    invoice = await env.DB.prepare('SELECT * FROM invoices WHERE id = ?')
      .bind(invoice?.id as string)
      .first<Record<string, unknown>>();
  }

  // Cash never touches the online gateway (works even when keys are absent).
  const isCash = opts.method === 'CASH';
  const provider = isCash ? null : getPaymentProvider(env);

  let providerRef: string;
  let status: 'PENDING' | 'AUTHORIZED' | 'PAID';
  if (isCash) {
    providerRef = `cash_${newId().slice(0, 10)}`;
    status = 'PAID';
  } else {
    try {
      const result = await provider!.createPayment({
        requestId: fresh.id,
        amountCents: totalCents,
        currency: 'INR',
        method: opts.method,
        customerName: fresh.driver_name,
      });
      providerRef = result.providerRef;
      status = result.status;
    } catch (err) {
      if (err instanceof Error && 'code' in err) throw err;
      logger.error(fresh.id, 'payment_provider_failed', { error: String(err) });
      throw errors.unavailable('PAYMENT_PROVIDER_ERROR', 'Payment provider is unavailable.', 502);
    }
  }

  const paymentId = newId();
  const paidAt = status === 'PAID' ? nowIso() : null;
  await env.DB.prepare(
    `INSERT INTO payments (id, request_id, invoice_id, provider, provider_ref, status, amount_cents,
                           currency, method, coupon_code, coupon_discount_cents, created_at, updated_at, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      paymentId,
      fresh.id,
      (invoice?.id as string) ?? null,
      isCash ? 'cash' : provider!.name,
      providerRef,
      status,
      totalCents,
      opts.method,
      couponCode,
      discountCents,
      nowIso(),
      nowIso(),
      paidAt,
    )
    .run();

  await env.DB.prepare(
    `UPDATE emergency_requests
     SET total_amount_cents = ?, coupon_code = ?, coupon_discount_cents = ?, updated_at = ?
     WHERE id = ?`,
  )
    .bind(totalCents, couponCode, discountCents, nowIso(), fresh.id)
    .run();

  if (status === 'PAID') {
    await finalizePaid(env, fresh, paymentId, totalCents, opts.actorUserId);
  } else if (fresh.status === 'COMPLETED') {
    await setRequestStatus(env, fresh, 'PAYMENT_PENDING', {
      actorRole: 'SYSTEM',
      message: 'Payment pending',
      extra: { payment_status: 'PENDING', total_amount_cents: totalCents },
    });
  }

  await recordEvent(env, {
    requestId: fresh.id,
    type: 'PAYMENT_CREATED',
    message: `Payment of ₹${Math.round(totalCents / 100)} created via ${opts.method}`,
    actorRole: 'DRIVER',
    actorUserId: opts.actorUserId,
    data: { paymentId, provider: isCash ? 'cash' : provider!.name, status },
  });

  const checkout: CheckoutPayload | null =
    !isCash && status !== 'PAID'
      ? buildCheckout(env, provider!.name, providerRef, totalCents, fresh.id)
      : null;

  return {
    id: paymentId,
    status,
    amountCents: totalCents,
    provider: isCash ? 'cash' : provider!.name,
    checkout,
  };
}

interface VerifyCheckoutInput {
  orderId: string;
  paymentId: string;
  signature: string;
  actorUserId: string;
}

/** Confirms a Razorpay checkout completion (signature check + capture). */
export async function verifyPaymentCheckout(
  env: Env,
  request: RequestRow,
  input: VerifyCheckoutInput,
): Promise<{ paymentId: string; status: string }> {
  const provider = getPaymentProvider(env);
  if (!provider.verifyCheckout) {
    throw errors.unavailable('PAYMENT_NOT_SUPPORTED', 'This provider does not support checkout verification.', 501);
  }

  const payment = await env.DB.prepare(
    `SELECT * FROM payments WHERE request_id = ? AND provider_ref = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(request.id, input.orderId)
    .first<{ id: string; status: string; amount_cents: number }>();
  if (!payment) throw errors.notFound('Payment not found.');
  if (payment.status === 'PAID') return { paymentId: payment.id, status: 'PAID' };
  if (payment.status !== 'PENDING') {
    throw errors.conflict('PAYMENT_NOT_PENDING', 'This payment is no longer pending.');
  }

  const valid = provider.verifyCheckout(input.orderId, input.paymentId, input.signature);
  if (!valid) {
    await env.DB.prepare(
      `UPDATE payments SET status = 'FAILED', failure_reason = ?, updated_at = ? WHERE id = ?`,
    ).bind('Invalid checkout signature', nowIso(), payment.id).run();
    throw errors.validation('Payment verification failed.');
  }

  const captured = provider.capture ? await provider.capture(input.orderId, payment.amount_cents) : { status: 'PAID' as const };
  if (captured.status !== 'PAID') {
    throw errors.unavailable('PAYMENT_CAPTURE_FAILED', 'Payment could not be captured. Please try again.');
  }

  await env.DB.prepare('UPDATE payments SET provider_payment_id = ?, updated_at = ? WHERE id = ?')
    .bind(input.paymentId, nowIso(), payment.id)
    .run();

  const fresh = (await getRequest(env, request.id)) ?? request;
  await finalizePaid(env, fresh, payment.id, payment.amount_cents, input.actorUserId);
  return { paymentId: payment.id, status: 'PAID' };
}

export async function markPaymentFailed(env: Env, paymentId: string, reason: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE payments SET status = 'FAILED', failure_reason = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'`,
  )
    .bind(reason, nowIso(), paymentId)
    .run();
}

/** Settles a PENDING payment from a verified webhook (fire-and-forget safe). */
export async function settlePaymentFromProvider(
  env: Env,
  providerRef: string,
  providerPaymentId?: string,
): Promise<boolean> {
  const payment = await env.DB.prepare(
    `SELECT * FROM payments WHERE provider_ref = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(providerRef)
    .first<{ id: string; request_id: string; status: string; amount_cents: number }>();
  if (!payment || payment.status === 'PAID') return false;
  if (payment.status !== 'PENDING') return false;

  if (providerPaymentId) {
    await env.DB.prepare('UPDATE payments SET provider_payment_id = ?, updated_at = ? WHERE id = ?')
      .bind(providerPaymentId, nowIso(), payment.id)
      .run();
  }
  const fresh = await getRequest(env, payment.request_id);
  if (!fresh) return false;
  await finalizePaid(env, fresh, payment.id, payment.amount_cents);
  return true;
}

/** Cron: settle or fail PENDING online payments using provider-side status. */
export async function reconcilePendingPayments(env: Env): Promise<void> {
  const provider = (env.PAYMENT_PROVIDER || 'test').toLowerCase();
  if (provider !== 'razorpay') return;

  const pending = await env.DB.prepare(
    `SELECT p.id, p.request_id, p.provider_ref, p.amount_cents, p.created_at FROM payments p
     WHERE p.status = 'PENDING' AND p.provider = 'razorpay'
       AND p.created_at < datetime('now', '-60 seconds')
     ORDER BY p.created_at LIMIT 20`,
  )
    .all<{ id: string; request_id: string; provider_ref: string | null; amount_cents: number; created_at: string }>();

  let gateway;
  try {
    gateway = getPaymentProvider(env);
  } catch {
    return; // Keys not configured — nothing to reconcile against.
  }
  if (!gateway.fetchStatus) return;

  for (const row of pending.results) {
    if (!row.provider_ref) continue;
    try {
      const state = await gateway.fetchStatus(row.provider_ref);
      if (state.paid) {
        if (state.paymentId) {
          await env.DB.prepare('UPDATE payments SET provider_payment_id = ?, updated_at = ? WHERE id = ?')
            .bind(state.paymentId, nowIso(), row.id)
            .run();
        }
        const fresh = await getRequest(env, row.request_id);
        if (fresh) {
          await finalizePaid(env, fresh, row.id, row.amount_cents);
          logger.info(fresh.id, 'payment_reconciled_paid', { paymentId: row.id });
        }
      } else if (state.failed) {
        await markPaymentFailed(env, row.id, 'Payment failed at provider');
        logger.warn('reconcile', 'payment_reconciled_failed', { paymentId: row.id });
      }
    } catch (err) {
      logger.warn('reconcile', 'payment_reconcile_error', { paymentId: row.id, error: String(err) });
    }
  }
}

export async function finalizePaid(
  env: Env,
  request: RequestRow,
  paymentId: string,
  totalCents: number,
  actorUserId?: string,
): Promise<void> {
  const cfg = await getConfig(env);
  const payout = computeMechanicPayout(totalCents, cfg.pricing.platformFeePercent);

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE payments SET status = 'PAID', paid_at = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(nowIso(), nowIso(), paymentId),
    env.DB.prepare(`UPDATE invoices SET status = 'PAID', paid_at = ? WHERE request_id = ?`)
      .bind(nowIso(), request.id),
    env.DB.prepare(
      `UPDATE emergency_requests SET payment_status = 'PAID', updated_at = ? WHERE id = ?`,
    )
      .bind(nowIso(), request.id),
  ]);

  // Burn a coupon redemption now that the money has landed.
  const settledPayment = await env.DB.prepare('SELECT coupon_code FROM payments WHERE id = ?')
    .bind(paymentId)
    .first<{ coupon_code: string | null }>();
  if (settledPayment?.coupon_code) {
    await redeemCoupon(env, settledPayment.coupon_code);
  }

  if (request.assigned_mechanic_user_id) {
    await env.DB.prepare(
      `UPDATE mechanics SET earnings_cents = earnings_cents + ?, updated_at = ? WHERE user_id = ?`,
    )
      .bind(payout.payoutCents, nowIso(), request.assigned_mechanic_user_id).run();
    await env.DB.prepare(
      `UPDATE jobs SET earnings_cents = ?, updated_at = ? WHERE request_id = ? AND deleted_at IS NULL`,
    )
      .bind(payout.payoutCents, nowIso(), request.id).run();
  }

  const fresh = await getRequest(env, request.id);
  // Never resurrect a cancelled/failed request — its fee payment only marks
  // payment_status. Active requests advance to PAID.
  if (fresh && ['COMPLETED', 'PAYMENT_PENDING'].includes(fresh.status)) {
    await setRequestStatus(env, fresh, 'PAID', {
      actorRole: 'SYSTEM',
      actorUserId: actorUserId ?? null,
      message: 'Payment completed',
      extra: { payment_status: 'PAID' },
    });
  }

  await recordEvent(env, {
    requestId: request.id,
    type: 'PAYMENT_COMPLETED',
    message: `Payment of ₹${Math.round(totalCents / 100)} received`,
    data: { paymentId, totalCents, payoutCents: payout.payoutCents },
  });

  await notify(env, {
    userId: request.driver_user_id,
    type: 'PAYMENT_COMPLETED',
    title: 'Payment successful',
    body: `₹${Math.round(totalCents / 100)} paid. Your invoice is ready.`,
    data: { requestId: request.id, paymentId },
    requestId: request.id,
  });

  if (request.assigned_mechanic_user_id) {
    await notify(env, {
      userId: request.assigned_mechanic_user_id,
      type: 'PAYMENT_COMPLETED',
      title: 'Job paid',
      body: `₹${Math.round(payout.payoutCents / 100)} added to your earnings.`,
      data: { requestId: request.id },
      requestId: request.id,
    });
  }

  await loadRequestDto(env, request.id).catch(() => undefined);
}
