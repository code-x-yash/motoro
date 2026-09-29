import type {
  DiagnosisDto,
  DiagnosisItemDto,
  DispatchAttemptDto,
  EmergencyContactDto,
  InvoiceDto,
  JobDto,
  JobPhotoDto,
  JobStatusHistoryDto,
  MechanicProfileDto,
  MechanicPublicDto,
  NotificationDto,
  PaymentDto,
  QuoteDto,
  QuoteItemDto,
  ReviewDto,
  TowingProfileDto,
  TowingVehicleDto,
  VehicleDto,
  WorkshopProfileDto,
} from '@rr/types';
import type { Env } from '../env';
import { distanceKm, roundKm } from './geo';
import { presignDownload } from './r2';

export function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function parseJsonArray(value: string | null | undefined): string[] {
  const parsed = parseJson<unknown[]>(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export interface VehicleRow {
  id: string;
  user_id: string;
  registration_number: string;
  make: string;
  model: string;
  variant: string | null;
  year: number | null;
  fuel_type: string;
  vehicle_type: string;
  insurance_expiry: string | null;
  rc_number: string | null;
  color: string | null;
  created_at: string;
}

export function mapVehicleRow(row: VehicleRow): VehicleDto {
  return {
    id: row.id,
    userId: row.user_id,
    registrationNumber: row.registration_number,
    make: row.make,
    model: row.model,
    variant: row.variant,
    year: row.year,
    fuelType: row.fuel_type as VehicleDto['fuelType'],
    vehicleType: row.vehicle_type as VehicleDto['vehicleType'],
    insuranceExpiry: row.insurance_expiry,
    rcNumber: row.rc_number,
    color: row.color,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface JobRow {
  id: string;
  request_id: string;
  mechanic_user_id: string;
  status: string;
  earnings_cents: number;
  otp_verified_at: string | null;
  otp_code_hash?: string | null;
  otp_expires_at?: string | null;
  accepted_at: string;
  en_route_at: string | null;
  arrived_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  mechanic_name?: string;
}

export async function mapJobRow(env: Env, row: JobRow): Promise<JobDto> {
  const [photoRows, historyRows, requestPhotoRows] = await Promise.all([
    env.DB.prepare('SELECT * FROM job_photos WHERE job_id = ? ORDER BY created_at ASC').bind(row.id).all(),
    env.DB.prepare('SELECT * FROM job_status_history WHERE job_id = ? ORDER BY created_at ASC').bind(row.id).all(),
    // Photos the driver attached at request creation (before a job existed).
    env.DB.prepare('SELECT * FROM job_photos WHERE request_id = ? AND job_id IS NULL ORDER BY created_at ASC')
      .bind(row.request_id)
      .all(),
  ]);

  const photos: JobPhotoDto[] = [];
  for (const p of [...photoRows.results, ...requestPhotoRows.results]) {
    const photo = p as unknown as {
      id: string;
      stage: JobPhotoDto['stage'];
      object_key: string;
      caption: string | null;
      created_at: string;
    };
    photos.push({
      id: photo.id,
      stage: photo.stage,
      url: (await presignDownload(env, '', photo.object_key, 3600)).url,
      caption: photo.caption,
      createdAt: photo.created_at,
    });
  }
  photos.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const statusHistory: JobStatusHistoryDto[] = historyRows.results.map((h) => {
    const record = h as unknown as {
      id: string;
      from_status: string | null;
      to_status: string;
      note: string | null;
      latitude: number | null;
      longitude: number | null;
      created_at: string;
    };
    return {
      id: record.id,
      fromStatus: record.from_status,
      toStatus: record.to_status,
      note: record.note,
      latitude: record.latitude,
      longitude: record.longitude,
      createdAt: record.created_at,
    };
  });

  return {
    id: row.id,
    requestId: row.request_id,
    mechanicUserId: row.mechanic_user_id,
    mechanicName: row.mechanic_name ?? '',
    status: row.status as JobDto['status'],
    earningsCents: row.earnings_cents,
    otpRequired: Boolean(row.otp_code_hash),
    otpVerifiedAt: row.otp_verified_at,
    acceptedAt: row.accepted_at,
    enRouteAt: row.en_route_at,
    arrivedAt: row.arrived_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    photos,
    statusHistory,
  };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export interface QuoteRow {
  id: string;
  request_id: string;
  job_id: string | null;
  diagnosis_id: string | null;
  status: string;
  subtotal_cents: number;
  tax_cents: number;
  fees_cents: number;
  discount_cents: number;
  total_cents: number;
  notes: string | null;
  created_at: string;
  decided_at: string | null;
}

export async function mapQuoteRow(env: Env, row: QuoteRow): Promise<QuoteDto> {
  const items = await env.DB.prepare(
    'SELECT * FROM quote_items WHERE quote_id = ? ORDER BY sort ASC, created_at ASC',
  )
    .bind(row.id)
    .all();
  const mapped: QuoteItemDto[] = items.results.map((i) => {
    const item = i as unknown as {
      id: string;
      type: QuoteItemDto['type'];
      description: string;
      quantity: number;
      unit_price_cents: number;
      total_cents: number;
      part_id: string | null;
    };
    return {
      id: item.id,
      type: item.type,
      description: item.description,
      quantity: item.quantity,
      unitPriceCents: item.unit_price_cents,
      totalCents: item.total_cents,
      partId: item.part_id,
    };
  });
  return {
    id: row.id,
    requestId: row.request_id,
    jobId: row.job_id,
    diagnosisId: row.diagnosis_id,
    status: row.status as QuoteDto['status'],
    items: mapped,
    subtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents,
    feesCents: row.fees_cents,
    discountCents: row.discount_cents,
    totalCents: row.total_cents,
    notes: row.notes,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

// ---------------------------------------------------------------------------
// Mechanics
// ---------------------------------------------------------------------------

export async function mapPublicMechanic(
  env: Env,
  mechanicUserId: string,
  fromLat?: number | null,
  fromLng?: number | null,
): Promise<MechanicPublicDto | null> {
  const row = await env.DB.prepare(
    `SELECT m.user_id, m.status, m.verification_status, m.rating_sum, m.rating_count,
            m.latitude, m.longitude, u.full_name
     FROM mechanics m
     JOIN users u ON u.id = m.user_id
     WHERE m.user_id = ?`,
  )
    .bind(mechanicUserId)
    .first<{
      user_id: string;
      status: string;
      verification_status: string;
      rating_sum: number;
      rating_count: number;
      latitude: number | null;
      longitude: number | null;
      full_name: string;
    }>();
  if (!row) return null;

  const skills = await env.DB.prepare('SELECT skill FROM mechanic_skills WHERE mechanic_user_id = ?')
    .bind(mechanicUserId)
    .all<{ skill: string }>();

  let dist: number | null = null;
  if (fromLat != null && fromLng != null && row.latitude != null && row.longitude != null) {
    dist = roundKm(distanceKm(fromLat, fromLng, row.latitude, row.longitude));
  }

  return {
    userId: row.user_id,
    fullName: row.full_name,
    verificationStatus: row.verification_status as MechanicPublicDto['verificationStatus'],
    ratingAverage: row.rating_count > 0 ? Math.round((row.rating_sum / row.rating_count) * 10) / 10 : 0,
    ratingCount: row.rating_count,
    distanceKm: dist,
    etaMinutes: dist != null ? Math.max(1, Math.round((dist / 30) * 60)) : null,
    status: row.status as MechanicPublicDto['status'],
    skills: skills.results.map((s) => s.skill),
    vehicle: null,
  };
}

export interface MechanicProfileRow {
  user_id: string;
  verification_status: string;
  status: string;
  bio: string | null;
  experience_years: number;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  service_radius_km: number;
  workshop_id: string | null;
  document_key: string | null;
  rating_sum: number;
  rating_count: number;
  jobs_completed: number;
  jobs_cancelled: number;
  offers_received: number;
  offers_accepted: number;
  earnings_cents: number;
  reliability_score: number;
  full_name?: string;
}

export async function mapMechanicProfile(
  env: Env,
  row: MechanicProfileRow,
  origin = '',
): Promise<MechanicProfileDto> {
  const [skills, equipment, vehicleTypes] = await Promise.all([
    env.DB.prepare('SELECT skill FROM mechanic_skills WHERE mechanic_user_id = ? ORDER BY skill')
      .bind(row.user_id)
      .all<{ skill: string }>(),
    env.DB.prepare('SELECT equipment FROM mechanic_equipment WHERE mechanic_user_id = ? ORDER BY equipment')
      .bind(row.user_id)
      .all<{ equipment: string }>(),
    env.DB.prepare('SELECT vehicle_type FROM mechanic_vehicle_types WHERE mechanic_user_id = ?')
      .bind(row.user_id)
      .all<{ vehicle_type: string }>(),
  ]);

  return {
    userId: row.user_id,
    fullName: row.full_name ?? '',
    verificationStatus: row.verification_status as MechanicProfileDto['verificationStatus'],
    status: row.status as MechanicProfileDto['status'],
    bio: row.bio,
    experienceYears: row.experience_years,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    serviceRadiusKm: row.service_radius_km,
    skills: skills.results.map((s) => s.skill),
    equipment: equipment.results.map((e) => e.equipment),
    workshopId: row.workshop_id,
    ratingAverage: row.rating_count > 0 ? Math.round((row.rating_sum / row.rating_count) * 10) / 10 : 0,
    ratingCount: row.rating_count,
    jobsCompleted: row.jobs_completed,
    acceptanceRate:
      row.offers_received > 0 ? Math.round((row.offers_accepted / row.offers_received) * 100) : 100,
    cancellationCount: row.jobs_cancelled,
    reliabilityScore: row.reliability_score,
    earningsCents: row.earnings_cents,
    documentUrl: row.document_key
      ? (await presignDownload(env, origin, row.document_key, 3600)).url
      : null,
    vehicleTypes: vehicleTypes.results.map((v) => v.vehicle_type),
  };
}

// ---------------------------------------------------------------------------
// Workshops / towing
// ---------------------------------------------------------------------------

export interface WorkshopRow {
  id: string;
  owner_user_id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  service_radius_km: number;
  verification_status: string;
  capabilities: string;
  rating_sum: number;
  rating_count: number;
}

export async function mapWorkshop(env: Env, row: WorkshopRow): Promise<WorkshopProfileDto> {
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM workshop_mechanics WHERE workshop_id = ?',
  )
    .bind(row.id)
    .first<{ c: number }>();
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    serviceRadiusKm: row.service_radius_km,
    verificationStatus: row.verification_status as WorkshopProfileDto['verificationStatus'],
    capabilities: parseJsonArray(row.capabilities),
    ratingAverage: row.rating_count > 0 ? Math.round((row.rating_sum / row.rating_count) * 10) / 10 : 0,
    ratingCount: row.rating_count,
    mechanicsCount: count?.c ?? 0,
  };
}

export interface TowingRow {
  id: string;
  owner_user_id: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  service_radius_km: number;
  status: string;
  verification_status: string;
}

export async function mapTowing(env: Env, row: TowingRow): Promise<TowingProfileDto> {
  const vehicles = await env.DB.prepare(
    'SELECT id, plate_number, towing_type, capacity_kg FROM towing_vehicles WHERE partner_id = ?',
  )
    .bind(row.id)
    .all<{ id: string; plate_number: string; towing_type: string; capacity_kg: number | null }>();
  const fleet: TowingVehicleDto[] = vehicles.results.map((v) => ({
    id: v.id,
    plateNumber: v.plate_number,
    towingType: v.towing_type,
    capacityKg: v.capacity_kg,
  }));
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    serviceRadiusKm: row.service_radius_km,
    verificationStatus: row.verification_status as TowingProfileDto['verificationStatus'],
    status: row.status as TowingProfileDto['status'],
    fleet,
  };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function mapEmergencyContact(row: {
  id: string;
  name: string;
  phone: string;
  relationship: string;
}): EmergencyContactDto {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    relationship: row.relationship,
  };
}

export function mapNotification(row: {
  id: string;
  type: string;
  title: string;
  body: string;
  data_json: string | null;
  read_at: string | null;
  created_at: string;
}): NotificationDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data: parseJson<Record<string, unknown>>(row.data_json),
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export async function mapPayment(row: {
  id: string;
  request_id: string;
  provider: string;
  status: string;
  amount_cents: number;
  currency: string;
  method: string | null;
  created_at: string;
  paid_at: string | null;
}): Promise<PaymentDto> {
  return {
    id: row.id,
    requestId: row.request_id,
    provider: row.provider,
    status: row.status as PaymentDto['status'],
    amountCents: row.amount_cents,
    currency: row.currency,
    method: row.method,
    createdAt: row.created_at,
    paidAt: row.paid_at,
  };
}

export async function mapInvoice(
  env: Env,
  row: {
    id: string;
    number: string;
    request_id: string;
    subtotal_cents: number;
    tax_cents: number;
    discount_cents?: number;
    total_cents: number;
    status: string;
    pdf_key: string | null;
    created_at: string;
  },
  origin = '',
): Promise<InvoiceDto> {
  return {
    id: row.id,
    number: row.number,
    requestId: row.request_id,
    subtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents,
    discountCents: row.discount_cents ?? 0,
    totalCents: row.total_cents,
    status: row.status as InvoiceDto['status'],
    pdfUrl: row.pdf_key ? (await presignDownload(env, origin, row.pdf_key, 3600)).url : null,
    createdAt: row.created_at,
  };
}

export function mapReview(row: {
  id: string;
  request_id: string;
  reviewer_user_id: string;
  reviewee_user_id: string;
  overall: number;
  arrival: number;
  diagnosis: number;
  pricing: number;
  professionalism: number;
  resolution: number;
  comment: string | null;
  created_at: string;
  reviewee_name?: string;
}): ReviewDto {
  return {
    id: row.id,
    requestId: row.request_id,
    reviewerUserId: row.reviewer_user_id,
    revieweeUserId: row.reviewee_user_id,
    revieweeName: row.reviewee_name ?? '',
    overall: row.overall,
    categories: {
      arrival: row.arrival,
      diagnosis: row.diagnosis,
      pricing: row.pricing,
      professionalism: row.professionalism,
      resolution: row.resolution,
    },
    comment: row.comment,
    createdAt: row.created_at,
  };
}

export function mapDispatchAttempt(row: {
  id: string;
  request_id: string;
  attempt_no: number;
  mechanic_user_id: string;
  status: string;
  score: number | null;
  distance_km: number | null;
  eta_minutes: number | null;
  offered_at: string;
  responded_at: string | null;
  timeout_at: string | null;
  decline_reason: string | null;
  mechanic_name?: string;
}): DispatchAttemptDto {
  return {
    id: row.id,
    requestId: row.request_id,
    attemptNo: row.attempt_no,
    mechanicUserId: row.mechanic_user_id,
    mechanicName: row.mechanic_name ?? '',
    status: row.status as DispatchAttemptDto['status'],
    distanceKm: row.distance_km,
    etaMinutes: row.eta_minutes,
    score: row.score,
    offeredAt: row.offered_at,
    respondedAt: row.responded_at,
    timeoutAt: row.timeout_at,
    declineReason: row.decline_reason,
  };
}

export function mapDiagnosis(row: {
  id: string;
  request_id: string;
  mechanic_user_id: string;
  notes: string;
  created_at: string;
  items?: Array<{
    id: string;
    code: string;
    label: string;
    result: DiagnosisItemDto['result'];
    notes: string | null;
  }>;
}): DiagnosisDto {
  return {
    id: row.id,
    requestId: row.request_id,
    mechanicUserId: row.mechanic_user_id,
    notes: row.notes,
    items: (row.items ?? []).map((i) => ({
      id: i.id,
      code: i.code,
      label: i.label,
      result: i.result,
      notes: i.notes,
    })),
    createdAt: row.created_at,
  };
}
