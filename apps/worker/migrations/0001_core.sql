-- Motoro - core schema: identity, profiles, vehicles, config
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  role              TEXT NOT NULL CHECK (role IN ('DRIVER','MECHANIC','WORKSHOP','TOWING_PARTNER','OPERATIONS','ADMIN')),
  email             TEXT NOT NULL,
  phone             TEXT,
  password_hash     TEXT NOT NULL,
  full_name         TEXT NOT NULL,
  locale            TEXT NOT NULL DEFAULT 'en',
  status            TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),
  email_verified_at TEXT,
  phone_verified_at TEXT,
  avatar_key        TEXT,
  last_login_at     TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at        TEXT
);
CREATE UNIQUE INDEX idx_users_email ON users (email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX idx_users_phone ON users (phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_users_role ON users (role, status);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT,
  ip           TEXT,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sessions_user ON sessions (user_id, revoked_at);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

CREATE TABLE password_resets (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_password_resets_user ON password_resets (user_id);

CREATE TABLE drivers (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  membership         TEXT NOT NULL DEFAULT 'FREE' CHECK (membership IN ('FREE','PLUS','FLEET')),
  default_vehicle_id TEXT,
  total_requests     INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE workshops (
  id                 TEXT PRIMARY KEY,
  owner_user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  address            TEXT,
  latitude           REAL,
  longitude          REAL,
  service_radius_km  REAL NOT NULL DEFAULT 10,
  verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','UNDER_REVIEW','VERIFIED','REJECTED','SUSPENDED')),
  capabilities       TEXT NOT NULL DEFAULT '[]',
  rating_sum         INTEGER NOT NULL DEFAULT 0,
  rating_count       INTEGER NOT NULL DEFAULT 0,
  revenue_cents      INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at         TEXT
);
CREATE INDEX idx_workshops_owner ON workshops (owner_user_id);

CREATE TABLE mechanics (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','UNDER_REVIEW','VERIFIED','REJECTED','SUSPENDED')),
  status              TEXT NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('OFFLINE','AVAILABLE','BUSY','EN_ROUTE','ON_JOB','PAUSED','SUSPENDED')),
  bio                 TEXT,
  experience_years    INTEGER NOT NULL DEFAULT 0,
  address             TEXT,
  latitude            REAL,
  longitude           REAL,
  last_known_latitude  REAL,
  last_known_longitude REAL,
  last_location_at    TEXT,
  service_radius_km   REAL NOT NULL DEFAULT 10,
  workshop_id         TEXT REFERENCES workshops(id) ON DELETE SET NULL,
  document_key        TEXT,
  submitted_at        TEXT,
  reviewed_at         TEXT,
  review_note         TEXT,
  rating_sum          INTEGER NOT NULL DEFAULT 0,
  rating_count        INTEGER NOT NULL DEFAULT 0,
  jobs_completed      INTEGER NOT NULL DEFAULT 0,
  jobs_cancelled      INTEGER NOT NULL DEFAULT 0,
  offers_received     INTEGER NOT NULL DEFAULT 0,
  offers_accepted     INTEGER NOT NULL DEFAULT 0,
  earnings_cents      INTEGER NOT NULL DEFAULT 0,
  reliability_score   REAL NOT NULL DEFAULT 0.7,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at          TEXT
);
CREATE INDEX idx_mechanics_status ON mechanics (status, verification_status);
CREATE INDEX idx_mechanics_workshop ON mechanics (workshop_id);

CREATE TABLE workshop_mechanics (
  workshop_id      TEXT NOT NULL REFERENCES workshops(id) ON DELETE CASCADE,
  mechanic_user_id TEXT NOT NULL REFERENCES mechanics(user_id) ON DELETE CASCADE,
  job_role         TEXT NOT NULL DEFAULT 'MECHANIC',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (workshop_id, mechanic_user_id)
);

CREATE TABLE towing_partners (
  id                 TEXT PRIMARY KEY,
  owner_user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  address            TEXT,
  latitude           REAL,
  longitude          REAL,
  service_radius_km  REAL NOT NULL DEFAULT 25,
  status             TEXT NOT NULL DEFAULT 'OFFLINE' CHECK (status IN ('OFFLINE','AVAILABLE','BUSY','EN_ROUTE','ON_JOB','PAUSED','SUSPENDED')),
  verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','UNDER_REVIEW','VERIFIED','REJECTED','SUSPENDED')),
  rating_sum         INTEGER NOT NULL DEFAULT 0,
  rating_count       INTEGER NOT NULL DEFAULT 0,
  jobs_completed     INTEGER NOT NULL DEFAULT 0,
  earnings_cents     INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at         TEXT
);
CREATE INDEX idx_towing_owner ON towing_partners (owner_user_id);

CREATE TABLE towing_vehicles (
  id           TEXT PRIMARY KEY,
  partner_id   TEXT NOT NULL REFERENCES towing_partners(id) ON DELETE CASCADE,
  plate_number TEXT NOT NULL,
  towing_type  TEXT NOT NULL DEFAULT 'FLATBED',
  capacity_kg  INTEGER,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_towing_vehicles_partner ON towing_vehicles (partner_id);

CREATE TABLE vehicles (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registration_number TEXT NOT NULL,
  make               TEXT NOT NULL,
  model               TEXT NOT NULL,
  variant            TEXT,
  year               INTEGER,
  fuel_type          TEXT NOT NULL CHECK (fuel_type IN ('PETROL','DIESEL','CNG','ELECTRIC','HYBRID')),
  vehicle_type       TEXT NOT NULL CHECK (vehicle_type IN ('TWO_WHEELER','CAR','SUV','SCOOTER','COMMERCIAL','EV')),
  insurance_expiry   TEXT,
  rc_number          TEXT,
  color              TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at         TEXT
);
CREATE INDEX idx_vehicles_user ON vehicles (user_id, deleted_at);

CREATE TABLE vehicle_documents (
  id           TEXT PRIMARY KEY,
  vehicle_id   TEXT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  doc_type     TEXT NOT NULL,
  object_key   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_vehicle_docs_vehicle ON vehicle_documents (vehicle_id);

CREATE TABLE mechanic_skills (
  id               TEXT PRIMARY KEY,
  mechanic_user_id TEXT NOT NULL REFERENCES mechanics(user_id) ON DELETE CASCADE,
  skill            TEXT NOT NULL,
  level            TEXT NOT NULL DEFAULT 'INTERMEDIATE' CHECK (level IN ('BEGINNER','INTERMEDIATE','EXPERT')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (mechanic_user_id, skill)
);
CREATE INDEX idx_mechanic_skills_skill ON mechanic_skills (skill);

CREATE TABLE mechanic_equipment (
  id               TEXT PRIMARY KEY,
  mechanic_user_id TEXT NOT NULL REFERENCES mechanics(user_id) ON DELETE CASCADE,
  equipment        TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (mechanic_user_id, equipment)
);
CREATE INDEX idx_mechanic_equipment_name ON mechanic_equipment (equipment);

CREATE TABLE mechanic_availability (
  id               TEXT PRIMARY KEY,
  mechanic_user_id TEXT NOT NULL REFERENCES mechanics(user_id) ON DELETE CASCADE,
  day_of_week      INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_minute     INTEGER NOT NULL,
  end_minute       INTEGER NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (mechanic_user_id, day_of_week, start_minute)
);

CREATE TABLE emergency_contacts (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  relationship TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at   TEXT
);
CREATE INDEX idx_emergency_contacts_user ON emergency_contacts (user_id, deleted_at);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  data_json  TEXT,
  channel    TEXT NOT NULL DEFAULT 'IN_APP',
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_notifications_user ON notifications (user_id, read_at, created_at);

CREATE TABLE audit_logs (
  id            TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_role    TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT,
  entity_id     TEXT,
  data_json     TEXT,
  ip            TEXT,
  request_id    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_logs_created ON audit_logs (created_at);
CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_type, entity_id);

CREATE TABLE files (
  id            TEXT PRIMARY KEY,
  object_key    TEXT NOT NULL UNIQUE,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  purpose       TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_files_owner ON files (owner_user_id, purpose);

CREATE TABLE platform_config (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by TEXT
);

CREATE TABLE pricing_rules (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  type        TEXT NOT NULL DEFAULT 'FIXED' CHECK (type IN ('FIXED','PERCENT','PER_KM')),
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE service_categories (
  code                TEXT PRIMARY KEY,
  name_en             TEXT NOT NULL,
  name_hi             TEXT NOT NULL,
  icon                TEXT NOT NULL DEFAULT 'wrench',
  required_skills     TEXT NOT NULL DEFAULT '[]',
  required_equipment  TEXT NOT NULL DEFAULT '[]',
  active              INTEGER NOT NULL DEFAULT 1,
  sort                INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
