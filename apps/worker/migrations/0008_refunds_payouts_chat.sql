-- Payment refunds: audit columns on payments.
ALTER TABLE payments ADD COLUMN refunded_at TEXT;
ALTER TABLE payments ADD COLUMN refund_reason TEXT;

-- Mechanic payouts + payout account (KYC-lite for withdrawals).
ALTER TABLE mechanics ADD COLUMN bank_account_json TEXT;

CREATE TABLE payout_requests (
  id               TEXT PRIMARY KEY,
  mechanic_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','REJECTED')),
  account_json     TEXT NOT NULL,
  note             TEXT,
  decided_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_payout_requests_mechanic ON payout_requests (mechanic_user_id, status);
CREATE INDEX idx_payout_requests_status ON payout_requests (status, created_at);

-- Driver <-> mechanic chat for an active request.
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  request_id      TEXT NOT NULL REFERENCES emergency_requests(id) ON DELETE CASCADE,
  sender_user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at         TEXT
);
CREATE INDEX idx_messages_request ON messages (request_id, created_at);
