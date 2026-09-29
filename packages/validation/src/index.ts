import { z } from 'zod';
import { ISSUE_TYPES, SKILL_CATALOG, EQUIPMENT_CATALOG } from '@rr/config';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid identifier');

export const uuidSchema = z.string().uuid();

export const latitudeSchema = z
  .number()
  .min(-90, 'Latitude out of range')
  .max(90, 'Latitude out of range')
  .refine((v) => Number.isFinite(v), 'Latitude must be finite');

export const longitudeSchema = z
  .number()
  .min(-180, 'Longitude out of range')
  .max(180, 'Longitude out of range')
  .refine((v) => Number.isFinite(v), 'Longitude must be finite');

export const coordinateSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  accuracy: z.number().min(0).max(100000).optional(),
  address: z.string().max(300).optional(),
});

export const localeSchema = z.enum(['en', 'hi']);

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{7,15}$/, 'Invalid phone number');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/[0-9]/, 'Password must contain a number');

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const registerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: emailSchema,
  phone: phoneSchema.optional(),
  password: passwordSchema,
  role: z.enum(['DRIVER', 'MECHANIC', 'WORKSHOP', 'TOWING_PARTNER']),
  locale: localeSchema.default('en'),
  /** Optional structured profile payload for mechanic/workshop/towing signup. */
  profile: z
    .object({
      experienceYears: z.number().int().min(0).max(60).optional(),
      address: z.string().max(300).optional(),
      latitude: latitudeSchema.optional(),
      longitude: longitudeSchema.optional(),
      serviceRadiusKm: z.number().min(1).max(500).optional(),
      skills: z.array(z.string().max(40)).max(30).optional(),
      equipment: z.array(z.string().max(40)).max(30).optional(),
      name: z.string().max(160).optional(),
    })
    .optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(200),
  password: passwordSchema,
});

export const updateProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: phoneSchema.optional(),
  locale: localeSchema.optional(),
});

/** Per-channel notification opt-in/out (absent key = enabled). */
export const updatePreferencesSchema = z.object({
  notifications: z
    .object({
      EMAIL: z.boolean().optional(),
      SMS: z.boolean().optional(),
      WHATSAPP: z.boolean().optional(),
      PUSH: z.boolean().optional(),
    })
    .strict(),
});

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export const createVehicleSchema = z.object({
  registrationNumber: z
    .string()
    .trim()
    .toUpperCase()
    .min(4)
    .max(20)
    .regex(/^[A-Z0-9 -]+$/, 'Invalid registration number'),
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(60),
  variant: z.string().trim().max(60).nullable().optional(),
  year: z.number().int().min(1950).max(2035).nullable().optional(),
  fuelType: z.enum(['PETROL', 'DIESEL', 'CNG', 'ELECTRIC', 'HYBRID']),
  vehicleType: z.enum(['TWO_WHEELER', 'CAR', 'SUV', 'SCOOTER', 'COMMERCIAL', 'EV']),
  insuranceExpiry: z.string().date().nullable().optional(),
  rcNumber: z.string().trim().max(40).nullable().optional(),
  color: z.string().trim().max(40).nullable().optional(),
});

export const updateVehicleSchema = createVehicleSchema.partial();

// ---------------------------------------------------------------------------
// Emergency contacts
// ---------------------------------------------------------------------------

export const emergencyContactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  phone: phoneSchema,
  relationship: z.string().trim().min(1).max(60),
});

// ---------------------------------------------------------------------------
// Emergency request
// ---------------------------------------------------------------------------

export const accidentModeSchema = z.object({
  driverInjured: z.boolean(),
  anyoneInjured: z.boolean(),
  blockingTraffic: z.boolean(),
  needsTowing: z.boolean(),
  medicalAssistance: z.boolean(),
  policeAssistance: z.boolean(),
});

export const createEmergencySchema = z.object({
  issueType: z.enum(ISSUE_TYPES),
  description: z.string().trim().max(2000).nullable().optional(),
  urgency: z.enum(['LOW', 'NORMAL', 'HIGH', 'CRITICAL']).default('NORMAL'),
  vehicleId: z.string().min(1).max(64).nullable().optional(),
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  accuracy: z.number().min(0).max(100000).optional(),
  address: z.string().trim().max(300).nullable().optional(),
  channel: z.enum(['WEB', 'APP', 'PHONE', 'WHATSAPP', 'OPS']).default('WEB'),
  accidentMode: accidentModeSchema.nullable().optional(),
  photoKeys: z.array(z.string().max(300)).max(10).optional(),
});

export const cancelEmergencySchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const escalateEmergencySchema = z.object({
  reason: z.string().trim().min(3).max(500).optional(),
});

export const updateEmergencyLocationSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  accuracy: z.number().min(0).max(100000).optional(),
});

export const shareEmergencySchema = z.object({
  contactIds: z.array(z.string().min(1).max(64)).min(1).max(20),
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export const dispatchRespondSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

export const nearbyMechanicsSchema = z.object({
  latitude: z.coerce.number().min(-90, 'Latitude out of range').max(90, 'Latitude out of range'),
  longitude: z.coerce.number().min(-180, 'Longitude out of range').max(180, 'Longitude out of range'),
  radiusKm: z.coerce.number().min(0.1).max(200).default(10),
  issueType: z.enum(ISSUE_TYPES).optional(),
});

export const reverseGeocodeSchema = z.object({
  latitude: z.coerce.number().min(-90, 'Latitude out of range').max(90, 'Latitude out of range'),
  longitude: z.coerce.number().min(-180, 'Longitude out of range').max(180, 'Longitude out of range'),
});

export const geocodeSearchSchema = z.object({
  query: z.string().trim().min(2, 'Type at least 2 characters').max(200),
  limit: z.coerce.number().int().min(1).max(5).default(5),
});

// ---------------------------------------------------------------------------
// Mechanic profile / availability
// ---------------------------------------------------------------------------

export const updateMechanicProfileSchema = z.object({
  bio: z.string().trim().max(1000).nullable().optional(),
  experienceYears: z.number().int().min(0).max(60).optional(),
  address: z.string().trim().max(300).nullable().optional(),
  latitude: latitudeSchema.nullable().optional(),
  longitude: longitudeSchema.nullable().optional(),
  serviceRadiusKm: z.number().min(1).max(500).optional(),
  skills: z.array(z.string().max(40)).max(30).optional(),
  equipment: z.array(z.string().max(40)).max(30).optional(),
});

export const skillSchema = z.object({
  skill: z.enum(SKILL_CATALOG),
  level: z.enum(['BEGINNER', 'INTERMEDIATE', 'EXPERT']).default('INTERMEDIATE'),
});

export const equipmentSchema = z.object({
  equipment: z.enum(EQUIPMENT_CATALOG),
});

export const mechanicAvailabilitySchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
});

export const setMechanicStatusSchema = z.object({
  status: z.enum(['OFFLINE', 'AVAILABLE', 'PAUSED']),
});

export const submitVerificationSchema = z.object({
  experienceYears: z.number().int().min(0).max(60),
  address: z.string().trim().min(3).max(300),
  documentKey: z.string().max(300).optional(),
  workshopName: z.string().trim().max(160).optional(),
  notes: z.string().trim().max(1000).optional(),
});

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const jobNoteSchema = z.object({
  note: z.string().trim().max(1000).optional(),
  latitude: latitudeSchema.optional(),
  longitude: longitudeSchema.optional(),
});

export const verifyOtpSchema = z.object({
  otp: z.string().trim().regex(/^[0-9]{6}$/, 'OTP must be 6 digits'),
});

export const diagnosisItemSchema = z.object({
  code: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(160),
  result: z.enum(['OK', 'FAIL', 'NA', 'UNCERTAIN']),
  notes: z.string().trim().max(600).nullable().optional(),
});

export const createDiagnosisSchema = z.object({
  notes: z.string().trim().max(4000).default(''),
  items: z.array(diagnosisItemSchema).max(50).default([]),
});

export const quoteItemInputSchema = z.object({
  type: z.enum(['PART', 'LABOUR', 'FEE', 'DISCOUNT']),
  description: z.string().trim().min(1).max(300),
  quantity: z.number().min(0.01).max(1000),
  unitPriceCents: z.number().int().min(0).max(100000000),
  partId: z.string().max(64).nullable().optional(),
});

export const createQuoteSchema = z.object({
  items: z.array(quoteItemInputSchema).min(1).max(100),
  taxPercent: z.number().min(0).max(50).default(18),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const decideQuoteSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().trim().max(500).optional(),
});

export const jobPhotoSchema = z.object({
  stage: z.enum(['BEFORE', 'DIAGNOSIS', 'AFTER', 'VERIFICATION']),
  objectKey: z.string().min(3).max(300),
  caption: z.string().trim().max(300).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export const createPaymentSchema = z.object({
  method: z.enum(['CARD', 'UPI', 'NETBANKING', 'WALLET', 'CASH']).default('UPI'),
});

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export const createReviewSchema = z.object({
  requestId: z.string().min(1).max(64),
  overall: z.number().int().min(1).max(5),
  arrival: z.number().int().min(1).max(5),
  diagnosis: z.number().int().min(1).max(5),
  pricing: z.number().int().min(1).max(5),
  professionalism: z.number().int().min(1).max(5),
  resolution: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export const presignUploadSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  purpose: z.enum([
    'breakdown',
    'diagnosis',
    'completion',
    'verification',
    'profile',
    'vehicle',
    'invoice',
  ]),
  fileName: z.string().trim().max(160).optional(),
  sizeBytes: z.number().int().min(1).max(16 * 1024 * 1024),
  entityId: z.string().max(64).optional(),
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const assignMechanicSchema = z.object({
  mechanicUserId: idSchema,
  note: z.string().trim().max(500).optional(),
});

export const operationsNoteSchema = z.object({
  note: z.string().trim().min(1).max(1000),
});

/** Comma-separated list of request statuses, e.g. `CREATED,SEARCHING,ESCALATED`. */
export const csvStatusFilter = z
  .string()
  .trim()
  .max(600)
  .regex(/^[A-Z][A-Z0-9_]*(?:,[A-Z][A-Z0-9_]*)*$/, 'Invalid status filter')
  .optional();

export const operationsFilterSchema = z
  .object({
    status: csvStatusFilter,
    urgency: z.string().max(30).optional(),
    q: z.string().max(120).optional(),
  })
  .merge(paginationSchema);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const adminVerifyMechanicSchema = z.object({
  decision: z.enum(['VERIFIED', 'REJECTED', 'UNDER_REVIEW']),
  reason: z.string().trim().max(500).optional(),
});

export const adminSuspendSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  suspend: z.boolean().default(true),
});

export const pricingRuleSchema = z.object({
  code: z.string().trim().min(2).max(60),
  name: z.string().trim().min(2).max(120),
  amountCents: z.number().int().min(0).max(100000000),
  type: z.enum(['FIXED', 'PERCENT', 'PER_KM']),
  active: z.boolean().default(true),
  sort: z.number().int().min(0).max(999).default(0),
});

export const platformConfigSchema = z.object({
  key: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9_.]+$/, 'Config key must be lowercase'),
  value: z.unknown(),
});

export const serviceCategorySchema = z.object({
  code: z.string().trim().min(2).max(40),
  nameEn: z.string().trim().min(1).max(80),
  nameHi: z.string().trim().min(1).max(80),
  icon: z.string().trim().max(40),
  requiredSkills: z.array(z.string().max(40)).max(20),
  requiredEquipment: z.array(z.string().max(40)).max(20),
  active: z.boolean().default(true),
  sort: z.number().int().min(0).max(999).default(0),
});

// ---------------------------------------------------------------------------
// Search / list queries
// ---------------------------------------------------------------------------

export const emergencyListQuerySchema = z
  .object({
    status: csvStatusFilter,
    role: z.enum(['driver', 'mechanic']).optional(),
    urgency: z.enum(['NORMAL', 'HIGH']).optional(),
    q: z.string().trim().max(80).optional(),
  })
  .merge(paginationSchema);

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;
export type CreateEmergencyInput = z.infer<typeof createEmergencySchema>;
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;
export type CreateDiagnosisInput = z.infer<typeof createDiagnosisSchema>;
export type CreateReviewInput = z.infer<typeof createReviewSchema>;

export const createDisputeSchema = z.object({
  requestId: z.string().min(1).max(64),
  category: z.enum(['SERVICE_QUALITY', 'OVERCHARGING', 'NO_SHOW', 'VEHICLE_DAMAGE', 'SAFETY', 'OTHER']),
  reason: z.string().trim().min(10).max(2000),
});

export type CreateDisputeInput = z.infer<typeof createDisputeSchema>;

export const applyCouponSchema = z.object({
  code: z.string().trim().min(3, 'Enter a coupon code').max(40),
});

export const createCouponSchema = z.object({
  code: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/, 'Code may contain letters, numbers, - and _')
    .transform((value) => value.toUpperCase()),
  description: z.string().trim().max(200).nullable().optional(),
  percentOff: z.number().int().min(1).max(100),
  minAmountCents: z.number().int().min(0).default(0),
  maxUses: z.number().int().min(1).nullable().optional(),
  validFrom: z.string().datetime().nullable().optional(),
  validUntil: z.string().datetime().nullable().optional(),
});

export type CreateCouponInput = z.infer<typeof createCouponSchema>;

export const payoutAccountSchema = z.object({
  accountHolder: z.string().trim().min(3, 'Enter the account holder name').max(120),
  accountNumber: z.string().trim().min(6).max(34),
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code'),
  bankName: z.string().trim().max(120).optional(),
});

export const requestPayoutSchema = z.object({
  amountCents: z.number().int().min(10_000, 'Minimum payout is ₹100'),
  note: z.string().trim().max(200).nullable().optional(),
});

export const sendMessageSchema = z.object({
  body: z.string().trim().min(1, 'Message cannot be empty').max(1000),
});

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(10).max(200),
    auth: z.string().min(10).max(200),
  }),
});
export type PresignUploadInput = z.infer<typeof presignUploadSchema>;
