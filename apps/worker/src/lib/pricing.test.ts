import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@rr/config';
import type { RuntimeConfig } from './config';
import {
  computeMechanicPayout,
  computeQuoteTotals,
  computeServiceFee,
  isNightHour,
} from './pricing';

const config = DEFAULT_CONFIG as unknown as RuntimeConfig;

describe('computeServiceFee', () => {
  it('adds base + distance for a normal daytime request', () => {
    const fee = computeServiceFee(config, { distanceKm: 4, urgency: 'NORMAL', isNight: false });
    expect(fee.baseFeeCents).toBe(DEFAULT_CONFIG.pricing.baseFeeCents);
    expect(fee.distanceFeeCents).toBe(DEFAULT_CONFIG.pricing.distanceFeePerKmCents * 4);
    expect(fee.nightSurchargeCents).toBe(0);
    expect(fee.emergencySurchargeCents).toBe(0);
    expect(fee.towingFeeCents).toBe(0);
    expect(fee.totalCents).toBe(fee.baseFeeCents + fee.distanceFeeCents);
    expect(fee.currency).toBe('INR');
    expect(fee.breakdown.map((line) => line.code)).toEqual(['base_fee', 'distance_fee']);
  });

  it('applies night, emergency and towing surcharges', () => {
    const fee = computeServiceFee(config, { distanceKm: 2, urgency: 'CRITICAL', isNight: true, isTowing: true });
    expect(fee.nightSurchargeCents).toBe(DEFAULT_CONFIG.pricing.nightSurchargeCents);
    expect(fee.emergencySurchargeCents).toBe(DEFAULT_CONFIG.pricing.emergencySurchargeCents);
    expect(fee.towingFeeCents).toBe(DEFAULT_CONFIG.pricing.towingFeeCents);
    const sum = fee.breakdown.reduce((total, line) => total + line.amountCents, 0);
    expect(fee.totalCents).toBe(sum);
  });

  it('does not surcharge LOW / NORMAL urgency', () => {
    for (const urgency of ['LOW', 'NORMAL'] as const) {
      const fee = computeServiceFee(config, { distanceKm: 1, urgency, isNight: false });
      expect(fee.emergencySurchargeCents).toBe(0);
    }
  });

  it('never charges for negative distance input', () => {
    const fee = computeServiceFee(config, { distanceKm: -5, urgency: 'LOW', isNight: false });
    expect(fee.distanceFeeCents).toBe(0);
    expect(fee.totalCents).toBe(fee.baseFeeCents);
  });
});

describe('isNightHour', () => {
  const at = (hour: number) => new Date(2026, 0, 15, hour, 30);

  it('treats 22:00-06:00 as night', () => {
    expect(isNightHour(at(23))).toBe(true);
    expect(isNightHour(at(2))).toBe(true);
    expect(isNightHour(at(5))).toBe(true);
    expect(isNightHour(at(12))).toBe(false);
    expect(isNightHour(at(21))).toBe(false);
  });
});

describe('computeQuoteTotals', () => {
  it('taxes the discounted subtotal', () => {
    const totals = computeQuoteTotals(
      [
        { type: 'PART', quantity: 2, unitPriceCents: 100000 },
        { type: 'LABOUR', quantity: 1, unitPriceCents: 50000 },
        { type: 'DISCOUNT', quantity: 1, unitPriceCents: 30000 },
      ],
      18,
    );
    expect(totals.subtotalCents).toBe(250000);
    expect(totals.discountCents).toBe(30000);
    expect(totals.taxCents).toBe(Math.round((220000 * 18) / 100));
    expect(totals.totalCents).toBe(220000 + totals.taxCents);
  });

  it('rounds fractional quantities and taxes', () => {
    const totals = computeQuoteTotals([{ type: 'LABOUR', quantity: 1.5, unitPriceCents: 333 }], 18);
    expect(totals.subtotalCents).toBe(500);
    expect(totals.taxCents).toBe(Math.round((500 * 18) / 100));
  });

  it('never produces a negative taxable base', () => {
    const totals = computeQuoteTotals([{ type: 'DISCOUNT', quantity: 1, unitPriceCents: 99999 }], 18);
    expect(totals.discountCents).toBe(99999);
    expect(totals.taxCents).toBe(0);
    expect(totals.totalCents).toBe(0);
  });

  it('supports a zero-tax quote', () => {
    const totals = computeQuoteTotals([{ type: 'PART', quantity: 1, unitPriceCents: 1000 }], 0);
    expect(totals.totalCents).toBe(1000);
  });
});

describe('computeMechanicPayout', () => {
  it('takes the platform cut from the payout, not the customer total', () => {
    const { payoutCents, platformFeeCents } = computeMechanicPayout(100000, 10);
    expect(platformFeeCents).toBe(10000);
    expect(payoutCents).toBe(90000);
    expect(payoutCents + platformFeeCents).toBe(100000);
  });

  it('never pays out a negative amount', () => {
    const { payoutCents } = computeMechanicPayout(1000, 200);
    expect(payoutCents).toBe(0);
  });
});
