import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Env } from '../env';
import { isProduction } from '../env';
import { AppError } from './errors';
import { newId } from './ids';

/**
 * Payment abstraction. Business logic never depends on a concrete provider.
 */

export interface CreatePaymentInput {
  requestId: string;
  amountCents: number;
  currency: string;
  method: 'CARD' | 'UPI' | 'NETBANKING' | 'WALLET' | 'CASH';
  customerName?: string;
  metadata?: Record<string, string>;
}

export interface CreatePaymentResult {
  providerRef: string;
  status: 'PENDING' | 'AUTHORIZED' | 'PAID';
  redirectUrl?: string;
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  capture?(providerRef: string, amountCents: number): Promise<{ status: 'PAID' | 'FAILED' }>;
  refund?(providerRef: string, amountCents: number): Promise<{ status: 'REFUNDED' | 'FAILED' }>;
  /** Verify a checkout completion signature (order|payment HMAC). */
  verifyCheckout?(orderId: string, paymentId: string, signature: string): boolean;
  /** Verify a webhook body signature (raw body HMAC). */
  verifyWebhook?(rawBody: string, signature: string): boolean;
  /** Current provider-side status for a stored reference. */
  fetchStatus?(providerRef: string): Promise<{ paid: boolean; failed: boolean; paymentId?: string }>;
}

/** Sandbox provider for development only. Enabled explicitly via PAYMENT_PROVIDER=test. */
export class TestPaymentProvider implements PaymentProvider {
  readonly name = 'test';

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (input.method === 'CASH') {
      return { providerRef: `cash_${newId().slice(0, 8)}`, status: 'PAID' };
    }
    return {
      providerRef: `test_pay_${newId().slice(0, 12)}`,
      status: 'PAID',
    };
  }

  async refund(_providerRef: string, _amountCents: number): Promise<{ status: 'REFUNDED' | 'FAILED' }> {
    return { status: 'REFUNDED' };
  }
}

/** Razorpay provider — orders, checkout verification, capture, refunds, webhooks. */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay';
  private keyId: string;
  private keySecret: string;
  private webhookSecret: string;

  constructor(keyId: string, keySecret: string, webhookSecret?: string) {
    this.keyId = keyId;
    this.keySecret = keySecret;
    this.webhookSecret = webhookSecret?.trim() || keySecret;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`https://api.razorpay.com/v1${path}`, {
      ...init,
      headers: {
        authorization: `Basic ${btoa(`${this.keyId}:${this.keySecret}`)}`,
        'content-type': 'application/json',
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new AppError('PAYMENT_PROVIDER_ERROR', 'Payment provider rejected the request.', 502, {
        provider: 'razorpay',
        detail: text.slice(0, 300),
      });
    }
    return (await res.json()) as T;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const order = await this.call<{ id: string; status: string }>('/orders', {
      method: 'POST',
      body: JSON.stringify({
        amount: input.amountCents,
        currency: input.currency,
        receipt: input.requestId,
        notes: { requestId: input.requestId, method: input.method },
      }),
    });
    return {
      providerRef: order.id,
      status: order.status === 'paid' ? 'PAID' : 'PENDING',
    };
  }

  verifyCheckout(orderId: string, paymentId: string, signature: string): boolean {
    const expected = createHmac('sha256', this.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  verifyWebhook(rawBody: string, signature: string): boolean {
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    if (expected.length !== signature.length) return false;
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  async capture(providerRef: string, amountCents: number): Promise<{ status: 'PAID' | 'FAILED' }> {
    try {
      const payments = await this.call<{ items: { id: string; status: string }[] }>(
        `/orders/${providerRef}/payments`,
      );
      const payment = payments.items?.[0];
      if (!payment) return { status: 'FAILED' };
      if (payment.status === 'captured') return { status: 'PAID' };
      await this.call(`/payments/${payment.id}/capture`, {
        method: 'POST',
        body: JSON.stringify({ amount: amountCents, currency: 'INR' }),
      });
      return { status: 'PAID' };
    } catch {
      return { status: 'FAILED' };
    }
  }

  async fetchStatus(providerRef: string): Promise<{ paid: boolean; failed: boolean; paymentId?: string }> {
    try {
      const order = await this.call<{ status: string }>(`/orders/${providerRef}`);
      if (order.status === 'paid') return { paid: true, failed: false };
      const payments = await this.call<{ items: { id: string; status: string }[] }>(
        `/orders/${providerRef}/payments`,
      );
      const payment = payments.items?.[0];
      if (!payment) return { paid: false, failed: order.status === 'failed' };
      return {
        paid: payment.status === 'captured',
        failed: payment.status === 'failed' || payment.status === 'expired',
        paymentId: payment.id,
      };
    } catch {
      return { paid: false, failed: false };
    }
  }

  async refund(providerRef: string, amountCents: number): Promise<{ status: 'REFUNDED' | 'FAILED' }> {
    try {
      const payments = await this.call<{ items: { id: string; status: string }[] }>(
        `/orders/${providerRef}/payments`,
      );
      const paymentId = payments.items?.[0]?.id;
      if (!paymentId) return { status: 'FAILED' };
      await this.call('/refunds', {
        method: 'POST',
        body: JSON.stringify({ payment_id: paymentId, amount: amountCents }),
      });
      return { status: 'REFUNDED' };
    } catch {
      return { status: 'FAILED' };
    }
  }
}

/**
 * Free direct-to-account UPI provider: no aggregator, no fees, no KYC.
 * `createPayment` returns a pre-filled `upi://pay` intent; money lands
 * directly in the configured VPA. Confirmation is manual — the customer
 * claims payment (with optional UPI reference) and ops settles from the
 * admin console after checking the bank credit.
 */
export class UpiPaymentProvider implements PaymentProvider {
  readonly name = 'upi';
  private vpa: string;
  private payeeName: string;

  constructor(vpa: string, payeeName: string) {
    this.vpa = vpa;
    this.payeeName = payeeName;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    return {
      providerRef: `upi_${newId().slice(0, 12)}`,
      status: 'PENDING',
      redirectUrl: buildUpiUrl({
        vpa: this.vpa,
        payeeName: this.payeeName,
        amountCents: input.amountCents,
        reference: input.requestId,
      }),
    };
  }
}

/** Pre-filled UPI deep link (works in any UPI app: GPay, PhonePe, Paytm, BHIM). */
export function buildUpiUrl(opts: {
  vpa: string;
  payeeName: string;
  amountCents: number;
  reference: string;
}): string {
  const params = new URLSearchParams({
    pa: opts.vpa,
    pn: opts.payeeName,
    am: (opts.amountCents / 100).toFixed(2),
    cu: 'INR',
    tn: `Motoro ${opts.reference}`.slice(0, 40),
  });
  return `upi://pay?${params.toString()}`;
}

export function getPaymentProvider(env: Env): PaymentProvider {
  const provider = (env.PAYMENT_PROVIDER || 'test').toLowerCase();

  if (provider === 'upi') {
    const vpa = env.PAYMENT_UPI_VPA?.trim();
    if (!vpa) {
      throw new AppError(
        'PAYMENT_NOT_CONFIGURED',
        'Card/UPI payments are not configured on this deployment. Pay by cash, or ask support to enable the payment gateway.',
        503,
        { provider: 'upi' },
      );
    }
    return new UpiPaymentProvider(vpa, env.PAYMENT_UPI_NAME?.trim() || 'Motoro');
  }

  if (provider === 'razorpay') {
    if (env.PAYMENT_PROVIDER_KEY && env.PAYMENT_PROVIDER_SECRET) {
      return new RazorpayProvider(
        env.PAYMENT_PROVIDER_KEY,
        env.PAYMENT_PROVIDER_SECRET,
        env.PAYMENT_WEBHOOK_SECRET,
      );
    }
    if (isProduction(env)) {
      throw new AppError(
        'PAYMENT_NOT_CONFIGURED',
        'Card/UPI payments are not configured on this deployment. Pay by cash, or ask support to enable the payment gateway.',
        503,
        { provider: 'razorpay' },
      );
    }
    throw new AppError(
      'PAYMENT_NOT_CONFIGURED',
      'Set PAYMENT_PROVIDER_KEY and PAYMENT_PROVIDER_SECRET for razorpay, or use PAYMENT_PROVIDER=test in development.',
      503,
      { provider },
    );
  }

  if (provider === 'test') {
    if (isProduction(env)) {
      throw new AppError(
        'PAYMENT_NOT_CONFIGURED',
        'Payments are not configured for this environment.',
        503,
      );
    }
    return new TestPaymentProvider();
  }

  throw new AppError(
    'PAYMENT_NOT_CONFIGURED',
    'Payment provider is not configured.',
    503,
    { provider },
  );
}
