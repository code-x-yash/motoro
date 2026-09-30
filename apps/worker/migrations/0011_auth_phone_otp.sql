-- Phone OTP verification for signup and password reset.
-- (users.phone_verified_at already exists via 0001_core.)

-- Normalize legacy phone numbers to E.164 before the unique index lands.
UPDATE users SET phone = '+91' || phone
  WHERE phone IS NOT NULL AND length(phone) = 10 AND phone NOT LIKE '+%';
UPDATE users SET phone = '+91' || substr(phone, 2)
  WHERE phone IS NOT NULL AND length(phone) = 11 AND phone LIKE '0%';
UPDATE users SET phone = '+' || phone
  WHERE phone IS NOT NULL AND phone NOT LIKE '+%' AND length(phone) > 10;

-- One account per phone per role: the same number may hold a DRIVER and a
-- MECHANIC account, but never two of the same role. This replaces the old
-- phone-global unique index from 0001_core.
DROP INDEX IF EXISTS idx_users_phone;
CREATE UNIQUE INDEX users_phone_role_unique
  ON users(phone, role)
  WHERE phone IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE auth_otps (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('SIGNUP', 'RESET')),
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  meta_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX auth_otps_target_idx ON auth_otps(phone, purpose, created_at);
