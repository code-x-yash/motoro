/** Shared domain types used by both the Worker API and the Next.js web app. */

// ---------------------------------------------------------------------------
// Auth / RBAC
// ---------------------------------------------------------------------------

export const ROLES = [
  'DRIVER',
  'MECHANIC',
  'WORKSHOP',
  'TOWING_PARTNER',
  'OPERATIONS',
  'ADMIN',
] as const;
export type Role = (typeof ROLES)[number];

export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';

export interface UserDto {
  id: string;
  role: Role;
  email: string;
  phone: string | null;
  fullName: string;
  locale: 'en' | 'hi';
  status: UserStatus;
  emailVerifiedAt: string | null;
  phoneVerifiedAt: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

export interface SessionUser extends UserDto {
  /** Role-specific profile summary (driver / mechanic / workshop / towing). */
  profile: DriverProfileDto | MechanicProfileDto | WorkshopProfileDto | TowingProfileDto | null;
}

/** Envelope returned by GET /api/auth/me and /api/me. */
export interface SessionPayload {
  user: UserDto;
  profile: DriverProfileDto | MechanicProfileDto | WorkshopProfileDto | TowingProfileDto | null;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface DriverProfileDto {
  userId: string;
  membership: 'FREE' | 'PLUS' | 'FLEET';
  emergencyContacts: EmergencyContactDto[];
}

export interface EmergencyContactDto {
  id: string;
  name: string;
  phone: string;
  relationship: string;
}

export type VehicleType = 'TWO_WHEELER' | 'CAR' | 'SUV' | 'SCOOTER' | 'COMMERCIAL' | 'EV';
export type FuelType = 'PETROL' | 'DIESEL' | 'CNG' | 'ELECTRIC' | 'HYBRID';

export interface VehicleDto {
  id: string;
  userId: string;
  registrationNumber: string;
  make: string;
  model: string;
  variant: string | null;
  year: number | null;
  fuelType: FuelType;
  vehicleType: VehicleType;
  insuranceExpiry: string | null;
  rcNumber: string | null;
  color: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Mechanic / workshop / towing
// ---------------------------------------------------------------------------

export type MechanicStatus =
  | 'OFFLINE'
  | 'AVAILABLE'
  | 'BUSY'
  | 'EN_ROUTE'
  | 'ON_JOB'
  | 'PAUSED'
  | 'SUSPENDED';

export type VerificationStatus =
  | 'PENDING'
  | 'UNDER_REVIEW'
  | 'VERIFIED'
  | 'REJECTED'
  | 'SUSPENDED';

export interface MechanicProfileDto {
  userId: string;
  fullName: string;
  verificationStatus: VerificationStatus;
  status: MechanicStatus;
  bio: string | null;
  experienceYears: number;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  serviceRadiusKm: number;
  skills: string[];
  equipment: string[];
  vehicleTypes?: string[];
  workshopId: string | null;
  ratingAverage: number;
  ratingCount: number;
  jobsCompleted: number;
  acceptanceRate: number;
  cancellationCount: number;
  reliabilityScore: number;
  earningsCents: number;
  documentUrl: string | null;
}

export interface WorkshopProfileDto {
  id: string;
  name: string;
  ownerUserId: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  serviceRadiusKm: number;
  verificationStatus: VerificationStatus;
  capabilities: string[];
  ratingAverage: number;
  ratingCount: number;
  mechanicsCount: number;
}

export interface TowingProfileDto {
  id: string;
  name: string;
  ownerUserId: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  serviceRadiusKm: number;
  verificationStatus: VerificationStatus;
  status: MechanicStatus;
  fleet: TowingVehicleDto[];
}

export interface TowingVehicleDto {
  id: string;
  plateNumber: string;
  towingType: string;
  capacityKg: number | null;
}

export interface MechanicPublicDto {
  userId: string;
  fullName: string;
  verificationStatus: VerificationStatus;
  ratingAverage: number;
  ratingCount: number;
  distanceKm: number | null;
  etaMinutes: number | null;
  status: MechanicStatus;
  skills: string[];
  vehicle: string | null;
}

// ---------------------------------------------------------------------------
// Emergency request
// ---------------------------------------------------------------------------

export type RequestStatus =
  | 'CREATED'
  | 'SEARCHING'
  | 'DISPATCHING'
  | 'ASSIGNED'
  | 'MECHANIC_EN_ROUTE'
  | 'MECHANIC_NEARBY'
  | 'ARRIVED'
  | 'DIAGNOSING'
  | 'QUOTE_PENDING'
  | 'QUOTE_APPROVED'
  | 'REPAIRING'
  | 'COMPLETED'
  | 'PAYMENT_PENDING'
  | 'PAID'
  | 'CANCELLED'
  | 'ESCALATED'
  | 'TOWING_REQUIRED'
  | 'FAILED';

export type Urgency = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';

export type RequestChannel = 'WEB' | 'APP' | 'PHONE' | 'WHATSAPP' | 'OPS';

export interface EmergencyRequestDto {
  id: string;
  reference: string;
  driverUserId: string;
  driverName: string;
  driverPhone: string | null;
  vehicleId: string | null;
  vehicleLabel: string | null;
  vehicleRegistration: string | null;
  issueType: string;
  categoryCode: string;
  description: string | null;
  urgency: Urgency;
  status: RequestStatus;
  channel: RequestChannel;
  /** Coupon applied at payment time (discount already reflected in totals). */
  couponCode: string | null;
  couponDiscountCents: number;
  /** Photos attached by the driver when creating the request. */
  photos: JobPhotoDto[];
  accidentMode: AccidentModeDto | null;
  latitude: number;
  longitude: number;
  address: string | null;
  assignedMechanicUserId: string | null;
  assignedMechanic: MechanicPublicDto | null;
  /** Latest live position streamed by the assigned mechanic (null until they share one). */
  mechanicLocation?: { latitude: number; longitude: number; at: string } | null;
  /** Job-start OTP for the driver to share with the mechanic (pending only). */
  arrivalOtp?: string | null;
  arrivalOtpExpiresAt?: string | null;
  job: JobDto | null;
  quote: QuoteDto | null;
  paymentStatus: PaymentStatus | null;
  totalAmountCents: number | null;
  escalationLevel: number;
  dispatchRadiusKm: number;
  rating: number | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccidentModeDto {
  driverInjured: boolean;
  anyoneInjured: boolean;
  blockingTraffic: boolean;
  needsTowing: boolean;
  medicalAssistance: boolean;
  policeAssistance: boolean;
}

export interface TimelineEventDto {
  id: string;
  requestId: string;
  type: string;
  message: string;
  actorRole: Role | 'SYSTEM' | null;
  actorUserId: string | null;
  data: Record<string, unknown> | null;
  createdAt: string;
}

export type DispatchAttemptStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'DECLINED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'FAILED'
  | 'EXPIRED'
  | 'REASSIGNED';

export interface DispatchAttemptDto {
  id: string;
  requestId: string;
  attemptNo: number;
  mechanicUserId: string;
  mechanicName: string;
  status: DispatchAttemptStatus;
  distanceKm: number | null;
  etaMinutes: number | null;
  score: number | null;
  offeredAt: string;
  respondedAt: string | null;
  timeoutAt: string | null;
  declineReason: string | null;
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

export type JobStatus =
  | 'ACCEPTED'
  | 'EN_ROUTE'
  | 'ARRIVED'
  | 'VERIFIED'
  | 'DIAGNOSING'
  | 'QUOTE_PENDING'
  | 'QUOTE_APPROVED'
  | 'REPAIRING'
  | 'COMPLETED'
  | 'CANCELLED';

export interface JobDto {
  id: string;
  requestId: string;
  mechanicUserId: string;
  mechanicName: string;
  status: JobStatus;
  earningsCents: number | null;
  otpRequired: boolean;
  otpVerifiedAt: string | null;
  acceptedAt: string | null;
  enRouteAt: string | null;
  arrivedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  photos: JobPhotoDto[];
  statusHistory: JobStatusHistoryDto[];
}

export interface JobStatusHistoryDto {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  note: string | null;
  latitude: number | null;
  longitude: number | null;
  createdAt: string;
}

export type PhotoStage = 'BEFORE' | 'DIAGNOSIS' | 'AFTER' | 'VERIFICATION';

export interface JobPhotoDto {
  id: string;
  stage: PhotoStage;
  url: string | null;
  caption: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Diagnosis / quotes
// ---------------------------------------------------------------------------

export interface DiagnosisDto {
  id: string;
  requestId: string;
  mechanicUserId: string;
  notes: string;
  items: DiagnosisItemDto[];
  createdAt: string;
}

export interface DiagnosisItemDto {
  id: string;
  code: string;
  label: string;
  result: 'OK' | 'FAIL' | 'NA' | 'UNCERTAIN';
  notes: string | null;
}

export type QuoteStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
export type QuoteItemType = 'PART' | 'LABOUR' | 'FEE' | 'DISCOUNT';

export interface QuoteItemDto {
  id: string;
  type: QuoteItemType;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  partId: string | null;
}

export interface QuoteDto {
  id: string;
  requestId: string;
  jobId: string | null;
  diagnosisId: string | null;
  status: QuoteStatus;
  items: QuoteItemDto[];
  subtotalCents: number;
  taxCents: number;
  feesCents: number;
  discountCents: number;
  totalCents: number;
  notes: string | null;
  createdAt: string;
  decidedAt: string | null;
}

// ---------------------------------------------------------------------------
// Payments / invoices
// ---------------------------------------------------------------------------

export type PaymentStatus = 'PENDING' | 'AUTHORIZED' | 'PAID' | 'FAILED' | 'REFUNDED';

export interface PaymentDto {
  id: string;
  requestId: string;
  provider: string;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  method: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface DisputeDto {
  id: string;
  requestId: string;
  reference: string | null;
  raisedBy: string;
  category: string;
  reason: string;
  status: 'OPEN' | 'IN_REVIEW' | 'RESOLVED' | 'DISMISSED';
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface InvoiceDto {
  id: string;
  number: string;
  requestId: string;
  subtotalCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  status: 'ISSUED' | 'PAID' | 'VOID';
  pdfUrl: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export interface ReviewDto {
  id: string;
  requestId: string;
  reviewerUserId: string;
  revieweeUserId: string;
  revieweeName: string;
  overall: number;
  categories: {
    arrival: number;
    diagnosis: number;
    pricing: number;
    professionalism: number;
    resolution: number;
  };
  comment: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type NotificationChannel = 'IN_APP' | 'EMAIL' | 'SMS' | 'WHATSAPP' | 'PUSH';

export interface NotificationDto {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Operations / admin
// ---------------------------------------------------------------------------

export interface OperationsDashboardDto {
  active: number;
  searching: number;
  assigned: number;
  enRoute: number;
  delayed: number;
  escalated: number;
  towing: number;
  completedToday: number;
  failedToday: number;
  activeMechanics: number;
  recentEscalations: EmergencyRequestDto[];
}

export interface AuditLogDto {
  id: string;
  actorUserId: string | null;
  actorName: string | null;
  actorRole: Role | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  entityReference: string | null;
  data: Record<string, unknown> | null;
  requestId: string | null;
  createdAt: string;
}

export interface PricingRuleDto {
  id: string;
  code: string;
  name: string;
  amountCents: number;
  type: 'FIXED' | 'PERCENT' | 'PER_KM';
  active: boolean;
  sort: number;
}

export interface PlatformConfigDto {
  key: string;
  value: unknown;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

export type RealtimeEventType =
  | 'connected'
  | 'request.state'
  | 'request.event'
  | 'request.location'
  | 'mechanic.location'
  | 'quote.updated'
  | 'job.updated'
  | 'presence'
  | 'notification'
  | 'chat.message'
  | 'error';

export interface RealtimeServerMessage {
  type: RealtimeEventType;
  requestId?: string;
  payload: Record<string, unknown>;
  at: string;
}

export interface RealtimeClientMessage {
  type: 'ping' | 'location' | 'subscribe';
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// API envelope
// ---------------------------------------------------------------------------

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  error: null;
  requestId: string;
}

export interface ApiFailure {
  success: false;
  data: null;
  error: ApiErrorBody;
  requestId: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
