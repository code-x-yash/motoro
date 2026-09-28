#!/usr/bin/env node
/**
 * Seeds the Motoro database with a production-grade demo dataset.
 *
 *   npm run seed                 # reset + seed the local D1 SQLite file
 *   npm run seed -- --no-reset   # print current counts, touch nothing
 *   MOTORO_D1_PATH=/path/to.sqlite npm run seed
 *
 * The seeder writes directly to the local D1 object under
 * `apps/worker/.wrangler/state/v3/d1/` — the exact file the dev worker serves —
 * so it needs no running server, no network and no ENABLE_SEED_ROUTES flag.
 *
 * Everything is deterministic: ids, references and counts are generated from
 * counters, timestamps are derived from the clock at run time. Re-running
 * `npm run seed` therefore always produces identical counts (idempotent).
 *
 * Rows are written inside a single transaction, and the dataset is built to be
 * stable under the worker cron sweeps (`apps/worker/src/dispatch/service.ts`):
 *   - SEARCHING / DISPATCHING requests keep a PENDING offer with a future
 *     `timeout_at`, so `sweepStaleSearching` / `sweepExpiredAttempts` skip them;
 *   - ESCALATED requests carry `escalation_level > maxEscalationRetries`;
 *   - EN_ROUTE jobs keep `en_route_at IS NULL`, so `sweepStalledJobs` skips them.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash, pbkdf2Sync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_CONFIG,
  EQUIPMENT_CATALOG,
  ISSUE_REQUIRED_EQUIPMENT,
  ISSUE_REQUIRED_SKILLS,
  ISSUE_TYPES,
  SKILL_CATALOG,
} from '@rr/config';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D1_DIR = path.join(ROOT, 'apps', 'worker', '.wrangler', 'state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
const MIGRATIONS_DIR = path.join(ROOT, 'apps', 'worker', 'migrations');
const NO_RESET = process.argv.includes('--no-reset');

const PASSWORD = 'Demo@1234';
const DEMO_LAT = 19.076;
const DEMO_LNG = 72.8777;
const DEMO_OTP = '482913';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.now();

/** Same order the dev reset route uses (children before parents). */
const DELETION_ORDER = [
  'reviews', 'payments', 'invoices', 'service_reports', 'job_photos', 'job_parts',
  'jobs', 'job_status_history', 'quote_items', 'quotes', 'diagnosis_items', 'diagnoses',
  'mechanic_assignments', 'dispatch_attempts', 'emergency_events', 'emergency_locations',
  'emergency_requests', 'vehicle_documents', 'vehicles', 'towing_vehicles', 'towing_partners',
  'workshop_mechanics', 'workshops', 'mechanic_availability', 'mechanic_equipment',
  'mechanic_skills', 'mechanic_vehicle_types', 'ratings', 'notifications',
  'emergency_contacts', 'password_resets', 'sessions', 'files', 'audit_logs',
  'drivers', 'mechanics', 'parts',
];

const COUNT_TABLES = [
  'users', 'mechanics', 'vehicles', 'emergency_requests', 'jobs', 'quotes', 'payments', 'reviews',
  'drivers', 'workshops', 'towing_partners', 'dispatch_attempts', 'emergency_events',
  'emergency_locations', 'job_status_history', 'diagnoses', 'diagnosis_items', 'quote_items',
  'invoices', 'service_reports', 'notifications', 'audit_logs', 'emergency_contacts',
  'pricing_rules', 'platform_config', 'service_categories', 'disputes',
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function ago(ms) {
  return iso(NOW - ms);
}

function utcStartOfDay(offsetDays = 0) {
  const d = new Date(NOW);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() + offsetDays * DAY;
}

/** A timestamp on the given calendar day (clamped so it never runs ahead). */
function dayAt(daysAgo, hour = 10, minute = 0) {
  const at = utcStartOfDay(-daysAgo) + hour * HOUR + minute * MIN;
  return iso(Math.min(at, NOW));
}

/** A timestamp today (never before midnight UTC, never in the future). */
function todayAt(minutesAgo = 0) {
  return iso(Math.max(utcStartOfDay(0), NOW - minutesAgo * MIN));
}

function parseMs(value) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? NOW : t;
}

let idSeq = 0;
function newId() {
  idSeq += 1;
  return `00000000-0000-4000-8000-${idSeq.toString(16).padStart(12, '0')}`;
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REF_MAP = REF_ALPHABET.slice(16) + REF_ALPHABET.slice(0, 16);
let refSeq = 0;
function newReference() {
  refSeq += 1;
  let n = refSeq;
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out = REF_MAP[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return `RR-${out}`;
}

let invoiceSeq = 0;
function newInvoiceNumber(year) {
  invoiceSeq += 1;
  return `INV-${year}-${String(invoiceSeq).padStart(5, '0')}`;
}

function demoPasswordHash() {
  const salt = Buffer.from('motoro-demo-salt');
  const hash = pbkdf2Sync(PASSWORD, salt, 100_000, 32, 'sha256');
  return `pbkdf2$100000$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function makeInserter(db) {
  const cache = new Map();
  return (table, row) => {
    const cols = Object.keys(row);
    const key = `${table}|${cols.join(',')}`;
    let sql = cache.get(key);
    if (!sql) {
      sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      cache.set(key, sql);
    }
    const values = cols.map((col) => {
      const value = row[col];
      if (value === undefined || value === null) return null;
      if (typeof value === 'boolean') return value ? 1 : 0;
      return value;
    });
    db.prepare(sql).run(...values);
  };
}

/**
 * Upsert helper for the catalogue tables that survive a reset
 * (`platform_config`, `pricing_rules`, `service_categories` are not part of
 * `DELETION_ORDER`), so re-running the seeder must overwrite, not re-insert.
 */
function makeUpsert(db, conflictColumn) {
  const cache = new Map();
  return (table, row) => {
    const cols = Object.keys(row);
    let sql = cache.get(table);
    if (!sql) {
      const sets = cols
        .filter((col) => col !== conflictColumn)
        .map((col) => `${col} = excluded.${col}`)
        .join(', ');
      sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
        + ` ON CONFLICT(${conflictColumn}) DO UPDATE SET ${sets}`;
      cache.set(table, sql);
    }
    const values = cols.map((col) => {
      const value = row[col];
      if (value === undefined || value === null) return null;
      if (typeof value === 'boolean') return value ? 1 : 0;
      return value;
    });
    db.prepare(sql).run(...values);
  };
}

// ---------------------------------------------------------------------------
// Database discovery + schema
// ---------------------------------------------------------------------------

function findDatabase() {
  const override = process.env.MOTORO_D1_PATH;
  if (override) {
    if (!existsSync(override)) fail(`MOTORO_D1_PATH does not exist: ${override}`);
    return override;
  }
  if (!existsSync(D1_DIR)) return null;
  const files = readdirSync(D1_DIR)
    .filter((name) => name.endsWith('.sqlite') && !name.startsWith('metadata'))
    .sort();
  if (files.length === 0) return null;
  if (files.length > 1) console.log(`  found ${files.length} D1 objects, using ${files[0]}`);
  return path.join(D1_DIR, files[0]);
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function applyMigrations(db) {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const raw = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const sql = raw
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    for (const statement of sql.split(';')) {
      const trimmed = statement.trim();
      if (trimmed) db.exec(trimmed);
    }
  }
  console.log(`  applied ${files.length} migration file(s)`);
}

function resetDatabase(db) {
  for (const table of ['disputes', ...DELETION_ORDER, 'users']) {
    if (tableExists(db, table)) db.exec(`DELETE FROM ${table}`);
  }
}

// ---------------------------------------------------------------------------
// Demo catalogue (names, models, copy)
// ---------------------------------------------------------------------------

const DRIVER_NAMES = [
  'Yash Rajora', 'Meera Shah', 'Vikram Singh', 'Anita Desai', 'Karan Patel',
  'Sneha Iyer', 'Arjun Nair', 'Divya Menon', 'Rohit Gupta', 'Farhan Khan',
];

const MECHANIC_NAMES = [
  'Suresh Kumar', 'Amit Verma', 'Joseph Thomas', 'Nitin Rao', 'Sanjay Yadav',
  'Rakesh Sharma', 'Imran Ali', 'Deepak Chauhan', 'Manoj Tiwari', 'Sathish Kumar',
  'Harish Reddy', 'Vinod Pillai', 'Akash Gupta', 'Prakash Jadhav', 'Ravi Shankar',
];

const WORKSHOP_NAMES = ['City Auto Care', 'SpeedFix Motors', 'Highway Heroes'];
const TOWING_NAMES = ['Swift Recovery', 'Metro Towing'];

const FLEET = [
  ['Mahindra', 'XUV300', 'W8', 'PETROL', 'SUV'],
  ['Maruti', 'Swift', 'VXi', 'PETROL', 'CAR'],
  ['Honda', 'Activa', '6G', 'PETROL', 'SCOOTER'],
  ['Tata', 'Nexon', 'XZ+', 'ELECTRIC', 'EV'],
  ['Hyundai', 'Creta', 'SX', 'DIESEL', 'SUV'],
  ['Honda', 'City', 'V', 'PETROL', 'CAR'],
  ['Bajaj', 'Pulsar', 'NS200', 'PETROL', 'TWO_WHEELER'],
  ['Toyota', 'Innova', 'ZX', 'DIESEL', 'SUV'],
  ['Kia', 'Seltos', 'HTX', 'PETROL', 'SUV'],
  ['Volkswagen', 'Polo', 'GT', 'PETROL', 'CAR'],
  ['TVS', 'Jupiter', '125', 'PETROL', 'SCOOTER'],
  ['Renault', 'Kwid', 'RXT', 'PETROL', 'CAR'],
  ['Skoda', 'Slavia', 'Style', 'PETROL', 'CAR'],
  ['MG', 'Hector', 'Sharp', 'DIESEL', 'SUV'],
  ['Ford', 'EcoSport', 'Titanium', 'PETROL', 'SUV'],
];

const ADDRESSES = [
  'Linking Road, Bandra West, Mumbai',
  'SV Road, Andheri West, Mumbai',
  'Hill Road, Bandra West, Mumbai',
  'Turner Road, Bandra West, Mumbai',
  'Waterfield Road, Bandra West, Mumbai',
  'Andheri Kurla Road, Andheri East, Mumbai',
  'LBS Marg, Kurla West, Mumbai',
  'Dadar TT Circle, Dadar, Mumbai',
  'Worli Sea Face, Worli, Mumbai',
  'Chandivali Road, Powai, Mumbai',
];

const DESCRIPTIONS = {
  BATTERY: 'Car will not crank — the lights come on but the starter only clicks.',
  FLAT_TYRE: 'Rear tyre went flat on the service road, car is parked safely off the lane.',
  OUT_OF_FUEL: 'Ran out of fuel a few hundred metres from the petrol pump.',
  ENGINE_PROBLEM: 'Engine is misfiring and the check-engine light came on under load.',
  ELECTRICAL_PROBLEM: 'Dashboard lights flicker and the indicators stopped responding.',
  OVERHEATING: 'Temperature warning came on and steam is coming from the bonnet.',
  LOCKOUT: 'Keys are locked inside the car with the engine switched off.',
  ACCIDENT: 'Minor collision at a junction, bumper is damaged and the car will not move.',
  GENERAL_BREAKDOWN: 'Car stopped in the middle of traffic and will not start again.',
  DONT_KNOW: 'Something is wrong with the car — I cannot tell what it is.',
};

const QUOTE_TEMPLATES = {
  BATTERY: [
    ['PART', 'Battery 35Ah (48-month warranty)', 450_000],
    ['LABOUR', 'Battery fitment & charging system test', 30_000],
    ['PART', 'Terminal protection spray', 4_500],
  ],
  FLAT_TYRE: [
    ['PART', 'Tubeless puncture repair', 15_000],
    ['LABOUR', 'Wheel removal, repair & balancing', 45_000],
    ['PART', 'Wheel weights', 1_200],
  ],
  OUT_OF_FUEL: [
    ['PART', 'Fuel — 5L premium petrol', 55_000],
    ['LABOUR', 'Emergency fuel delivery', 40_000],
  ],
  ENGINE_PROBLEM: [
    ['PART', 'Fuel filter', 32_000],
    ['LABOUR', 'Diagnostics & labour (2h)', 60_000],
    ['PART', 'Air filter', 24_000],
  ],
  ELECTRICAL_PROBLEM: [
    ['PART', 'Fuse & relay set', 4_800],
    ['LABOUR', 'Wiring diagnosis and repair (1.5h)', 55_000],
    ['PART', 'Headlamp bulb H4', 1_800],
  ],
  OVERHEATING: [
    ['PART', 'Coolant 2L concentrate', 24_000],
    ['LABOUR', 'Cooling system pressure test', 35_000],
    ['PART', 'Thermostat', 42_000],
  ],
  LOCKOUT: [
    ['PART', 'Spare key cutting', 60_000],
    ['LABOUR', 'Lockout service', 45_000],
  ],
  ACCIDENT: [
    ['PART', 'Bumper clip set', 38_000],
    ['LABOUR', 'Body alignment & refit (3h)', 120_000],
    ['PART', 'Touch-up paint', 6_500],
  ],
  GENERAL_BREAKDOWN: [
    ['PART', 'Fuse set', 2_500],
    ['LABOUR', 'Roadside labour (1h)', 35_000],
    ['PART', 'Belt tensioner', 28_000],
  ],
  DONT_KNOW: [
    ['LABOUR', 'Inspection & labour (1h)', 35_000],
    ['PART', 'Consumables', 3_500],
  ],
};

const DIAGNOSIS_TEMPLATES = {
  BATTERY: [
    ['BATTERY_VOLTAGE', 'Battery resting voltage', 'FAIL', '11.4V — below the 12.4V spec'],
    ['ALTERNATOR_OUTPUT', 'Alternator charging output', 'OK', '14.1V at 2000 rpm'],
    ['TERMINALS', 'Terminals & corrosion', 'OK', 'Clean and torqued to spec'],
    ['STARTER_DRAW', 'Starter motor draw', 'UNCERTAIN', 'Needs a second reading after charging'],
  ],
  FLAT_TYRE: [
    ['TYRE_PRESSURE', 'Tyre pressure', 'FAIL', '0 psi on the rear left'],
    ['TREAD_DEPTH', 'Tread depth', 'OK', '5.5 mm remaining'],
    ['PUNCTURE', 'Puncture location', 'FAIL', '2 mm screw in the shoulder area'],
  ],
  OUT_OF_FUEL: [
    ['FUEL_LEVEL', 'Fuel level', 'FAIL', 'Tank dry'],
    ['FUEL_PUMP', 'Fuel pump prime', 'OK', 'Pump primes normally'],
  ],
  ENGINE_PROBLEM: [
    ['OBD_CODES', 'OBD fault codes', 'FAIL', 'P0301 — cylinder 1 misfire'],
    ['SPARK_PLUGS', 'Spark plugs', 'FAIL', 'Electrodes worn'],
    ['COMPRESSION', 'Compression test', 'OK', 'All cylinders within 5%'],
  ],
  ELECTRICAL_PROBLEM: [
    ['BATTERY_VOLTAGE', 'Battery resting voltage', 'OK', '12.6V'],
    ['FUSE_INSPECTION', 'Fuse box inspection', 'FAIL', 'Indicator fuse blown'],
    ['GROUND_STRAPS', 'Ground straps', 'OK', 'No resistance found'],
  ],
  OVERHEATING: [
    ['COOLANT_LEVEL', 'Coolant level', 'FAIL', 'Below the minimum mark'],
    ['RADIATOR', 'Radiator core', 'FAIL', 'Blocked fins, poor airflow'],
    ['THERMOSTAT', 'Thermostat opening', 'UNCERTAIN', 'Opens late — needs replacement'],
  ],
  LOCKOUT: [
    ['LOCK_MECHANISM', 'Door lock mechanism', 'OK', 'Locks operate normally'],
    ['KEY_BLANK', 'Key blank availability', 'OK', 'Blank in stock'],
  ],
  ACCIDENT: [
    ['BODY_ALIGNMENT', 'Body alignment', 'FAIL', 'Front crossmember slightly skewed'],
    ['COOLANT_LEAK', 'Coolant leak check', 'OK', 'No leak found'],
    ['LIGHTS', 'Lights & indicators', 'FAIL', 'Right headlamp bracket broken'],
  ],
  GENERAL_BREAKDOWN: [
    ['BATTERY_VOLTAGE', 'Battery resting voltage', 'OK', '12.5V'],
    ['FUEL_PRESSURE', 'Fuel pressure', 'OK', '3.4 bar at idle'],
    ['SCAN', 'Full system scan', 'FAIL', 'Intermittent immobiliser fault'],
  ],
  DONT_KNOW: [
    ['GENERAL_INSPECTION', 'General inspection', 'OK', 'No obvious external damage'],
    ['SCAN', 'Full system scan', 'UNCERTAIN', 'Pending code stored in the BCM'],
  ],
};

const CATEGORY_META = {
  BATTERY: ['Battery', 'बैटरी', 'battery'],
  FLAT_TYRE: ['Flat tyre', 'पंचर', 'circle-dot'],
  OUT_OF_FUEL: ['Out of fuel', 'ईंधन खत्म', 'fuel'],
  ENGINE_PROBLEM: ['Engine problem', 'इंजन की समस्या', 'cog'],
  ELECTRICAL_PROBLEM: ['Electrical problem', 'इलेक्ट्रिकल समस्या', 'zap'],
  OVERHEATING: ['Overheating', 'ओवरहीटिंग', 'thermometer'],
  LOCKOUT: ['Lockout', 'ताला खोलना', 'lock'],
  ACCIDENT: ['Accident', 'दुर्घटना', 'alert-triangle'],
  GENERAL_BREAKDOWN: ['General breakdown', 'सामान्य खराबी', 'wrench'],
  DONT_KNOW: ['Not sure', 'पता नहीं', 'help-circle'],
};

const PRICING_RULES = [
  ['base_fee', 'Base service fee', 19_900, 'FIXED', 1],
  ['distance_fee', 'Distance fee per km', 2_500, 'PER_KM', 2],
  ['night_fee', 'Night surcharge', 10_000, 'FIXED', 3],
  ['emergency_fee', 'Emergency surcharge', 5_000, 'FIXED', 4],
  ['towing_fee', 'Towing / recovery', 29_900, 'FIXED', 5],
  ['platform_fee', 'Platform fee (percent)', 10, 'PERCENT', 6],
];

// ---------------------------------------------------------------------------
// Pricing helpers (mirror apps/worker/src/lib/pricing.ts)
// ---------------------------------------------------------------------------

const PRICING = DEFAULT_CONFIG.pricing;

function serviceFee({ distanceKm, urgency, isNight, isTowing }) {
  let total = PRICING.baseFeeCents + Math.round(PRICING.distanceFeePerKmCents * Math.max(0, distanceKm));
  if (isNight) total += PRICING.nightSurchargeCents;
  if (urgency === 'HIGH' || urgency === 'CRITICAL') total += PRICING.emergencySurchargeCents;
  if (isTowing) total += PRICING.towingFeeCents;
  return total;
}

function quoteTotals(items) {
  let subtotal = 0;
  let discount = 0;
  for (const item of items) {
    const line = Math.round(item.quantity * item.unitPriceCents);
    if (item.type === 'DISCOUNT') discount += line;
    else subtotal += line;
  }
  const taxable = Math.max(0, subtotal - discount);
  const tax = Math.round((taxable * 18) / 100);
  return { subtotal, discount, tax, fees: 0, total: taxable + tax };
}

function payoutOf(totalCents) {
  const platformFee = Math.round((totalCents * PRICING.platformFeePercent) / 100);
  return Math.max(0, totalCents - platformFee);
}

function isNightHour(ms) {
  const hour = new Date(ms).getUTCHours();
  return hour >= PRICING.nightWindow.startHour || hour < PRICING.nightWindow.endHour;
}

function requiredSkillsFor(issueType) {
  return [...(ISSUE_REQUIRED_SKILLS[issueType] ?? ISSUE_REQUIRED_SKILLS.GENERAL_BREAKDOWN)];
}

function requiredEquipmentFor(issueType) {
  return [...(ISSUE_REQUIRED_EQUIPMENT[issueType] ?? ISSUE_REQUIRED_EQUIPMENT.GENERAL_BREAKDOWN)];
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

function seed(db) {
  const ins = makeInserter(db);
  // catalogue tables survive `resetDatabase`, so they are written with upserts
  const upConfig = makeUpsert(db, 'key');
  const upByCode = makeUpsert(db, 'code');
  const passwordHash = demoPasswordHash();
  const stats = {
    mechanics: new Map(),
    drivers: new Map(),
    offers: new Map(),
    attempts: new Map(),
    accepted: new Map(),
    notifications: [],
    audit: [],
  };

  const track = (map, key, delta = 1) => map.set(key, (map.get(key) ?? 0) + delta);

  function addNotification({ userId, type, title, body, data = null, at, read = false }) {
    stats.notifications.push({
      id: newId(),
      userId,
      type,
      title,
      body,
      dataJson: data ? JSON.stringify(data) : null,
      at,
      readAt: read ? ago(2 * MIN) : null,
    });
  }

  // --- users ---------------------------------------------------------------

  function insertUser({ id, role, email, phone, name, createdAt }) {
    ins('users', {
      id,
      role,
      email,
      phone,
      password_hash: passwordHash,
      full_name: name,
      locale: 'en',
      status: 'ACTIVE',
      email_verified_at: createdAt,
      phone_verified_at: createdAt,
      avatar_key: null,
      last_login_at: ago(((idSeq * 7) % 90 + 3) * HOUR),
      created_at: createdAt,
      updated_at: createdAt,
      deleted_at: null,
    });
  }

  const userIds = {
    admin: newId(),
    ops: [newId(), newId()],
    drivers: Array.from({ length: 10 }, () => newId()),
    mechanics: Array.from({ length: 15 }, () => newId()),
    workshops: Array.from({ length: 3 }, () => newId()),
    towing: Array.from({ length: 2 }, () => newId()),
  };

  insertUser({
    id: userIds.admin,
    role: 'ADMIN',
    email: 'admin@motoro.test',
    phone: '9110000001',
    name: 'Asha Admin',
    createdAt: ago(400 * DAY),
  });
  userIds.ops.forEach((id, i) => {
    insertUser({
      id,
      role: 'OPERATIONS',
      email: `ops${i + 1}@motoro.test`,
      phone: `911000001${i}`,
      name: i === 0 ? 'Rahul Ops' : 'Priya Ops',
      createdAt: ago((390 - i) * DAY),
    });
  });
  userIds.drivers.forEach((id, i) => {
    insertUser({
      id,
      role: 'DRIVER',
      email: `driver${i + 1}@motoro.test`,
      phone: `91100001${String(i).padStart(2, '0')}`,
      name: DRIVER_NAMES[i],
      createdAt: ago((360 - i * 12) * DAY),
    });
  });
  userIds.mechanics.forEach((id, i) => {
    insertUser({
      id,
      role: 'MECHANIC',
      email: `mechanic${i + 1}@motoro.test`,
      phone: `91100002${String(i).padStart(2, '0')}`,
      name: MECHANIC_NAMES[i],
      createdAt: ago((350 - i * 8) * DAY),
    });
  });
  userIds.workshops.forEach((id, i) => {
    insertUser({
      id,
      role: 'WORKSHOP',
      email: `workshop${i + 1}@motoro.test`,
      phone: `911000030${i}`,
      name: `Workshop Owner ${i + 1}`,
      createdAt: ago((340 - i * 10) * DAY),
    });
  });
  userIds.towing.forEach((id, i) => {
    insertUser({
      id,
      role: 'TOWING_PARTNER',
      email: `towing${i + 1}@motoro.test`,
      phone: `911000040${i}`,
      name: `Tow Partner ${i + 1}`,
      createdAt: ago((330 - i * 10) * DAY),
    });
  });

  // --- driver profiles -----------------------------------------------------

  const driverIds = userIds.drivers;
  driverIds.forEach((id, i) => {
    ins('drivers', {
      user_id: id,
      membership: i < 3 ? 'PLUS' : 'FREE',
      default_vehicle_id: null,
      total_requests: 0,
      created_at: ago((360 - i * 12) * DAY),
      updated_at: ago(30 * DAY),
    });
  });

  // --- vehicles ------------------------------------------------------------

  const vehicles = [];
  let vehicleSeq = 0;
  function addVehicle(driverIndex, fleetIndex, ownerCreatedAt) {
    const [make, model, variant, fuelType, vehicleType] = FLEET[fleetIndex % FLEET.length];
    const id = newId();
    vehicleSeq += 1;
    ins('vehicles', {
      id,
      user_id: driverIds[driverIndex],
      registration_number: `MH01AB${1000 + vehicleSeq}`,
      make,
      model,
      variant,
      year: 2015 + (vehicleSeq % 9),
      fuel_type: fuelType,
      vehicle_type: vehicleType,
      insurance_expiry: iso(NOW + (120 + vehicleSeq * 9) * DAY),
      rc_number: `RC${2000 + vehicleSeq}`,
      color: ['White', 'Silver', 'Red', 'Blue', 'Black', 'Grey'][vehicleSeq % 6],
      created_at: ownerCreatedAt,
      updated_at: ago(60 * DAY),
      deleted_at: null,
    });
    vehicles.push({ id, driverIndex, vehicleType, fleetIndex });
    return id;
  }

  const driverVehicleIds = Array.from({ length: 10 }, () => []);
  driverVehicleIds[0] = [0, 1, 2, 3].map((f) => addVehicle(0, f, ago(340 * DAY)));
  for (let d = 1; d < 10; d += 1) {
    driverVehicleIds[d] = [0, 1].map((f) => addVehicle(d, (d * 2 + f) % FLEET.length, ago((350 - d * 8) * DAY)));
  }
  driverIds.forEach((id, i) => {
    db.prepare('UPDATE drivers SET default_vehicle_id = ? WHERE user_id = ?')
      .run(driverVehicleIds[i][0], id);
  });

  ins('vehicle_documents', {
    id: newId(),
    vehicle_id: driverVehicleIds[0][0],
    doc_type: 'RC',
    object_key: 'demo/documents/rc-mh01ab1000.pdf',
    created_at: ago(300 * DAY),
  });
  ins('vehicle_documents', {
    id: newId(),
    vehicle_id: driverVehicleIds[0][0],
    doc_type: 'INSURANCE',
    object_key: 'demo/documents/insurance-mh01ab1000.pdf',
    created_at: ago(300 * DAY),
  });

  // --- workshops + towing --------------------------------------------------

  const workshopIds = [];
  WORKSHOP_NAMES.forEach((name, i) => {
    const id = newId();
    workshopIds.push(id);
    const createdAt = ago((335 - i * 6) * DAY);
    ins('workshops', {
      id,
      owner_user_id: userIds.workshops[i],
      name,
      address: `${i + 1} Industrial Lane, Andheri East, Mumbai`,
      latitude: DEMO_LAT + 0.018 * (i + 1),
      longitude: DEMO_LNG - 0.018 * (i + 1),
      service_radius_km: 15,
      verification_status: 'VERIFIED',
      capabilities: JSON.stringify(['engine', 'electrical', 'tyre', 'bodywork']),
      rating_sum: 0,
      rating_count: 0,
      revenue_cents: 0,
      created_at: createdAt,
      updated_at: ago(20 * DAY),
      deleted_at: null,
    });
  });

  const towingPartnerIds = [];
  TOWING_NAMES.forEach((name, i) => {
    const id = newId();
    towingPartnerIds.push(id);
    ins('towing_partners', {
      id,
      owner_user_id: userIds.towing[i],
      name,
      address: `${i + 1} Ring Road, Wadala, Mumbai`,
      latitude: DEMO_LAT - 0.03 * (i + 1),
      longitude: DEMO_LNG + 0.03 * (i + 1),
      service_radius_km: 30,
      status: 'AVAILABLE',
      verification_status: 'VERIFIED',
      rating_sum: 96,
      rating_count: 20,
      jobs_completed: 24 + i * 6,
      earnings_cents: 180_000 + i * 60_000,
      created_at: ago((320 - i * 8) * DAY),
      updated_at: ago(3 * DAY),
      deleted_at: null,
    });
    ins('towing_vehicles', {
      id: newId(),
      partner_id: id,
      plate_number: `MH01TW${100 + i}0${i + 1}`,
      towing_type: 'FLATBED',
      capacity_kg: 3500,
      active: true,
      created_at: ago(300 * DAY),
    });
  });

  // --- mechanics -----------------------------------------------------------
  //
  // Statuses are chosen so that every active job has a consistent mechanic
  // state, and so the operations dashboard sees a healthy mix of availability:
  //   AVAILABLE  m1  m3  m6  m8  m11 w2      (dispatch candidates)
  //   BUSY       m2  m5                       (accepted, not yet arrived)
  //   EN_ROUTE   m7  m12                       (travelling)
  //   ON_JOB     m4  m10  m15  w1  w3         (arrived / being repaired)
  //   PAUSED     m9      OFFLINE m13 (PENDING) m14 (UNDER_REVIEW)

  const MECHANIC_PLAN = [
    { key: 'm1', userId: userIds.mechanics[0], status: 'AVAILABLE', verification: 'VERIFIED' },
    { key: 'm2', userId: userIds.mechanics[1], status: 'BUSY', verification: 'VERIFIED' },
    { key: 'm3', userId: userIds.mechanics[2], status: 'AVAILABLE', verification: 'VERIFIED' },
    { key: 'm4', userId: userIds.mechanics[3], status: 'ON_JOB', verification: 'VERIFIED' },
    { key: 'm5', userId: userIds.mechanics[4], status: 'BUSY', verification: 'VERIFIED' },
    { key: 'm6', userId: userIds.mechanics[5], status: 'AVAILABLE', verification: 'VERIFIED' },
    { key: 'm7', userId: userIds.mechanics[6], status: 'EN_ROUTE', verification: 'VERIFIED' },
    { key: 'm8', userId: userIds.mechanics[7], status: 'AVAILABLE', verification: 'VERIFIED' },
    { key: 'm9', userId: userIds.mechanics[8], status: 'PAUSED', verification: 'VERIFIED' },
    { key: 'm10', userId: userIds.mechanics[9], status: 'ON_JOB', verification: 'VERIFIED' },
    { key: 'm11', userId: userIds.mechanics[10], status: 'AVAILABLE', verification: 'VERIFIED' },
    { key: 'm12', userId: userIds.mechanics[11], status: 'EN_ROUTE', verification: 'VERIFIED' },
    { key: 'm13', userId: userIds.mechanics[12], status: 'OFFLINE', verification: 'PENDING' },
    { key: 'm14', userId: userIds.mechanics[13], status: 'OFFLINE', verification: 'UNDER_REVIEW' },
    { key: 'm15', userId: userIds.mechanics[14], status: 'ON_JOB', verification: 'VERIFIED' },
    { key: 'w1', userId: userIds.workshops[0], status: 'ON_JOB', verification: 'VERIFIED', workshop: 0 },
    { key: 'w2', userId: userIds.workshops[1], status: 'AVAILABLE', verification: 'VERIFIED', workshop: 1 },
    { key: 'w3', userId: userIds.workshops[2], status: 'ON_JOB', verification: 'VERIFIED', workshop: 2 },
  ];

  const mechanics = new Map();
  const extraSkills = SKILL_CATALOG.filter((s) => !['battery', 'electrical', 'general', 'engine', 'tyre'].includes(s));
  const extraEquipment = EQUIPMENT_CATALOG.filter(
    (e) => !['basic_tools', 'jumper_cables', 'multimeter', 'obd_scanner'].includes(e),
  );

  MECHANIC_PLAN.forEach((plan, index) => {
    const isWorkshop = plan.workshop !== undefined;
    const angle = (index / MECHANIC_PLAN.length) * Math.PI * 2;
    const spread = 0.006 + (index % 5) * 0.004;
    const lat = DEMO_LAT + Math.sin(angle) * spread;
    const lng = DEMO_LNG + Math.cos(angle) * spread;
    const createdAt = ago((350 - index * 5) * DAY);

    ins('mechanics', {
      user_id: plan.userId,
      verification_status: plan.verification,
      status: plan.status,
      bio: `${5 + (index % 11)} years of roadside experience. Specialist in batteries, engines and electrical fault-finding.`,
      experience_years: 4 + (index % 12),
      address: isWorkshop
        ? `${(plan.workshop ?? 0) + 1} Industrial Lane, Andheri East, Mumbai`
        : `Workshop lane ${index + 1}, Andheri West, Mumbai`,
      latitude: isWorkshop ? DEMO_LAT + 0.018 * ((plan.workshop ?? 0) + 1) : lat,
      longitude: isWorkshop ? DEMO_LNG - 0.018 * ((plan.workshop ?? 0) + 1) : lng,
      last_known_latitude: isWorkshop ? DEMO_LAT + 0.018 * ((plan.workshop ?? 0) + 1) : lat,
      last_known_longitude: isWorkshop ? DEMO_LNG - 0.018 * ((plan.workshop ?? 0) + 1) : lng,
      last_location_at: ago(4 * MIN + index * MIN),
      service_radius_km: 8 + (index % 5) * 4,
      workshop_id: isWorkshop ? workshopIds[plan.workshop] : null,
      document_key:
        plan.verification === 'VERIFIED'
          ? null
          : `demo/documents/licence-${plan.key}.pdf`,
      submitted_at: plan.verification === 'VERIFIED' ? createdAt : ago(9 * DAY),
      reviewed_at: plan.verification === 'VERIFIED' ? createdAt : null,
      review_note: plan.verification === 'UNDER_REVIEW' ? 'Awaiting field inspection' : null,
      rating_sum: 0,
      rating_count: 0,
      jobs_completed: 0,
      jobs_cancelled: 0,
      offers_received: 0,
      offers_accepted: 0,
      earnings_cents: 0,
      reliability_score: Math.round((0.72 + (index % 5) * 0.05) * 100) / 100,
      created_at: createdAt,
      updated_at: ago(2 * DAY),
      deleted_at: null,
    });

    mechanics.set(plan.key, {
      key: plan.key,
      userId: plan.userId,
      status: plan.status,
      verification: plan.verification,
      workshopId: isWorkshop ? workshopIds[plan.workshop] : null,
      lat: isWorkshop ? DEMO_LAT + 0.018 * ((plan.workshop ?? 0) + 1) : lat,
      lng: isWorkshop ? DEMO_LNG - 0.018 * ((plan.workshop ?? 0) + 1) : lng,
      index,
    });

    const skills = new Set([
      'battery', 'electrical', 'general', 'engine', 'tyre',
      extraSkills[index % extraSkills.length],
      extraSkills[(index + 3) % extraSkills.length],
    ]);
    for (const skill of skills) {
      ins('mechanic_skills', {
        id: newId(),
        mechanic_user_id: plan.userId,
        skill,
        level: skill === 'battery' || skill === 'electrical' ? 'EXPERT' : 'INTERMEDIATE',
        created_at: createdAt,
      });
    }

    const equipment = new Set([
      'basic_tools', 'jumper_cables', 'multimeter', 'obd_scanner',
      extraEquipment[index % extraEquipment.length],
      extraEquipment[(index + 2) % extraEquipment.length],
      extraEquipment[(index + 5) % extraEquipment.length],
    ]);
    for (const item of equipment) {
      ins('mechanic_equipment', {
        id: newId(),
        mechanic_user_id: plan.userId,
        equipment: item,
        created_at: createdAt,
      });
    }

    for (const vehicleType of ['CAR', 'SUV', 'TWO_WHEELER', 'SCOOTER', 'EV', 'COMMERCIAL']) {
      ins('mechanic_vehicle_types', { mechanic_user_id: plan.userId, vehicle_type: vehicleType, created_at: createdAt });
    }

    // 24x7 windows keep dispatch working at any hour of the demo.
    for (let day = 0; day < 7; day += 1) {
      ins('mechanic_availability', {
        id: newId(),
        mechanic_user_id: plan.userId,
        day_of_week: day,
        start_minute: 0,
        end_minute: 1440,
        created_at: createdAt,
      });
    }

    if (isWorkshop) {
      ins('workshop_mechanics', {
        workshop_id: workshopIds[plan.workshop],
        mechanic_user_id: plan.userId,
        job_role: 'OWNER',
        created_at: createdAt,
      });
    }
  });

  workshopIds.forEach((workshopId, i) => {
    for (let m = 0; m < 4; m += 1) {
      const member = MECHANIC_PLAN[(i * 4 + m + 1) % MECHANIC_PLAN.length];
      if (member.workshop !== undefined) continue;
      ins('workshop_mechanics', {
        workshop_id: workshopId,
        mechanic_user_id: member.userId,
        job_role: 'MECHANIC',
        created_at: ago(200 * DAY),
      });
    }
  });

  // --- static catalogue tables --------------------------------------------

  const parts = [
    ['Battery 35Ah', 'BAT-35AH', 450_000],
    ['Brake pad set (front)', 'BRK-FRT-11', 82_000],
    ['Tubeless tyre 185/65 R15', 'TYR-185-65', 145_000],
    ['Alternator 90A', 'ALT-90A', 128_000],
    ['Coolant concentrate 2L', 'CLT-2L', 24_000],
    ['Wiper blade pair', 'WPR-PAIR', 9_500],
  ];
  for (const [name, sku, price] of parts) {
    ins('parts', { id: newId(), name, sku, unit_price_cents: price, active: true, created_at: ago(300 * DAY) });
  }

  for (const [code, name, amount, type, sort] of PRICING_RULES) {
    upByCode('pricing_rules', {
      id: newId(),
      code,
      name,
      amount_cents: amount,
      type,
      active: true,
      sort,
      created_at: ago(300 * DAY),
      updated_at: ago(12 * DAY),
    });
  }

  const platformConfig = {
    dispatch: {
      radiusStepsKm: DEFAULT_CONFIG.dispatch.radiusStepsKm,
      attemptTimeoutSeconds: DEFAULT_CONFIG.dispatch.attemptTimeoutSeconds,
      maxActiveJobsPerMechanic: DEFAULT_CONFIG.dispatch.maxActiveJobsPerMechanic,
      stallWarningSeconds: DEFAULT_CONFIG.dispatch.stallWarningSeconds,
      stallEscalateSeconds: DEFAULT_CONFIG.dispatch.stallEscalateSeconds,
      maxAttempts: DEFAULT_CONFIG.dispatch.maxAttempts,
      parallelOffers: DEFAULT_CONFIG.dispatch.parallelOffers,
      maxEscalationRetries: DEFAULT_CONFIG.dispatch.maxEscalationRetries,
    },
    pricing: {
      baseFeeCents: PRICING.baseFeeCents,
      distanceFeePerKmCents: PRICING.distanceFeePerKmCents,
      nightSurchargeCents: PRICING.nightSurchargeCents,
      emergencySurchargeCents: PRICING.emergencySurchargeCents,
      towingFeeCents: PRICING.towingFeeCents,
      platformFeePercent: PRICING.platformFeePercent,
      nightWindow: PRICING.nightWindow,
    },
    cancellation: DEFAULT_CONFIG.cancellation,
    uploads: DEFAULT_CONFIG.uploads,
    feature_flags: { liveTracking: true, inAppPayments: true, hindiLocale: true },
  };
  for (const [key, value] of Object.entries(platformConfig)) {
    upConfig('platform_config', {
      key,
      value_json: JSON.stringify(value),
      updated_at: ago(12 * DAY),
      updated_by: userIds.admin,
    });
  }

  ISSUE_TYPES.forEach((issue, index) => {
    const [nameEn, nameHi, icon] = CATEGORY_META[issue];
    upByCode('service_categories', {
      code: issue,
      name_en: nameEn,
      name_hi: nameHi,
      icon,
      required_skills: JSON.stringify(requiredSkillsFor(issue)),
      required_equipment: JSON.stringify(requiredEquipmentFor(issue)),
      active: true,
      sort: index + 1,
      created_at: ago(300 * DAY),
    });
  });

  // --- emergency contacts --------------------------------------------------

  const contacts = [
    [0, 'Priya Rajora', '9820011001', 'Spouse'],
    [0, 'Aman Rajora', '9820011002', 'Brother'],
    [0, 'Neha (Office)', '9820011003', 'Colleague'],
    [1, 'Rohan Shah', '9820011004', 'Spouse'],
    [2, 'Kavita Singh', '9820011005', 'Spouse'],
    [3, 'Dev Desai', '9820011006', 'Father'],
    [4, 'Ishita Patel', '9820011007', 'Spouse'],
    [5, 'Anil Iyer', '9820011008', 'Father'],
    [6, 'Sara Nair', '9820011009', 'Spouse'],
    [7, 'Joseph Menon', '9820011010', 'Father'],
    [8, 'Sunita Gupta', '9820011011', 'Mother'],
    [9, 'Zoya Khan', '9820011012', 'Spouse'],
  ];
  for (const [driverIndex, name, phone, relationship] of contacts) {
    ins('emergency_contacts', {
      id: newId(),
      user_id: driverIds[driverIndex],
      name,
      phone,
      relationship,
      created_at: ago(200 * DAY),
      deleted_at: null,
    });
  }

  // --- emergency requests --------------------------------------------------

  const requests = [];

  function insertRequestRow(spec) {
    const id = newId();
    const reference = newReference();
    ins('emergency_requests', {
      id,
      reference,
      driver_user_id: driverIds[spec.driverIndex],
      vehicle_id: driverVehicleIds[spec.driverIndex][spec.vehicleSlot ?? 0],
      channel: spec.channel ?? 'WEB',
      category_code: spec.issue,
      issue_type: spec.issue,
      description: spec.description ?? DESCRIPTIONS[spec.issue],
      urgency: spec.urgency,
      status: spec.status,
      accident_json: spec.accident ? JSON.stringify(spec.accident) : null,
      latitude: spec.lat,
      longitude: spec.lng,
      accuracy: spec.accuracy ?? 12,
      address: spec.address,
      required_skills: JSON.stringify(requiredSkillsFor(spec.issue)),
      required_equipment: JSON.stringify(requiredEquipmentFor(spec.issue)),
      assigned_mechanic_user_id: spec.mechanic ? spec.mechanic.userId : null,
      workshop_id: spec.mechanic?.workshopId ?? null,
      towing_partner_id: spec.towing ? towingPartnerIds[0] : null,
      dispatch_radius_km: spec.dispatchRadiusKm ?? 5,
      dispatch_round: spec.dispatchRound ?? 0,
      escalation_level: spec.escalationLevel ?? 0,
      dispatch_started_at: spec.dispatchStartedAt ?? null,
      assigned_at: spec.assignedAt ?? null,
      completed_at: spec.completedAt ?? null,
      payment_status: spec.paymentStatus ?? null,
      total_amount_cents: spec.totalCents ?? null,
      rating: spec.rating ?? null,
      cancel_reason: spec.cancelReason ?? null,
      cancelled_by: spec.cancelledBy ?? null,
      created_by_role: spec.channel === 'OPS' ? 'OPERATIONS' : 'DRIVER',
      source_meta_json: JSON.stringify({ isAccident: Boolean(spec.accident), seeded: true }),
      created_at: spec.createdAt,
      updated_at: spec.updatedAt,
      deleted_at: null,
    });
    spec.id = id;
    spec.reference = reference;
    requests.push(spec);
    track(stats.drivers, driverIds[spec.driverIndex]);
    return spec;
  }

  function addressFor(i) {
    return ADDRESSES[i % ADDRESSES.length];
  }

  function coordsFor(i, jitter = 1) {
    return {
      lat: DEMO_LAT + (((i * 7) % 9) - 4) * 0.004 * jitter,
      lng: DEMO_LNG + (((i * 5) % 9) - 4) * 0.004 * jitter,
    };
  }

  // 27 historical requests: 22 with completed jobs, 3 cancelled, 2 failed.
  const HISTORICAL_MECHANIC = [
    'm1', 'm1', 'm1', 'm1', 'm1', 'm1', 'm1', 'm1', 'm1', 'm1',
    'm2', 'm4', 'm5', 'm6', 'm6', 'm7', 'm8', 'm10', 'm11', 'm15', 'w1', 'w3',
  ];
  const HISTORICAL_STATUS = [
    ...Array(20).fill('PAID'),
    'PAYMENT_PENDING',
    'COMPLETED',
    'CANCELLED',
    'CANCELLED',
    'CANCELLED',
    'FAILED',
    'FAILED',
  ];

  for (let i = 0; i < HISTORICAL_STATUS.length; i += 1) {
    const status = HISTORICAL_STATUS[i];
    const daysAgo = 26 - i;
    const issue = ISSUE_TYPES[i % ISSUE_TYPES.length];
    const driverIndex = i < 6 ? 0 : ((i - 6) % 9) + 1;
    const urgency = ['NORMAL', 'HIGH', 'NORMAL', 'CRITICAL', 'LOW', 'HIGH'][i % 6];
    const hasJob = status === 'PAID' || status === 'PAYMENT_PENDING' || status === 'COMPLETED';
    // one cancelled request keeps its (cancelled) job so the UI shows the state
    const cancelledWithJob = status === 'CANCELLED' && i === 22;
    const mechanic = hasJob
      ? mechanics.get(HISTORICAL_MECHANIC[i])
      : cancelledWithJob
        ? mechanics.get('m3')
        : null;
    const coords = coordsFor(i);
    const createdAt = dayAt(daysAgo, 8 + (i % 10), (i * 7) % 60);
    const updatedAt =
      status === 'CANCELLED' || status === 'FAILED'
        ? dayAt(daysAgo, 8 + (i % 10), 20 + (i % 30))
        : dayAt(daysAgo, 11 + (i % 8), (i * 11) % 60);
    const distanceKm = 1.4 + ((i * 3) % 8) * 0.4;
    const fee = serviceFee({
      distanceKm,
      urgency,
      isNight: isNightHour(parseMs(createdAt)),
      isTowing: issue === 'ACCIDENT',
    });
    const quoteItems = (QUOTE_TEMPLATES[issue] ?? QUOTE_TEMPLATES.GENERAL_BREAKDOWN).map(
      ([type, description, unitPriceCents]) => ({ type, description, quantity: 1, unitPriceCents }),
    );
    const totals = quoteTotals(quoteItems);
    const totalCents = hasJob ? totals.total + fee : null;
    // the one cancelled-with-job request gets a (cancelled) job + assignment
    const withJob = hasJob || cancelledWithJob;

    insertRequestRow({
      kind: 'historical',
      driverIndex,
      issue,
      urgency,
      status,
      mechanic,
      createdAt,
      updatedAt,
      address: addressFor(i),
      lat: coords.lat,
      lng: coords.lng,
      channel: i % 11 === 0 ? 'APP' : 'WEB',
      dispatchStartedAt: withJob ? createdAt : null,
      assignedAt: withJob ? createdAt : null,
      completedAt: hasJob ? updatedAt : null,
      paymentStatus:
        status === 'PAID' ? 'PAID' : status === 'PAYMENT_PENDING' ? 'PENDING' : status === 'COMPLETED' ? 'FAILED' : null,
      totalCents,
      cancelReason: status === 'CANCELLED' ? 'Resolved it myself before the mechanic arrived' : null,
      cancelledBy: status === 'CANCELLED' ? driverIds[driverIndex] : null,
      distanceKm,
      quoteItems,
      quoteTotals: totals,
      fee,
      jobStatus: hasJob ? 'COMPLETED' : cancelledWithJob ? 'CANCELLED' : null,
      hasJob: withJob,
      rating: hasJob ? [5, 5, 4, 5, 5, 4][i % 6] : null,
      issueLabel: issue.replace(/_/g, ' '),
    });
  }

  // 18 "live" requests covering every status the UI renders.
  const LIVE = [
    {
      key: 'created', status: 'CREATED', driverIndex: 1, issue: 'ENGINE_PROBLEM', urgency: 'NORMAL',
      createdAt: ago(4 * MIN), updatedAt: ago(3 * MIN),
    },
    {
      key: 'search1', status: 'SEARCHING', driverIndex: 2, issue: 'BATTERY', urgency: 'HIGH',
      createdAt: ago(12 * MIN), updatedAt: ago(2 * MIN), pending: ['m6', 'm3'],
      previous: [{ mechanic: 'm8', status: 'TIMEOUT' }],
    },
    {
      key: 'search2', status: 'SEARCHING', driverIndex: 3, issue: 'FLAT_TYRE', urgency: 'NORMAL',
      createdAt: ago(20 * MIN), updatedAt: ago(6 * MIN), pending: ['m8', 'm11'],
    },
    {
      key: 'search3', status: 'SEARCHING', driverIndex: 4, issue: 'OUT_OF_FUEL', urgency: 'LOW',
      createdAt: ago(35 * MIN), updatedAt: ago(9 * MIN), pending: ['m1', 'm3'],
      previous: [{ mechanic: 'm6', status: 'DECLINED', reason: 'On another job' }],
    },
    {
      key: 'dispatch', status: 'DISPATCHING', driverIndex: 5, issue: 'OVERHEATING', urgency: 'CRITICAL',
      createdAt: ago(8 * MIN), updatedAt: ago(1 * MIN), pending: ['m1', 'w2'], dispatchRound: 1, dispatchRadiusKm: 10,
    },
    {
      key: 'assigned1', status: 'ASSIGNED', driverIndex: 6, issue: 'ELECTRICAL_PROBLEM', urgency: 'NORMAL',
      createdAt: ago(25 * MIN), updatedAt: ago(22 * MIN), mechanic: 'm2', jobStatus: 'ACCEPTED',
    },
    {
      key: 'assigned2', status: 'ASSIGNED', driverIndex: 7, issue: 'LOCKOUT', urgency: 'HIGH',
      createdAt: ago(40 * MIN), updatedAt: ago(36 * MIN), mechanic: 'm5', jobStatus: 'ACCEPTED',
    },
    {
      key: 'enroute', status: 'MECHANIC_EN_ROUTE', driverIndex: 8, issue: 'BATTERY', urgency: 'HIGH',
      createdAt: ago(30 * MIN), updatedAt: ago(12 * MIN), mechanic: 'm7', jobStatus: 'EN_ROUTE',
    },
    {
      key: 'nearby', status: 'MECHANIC_NEARBY', driverIndex: 9, issue: 'GENERAL_BREAKDOWN', urgency: 'NORMAL',
      createdAt: ago(45 * MIN), updatedAt: ago(16 * MIN), mechanic: 'm12', jobStatus: 'EN_ROUTE',
    },
    {
      key: 'arrived', status: 'ARRIVED', driverIndex: 1, issue: 'FLAT_TYRE', urgency: 'HIGH',
      createdAt: ago(2 * DAY + 4 * HOUR), updatedAt: ago(2 * DAY + 2 * HOUR),
      mechanic: 'm4', jobStatus: 'ARRIVED',
    },
    {
      key: 'diagnosing', status: 'DIAGNOSING', driverIndex: 2, issue: 'ENGINE_PROBLEM', urgency: 'NORMAL',
      createdAt: ago(1 * DAY + 5 * HOUR), updatedAt: ago(1 * DAY + 3 * HOUR),
      mechanic: 'm10', jobStatus: 'DIAGNOSING',
    },
    {
      key: 'quotePending', status: 'QUOTE_PENDING', driverIndex: 3, issue: 'OVERHEATING', urgency: 'HIGH',
      createdAt: ago(2 * DAY + 7 * HOUR), updatedAt: ago(2 * DAY + 5 * HOUR),
      mechanic: 'w1', jobStatus: 'QUOTE_PENDING',
    },
    {
      key: 'quoteApproved', status: 'QUOTE_APPROVED', driverIndex: 4, issue: 'ELECTRICAL_PROBLEM', urgency: 'NORMAL',
      createdAt: ago(7 * HOUR), updatedAt: ago(5 * HOUR),
      mechanic: 'm15', jobStatus: 'QUOTE_APPROVED',
    },
    {
      key: 'repairing', status: 'REPAIRING', driverIndex: 5, issue: 'BATTERY', urgency: 'NORMAL',
      createdAt: ago(9 * HOUR), updatedAt: ago(3 * HOUR),
      mechanic: 'w3', jobStatus: 'REPAIRING',
    },
    {
      key: 'escalated1', status: 'ESCALATED', driverIndex: 6, issue: 'ACCIDENT', urgency: 'CRITICAL',
      createdAt: ago(3 * DAY + 2 * HOUR), updatedAt: ago(2 * DAY + 20 * HOUR),
      escalationLevel: 5, dispatchRound: 4, dispatchRadiusKm: 20,
      previous: [
        { mechanic: 'm1', status: 'TIMEOUT' },
        { mechanic: 'm3', status: 'DECLINED', reason: 'Too far' },
        { mechanic: 'm6', status: 'TIMEOUT' },
      ],
    },
    {
      key: 'escalated2', status: 'ESCALATED', driverIndex: 7, issue: 'DONT_KNOW', urgency: 'HIGH',
      createdAt: ago(2 * DAY + 8 * HOUR), updatedAt: ago(1 * DAY + 22 * HOUR),
      escalationLevel: 5, dispatchRound: 3, dispatchRadiusKm: 20,
      previous: [
        { mechanic: 'm8', status: 'TIMEOUT' },
        { mechanic: 'm11', status: 'TIMEOUT' },
      ],
    },
    {
      key: 'towing', status: 'TOWING_REQUIRED', driverIndex: 8, issue: 'ACCIDENT', urgency: 'CRITICAL',
      createdAt: ago(1 * DAY + 3 * HOUR), updatedAt: ago(1 * DAY + 1 * HOUR),
      towing: true,
      accident: {
        driverInjured: false,
        anyoneInjured: false,
        blockingTraffic: true,
        needsTowing: true,
        medicalAssistance: false,
        policeAssistance: true,
      },
      previous: [{ mechanic: 'm2', status: 'FAILED', reason: 'Mechanic vehicle broke down' }],
    },
    {
      key: 'failedToday', status: 'FAILED', driverIndex: 9, issue: 'ENGINE_PROBLEM', urgency: 'HIGH',
      createdAt: todayAt(300), updatedAt: todayAt(295),
      previous: [
        { mechanic: 'm4', status: 'TIMEOUT' },
        { mechanic: 'm10', status: 'FAILED', reason: 'Could not reach the customer' },
      ],
    },
    {
      key: 'completedToday', status: 'COMPLETED', driverIndex: 1, issue: 'FLAT_TYRE', urgency: 'NORMAL',
      createdAt: todayAt(240), updatedAt: todayAt(60), mechanic: 'm1', jobStatus: 'COMPLETED',
    },
    {
      key: 'paymentToday', status: 'PAYMENT_PENDING', driverIndex: 2, issue: 'BATTERY', urgency: 'HIGH',
      createdAt: todayAt(180), updatedAt: todayAt(45), mechanic: 'm6', jobStatus: 'COMPLETED',
    },
  ];

  for (let i = 0; i < LIVE.length; i += 1) {
    const spec = LIVE[i];
    const coords = coordsFor(i + 30);
    const mechanic = spec.mechanic ? mechanics.get(spec.mechanic) : null;
    const distanceKm = 1.6 + ((i * 5) % 7) * 0.4;
    const quoteItems = (QUOTE_TEMPLATES[spec.issue] ?? QUOTE_TEMPLATES.GENERAL_BREAKDOWN).map(
      ([type, description, unitPriceCents]) => ({ type, description, quantity: 1, unitPriceCents }),
    );
    const totals = quoteTotals(quoteItems);
    const fee = serviceFee({
      distanceKm,
      urgency: spec.urgency,
      isNight: isNightHour(parseMs(spec.createdAt)),
      isTowing: spec.issue === 'ACCIDENT',
    });
    const closed = ['COMPLETED', 'PAYMENT_PENDING', 'PAID'].includes(spec.status);
    const hasJob = Boolean(spec.jobStatus);

    insertRequestRow({
      kind: 'live',
      driverIndex: spec.driverIndex,
      issue: spec.issue,
      urgency: spec.urgency,
      status: spec.status,
      mechanic,
      accident: spec.accident ?? null,
      towing: spec.towing,
      createdAt: spec.createdAt,
      updatedAt: spec.updatedAt,
      address: addressFor(i + 30),
      lat: coords.lat,
      lng: coords.lng,
      channel: i % 7 === 0 ? 'APP' : 'WEB',
      dispatchStartedAt: ['CREATED'].includes(spec.status) ? null : spec.createdAt,
      assignedAt: hasJob ? spec.createdAt : null,
      completedAt: closed ? spec.updatedAt : null,
      paymentStatus: closed ? (spec.status === 'PAYMENT_PENDING' ? 'PENDING' : null) : null,
      totalCents: hasJob ? totals.total + fee : null,
      escalationLevel: spec.escalationLevel ?? 0,
      dispatchRound: spec.dispatchRound ?? 0,
      dispatchRadiusKm: spec.dispatchRadiusKm ?? 5,
      distanceKm,
      quoteItems,
      quoteTotals: totals,
      fee,
      jobStatus: spec.jobStatus ?? null,
      hasJob,
      pending: spec.pending ?? [],
      previous: spec.previous ?? [],
      issueLabel: spec.issue.replace(/_/g, ' '),
      liveKey: spec.key,
    });
  }

  // --- per-request story: locations, dispatch, job, quote, billing, events -

  const JOB_STAGES = [
    'ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'VERIFIED', 'DIAGNOSING',
    'QUOTE_PENDING', 'QUOTE_APPROVED', 'REPAIRING', 'COMPLETED',
  ];

  const reviewPlan = [];
  const reverseReviewPlan = [];

  requests.forEach((request, requestIndex) => {
    const createdMs = parseMs(request.createdAt);
    const updatedMs = Math.min(parseMs(request.updatedAt), NOW);
    const driverId = driverIds[request.driverIndex];
    const events = [];
    let eventSeq = 0;

    const pushEvent = (type, message, actorRole = 'SYSTEM', actorUserId = null, data = null, atMs = null) => {
      let at = atMs ?? createdMs + eventSeq * 90_000;
      eventSeq += 1;
      if (at > updatedMs) at = updatedMs;
      if (at > NOW) at = NOW;
      events.push({ type, message, actorRole, actorUserId, data, at });
    };

    pushEvent(
      'REQUEST_CREATED',
      `Emergency request created (${request.issueLabel})`,
      request.channel === 'OPS' ? 'OPERATIONS' : 'DRIVER',
      driverId,
      { channel: request.channel, urgency: request.urgency },
      createdMs,
    );

    // --- locations -------------------------------------------------------
    ins('emergency_locations', {
      id: newId(),
      request_id: request.id,
      source: request.channel === 'OPS' ? 'OPS' : 'DRIVER',
      actor_user_id: driverId,
      latitude: request.lat,
      longitude: request.lng,
      accuracy: request.accuracy ?? 12,
      recorded_at: iso(createdMs),
    });

    // --- dispatch attempts ------------------------------------------------
    let attemptNo = 0;
    const attemptIds = new Map();

    function addAttempt(mechanicKey, status, options = {}) {
      attemptNo += 1;
      const mechanic = mechanics.get(mechanicKey);
      const id = newId();
      const offeredAt = options.offeredAt ?? iso(createdMs + attemptNo * 60_000);
      const respondedAt =
        status === 'PENDING' ? null : options.respondedAt ?? iso(parseMs(offeredAt) + 45_000);
      ins('dispatch_attempts', {
        id,
        request_id: request.id,
        attempt_no: attemptNo,
        mechanic_user_id: mechanic.userId,
        status,
        score: options.score ?? 0.7 + ((attemptNo * 7) % 25) / 100,
        distance_km: options.distanceKm ?? 1.4 + ((attemptNo * 3 + requestIndex) % 8) * 0.4,
        eta_minutes: options.etaMinutes ?? Math.max(2, Math.round((options.distanceKm ?? 2.5) * 2)),
        offered_at: offeredAt,
        responded_at: respondedAt,
        timeout_at:
          status === 'PENDING'
            ? ago(-900_000)
            : options.timeoutAt ?? iso(parseMs(offeredAt) + 45_000),
        decline_reason: options.reason ?? null,
        notified_count: 1,
        created_at: offeredAt,
        updated_at: respondedAt ?? offeredAt,
      });
      attemptIds.set(mechanicKey, id);
      track(stats.offers, mechanicKey);
      track(stats.attempts, mechanicKey);
      if (status === 'ACCEPTED') track(stats.accepted, mechanicKey);
      if (status === 'PENDING') {
        addNotification({
          userId: mechanic.userId,
          type: 'JOB_OFFER',
          title: 'New emergency nearby',
          body: `${request.issueLabel} · ${options.distanceKm ?? 2.5} km away · ETA ${Math.max(2, Math.round((options.distanceKm ?? 2.5) * 2))} min`,
          data: { requestId: request.id, reference: request.reference, issueType: request.issue },
          at: parseMs(offeredAt),
          read: mechanicKey !== 'm1',
        });
      }
      return id;
    }

    for (const previous of request.previous ?? []) {
      addAttempt(previous.mechanic, previous.status, { reason: previous.reason ?? null });
    }

    if (request.hasJob && request.mechanic) {
      const acceptedKey = [...mechanics.values()].find((m) => m.userId === request.mechanic.userId)?.key;
      const acceptedAttempt = addAttempt(acceptedKey, 'ACCEPTED', {
        distanceKm: request.distanceKm,
        etaMinutes: Math.max(3, Math.round(request.distanceKm * 2)),
        respondedAt: iso(createdMs + 3 * MIN),
      });
      pushEvent(
        'DISPATCH_OFFERED',
        'Notified nearby mechanics within 5 km',
        'SYSTEM',
        null,
        { radiusKm: 5 },
        createdMs + MIN,
      );
      pushEvent(
        'MECHANIC_ACCEPTED',
        'A mechanic accepted your request',
        'MECHANIC',
        request.mechanic.userId,
        null,
        createdMs + 3 * MIN,
      );
      request.acceptedAttemptId = acceptedAttempt;
    } else {
      for (const key of request.pending ?? []) {
        addAttempt(key, 'PENDING', { offeredAt: iso(Math.min(updatedMs, NOW - 30_000)) });
      }
      if ((request.pending ?? []).length > 0 || (request.previous ?? []).length > 0) {
        pushEvent(
          'DISPATCH_OFFERED',
          `Notified ${(request.pending ?? []).length} mechanic(s) within ${request.dispatchRadiusKm} km`,
          'SYSTEM',
          null,
          { radiusKm: request.dispatchRadiusKm },
          createdMs + MIN,
        );
      }
      if (request.status === 'ESCALATED') {
        pushEvent(
          'ESCALATED',
          'Escalated to operations: NO_ELIGIBLE_MECHANIC',
          'SYSTEM',
          null,
          { reason: 'NO_ELIGIBLE_MECHANIC' },
          createdMs + 4 * MIN,
        );
        for (const opsId of userIds.ops) {
          addNotification({
            userId: opsId,
            type: 'EMERGENCY_ESCALATED',
            title: 'Emergency escalated',
            body: `${request.reference} · ${request.issueLabel} · no mechanic available`,
            data: { requestId: request.id, reference: request.reference },
            at: createdMs + 4 * MIN,
            read: opsId === userIds.ops[0],
          });
        }
        addNotification({
          userId: userIds.admin,
          type: 'EMERGENCY_ESCALATED',
          title: 'Emergency escalated',
          body: `${request.reference} is waiting on operations`,
          data: { requestId: request.id },
          at: createdMs + 4 * MIN,
          read: true,
        });
      }
      if (request.status === 'TOWING_REQUIRED') {
        pushEvent('TOWING_REQUESTED', 'Towing partner requested for recovery', 'OPS', userIds.ops[0]);
      }
      if (request.status === 'FAILED') {
        pushEvent('STATUS_FAILED', 'Request failed — no mechanic could be reached', 'SYSTEM');
      }
      if (request.status === 'CANCELLED') {
        pushEvent('STATUS_CANCELLED', `Request cancelled: ${request.cancelReason}`, 'DRIVER', driverId);
      }
    }

    addNotification({
      userId: driverId,
      type: 'EMERGENCY_CREATED',
      title: 'Help is on the way',
      body: `Your request ${request.reference} was created. We are finding a nearby mechanic.`,
      data: { requestId: request.id, reference: request.reference },
      at: createdMs,
      read: true,
    });

    // --- assignment -------------------------------------------------------
    if (request.hasJob && request.mechanic) {
      ins('mechanic_assignments', {
        id: newId(),
        request_id: request.id,
        mechanic_user_id: request.mechanic.userId,
        attempt_id: request.acceptedAttemptId,
        status: request.status === 'CANCELLED' ? 'CANCELLED' : request.kind === 'live' ? 'ACTIVE' : 'COMPLETED',
        assigned_at: iso(createdMs + 3 * MIN),
        ended_at: request.kind === 'live' && request.status !== 'CANCELLED' ? null : request.updatedAt,
        end_reason: null,
      });
      if (request.status !== 'CANCELLED') {
        pushEvent('STATUS_ASSIGNED', 'A mechanic is assigned to your request', 'SYSTEM', null, null, createdMs + 3 * MIN);
      }
    }

    // --- job + status history --------------------------------------------
    let job = null;
    if (request.hasJob && request.mechanic && request.jobStatus && request.jobStatus !== 'CANCELLED') {
      const jobId = newId();
      const targetIndex = JOB_STAGES.indexOf(request.jobStatus);
      const stageCount = Math.max(1, targetIndex + 1);
      const stageAt = (index) => {
        const span = Math.max(MIN, updatedMs - createdMs);
        return iso(createdMs + 3 * MIN + Math.round(((span - 4 * MIN) * index) / stageCount));
      };
      const isCompleted = request.jobStatus === 'COMPLETED';
      const otpVerified = targetIndex >= JOB_STAGES.indexOf('VERIFIED') || isCompleted;
      const payout = isCompleted && request.paymentStatus === 'PAID'
        ? payoutOf(request.totalCents ?? 0)
        : 0;

      ins('jobs', {
        id: jobId,
        request_id: request.id,
        mechanic_user_id: request.mechanic.userId,
        status: request.jobStatus,
        otp_code_hash: targetIndex === JOB_STAGES.indexOf('ARRIVED') ? sha256Hex(DEMO_OTP) : null,
        // Seeded demo code stays valid for a day (live arrival OTPs are 15 min)
        // so the driver's OTP card works whenever the demo is opened.
        otp_expires_at: targetIndex === JOB_STAGES.indexOf('ARRIVED') ? ago(-86_400_000) : null,
        otp_attempts: 0,
        otp_verified_at: otpVerified ? stageAt(Math.min(2, stageCount - 1)) : null,
        earnings_cents: payout,
        accepted_at: iso(createdMs + 3 * MIN),
        en_route_at: null,
        arrived_at: targetIndex >= JOB_STAGES.indexOf('ARRIVED') ? stageAt(2) : null,
        started_at: targetIndex >= JOB_STAGES.indexOf('DIAGNOSING') ? stageAt(Math.min(4, stageCount - 1)) : null,
        completed_at: isCompleted ? request.updatedAt : null,
        stall_warned_at: null,
        created_at: iso(createdMs + 3 * MIN),
        updated_at: request.updatedAt,
        deleted_at: null,
      });

      // Driver must be able to see the job-start OTP for the request parked at
      // ARRIVED — mirrors the live MECHANIC_ARRIVED notification on arrival.
      if (targetIndex === JOB_STAGES.indexOf('ARRIVED')) {
        addNotification({
          userId: driverId,
          type: 'MECHANIC_ARRIVED',
          title: 'Your mechanic has arrived',
          body: `Share this OTP with your mechanic to start the job: ${DEMO_OTP}`,
          data: { requestId: request.id, jobId, otp: DEMO_OTP },
          at: stageAt(2),
          read: false,
        });
      }

      for (let s = 0; s <= targetIndex; s += 1) {
        ins('job_status_history', {
          id: newId(),
          job_id: jobId,
          from_status: s === 0 ? null : JOB_STAGES[s - 1],
          to_status: JOB_STAGES[s],
          actor_user_id: request.mechanic.userId,
          note: null,
          latitude: request.lat + 0.001 * s,
          longitude: request.lng + 0.001 * s,
          created_at: stageAt(s),
        });
      }

      const stageMessages = {
        EN_ROUTE: ['STATUS_MECHANIC_EN_ROUTE', 'Mechanic is on the way'],
        ARRIVED: ['STATUS_ARRIVED', 'Mechanic has arrived at your location'],
        DIAGNOSING: ['STATUS_DIAGNOSING', 'Diagnosis in progress'],
        QUOTE_PENDING: ['QUOTE_CREATED', 'Quote sent for your approval'],
        QUOTE_APPROVED: ['STATUS_QUOTE_APPROVED', 'Quote approved — repair starting'],
        REPAIRING: ['STATUS_REPAIRING', 'Repair in progress'],
        COMPLETED: ['STATUS_COMPLETED', 'Service completed'],
      };
      for (let s = 1; s <= targetIndex; s += 1) {
        const message = stageMessages[JOB_STAGES[s]];
        if (message) pushEvent(message[0], message[1], 'MECHANIC', request.mechanic.userId, null, parseMs(stageAt(s)));
      }

      job = { id: jobId, payout, mechanic: request.mechanic };
    }

    if (request.jobStatus === 'CANCELLED') {
      const jobId = newId();
      ins('jobs', {
        id: jobId,
        request_id: request.id,
        mechanic_user_id: request.mechanic.userId,
        status: 'CANCELLED',
        otp_code_hash: null,
        otp_expires_at: null,
        otp_attempts: 0,
        otp_verified_at: null,
        earnings_cents: 0,
        accepted_at: iso(createdMs + 3 * MIN),
        en_route_at: null,
        arrived_at: null,
        started_at: null,
        completed_at: null,
        stall_warned_at: null,
        created_at: iso(createdMs + 3 * MIN),
        updated_at: request.updatedAt,
        deleted_at: null,
      });
      ins('job_status_history', {
        id: newId(),
        job_id: jobId,
        from_status: null,
        to_status: 'ACCEPTED',
        actor_user_id: request.mechanic.userId,
        note: null,
        latitude: null,
        longitude: null,
        created_at: iso(createdMs + 3 * MIN),
      });
      ins('job_status_history', {
        id: newId(),
        job_id: jobId,
        from_status: 'ACCEPTED',
        to_status: 'CANCELLED',
        actor_user_id: driverId,
        note: 'Customer cancelled before arrival',
        latitude: null,
        longitude: null,
        created_at: request.updatedAt,
      });
      pushEvent('STATUS_CANCELLED', `Request cancelled: ${request.cancelReason}`, 'DRIVER', driverId, null, updatedMs);
      job = { id: jobId, payout: 0, mechanic: request.mechanic };
    }

    // --- diagnosis --------------------------------------------------------
    let diagnosisId = null;
    if (job && ['ARRIVED', 'DIAGNOSING', 'QUOTE_PENDING', 'QUOTE_APPROVED', 'REPAIRING', 'COMPLETED'].includes(request.jobStatus)) {
      diagnosisId = newId();
      const items = DIAGNOSIS_TEMPLATES[request.issue] ?? DIAGNOSIS_TEMPLATES.DONT_KNOW;
      ins('diagnoses', {
        id: diagnosisId,
        request_id: request.id,
        mechanic_user_id: request.mechanic.userId,
        notes: `Checked ${request.issueLabel.toLowerCase()} on site; shared findings with the customer before quoting.`,
        created_at: iso(parseMs(request.createdAt) + 20 * MIN),
        updated_at: iso(parseMs(request.createdAt) + 30 * MIN),
      });
      items.forEach(([code, label, result, notes], index) => {
        ins('diagnosis_items', {
          id: newId(),
          diagnosis_id: diagnosisId,
          code,
          label,
          result,
          notes,
          sort: index,
          created_at: iso(parseMs(request.createdAt) + 20 * MIN),
        });
      });
    }

    // --- quote ------------------------------------------------------------
    const quoteStatuses = {
      PAID: 'APPROVED',
      PAYMENT_PENDING: 'APPROVED',
      COMPLETED: 'APPROVED',
      QUOTE_PENDING: 'PENDING',
      QUOTE_APPROVED: 'APPROVED',
      REPAIRING: 'APPROVED',
    };
    const quoteStatus = quoteStatuses[request.status];
    if (quoteStatus && request.quoteItems) {
      const quoteId = newId();
      const totals = request.quoteTotals;
      const quoteCreatedAt = iso(parseMs(request.createdAt) + 55 * MIN);
      const decidedAt = quoteStatus === 'APPROVED' ? iso(parseMs(request.createdAt) + 70 * MIN) : null;
      ins('quotes', {
        id: quoteId,
        request_id: request.id,
        job_id: job?.id ?? null,
        diagnosis_id: diagnosisId,
        status: quoteStatus,
        subtotal_cents: totals.subtotal,
        tax_cents: totals.tax,
        fees_cents: totals.fees,
        discount_cents: totals.discount,
        total_cents: totals.total,
        tax_percent: 18,
        notes: 'Warranty on parts as per manufacturer terms. labour rates include diagnostics.',
        created_by: request.mechanic?.userId ?? null,
        decided_by: quoteStatus === 'APPROVED' ? driverId : null,
        decided_at: decidedAt,
        decide_reason: null,
        created_at: quoteCreatedAt,
        updated_at: decidedAt ?? quoteCreatedAt,
      });
      request.quoteItems.forEach((item, index) => {
        ins('quote_items', {
          id: newId(),
          quote_id: quoteId,
          type: item.type,
          description: item.description,
          quantity: item.quantity,
          unit_price_cents: item.unitPriceCents,
          total_cents: Math.round(item.quantity * item.unitPriceCents),
          part_id: null,
          sort: index,
          created_at: quoteCreatedAt,
        });
      });
      if (quoteStatus === 'APPROVED') {
        pushEvent('STATUS_QUOTE_APPROVED', 'Quote approved — starting repair', 'DRIVER', driverId, null, parseMs(decidedAt));
      }
      if (quoteStatus === 'PENDING') {
        pushEvent('QUOTE_CREATED', 'Quote sent for approval', 'MECHANIC', request.mechanic?.userId ?? null, null, parseMs(quoteCreatedAt));
        addNotification({
          userId: driverId,
          type: 'QUOTE_CREATED',
          title: 'Quote ready for approval',
          body: `Your mechanic sent a quote of ₹${Math.round(totals.total / 100)}. Review and approve to start the repair.`,
          data: { requestId: request.id, totalCents: totals.total },
          at: parseMs(quoteCreatedAt),
          read: false,
        });
      }
    }

    // --- billing ----------------------------------------------------------
    if (request.paymentStatus && request.totalCents) {
      const invoiceId = newId();
      const invoiceNumber = newInvoiceNumber(new Date(parseMs(request.createdAt)).getUTCFullYear());
      const invoiceStatus = request.paymentStatus === 'PAID' ? 'PAID' : 'ISSUED';
      const issuedAt = iso(parseMs(request.completedAt ?? request.updatedAt));
      ins('invoices', {
        id: invoiceId,
        number: invoiceNumber,
        request_id: request.id,
        subtotal_cents: request.quoteTotals.subtotal,
        tax_cents: request.quoteTotals.tax,
        total_cents: request.totalCents,
        status: invoiceStatus,
        pdf_key: `demo/invoices/${invoiceNumber}.pdf`,
        issued_at: issuedAt,
        paid_at: invoiceStatus === 'PAID' ? issuedAt : null,
        created_at: issuedAt,
      });

      const paymentStatus =
        request.paymentStatus === 'PAID' ? 'PAID' : request.paymentStatus === 'PENDING' ? 'PENDING' : 'FAILED';
      const paidAt = paymentStatus === 'PAID' ? issuedAt : null;
      ins('payments', {
        id: newId(),
        request_id: request.id,
        invoice_id: invoiceId,
        provider: 'test',
        provider_ref: `test_seed_${request.reference}`,
        status: paymentStatus,
        amount_cents: request.totalCents,
        currency: 'INR',
        method: paymentStatus === 'FAILED' ? 'CARD' : 'UPI',
        failure_reason: paymentStatus === 'FAILED' ? 'Card declined by issuer' : null,
        created_at: issuedAt,
        updated_at: issuedAt,
        paid_at: paidAt,
      });

      if (paymentStatus === 'PAID') {
        pushEvent('PAYMENT_COMPLETED', `Payment completed — ₹${Math.round(request.totalCents / 100)}`, 'DRIVER', driverId, null, parseMs(issuedAt));
        addNotification({
          userId: driverId,
          type: 'PAYMENT_COMPLETED',
          title: 'Payment successful',
          body: `₹${Math.round(request.totalCents / 100)} paid. Your invoice is ready.`,
          data: { requestId: request.id, reference: request.reference },
          at: parseMs(issuedAt),
          read: request.kind === 'historical',
        });
      }
      if (paymentStatus === 'PENDING') {
        addNotification({
          userId: driverId,
          type: 'REPAIR_COMPLETED',
          title: 'Repair completed',
          body: `Your vehicle is ready. Amount payable: ₹${Math.round(request.totalCents / 100)}.`,
          data: { requestId: request.id, totalCents: request.totalCents },
          at: parseMs(issuedAt),
          read: false,
        });
      }

      if (job) {
        ins('service_reports', {
          id: newId(),
          request_id: request.id,
          job_id: job.id,
          object_key: `demo/reports/${request.reference}.pdf`,
          summary_json: JSON.stringify({
            reference: request.reference,
            issueType: request.issue,
            description: request.description,
            totalCents: request.totalCents,
            mechanic: request.mechanic.userId,
            completedAt: request.completedAt,
          }),
          generated_at: issuedAt,
        });
      }
    }

    // --- extras: photos, parts -------------------------------------------
    if (job && requestIndex % 5 === 0) {
      for (const stage of ['BEFORE', 'DIAGNOSIS', 'AFTER']) {
        ins('job_photos', {
          id: newId(),
          job_id: job.id,
          request_id: request.id,
          stage,
          object_key: `demo/photos/${request.reference.toLowerCase()}-${stage.toLowerCase()}.jpg`,
          caption: `${stage.toLowerCase()} inspection photo`,
          uploaded_by: request.mechanic.userId,
          created_at: iso(parseMs(request.createdAt) + 40 * MIN),
        });
      }
      ins('job_parts', {
        id: newId(),
        job_id: job.id,
        part_id: null,
        description: 'Workshop consumables used during the repair',
        quantity: 1,
        unit_price_cents: 1_800,
        created_at: iso(parseMs(request.createdAt) + 60 * MIN),
      });
    }

    if (request.status === 'CANCELLED' && job) {
      ins('job_parts', {
        id: newId(),
        job_id: job.id,
        part_id: null,
        description: 'Diagnostic fee (partial)',
        quantity: 1,
        unit_price_cents: 5_000,
        created_at: request.updatedAt,
      });
    }

    // --- mechanical location ping for travelling mechanics ----------------
    if (['MECHANIC_EN_ROUTE', 'MECHANIC_NEARBY', 'ARRIVED'].includes(request.status) && request.mechanic) {
      ins('emergency_locations', {
        id: newId(),
        request_id: request.id,
        source: 'MECHANIC',
        actor_user_id: request.mechanic.userId,
        latitude: request.mechanic.lat,
        longitude: request.mechanic.lng,
        accuracy: 18,
        recorded_at: iso(Math.min(updatedMs, NOW - 60_000)),
      });
    }

    // --- timeline ---------------------------------------------------------
    events.sort((a, b) => a.at - b.at);
    for (const event of events) {
      ins('emergency_events', {
        id: newId(),
        request_id: request.id,
        type: event.type,
        message: event.message,
        actor_role: event.actorRole,
        actor_user_id: event.actorUserId,
        data_json: event.data ? JSON.stringify(event.data) : null,
        created_at: iso(event.at),
      });
    }

    // --- reviews ----------------------------------------------------------
    if (job && ['PAID', 'PAYMENT_PENDING', 'COMPLETED'].includes(request.status)) {
      reviewPlan.push({
        requestId: request.id,
        jobId: job.id,
        reviewer: driverId,
        reviewee: request.mechanic.userId,
        overall: request.rating ?? 5,
        createdAt: iso(parseMs(request.completedAt ?? request.updatedAt) + 20 * MIN),
        direction: 'DRIVER_TO_MECHANIC',
      });
    }
  });

  // Three mechanic → driver reviews round out the two-way rating system.
  const reverseSources = [
    { request: requests[0], overall: 5, comment: 'Clear communication and arrived exactly when promised.' },
    { request: requests[5], overall: 4, comment: 'Sorted the issue quickly, though the wait for parts was long.' },
    { request: requests[13], overall: 5, comment: 'Explained the fault before starting work. Very professional.' },
  ];
  for (const source of reverseSources) {
    if (!source.request?.hasJob || !source.request.mechanic) continue;
    reverseReviewPlan.push({
      requestId: source.request.id,
      jobId: null,
      reviewer: source.request.mechanic.userId,
      reviewee: driverIds[source.request.driverIndex],
      overall: source.overall,
      comment: source.comment,
      createdAt: iso(parseMs(source.request.completedAt ?? source.request.updatedAt) + 40 * MIN),
      direction: 'MECHANIC_TO_DRIVER',
    });
  }

  const REVIEW_COMMENTS = [
    'Quick and professional — fixed it on the spot.',
    'Explained the fault clearly and the price matched the quote.',
    'Arrived early and got the car running in 20 minutes.',
    'Good work, would book again.',
    'Honest diagnosis, no upselling.',
    'Took a little longer than promised but the job is solid.',
    'Polite mechanic, kept me updated throughout.',
    'Straightforward experience from start to finish.',
  ];

  const allReviews = [...reviewPlan, ...reverseReviewPlan];
  const ratingAggregates = new Map();

  allReviews.forEach((review, index) => {
    ins('reviews', {
      id: newId(),
      request_id: review.requestId,
      job_id: review.jobId,
      reviewer_user_id: review.reviewer,
      reviewee_user_id: review.reviewee,
      direction: review.direction,
      overall: review.overall,
      arrival: Math.min(5, review.overall + (index % 2)),
      diagnosis: review.overall,
      pricing: Math.max(1, review.overall - (index % 3 === 0 ? 1 : 0)),
      professionalism: 5,
      resolution: Math.min(5, review.overall + (index % 2)),
      comment: review.comment ?? REVIEW_COMMENTS[index % REVIEW_COMMENTS.length],
      created_at: review.createdAt,
    });
    const aggregate = ratingAggregates.get(review.reviewee) ?? { sum: 0, count: 0 };
    aggregate.sum += review.overall;
    aggregate.count += 1;
    ratingAggregates.set(review.reviewee, aggregate);

    if (review.direction === 'DRIVER_TO_MECHANIC') {
      addNotification({
        userId: review.reviewee,
        type: 'REVIEW_RECEIVED',
        title: 'You received a review',
        body: `${review.overall}/5 — thanks for your feedback!`,
        data: { requestId: review.requestId },
        at: parseMs(review.createdAt),
        read: true,
      });
    }
  });

  for (const [userId, aggregate] of ratingAggregates) {
    ins('ratings', {
      user_id: userId,
      average: aggregate.sum / aggregate.count,
      count: aggregate.count,
      sum: aggregate.sum,
      updated_at: ago(2 * DAY),
    });
  }

  // --- disputes -----------------------------------------------------------

  const paidRequests = requests.filter((r) => r.status === 'PAID');
  if (paidRequests[0]) {
    ins('disputes', {
      id: newId(),
      request_id: paidRequests[0].id,
      raised_by: driverIds[paidRequests[0].driverIndex],
      reason: 'The final amount does not match the quote I approved.',
      status: 'OPEN',
      resolution: null,
      resolved_by: null,
      resolved_at: null,
      created_at: ago(2 * DAY),
      updated_at: ago(2 * DAY),
    });
  }
  if (paidRequests[1]) {
    ins('disputes', {
      id: newId(),
      request_id: paidRequests[1].id,
      raised_by: driverIds[paidRequests[1].driverIndex],
      reason: 'The replacement part looks used.',
      status: 'RESOLVED',
      resolution: 'Part replaced under warranty, ₹1,200 credited back to the customer.',
      resolved_by: userIds.admin,
      resolved_at: ago(1 * DAY),
      created_at: ago(3 * DAY),
      updated_at: ago(1 * DAY),
    });
  }

  // --- notifications for the live fleet -----------------------------------

  for (const live of requests.filter((r) => r.kind === 'live')) {
    if (!['ASSIGNED', 'MECHANIC_EN_ROUTE', 'MECHANIC_NEARBY', 'ARRIVED'].includes(live.status)) continue;
    addNotification({
      userId: driverIds[live.driverIndex],
      type: 'MECHANIC_ACCEPTED',
      title: 'Mechanic found',
      body: `${MECHANIC_NAMES[(live.mechanic.index ?? 0) % MECHANIC_NAMES.length]} is on the way. Track live status in the app.`,
      data: { requestId: live.id, mechanicUserId: live.mechanic.userId },
      at: parseMs(live.createdAt) + 3 * MIN,
      read: false,
    });
  }

  addNotification({
    userId: userIds.admin,
    type: 'VERIFICATION_SUBMITTED',
    title: 'Mechanic verification submitted',
    body: 'Akash Gupta submitted verification documents.',
    data: { mechanicUserId: mechanics.get('m13').userId },
    at: ago(9 * DAY),
    read: false,
  });
  addNotification({
    userId: userIds.ops[1],
    type: 'MECHANIC_DELAYED',
    title: 'A job is running late',
    body: 'One of the active jobs has not reported progress in a while.',
    data: null,
    at: ago(3 * HOUR),
    read: false,
  });
  addNotification({
    userId: driverIds[0],
    type: 'REVIEW_RECEIVED',
    title: 'Thanks for your review',
    body: 'Your rating has been shared with the mechanic.',
    data: null,
    at: ago(6 * DAY),
    read: true,
  });

  // the demo driver keeps a few unread items so the bell badge shows on sign-in
  stats.notifications
    .filter((notification) => notification.userId === driverIds[0])
    .sort((a, b) => b.at - a.at)
    .slice(0, 3)
    .forEach((notification) => {
      notification.readAt = null;
    });

  for (const notification of stats.notifications) {
    ins('notifications', {
      id: notification.id,
      user_id: notification.userId,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      data_json: notification.dataJson,
      channel: 'IN_APP',
      read_at: notification.readAt,
      created_at: iso(notification.at),
    });
  }

  // --- audit trail --------------------------------------------------------

  const auditEntries = [
    [userIds.admin, 'ADMIN', 'LOGIN_SUCCESS', 'user', userIds.admin, 2],
    [userIds.ops[0], 'OPERATIONS', 'OPS_ASSIGN', 'emergency_request', requests[27]?.id, 3],
    [userIds.drivers[0], 'DRIVER', 'EMERGENCY_CREATED', 'emergency_request', requests[0]?.id, 4],
    [userIds.drivers[1], 'DRIVER', 'QUOTE_APPROVED', 'quote', null, 5],
    [userIds.mechanics[0], 'MECHANIC', 'DISPATCH_ACCEPTED', 'emergency_request', requests[0]?.id, 6],
    [userIds.mechanics[5], 'MECHANIC', 'DISPATCH_DECLINED', 'emergency_request', requests[28]?.id, 7],
    [userIds.mechanics[3], 'MECHANIC', 'JOB_COMPLETED', 'job', null, 8],
    [userIds.drivers[2], 'DRIVER', 'EMERGENCY_CANCELLED', 'emergency_request', requests[23]?.id, 9],
    [userIds.admin, 'ADMIN', 'MECHANIC_VERIFICATION_DECISION', 'mechanic', mechanics.get('m13').userId, 10],
    [userIds.admin, 'ADMIN', 'PRICING_RULE_UPDATED', 'pricing_rule', null, 11],
    [userIds.admin, 'ADMIN', 'CONFIG_UPDATED', 'platform_config', 'dispatch', 12],
    [userIds.admin, 'ADMIN', 'USER_SUSPENDED', 'user', userIds.drivers[9], 13],
    [userIds.ops[1], 'OPERATIONS', 'OPS_ESCALATE', 'emergency_request', requests[41]?.id, 14],
    [userIds.ops[0], 'OPERATIONS', 'OPS_NOTE', 'emergency_request', requests[42]?.id, 15],
    [userIds.drivers[3], 'DRIVER', 'EMERGENCY_ESCALATED', 'emergency_request', requests[41]?.id, 16],
    [userIds.mechanics[1], 'MECHANIC', 'JOB_CANCELLED_REASSIGNED', 'job', null, 17],
    [userIds.drivers[4], 'DRIVER', 'REVIEW_CREATED', 'review', null, 18],
    [userIds.ops[1], 'OPERATIONS', 'LOGIN_SUCCESS', 'user', userIds.ops[1], 19],
  ];

  for (const [actorUserId, actorRole, action, entityType, entityId, daysAgo] of auditEntries) {
    stats.audit.push({
      id: newId(),
      actorUserId,
      actorRole,
      action,
      entityType,
      entityId: entityId ?? null,
      dataJson: JSON.stringify({ source: 'seed', note: 'demo audit entry' }),
      ip: '127.0.0.1',
      requestId: `seed-${String(daysAgo).padStart(4, '0')}`,
      at: dayAt(Math.min(daysAgo, 26), 10 + (daysAgo % 8), (daysAgo * 9) % 60),
    });
  }

  for (const entry of stats.audit) {
    ins('audit_logs', {
      id: entry.id,
      actor_user_id: entry.actorUserId,
      actor_role: entry.actorRole,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      data_json: entry.dataJson,
      ip: entry.ip,
      request_id: entry.requestId,
      created_at: entry.at,
    });
  }

  // --- aggregates ---------------------------------------------------------

  const completedJobs = new Map();
  const cancelledJobs = new Map();
  const earningsByMechanic = new Map();
  db.prepare(
    `SELECT mechanic_user_id, status, earnings_cents FROM jobs WHERE deleted_at IS NULL AND status IN ('COMPLETED','CANCELLED')`,
  )
    .all()
    .forEach((row) => {
      if (row.status === 'COMPLETED') track(completedJobs, row.mechanic_user_id);
      else track(cancelledJobs, row.mechanic_user_id);
      if (row.earnings_cents > 0) track(earningsByMechanic, row.mechanic_user_id, row.earnings_cents);
    });

  for (const mechanic of mechanics.values()) {
    const received = 15 + (stats.attempts.get(mechanic.key) ?? 0) * 2 + (mechanic.index % 7) * 3;
    const accepted = Math.min(received, (stats.accepted.get(mechanic.key) ?? 0) + 8 + (mechanic.index % 5));
    const rating = ratingAggregates.get(mechanic.userId) ?? { sum: 0, count: 0 };
    db.prepare(
      `UPDATE mechanics
          SET rating_sum = ?, rating_count = ?, jobs_completed = ?, jobs_cancelled = ?,
              offers_received = ?, offers_accepted = ?, earnings_cents = ?, updated_at = ?
        WHERE user_id = ?`,
    ).run(
      rating.sum,
      rating.count,
      completedJobs.get(mechanic.userId) ?? 0,
      cancelledJobs.get(mechanic.userId) ?? 0,
      received,
      accepted,
      earningsByMechanic.get(mechanic.userId) ?? 0,
      ago(1 * HOUR),
      mechanic.userId,
    );
  }

  for (const [driverId, total] of stats.drivers) {
    db.prepare('UPDATE drivers SET total_requests = ?, updated_at = ? WHERE user_id = ?')
      .run(total, ago(2 * DAY), driverId);
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function countRows(db, table) {
  if (!tableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
  return row?.c ?? 0;
}

function printCounts(db) {
  console.log('\n  table'.padEnd(30) + 'rows');
  console.log('  ' + '-'.repeat(28));
  for (const table of COUNT_TABLES) {
    console.log(`  ${table.padEnd(28)} ${countRows(db, table)}`);
  }
}

function printAccounts() {
  console.log('\nDemo accounts (password: Demo@1234)');
  console.log('   driver1..10@motoro.test    mechanic1..15@motoro.test');
  console.log('   workshop1..3@motoro.test   towing1..2@motoro.test');
  console.log('   ops1, ops2@motoro.test     admin@motoro.test');
}

function main() {
  const dbPath = findDatabase();
  if (!dbPath) {
    fail(
      'No local D1 database found.\n' +
        '  Start the worker once so wrangler creates it, then re-run:\n' +
        '    npm run worker:dev   (Ctrl+C after it boots)\n' +
        '  Or point at a file:  MOTORO_D1_PATH=/path/to.sqlite npm run seed',
    );
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 15000');
  db.exec('PRAGMA foreign_keys = ON');

  if (!tableExists(db, 'users')) {
    console.log('  schema missing — applying migrations');
    applyMigrations(db);
  }

  const existingUsers = countRows(db, 'users');
  if (NO_RESET && existingUsers > 0) {
    console.log(`✓ Database already seeded (${existingUsers} users) — nothing written`);
    printCounts(db);
    printAccounts();
    db.close();
    return;
  }

  console.log(`Seeding ${path.relative(ROOT, dbPath)}`);
  resetDatabase(db);

  db.exec('BEGIN');
  try {
    seed(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }

  console.log('✓ Database seeded');
  printCounts(db);
  printAccounts();
  db.close();
}

try {
  main();
} catch (error) {
  console.error('✗ Seed failed:', error?.message ?? String(error));
  if (error?.stack) console.error(error.stack);
  process.exit(1);
}
