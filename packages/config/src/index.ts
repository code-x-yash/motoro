/**
 * Central branding + product configuration layer.
 *
 * The product name is intentionally NOT hard-coded anywhere else in the
 * codebase. Rename the product by changing BRAND.name / BRAND.shortName and
 * running a search for any remaining literal usages (there should be none).
 */

export const BRAND = {
  name: 'Motoro',
  shortName: 'MO',
  legalName: 'Motoro Mobility Private Limited',
  tagline: 'Never leave the customer stranded.',
  description:
    '24x7 roadside assistance and mechanic dispatch platform. Emergency help in minutes, verified mechanics, live tracking.',
  supportPhone: '+91 97602 86560',
  supportEmail: 'yashrajwanshii@gmail.com',
  domain: 'motoro-web.vercel.app',
} as const;

export type Brand = typeof BRAND;

/** UI color tokens (tailwind-safe class fragments). */
export const BRAND_COLORS = {
  primary: 'bg-brand-600',
  primaryHover: 'hover:bg-brand-700',
  primaryText: 'text-brand-700',
  accent: 'bg-sun-400',
  surface: 'bg-white',
  canvas: 'bg-canvas',
} as const;

export const CURRENCY = {
  code: 'INR',
  symbol: '₹',
  /** All money values are stored as integer minor units (paise). */
  minorUnit: 100,
} as const;

export function formatMoney(amountMinor: number, locale = 'en-IN'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: CURRENCY.code,
    maximumFractionDigits: amountMinor % CURRENCY.minorUnit === 0 ? 0 : 2,
  }).format(amountMinor / CURRENCY.minorUnit);
}

/**
 * Fallback defaults for platform configuration.
 * Runtime values live in the `platform_config` table and override these.
 */
export const DEFAULT_CONFIG = {
  dispatch: {
    /** Expanding search radii in km, used in order. */
    radiusStepsKm: [5, 10, 20],
    /** Seconds a mechanic has to respond before the attempt times out. */
    attemptTimeoutSeconds: 45,
    /** Seconds without movement before a stall warning is raised. */
    stallWarningSeconds: 180,
    /** Seconds without movement before escalation / reassignment. */
    stallEscalateSeconds: 420,
    /** Max concurrently active jobs for one mechanic. */
    maxActiveJobsPerMechanic: 3,
    /** Max dispatch attempts before escalating to operations. */
    maxAttempts: 12,
    /** Increase of radius per expansion step (multiplier). */
    radiusExpansionFactor: 2,
    /** Mechanics offered the job simultaneously (first accept wins). */
    parallelOffers: 2,
    /** Safety sweep cadence in seconds for timeouts/stalls. */
    sweepIntervalSeconds: 60,
    /** Escalate automatically after this many failed dispatch rounds. */
    maxEscalationRetries: 4,
  },
  pricing: {
    baseFeeCents: 19900,
    distanceFeePerKmCents: 2500,
    nightSurchargeCents: 10000,
    emergencySurchargeCents: 5000,
    platformFeePercent: 10,
    towingFeeCents: 29900,
    nightWindow: { startHour: 22, endHour: 6 },
  },
  cancellation: {
    freeWindowSeconds: 60,
    feeCents: 5000,
  },
  uploads: {
    maxFileBytes: 8 * 1024 * 1024,
    allowedTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
    signedUrlTtlSeconds: 600,
  },
} as const;

export const ISSUE_TYPES = [
  'BATTERY',
  'FLAT_TYRE',
  'OUT_OF_FUEL',
  'ENGINE_PROBLEM',
  'ELECTRICAL_PROBLEM',
  'OVERHEATING',
  'LOCKOUT',
  'ACCIDENT',
  'GENERAL_BREAKDOWN',
  "DONT_KNOW",
] as const;

export type IssueType = (typeof ISSUE_TYPES)[number];

export const ISSUE_REQUIRED_SKILLS: Record<IssueType, string[]> = {
  BATTERY: ['battery', 'electrical'],
  FLAT_TYRE: ['tyre'],
  OUT_OF_FUEL: ['fuel'],
  ENGINE_PROBLEM: ['engine'],
  ELECTRICAL_PROBLEM: ['electrical'],
  OVERHEATING: ['cooling', 'engine'],
  LOCKOUT: ['lockout'],
  ACCIDENT: ['bodywork', 'towing'],
  GENERAL_BREAKDOWN: ['general'],
  DONT_KNOW: ['general'],
};

export const ISSUE_REQUIRED_EQUIPMENT: Record<IssueType, string[]> = {
  BATTERY: ['jumper_cables', 'multimeter'],
  FLAT_TYRE: ['jack', 'wheel_spanner', 'spare_tyre'],
  OUT_OF_FUEL: ['fuel_can'],
  ENGINE_PROBLEM: ['obd_scanner', 'basic_tools'],
  ELECTRICAL_PROBLEM: ['multimeter', 'basic_tools'],
  OVERHEATING: ['coolant', 'basic_tools'],
  LOCKOUT: ['lockout_kit'],
  ACCIDENT: ['tow_hook', 'first_aid'],
  GENERAL_BREAKDOWN: ['basic_tools'],
  DONT_KNOW: ['basic_tools'],
};

export const SKILL_CATALOG = [
  'general',
  'battery',
  'electrical',
  'engine',
  'tyre',
  'fuel',
  'cooling',
  'lockout',
  'bodywork',
  'towing',
] as const;

export const EQUIPMENT_CATALOG = [
  'basic_tools',
  'jumper_cables',
  'multimeter',
  'obd_scanner',
  'jack',
  'wheel_spanner',
  'spare_tyre',
  'fuel_can',
  'coolant',
  'lockout_kit',
  'tow_hook',
  'first_aid',
  'tyre_inflator',
  'jump_starter',
] as const;
