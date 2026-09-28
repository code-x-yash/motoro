import type { Env } from '../env';
import { errors } from './errors';
import { newId, newReference, nowIso } from './ids';
import { logger } from './logger';
import { recordEvent } from './events';
import { notify } from './notify';
import { getRequest, loadRequestDto, setRequestStatus, type RequestRow } from './requests';
import { getPaymentProvider } from './payments';
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

export async function ensureInvoice(env: Env, request: RequestRow, totalCents: number) {
  const existing = await env.DB.prepare(
    'SELECT * FROM invoices WHERE request_id = ? ORDER BY created_at DESC LIMIT 1',
  )
    .bind(request.id)
    .first<Record<string, unknown>>();
  if (existing) return existing;

  const id = newId();
  const number = `INV-${newReference('').replace('-', '')}`;
  await env.DB.prepare(
    `INSERT INTO invoices (id, number, request_id, subtotal_cents, tax_cents, total_cents, status, issued_at, created_at)
     VALUES (?, ?, ?, ?, 0, ?, 'ISSUED', ?, ?)`,
  )
    .bind(id, number, request.id, totalCents, totalCents, nowIso(), nowIso()).run();
  return env.DB.prepare('SELECT * FROM invoices WHERE id = ?').bind(id).first<Record<string, unknown>>();
}

export interface CreatePaymentOptions {
  method: 'CARD' | 'UPI' | 'NETBANKING' | 'WALLET' | 'CASH';
  actorUserId: string;
}

export async function createPayment(
  env: Env,
  request: RequestRow,
  opts: CreatePaymentOptions,
): Promise<{ id: string; status: string; amountCents: number; provider: string }> {
  const fresh = (await getRequest(env, request.id)) ?? request;
  const totalCents = fresh.total_amount_cents ?? (await computeRequestTotal(env, fresh));
  if (totalCents <= 0) throw errors.conflict('NOTHING_TO_PAY', 'There is nothing to pay for this request.');

  const invoice = await ensureInvoice(env, fresh, totalCents);
  const provider = getPaymentProvider(env);

  let providerRef: string;
  let status: 'PENDING' | 'AUTHORIZED' | 'PAID';
  try {
    const result = await provider.createPayment({
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

  const paymentId = newId();
  const paidAt = status === 'PAID' ? nowIso() : null;
  await env.DB.prepare(
    `INSERT INTO payments (id, request_id, invoice_id, provider, provider_ref, status, amount_cents,
                           currency, method, created_at, updated_at, paid_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?, ?)`,
  )
    .bind(
      paymentId,
      fresh.id,
      (invoice?.id as string) ?? null,
      provider.name,
      providerRef,
      status,
      totalCents,
      opts.method,
      nowIso(),
      nowIso(),
      paidAt,
    )
    .run();

  await env.DB.prepare('UPDATE emergency_requests SET total_amount_cents = ?, updated_at = ? WHERE id = ?')
    .bind(totalCents, nowIso(), fresh.id)
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
    data: { paymentId, provider: provider.name, status },
  });

  return { id: paymentId, status, amountCents: totalCents, provider: provider.name };
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
  if (fresh && fresh.status !== 'PAID') {
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
    message: `Payment completed — ₹${Math.round(totalCents / 100)}`,
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
