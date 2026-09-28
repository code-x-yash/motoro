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

/** Razorpay provider skeleton — activated when credentials are supplied. */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay';
  private keyId: string;
  private keySecret: string;

  constructor(keyId: string, keySecret: string) {
    this.keyId = keyId;
    this.keySecret = keySecret;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const auth = btoa(`${this.keyId}:${this.keySecret}`);
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        amount: input.amountCents,
        currency: input.currency,
        receipt: input.requestId,
        notes: { requestId: input.requestId, method: input.method },
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new AppError('PAYMENT_PROVIDER_ERROR', 'Payment provider rejected the request.', 502, {
        provider: 'razorpay',
        detail: text.slice(0, 300),
      });
    }
    const order = (await res.json()) as { id: string; status: string };
    return {
      providerRef: order.id,
      status: order.status === 'paid' ? 'PAID' : 'PENDING',
    };
  }
}

export function getPaymentProvider(env: Env): PaymentProvider {
  const provider = (env.PAYMENT_PROVIDER || 'test').toLowerCase();

  if (provider === 'razorpay' && env.PAYMENT_PROVIDER_KEY && env.PAYMENT_PROVIDER_SECRET) {
    return new RazorpayProvider(env.PAYMENT_PROVIDER_KEY, env.PAYMENT_PROVIDER_SECRET);
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
