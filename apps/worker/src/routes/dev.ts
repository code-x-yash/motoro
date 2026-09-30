import { Hono } from 'hono';
import type { Env } from '../env';
import { ok } from '../lib/response';
import { errors } from '../lib/errors';
import { requireUser } from '../lib/auth';
import { newId, newReference, nowIso, isoIn } from '../lib/ids';
import { hashPassword } from '../lib/crypto';
import { seedRoutesEnabled } from '../env';
import { DEFAULT_CONFIG, ISSUE_TYPES, SKILL_CATALOG, EQUIPMENT_CATALOG } from '@rr/config';
import { clearRateLimitMemory } from '../lib/rate-limit';

/**
 * Development-only seed + demo utilities.
 * Guarded by ENABLE_SEED_ROUTES=true AND ENVIRONMENT != production.
 * Everything here writes through the same tables the real API uses.
 */

const routes = new Hono<{ Bindings: Env }>();

function assertSeedEnabled(env: Env): void {
  if (!seedRoutesEnabled(env)) {
    throw errors.forbidden('Seed routes are disabled in this environment.');
  }
}

const DEMO_PASSWORD = 'Demo@1234';
const DEMO_LAT = 19.076;
const DEMO_LNG = 72.8777;

const DELETION_ORDER = [
  'push_subscriptions',
  'messages', 'payout_requests', 'coupons', 'disputes',
  'reviews', 'payments', 'invoices', 'service_reports', 'job_photos', 'job_parts',
  'jobs', 'job_status_history', 'quote_items', 'quotes', 'diagnosis_items', 'diagnoses',
  'mechanic_assignments', 'dispatch_attempts', 'emergency_events', 'emergency_locations',
  'emergency_requests', 'vehicle_documents', 'vehicles', 'towing_vehicles', 'towing_partners',
  'workshop_mechanics', 'workshops', 'mechanic_availability', 'mechanic_equipment',
  'mechanic_skills', 'mechanic_vehicle_types', 'ratings', 'notifications',
  'emergency_contacts', 'password_resets', 'sessions', 'files', 'audit_logs',
  'drivers', 'mechanics', 'parts',
];

routes.post('/reset', async (c) => {
  assertSeedEnabled(c.env);
  for (const table of DELETION_ORDER) {
    await c.env.DB.prepare(`DELETE FROM ${table}`).run().catch(() => undefined);
  }
  await c.env.DB.prepare('DELETE FROM users').run().catch(() => undefined);
  return ok({ reset: true }, c.get('requestId'));
});

/**
 * Resets rate limiting: clears the in-process counters and any mirrored KV
 * keys. Local test batteries call this instead of poking KV directly, since
 * counters now live primarily in memory.
 */
routes.post('/clear-ratelimits', async (c) => {
  assertSeedEnabled(c.env);
  const memoryCleared = clearRateLimitMemory();
  let kvCleared = 0;
  try {
    const listed = await c.env.KV.list({ prefix: 'rl:' });
    for (const key of listed.keys) {
      await c.env.KV.delete(key.name).catch(() => undefined);
      kvCleared += 1;
    }
  } catch {
    // KV unavailable (e.g. quota exhausted) — memory reset still applied.
  }
  return ok({ memory: memoryCleared, kv: kvCleared }, c.get('requestId'));
});

routes.get('/state', async (c) => {
  assertSeedEnabled(c.env);
  const tables = [
    'users', 'drivers', 'mechanics', 'workshops', 'towing_partners', 'vehicles',
    'emergency_requests', 'dispatch_attempts', 'jobs', 'quotes', 'payments', 'reviews',
  ];
  const counts: Record<string, number> = {};
  for (const t of tables) {
    const row = await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM ${t}`).first<{ c: number }>();
    counts[t] = row?.c ?? 0;
  }
  return ok({ counts }, c.get('requestId'));
});

/** Full realistic seed dataset. */
routes.post('/seed', async (c) => {
  assertSeedEnabled(c.env);
  const body = (await c.req.json().catch(() => ({}))) as { reset?: boolean; demoLat?: number; demoLng?: number };
  const demoLat = typeof body.demoLat === 'number' ? body.demoLat : DEMO_LAT;
  const demoLng = typeof body.demoLng === 'number' ? body.demoLng : DEMO_LNG;

  if (body.reset) {
    for (const table of DELETION_ORDER) {
      await c.env.DB.prepare(`DELETE FROM ${table}`).run().catch(() => undefined);
    }
    await c.env.DB.prepare('DELETE FROM users').run().catch(() => undefined);
  }

  const existing = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM users').first<{ c: number }>();
  if ((existing?.c ?? 0) > 0) {
    return ok(
      { seeded: false, reason: 'Database already contains users. Pass {"reset":true} to reseed.' },
      c.get('requestId'),
    );
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const now = nowIso();
  const created: Record<string, string[]> = {
    admin: [], operations: [], drivers: [], mechanics: [], workshops: [], towing: [],
  };

  const insertUser = (opts: {
    id: string; role: string; name: string; email: string; phone?: string;
  }) =>
    c.env.DB.prepare(
      `INSERT INTO users (id, role, email, phone, password_hash, full_name, locale, status, email_verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'en', 'ACTIVE', ?, ?, ?)`,
    ).bind(
      opts.id, opts.role, opts.email, opts.phone ?? null, passwordHash, opts.name, now, now, now,
    );

  const stmts = [];

  // 1 admin + 2 operations
  const adminId = newId();
  stmts.push(insertUser({ id: adminId, role: 'ADMIN', name: 'Asha Admin', email: 'admin@motoro.test', phone: '9110000001' }));
  created.admin.push('admin@motoro.test');
  for (let i = 0; i < 2; i++) {
    const id = newId();
    stmts.push(insertUser({
      id, role: 'OPERATIONS',
      name: i === 0 ? 'Rahul Ops' : 'Priya Ops',
      email: `ops${i + 1}@motoro.test`,
      phone: `911000001${i}`,
    }));
    created.operations.push(`ops${i + 1}@motoro.test`);
  }

  // 10 drivers
  const driverIds: string[] = [];
  const driverNames = ['Yash Rajora', 'Meera Shah', 'Vikram Singh', 'Anita Desai', 'Karan Patel', 'Sneha Iyer', 'Arjun Nair', 'Divya Menon', 'Rohit Gupta', 'Farhan Khan'];
  for (let i = 0; i < 10; i++) {
    const id = newId();
    driverIds.push(id);
    stmts.push(insertUser({
      id, role: 'DRIVER', name: driverNames[i], email: `driver${i + 1}@motoro.test`, phone: `91100001${String(i).padStart(2, '0')}`,
    }));
    stmts.push(c.env.DB.prepare('INSERT INTO drivers (user_id, membership, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind(id, i < 3 ? 'PLUS' : 'FREE', now, now));
    created.drivers.push(`driver${i + 1}@motoro.test`);
  }

  // 15 mechanics with mixed states
  const mechanicNames = ['Suresh Kumar', 'Amit Verma', 'Joseph Thomas', 'Nitin Rao', 'Sanjay Yadav', 'Rakesh Sharma', 'Imran Ali', 'Deepak Chauhan', 'Manoj Tiwari', 'Sathish Kumar', 'Harish Reddy', 'Vinod Pillai', 'Akash Gupta', 'Prakash Jadhav', 'Ravi Shankar'];
  const skillPool = [...SKILL_CATALOG];
  const equipmentPool = [...EQUIPMENT_CATALOG];
  const mechanicIds: string[] = [];
  const statuses = ['AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'AVAILABLE', 'BUSY', 'OFFLINE', 'PAUSED', 'AVAILABLE', 'OFFLINE', 'AVAILABLE', 'BUSY', 'OFFLINE', 'AVAILABLE'];

  for (let i = 0; i < 15; i++) {
    const id = newId();
    mechanicIds.push(id);
    stmts.push(insertUser({
      id, role: 'MECHANIC', name: mechanicNames[i], email: `mechanic${i + 1}@motoro.test`, phone: `91100002${String(i).padStart(2, '0')}`,
    }));
    // Spread around the demo location (~0.5-4 km).
    const angle = (i / 15) * Math.PI * 2;
    const spread = 0.01 + (i % 5) * 0.006;
    const lat = demoLat + Math.sin(angle) * spread;
    const lng = demoLng + Math.cos(angle) * spread;
    stmts.push(c.env.DB.prepare(
      `INSERT INTO mechanics (user_id, verification_status, status, bio, experience_years, address, latitude, longitude,
                              last_known_latitude, last_known_longitude, service_radius_km, rating_sum, rating_count,
                              jobs_completed, jobs_cancelled, offers_received, offers_accepted, earnings_cents,
                              reliability_score, submitted_at, reviewed_at, created_at, updated_at)
       VALUES (?, 'VERIFIED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      statuses[i],
      `${4 + (i % 12)} years of roadside experience. Specialist in ${skillPool[i % skillPool.length].replace('_', ' ')}.`,
      4 + (i % 12),
      `Workshop lane ${i + 1}, demo city`,
      lat, lng, lat, lng,
      8 + (i % 5) * 4,
      (3 + (i % 3)) * 40 + (i % 5) * 10,
      30 + (i % 5) * 10,
      40 + i * 3,
      i % 7 === 0 ? 2 : 0,
      60 + i * 4,
      52 + i * 4,
      (200000 + i * 15000),
      0.72 + (i % 5) * 0.05,
      now, now, now, now,
    ));
    mechanicIds.push(); // noop
    created.mechanics.push(`mechanic${i + 1}@motoro.test`);

    // Skills (3-5 each), equipment, vehicle types
    const skillCount = 3 + (i % 3);
    for (let s = 0; s < skillCount; s++) {
      stmts.push(c.env.DB.prepare(
        `INSERT INTO mechanic_skills (id, mechanic_user_id, skill, level, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(newId(), id, skillPool[(i + s) % skillPool.length], s === 0 ? 'EXPERT' : 'INTERMEDIATE', now));
    }
    const equipCount = 3 + (i % 4);
    for (let e = 0; e < equipCount; e++) {
      stmts.push(c.env.DB.prepare(
        `INSERT INTO mechanic_equipment (id, mechanic_user_id, equipment, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(newId(), id, equipmentPool[(i + e) % equipmentPool.length], now));
    }
    const types = ['CAR', 'SUV', 'TWO_WHEELER'];
    for (const t of types.slice(0, 1 + (i % 3))) {
      stmts.push(c.env.DB.prepare(
        `INSERT INTO mechanic_vehicle_types (mechanic_user_id, vehicle_type, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(id, t, now));
    }
    // Availability: every day 08:00-22:00
    for (let d = 0; d < 7; d++) {
      stmts.push(c.env.DB.prepare(
        `INSERT INTO mechanic_availability (id, mechanic_user_id, day_of_week, start_minute, end_minute, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(newId(), id, d, 480, 1320, now));
    }
  }

  // 3 workshops + their mechanics
  for (let i = 0; i < 3; i++) {
    const ownerId = newId();
    stmts.push(insertUser({
      id: ownerId, role: 'WORKSHOP', name: `Workshop Owner ${i + 1}`, email: `workshop${i + 1}@motoro.test`, phone: `91100003${i}`,
    }));
    const workshopId = newId();
    stmts.push(c.env.DB.prepare(
      `INSERT INTO workshops (id, owner_user_id, name, address, latitude, longitude, service_radius_km,
                              verification_status, capabilities, rating_sum, rating_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, ?, ?, ?, ?)`,
    ).bind(
      workshopId, ownerId,
      ['City Auto Care', 'SpeedFix Motors', 'Highway Heroes'][i],
      `${i + 1} Industrial Lane, demo city`,
      demoLat + 0.02 * (i + 1), demoLng - 0.02 * (i + 1),
      15,
      JSON.stringify(['engine', 'electrical', 'tyre', 'bodywork']),
      120 + i * 30, 25 + i * 5, now, now,
    ));
    created.workshops.push(`workshop${i + 1}@motoro.test`);

    // workshop owner is also a mechanic
    stmts.push(c.env.DB.prepare(
      `INSERT INTO mechanics (user_id, verification_status, status, experience_years, address, latitude, longitude,
                              service_radius_km, workshop_id, rating_sum, rating_count, jobs_completed, offers_received,
                              offers_accepted, earnings_cents, submitted_at, reviewed_at, created_at, updated_at)
       VALUES (?, 'VERIFIED', 'AVAILABLE', ?, ?, ?, ?, 12, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      ownerId, 10 + i,
      `${i + 1} Industrial Lane`,
      demoLat + 0.02 * (i + 1), demoLng - 0.02 * (i + 1),
      workshopId,
      90 + i * 20, 20 + i * 5, 25 + i * 5, 40 + i * 5, 35 + i * 5,
      150000 + i * 20000, now, now, now, now,
    ));
    stmts.push(c.env.DB.prepare(
      `INSERT INTO mechanic_skills (id, mechanic_user_id, skill, level, created_at) VALUES (?, ?, 'engine', 'EXPERT', ?)`,
    ).bind(newId(), ownerId, now));
    stmts.push(c.env.DB.prepare(
      `INSERT INTO workshop_mechanics (workshop_id, mechanic_user_id, job_role, created_at) VALUES (?, ?, 'OWNER', ?)`,
    ).bind(workshopId, ownerId, now));
    for (let m = 0; m < 4; m++) {
      const idx = (i * 4 + m) % mechanicIds.length;
      if (!mechanicIds[idx]) continue;
      stmts.push(c.env.DB.prepare(
        `INSERT INTO workshop_mechanics (workshop_id, mechanic_user_id, job_role, created_at) VALUES (?, ?, 'MECHANIC', ?) ON CONFLICT DO NOTHING`,
      ).bind(workshopId, mechanicIds[idx], now));
    }
  }

  // 2 towing partners
  for (let i = 0; i < 2; i++) {
    const ownerId = newId();
    stmts.push(insertUser({
      id: ownerId, role: 'TOWING_PARTNER', name: `Tow Partner ${i + 1}`, email: `towing${i + 1}@motoro.test`, phone: `91100004${i}`,
    }));
    const partnerId = newId();
    stmts.push(c.env.DB.prepare(
      `INSERT INTO towing_partners (id, owner_user_id, name, address, latitude, longitude, service_radius_km,
                                    status, verification_status, jobs_completed, earnings_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', 'VERIFIED', ?, ?, ?, ?)`,
    ).bind(
      partnerId, ownerId, ['Swift Recovery', 'Metro Towing'][i],
      `${i + 1} Ring Road, demo city`,
      demoLat - 0.03 * (i + 1), demoLng + 0.03 * (i + 1),
      30, 12 + i * 6, 80000 + i * 30000, now, now,
    ));
    stmts.push(c.env.DB.prepare(
      `INSERT INTO towing_vehicles (id, partner_id, plate_number, towing_type, capacity_kg, created_at)
       VALUES (?, ?, ?, 'FLATBED', ?, ?)`,
    ).bind(newId(), partnerId, `MH01TW${i + 1}00${i + 1}`, 3500, now));
    created.towing.push(`towing${i + 1}@motoro.test`);
  }

  await c.env.DB.batch(stmts);

  // 15 vehicles across drivers
  const vehicleStmts = [];
  const makes = [
    ['Mahindra', 'XUV300', 'W8', 'PETROL', 'SUV'],
    ['Maruti', 'Swift', 'VXi', 'PETROL', 'CAR'],
    ['Hyundai', 'Creta', 'SX', 'DIESEL', 'SUV'],
    ['Tata', 'Nexon', 'XZ+', 'ELECTRIC', 'EV'],
    ['Honda', 'City', 'V', 'PETROL', 'CAR'],
    ['Toyota', 'Innova', 'ZX', 'DIESEL', 'SUV'],
    ['Kia', 'Seltos', 'HTX', 'PETROL', 'SUV'],
    ['Volkswagen', 'Polo', 'GT', 'PETROL', 'CAR'],
    ['Bajaj', 'Pulsar', 'NS200', 'PETROL', 'TWO_WHEELER'],
    ['Honda', 'Activa', '6G', 'PETROL', 'SCOOTER'],
    ['MG', 'Hector', 'Sharp', 'DIESEL', 'SUV'],
    ['Renault', 'Kwid', 'RXT', 'PETROL', 'CAR'],
    ['Ford', 'EcoSport', 'Titanium', 'PETROL', 'SUV'],
    ['TVS', 'Jupiter', '125', 'PETROL', 'SCOOTER'],
    ['Skoda', 'Slavia', 'Style', 'PETROL', 'CAR'],
  ];
  const vehicleIds: string[] = [];
  for (let i = 0; i < 15; i++) {
    const id = newId();
    vehicleIds.push(id);
    const [make, model, variant, fuel, type] = makes[i];
    vehicleStmts.push(c.env.DB.prepare(
      `INSERT INTO vehicles (id, user_id, registration_number, make, model, variant, year, fuel_type, vehicle_type,
                             insurance_expiry, rc_number, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      driverIds[i % driverIds.length],
      `MH01AB${1000 + i}`,
      make, model, variant,
      2016 + (i % 8),
      fuel as 'PETROL' | 'DIESEL' | 'ELECTRIC',
      type as 'CAR' | 'SUV' | 'EV' | 'TWO_WHEELER' | 'SCOOTER',
      isoIn(60 * 60 * 24 * (90 + i * 10)),
      `RC${2000 + i}`,
      ['White', 'Silver', 'Red', 'Blue', 'Black'][i % 5],
      now, now,
    ));
  }
  await c.env.DB.batch(vehicleStmts);

  // 20 historical emergency requests (10 completed with jobs + reviews)
  const issueTypes = [...ISSUE_TYPES];
  const historyStmts = [];
  const completedRequestIds: string[] = [];

  for (let i = 0; i < 20; i++) {
    const id = newId();
    const driverIdx = i % driverIds.length;
    const mechanicIdx = (i * 3) % mechanicIds.length;
    const status = i < 10 ? 'PAID' : i < 14 ? 'COMPLETED' : i < 17 ? 'CANCELLED' : 'FAILED';
    const issue = issueTypes[i % issueTypes.length];
    const daysAgo = 20 - i;
    const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    const lat = demoLat + (Math.random() - 0.5) * 0.06;
    const lng = demoLng + (Math.random() - 0.5) * 0.06;
    const isPaid = status === 'PAID' || status === 'COMPLETED';
    const assigned = isPaid || status === 'CANCELLED' ? mechanicIds[mechanicIdx] : null;

    historyStmts.push(c.env.DB.prepare(
      `INSERT INTO emergency_requests (id, reference, driver_user_id, vehicle_id, channel, category_code, issue_type,
                                       description, urgency, status, latitude, longitude, address, required_skills,
                                       required_equipment, assigned_mechanic_user_id, dispatch_radius_km,
                                       payment_status, total_amount_cents, completed_at, cancel_reason, cancelled_by,
                                       created_at, updated_at)
       VALUES (?, ?, ?, ?, 'WEB', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 5, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      newReference(),
      driverIds[driverIdx],
      vehicleIds[driverIdx % vehicleIds.length],
      issue,
      issue,
      `Historical case: ${issue.replace(/_/g, ' ')}`,
      i % 5 === 0 ? 'HIGH' : 'NORMAL',
      status,
      lat, lng,
      `Near demo location ${i + 1}`,
      JSON.stringify(['general']),
      JSON.stringify(['basic_tools']),
      assigned,
      status === 'PAID' ? 'PAID' : status === 'COMPLETED' ? 'PENDING' : null,
      isPaid ? 120000 + i * 5000 : null,
      isPaid ? createdAt : null,
      status === 'CANCELLED' ? 'Customer resolved it themselves' : null,
      status === 'CANCELLED' ? driverIds[driverIdx] : null,
      createdAt,
      createdAt,
    ));
    if (isPaid) completedRequestIds.push(id);

    historyStmts.push(c.env.DB.prepare(
      `INSERT INTO emergency_events (id, request_id, type, message, actor_role, actor_user_id, created_at)
       VALUES (?, ?, 'REQUEST_CREATED', 'Emergency request created', 'DRIVER', ?, ?)`,
    ).bind(newId(), id, driverIds[driverIdx], createdAt));
    historyStmts.push(c.env.DB.prepare(
      `INSERT INTO emergency_events (id, request_id, type, message, actor_role, created_at)
       VALUES (?, ?, 'STATUS_COMPLETED', 'Request completed', 'SYSTEM', ?)`,
    ).bind(newId(), id, createdAt));

    if (isPaid && assigned) {
      const jobId = newId();
      historyStmts.push(c.env.DB.prepare(
        `INSERT INTO jobs (id, request_id, mechanic_user_id, status, earnings_cents, accepted_at, en_route_at,
                           arrived_at, otp_verified_at, started_at, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        jobId, id, assigned, 90000 + i * 4000,
        createdAt, createdAt, createdAt, createdAt, createdAt, createdAt, createdAt, createdAt,
      ));
      const quoteId = newId();
      historyStmts.push(c.env.DB.prepare(
        `INSERT INTO quotes (id, request_id, job_id, status, subtotal_cents, tax_cents, fees_cents, discount_cents,
                             total_cents, tax_percent, created_by, decided_by, decided_at, created_at, updated_at)
       VALUES (?, ?, ?, 'APPROVED', ?, ?, 0, 0, ?, 18, ?, ?, ?, ?, ?)`,
      ).bind(quoteId, id, jobId, 80000 + i * 3000, Math.round((80000 + i * 3000) * 0.18), 94400 + i * 3540, assigned, driverIds[driverIdx], createdAt, createdAt, createdAt));
      historyStmts.push(c.env.DB.prepare(
        `INSERT INTO quote_items (id, quote_id, type, description, quantity, unit_price_cents, total_cents, sort, created_at)
       VALUES (?, ?, 'PART', 'Replacement part', 1, ?, ?, 0, ?)`,
      ).bind(newId(), quoteId, 40000 + i * 2000, 40000 + i * 2000, createdAt));
      historyStmts.push(c.env.DB.prepare(
        `INSERT INTO quote_items (id, quote_id, type, description, quantity, unit_price_cents, total_cents, sort, created_at)
       VALUES (?, ?, 'LABOUR', 'Labour charges', 1, ?, ?, 1, ?)`,
      ).bind(newId(), quoteId, 40000 + i * 1000, 40000 + i * 1000, createdAt));
      historyStmts.push(c.env.DB.prepare(
        `INSERT INTO payments (id, request_id, provider, provider_ref, status, amount_cents, currency, method,
                               created_at, updated_at, paid_at)
       VALUES (?, ?, 'test', ?, 'PAID', ?, 'INR', 'UPI', ?, ?, ?)`,
      ).bind(newId(), id, `test_seed_${i}`, 120000 + i * 5000, createdAt, createdAt, createdAt));
      historyStmts.push(c.env.DB.prepare(
        `INSERT INTO invoices (id, number, request_id, subtotal_cents, tax_cents, total_cents, status, issued_at, paid_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PAID', ?, ?, ?)`,
      ).bind(newId(), `INV-SEED-${1000 + i}`, id, 100000 + i * 4000, 20000 + i * 1000, 120000 + i * 5000, createdAt, createdAt, createdAt));

      if (i % 2 === 0) {
        historyStmts.push(c.env.DB.prepare(
          `INSERT INTO reviews (id, request_id, job_id, reviewer_user_id, reviewee_user_id, direction, overall,
                                arrival, diagnosis, pricing, professionalism, resolution, comment, created_at)
         VALUES (?, ?, ?, ?, ?, 'DRIVER_TO_MECHANIC', ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          newId(), id, jobId, driverIds[driverIdx], assigned,
          4 + (i % 2), 5, 4, 4, 5, 5,
          'Quick and professional. Fixed it on the spot.',
          createdAt,
        ));
        const agg = { s: 4, c: 1 };
        historyStmts.push(c.env.DB.prepare(
          `INSERT INTO ratings (user_id, average, count, sum, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET average = excluded.average, count = excluded.count, sum = excluded.sum, updated_at = excluded.updated_at`,
        ).bind(assigned, 4, 1, 4, createdAt));
        void agg;
        historyStmts.push(c.env.DB.prepare(
          `UPDATE mechanics SET rating_sum = rating_sum + 4, rating_count = rating_count + 1, jobs_completed = jobs_completed + 1,
                                 earnings_cents = earnings_cents + 90000 WHERE user_id = ?`,
        ).bind(assigned));
      } else {
        historyStmts.push(c.env.DB.prepare(
          `UPDATE mechanics SET jobs_completed = jobs_completed + 1, earnings_cents = earnings_cents + 90000 WHERE user_id = ?`,
        ).bind(assigned));
      }
    }
  }

  // flush in batches to stay under statement limits
  for (let i = 0; i < historyStmts.length; i += 80) {
    await c.env.DB.batch(historyStmts.slice(i, i + 80));
  }

  await c.env.DB.prepare(
    `INSERT INTO platform_config (key, value_json, updated_at) VALUES ('dispatch', ?, ?)
     ON CONFLICT(key) DO NOTHING`,
  ).bind(
    JSON.stringify({
      radiusStepsKm: DEFAULT_CONFIG.dispatch.radiusStepsKm,
      attemptTimeoutSeconds: DEFAULT_CONFIG.dispatch.attemptTimeoutSeconds,
      maxActiveJobsPerMechanic: DEFAULT_CONFIG.dispatch.maxActiveJobsPerMechanic,
      stallWarningSeconds: DEFAULT_CONFIG.dispatch.stallWarningSeconds,
      stallEscalateSeconds: DEFAULT_CONFIG.dispatch.stallEscalateSeconds,
    }),
    now,
  ).run();

  return ok(
    {
      seeded: true,
      demoLocation: { latitude: demoLat, longitude: demoLng },
      accounts: {
        password: DEMO_PASSWORD,
        admin: created.admin,
        operations: created.operations,
        drivers: created.drivers,
        mechanics: created.mechanics,
        workshops: created.workshops,
        towing: created.towing,
      },
      counts: await countTables(c.env),
    },
    c.get('requestId'),
    201,
  );
});

async function countTables(env: Env): Promise<Record<string, number>> {
  const tables = ['users', 'mechanics', 'vehicles', 'emergency_requests', 'jobs', 'quotes', 'payments', 'reviews'];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${t}`).first<{ c: number }>();
    out[t] = row?.c ?? 0;
  }
  return out;
}

/** Quick authenticated ping so the UI can verify dev routes are live. */
routes.get('/ping', async (c) => {
  assertSeedEnabled(c.env);
  const user = await requireUser(c);
  return ok({ enabled: true, user: user.email }, c.get('requestId'));
});

export default routes;
