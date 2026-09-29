import type { Env } from '../env';
import { AppError } from './errors';
import { nowIso } from './ids';

/**
 * Coupon validation + discount maths. Discounts come off the grand total
 * (quote incl. GST + service fee) and are funded by the platform.
 */

export interface CouponRow {
  id: string;
  code: string;
  description: string | null;
  percent_off: number;
  min_amount_cents: number;
  max_uses: number | null;
  used_count: number;
  valid_from: string | null;
  valid_until: string | null;
  active: number;
}

export interface CouponApplied {
  code: string;
  percentOff: number;
  discountCents: number;
}

/** Validates a coupon against the payable total. Throws AppError on failure. */
export async function validateCoupon(env: Env, rawCode: string, totalCents: number): Promise<CouponRow> {
  const code = rawCode.trim().toUpperCase();
  const coupon = await env.DB.prepare('SELECT * FROM coupons WHERE code = ?')
    .bind(code)
    .first<CouponRow>();
  if (!coupon || coupon.active !== 1) {
    throw new AppError('COUPON_INVALID', 'That coupon code is not valid.');
  }
  const now = Date.now();
  if (coupon.valid_from && Date.parse(coupon.valid_from) > now) {
    throw new AppError('COUPON_NOT_ACTIVE', 'That coupon is not active yet.');
  }
  if (coupon.valid_until && Date.parse(coupon.valid_until) < now) {
    throw new AppError('COUPON_EXPIRED', 'That coupon has expired.');
  }
  if (totalCents < coupon.min_amount_cents) {
    throw new AppError(
      'COUPON_MIN_AMOUNT',
      `This coupon needs a minimum order of ₹${Math.ceil(coupon.min_amount_cents / 100)}.`,
    );
  }
  if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) {
    throw new AppError('COUPON_EXHAUSTED', 'That coupon has been fully redeemed.');
  }
  return coupon;
}

export function couponDiscount(coupon: CouponRow, totalCents: number): number {
  const discount = Math.floor((totalCents * coupon.percent_off) / 100);
  return Math.min(discount, totalCents);
}

/** Full check + discount calculation (no side effects). */
export async function applyCoupon(env: Env, rawCode: string, totalCents: number): Promise<CouponApplied> {
  const coupon = await validateCoupon(env, rawCode, totalCents);
  const discountCents = couponDiscount(coupon, totalCents);
  if (discountCents <= 0) {
    throw new AppError('COUPON_NO_DISCOUNT', 'That coupon does not apply to this request.');
  }
  return { code: coupon.code, percentOff: coupon.percent_off, discountCents };
}

/** Called once when a payment settles to PAID. */
export async function redeemCoupon(env: Env, code: string): Promise<void> {
  await env.DB.prepare('UPDATE coupons SET used_count = used_count + 1, updated_at = ? WHERE code = ?')
    .bind(nowIso(), code)
    .run()
    .catch(() => undefined);
}
