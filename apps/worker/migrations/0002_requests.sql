-- Motoro - emergency requests, dispatch, jobs, quotes, payments, reviews
PRAGMA foreign_keys = ON;

CREATE TABLE emergency_requests (
  id                     TEXT PRIMARY KEY,
  reference              TEXT NOT NULL UNIQUE,
  driver_user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  vehicle_id             TEXT REFERENCES vehicles(id) ON DELETE SET NULL,
  channel                TEXT NOT NULL DEFAULT 'WEB' CHECK (channel IN ('WEB','APP','PHONE','WHATSAPP','OPS')),
  category_code          TEXT NOT NULL DEFAULT 'GENERAL_BREAKDOWN',
  issue_type             TEXT NOT NULL,
  description            TEXT,
  urgency                TEXT NOT NULL DEFAULT 'NORMAL' CHECK (urgency IN ('LOW','NORMAL','HIGH','CRITICAL')),
  status                 TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN (
      'CREATED','SEARCHING','DISPATCHING','ASSIGNED','MECHANIC_EN_ROUTE','MECHANIC_NEARBY',
      'ARRIVED','DIAGNOSING','QUOTE_PENDING','QUOTE_APPROVED','REPAIRING','COMPLETED',
      'PAYMENT_PENDING','PAID','CANCELLED','ESCALATED','TOWING_REQUIRED','FAILED')),
  accident_json          TEXT,
  latitude               REAL NOT NULL,
  longitude              REAL NOT NULL,
  accuracy               REAL,
  address                TEXT,
  required_skills        TEXT NOT NULL DEFAULT '[]',
  required_equipment     TEXT NOT NULL DEFAULT '[]',
  assigned_mechanic_user_id TEXT REFERENCES mechanics(user_id) ON DELETE SET NULL,
  workshop_id            TEXT REFERENCES workshops(id) ON DELETE SET NULL,
  towing_partner_id      TEXT REFERENCES towing_partners(id) ON DELETE SET NULL,
  dispatch_radius_km     REAL NOT NULL DEFAULT 5,
  dispatch_round         INTEGER NOT NULL DEFAULT 0,
  escalation_level       INTEGER NOT NULL DEFAULT 0,
  dispatch_started_at    TEXT,
  assigned_at            TEXT,
  completed_at           TEXT,
  payment_status         TEXT CHECK (payment_status IN ('PENDING','AUTHORIZED','PAID','FAILED','REFUNDED')),
  total_amount_cents     INTEGER,
  rating                 INTEGER,
  cancel_reason          TEXT,
  cancelled_by           TEXT,
  created_by_role        TEXT NOT NULL DEFAULT 'DRIVER',
  source_meta_json       TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at             TEXT
);
CREATE INDEX idx_requests_status ON emergency_requests (status, created_at);
CREATE INDEX idx_requests_driver ON emergency_requests (driver_user_id, created_at);
CREATE INDEX idx_requests_mechanic ON emergency_requests (assigned_mechanic_user_id, status);
CREATE INDEX idx_requests_active ON emergency_requests (created_at) WHERE deleted_at IS NULL;

CREATE TABLE emergency_locations (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES emergency_requests(id) ON DELETE CASCADE,
  source      TEXT NOT NULL CHECK (source IN ('DRIVER','MECHANIC','OPS')),
  actor_user_id TEXT,
  latitude    REAL NOT NULL,
  longitude   REAL NOT NULL,
  accuracy    REAL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_locations_request ON emergency_locations (request_id, recorded_at);

CREATE TABLE emergency_events (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL REFERENCES emergency_requests(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  message       TEXT NOT NULL,
  actor_role    TEXT,
  actor_user_id TEXT,
  data_json     TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_events_request ON emergency_events (request_id, created_at);

CREATE TABLE dispatch_attempts (
  id               TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL REFERENCES emergency_requests(id) ON DELETE CASCADE,
  attempt_no       INTEGER NOT NULL,
  mechanic_user_id TEXT NOT NULL REFERENCES mechanics(user_id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
      'PENDING','ACCEPTED','DECLINED','TIMEOUT','CANCELLED','FAILED','EXPIRED','REASSIGNED')),
  score            REAL,
  distance_km      REAL,
  eta_minutes      INTEGER,
  offered_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  responded_at     TEXT,
  timeout_at       TEXT,
  decline_reason   TEXT,
  notified_count   INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (request_id, attempt_no)
);
CREATE INDEX idx_attempts_request ON dispatch_attempts (request_id, status);
CREATE INDEX idx_attempts_mechanic ON dispatch_attempts (mechanic_user_id, status);
CREATE INDEX idx_attempts_pending_timeout ON dispatch_attempts (status, timeout_at);

CREATE TABLE mechanic_assignments (
  id               TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL REFERENCES emergency_requests(id) ON DELETE CASCADE,
  mechanic_user_id TEXT NOT NULL REFERENCES mechanics(user_id) ON DELETE CASCADE,
  attempt_id       TEXT REFERENCES dispatch_attempts(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','COMPLETED','CANCELLED','REPLACED')),
  assigned_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at         TEXT,
  end_reason       TEXT
);
CREATE INDEX idx_assignments_request ON mechanic_assignments (request_id, status);
CREATE INDEX idx_assignments_mechanic ON mechanic_assignments (mechanic_user_id, status);

CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL REFERENCES emergency_requests(id) ON DELETE CASCADE,
  mechanic_user_id TEXT NOT NULL REFERENCES mechanics(user_id) ON DELETE RESTRICT,
  status           TEXT NOT NULL DEFAULT 'ACCEPTED' CHECK (status IN (
      'ACCEPTED','EN_ROUTE','ARRIVED','VERIFIED','DIAGNOSING','QUOTE_PENDING',
      'QUOTE_APPROVED','REPAIRING','COMPLETED','CANCELLED')),
  otp_code_hash    TEXT,
  otp_expires_at   TEXT,
  otp_attempts     INTEGER NOT NULL DEFAULT 0,
  otp_verified_at  TEXT,
  earnings_cents   INTEGER NOT NULL DEFAULT 0,
  accepted_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  en_route_at      TEXT,
  arrived_at       TEXT,
  started_at       TEXT,
  completed_at     TEXT,
  stall_warned_at  TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at       TEXT
);
CREATE UNIQUE INDEX idx_jobs_request_active ON jobs (request_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_jobs_mechanic ON jobs (mechanic_user_id, status);

CREATE TABLE job_status_history (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  actor_user_id TEXT,
  note         TEXT,
  latitude     REAL,
  longitude    REAL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_job_history_job ON job_status_history (job_id, created_at);

CREATE TABLE job_photos (
  id           TEXT PRIMARY KEY,
  job_id       TEXT REFERENCES jobs(id) ON DELETE CASCADE,
  request_id   TEXT NOT NULL REFERENCES emergency_requests(id) ON DELETE CASCADE,
  stage        TEXT NOT NULL CHECK (stage IN ('BEFORE','DIAGNOSIS','AFTER','VERIFICATION')),
  object_key   TEXT NOT NULL,
  caption      TEXT,
  uploaded_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_job_photos_job ON job_photos (job_id, stage);
CREATE INDEX idx_job_photos_request ON job_photos (request_id);

CREATE TABLE diagnoses (
  id               TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL REFERENCES emergency_requests(id) ON DELETE CASCADE,
  mechanic_user_id TEXT NOT NULL REFERENCES mechanics(user_id) ON DELETE RESTRICT,
  notes            TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_diagnoses_request ON diagnoses (request_id);

CREATE TABLE diagnosis_items (
  id           TEXT PRIMARY KEY,
  diagnosis_id TEXT NOT NULL REFERENCES diagnoses(id) ON DELETE CASCADE,
  code         TEXT NOT NULL,
  label        TEXT NOT NULL,
  result       TEXT NOT NULL CHECK (result IN ('OK','FAIL','NA','UNCERTAIN')),
  notes        TEXT,
  sort         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_diagnosis_items_parent ON diagnosis_items (diagnosis_id);

CREATE TABLE parts (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  sku           TEXT,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE quotes (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL REFERENCES emergency_requests(id) ON DELETE CASCADE,
  job_id        TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  diagnosis_id  TEXT REFERENCES diagnoses(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('DRAFT','PENDING','APPROVED','REJECTED','EXPIRED')),
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents     INTEGER NOT NULL DEFAULT 0,
  fees_cents    INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents   INTEGER NOT NULL DEFAULT 0,
  tax_percent   REAL NOT NULL DEFAULT 18,
  notes         TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TEXT,
  decide_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_quotes_request ON quotes (request_id, status);

CREATE TABLE quote_items (
  id             TEXT PRIMARY KEY,
  quote_id       TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('PART','LABOUR','FEE','DISCOUNT')),
  description    TEXT NOT NULL,
  quantity       REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  total_cents    INTEGER NOT NULL DEFAULT 0,
  part_id        TEXT REFERENCES parts(id) ON DELETE SET NULL,
  sort           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_quote_items_quote ON quote_items (quote_id);

CREATE TABLE job_parts (
  id               TEXT PRIMARY KEY,
  job_id           TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  part_id          TEXT REFERENCES parts(id) ON DELETE SET NULL,
  description      TEXT NOT NULL,
  quantity         REAL NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_job_parts_job ON job_parts (job_id);

CREATE TABLE invoices (
  id            TEXT PRIMARY KEY,
  number        TEXT NOT NULL UNIQUE,
  request_id    TEXT NOT NULL REFERENCES emergency_requests(id) ON DELETE CASCADE,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents     INTEGER NOT NULL DEFAULT 0,
  total_cents   INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED','PAID','VOID')),
  pdf_key       TEXT,
  issued_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_invoices_request ON invoices (request_id);

CREATE TABLE payments (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL REFERENCES emergency_requests(id) ON DELETE CASCADE,
  invoice_id    TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  provider      TEXT NOT NULL DEFAULT 'test',
  provider_ref  TEXT,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','AUTHORIZED','PAID','FAILED','REFUNDED')),
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'INR',
  method        TEXT,
  failure_reason TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at       TEXT
);
CREATE INDEX idx_payments_request ON payments (request_id, status);

CREATE TABLE reviews (
  id               TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL REFERENCES emergency_requests(id) ON DELETE CASCADE,
  job_id           TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  reviewer_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction        TEXT NOT NULL CHECK (direction IN ('DRIVER_TO_MECHANIC','MECHANIC_TO_DRIVER')),
  overall          INTEGER NOT NULL CHECK (overall BETWEEN 1 AND 5),
  arrival          INTEGER NOT NULL DEFAULT 5 CHECK (arrival BETWEEN 1 AND 5),
  diagnosis        INTEGER NOT NULL DEFAULT 5 CHECK (diagnosis BETWEEN 1 AND 5),
  pricing          INTEGER NOT NULL DEFAULT 5 CHECK (pricing BETWEEN 1 AND 5),
  professionalism  INTEGER NOT NULL DEFAULT 5 CHECK (professionalism BETWEEN 1 AND 5),
  resolution       INTEGER NOT NULL DEFAULT 5 CHECK (resolution BETWEEN 1 AND 5),
  comment          TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (request_id, reviewer_user_id)
);
CREATE INDEX idx_reviews_reviewee ON reviews (reviewee_user_id, created_at);

CREATE TABLE ratings (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  average     REAL NOT NULL DEFAULT 0,
  count       INTEGER NOT NULL DEFAULT 0,
  sum         INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE disputes (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL REFERENCES emergency_requests(id) ON DELETE CASCADE,
  raised_by     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_REVIEW','RESOLVED','DISMISSED')),
  resolution    TEXT,
  resolved_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_disputes_status ON disputes (status, created_at);
