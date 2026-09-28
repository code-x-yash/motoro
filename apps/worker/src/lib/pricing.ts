import type { RuntimeConfig } from './config';
import type { QuoteItemDto, Urgency } from '@rr/types';

/**
 * Simple, transparent, configurable pricing engine.
 * All money values are integer minor units (paise).
 */

export interface ServiceFeeInput {
  distanceKm: number;
  urgency: Urgency;
  isNight?: boolean;
  isTowing?: boolean;
}

export interface ServiceFeeBreakdown {
  currency: string;
  baseFeeCents: number;
  distanceFeeCents: number;
  nightSurchargeCents: number;
  emergencySurchargeCents: number;
  towingFeeCents: number;
  totalCents: number;
  breakdown: Array<{ code: string; label: string; amountCents: number }>;
}

export function isNightHour(date = new Date(), window = { startHour: 22, endHour: 6 }): boolean {
  const hour = date.getHours();
  return hour >= window.startHour || hour < window.endHour;
}

export function computeServiceFee(config: RuntimeConfig, input: ServiceFeeInput): ServiceFeeBreakdown {
  const p = config.pricing;
  const breakdown: ServiceFeeBreakdown['breakdown'] = [];

  const baseFeeCents = p.baseFeeCents;
  breakdown.push({ code: 'base_fee', label: 'Base service fee', amountCents: baseFeeCents });

  const distanceFeeCents = Math.round(p.distanceFeePerKmCents * Math.max(0, input.distanceKm));
  breakdown.push({ code: 'distance_fee', label: `Distance (${Math.max(1, Math.round(input.distanceKm))} km)`, amountCents: distanceFeeCents });

  let nightSurchargeCents = 0;
  const night = input.isNight ?? isNightHour(new Date(), p.nightWindow);
  if (night) {
    nightSurchargeCents = p.nightSurchargeCents;
    breakdown.push({ code: 'night_fee', label: 'Night surcharge', amountCents: nightSurchargeCents });
  }

  let emergencySurchargeCents = 0;
  if (input.urgency === 'HIGH' || input.urgency === 'CRITICAL') {
    emergencySurchargeCents = p.emergencySurchargeCents;
    breakdown.push({ code: 'emergency_fee', label: 'Emergency surcharge', amountCents: emergencySurchargeCents });
  }

  let towingFeeCents = 0;
  if (input.isTowing) {
    towingFeeCents = p.towingFeeCents;
    breakdown.push({ code: 'towing_fee', label: 'Towing / recovery', amountCents: towingFeeCents });
  }

  const totalCents =
    baseFeeCents + distanceFeeCents + nightSurchargeCents + emergencySurchargeCents + towingFeeCents;

  return {
    currency: 'INR',
    baseFeeCents,
    distanceFeeCents,
    nightSurchargeCents,
    emergencySurchargeCents,
    towingFeeCents,
    totalCents,
    breakdown,
  };
}

export interface QuoteTotals {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  feesCents: number;
  totalCents: number;
}

export function computeQuoteTotals(
  items: Array<Pick<QuoteItemDto, 'type' | 'quantity' | 'unitPriceCents'>>,
  taxPercent = 18,
): QuoteTotals {
  let subtotal = 0;
  let discount = 0;
  for (const item of items) {
    const line = Math.round(item.quantity * item.unitPriceCents);
    if (item.type === 'DISCOUNT') discount += line;
    else subtotal += line;
  }
  const taxable = Math.max(0, subtotal - discount);
  const tax = Math.round((taxable * taxPercent) / 100);
  return {
    subtotalCents: subtotal,
    discountCents: discount,
    taxCents: tax,
    feesCents: 0,
    totalCents: taxable + tax,
  };
}

/** Platform cut is taken from the mechanic payout, never added to the customer total. */
export function computeMechanicPayout(
  customerTotalCents: number,
  platformFeePercent: number,
): { payoutCents: number; platformFeeCents: number } {
  const platformFeeCents = Math.round((customerTotalCents * platformFeePercent) / 100);
  return {
    payoutCents: Math.max(0, customerTotalCents - platformFeeCents),
    platformFeeCents,
  };
}
