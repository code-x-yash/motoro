-- Coupons: driver-facing discounts applied at payment time.
CREATE TABLE coupons (
  id               TEXT PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  description      TEXT,
  percent_off      INTEGER NOT NULL CHECK (percent_off >= 1 AND percent_off <= 100),
  min_amount_cents INTEGER NOT NULL DEFAULT 0,
  max_uses         INTEGER,
  used_count       INTEGER NOT NULL DEFAULT 0,
  valid_from       TEXT,
  valid_until      TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_coupons_active ON coupons (active, valid_until);

-- The applied coupon is recorded on the request, each payment attempt, and the invoice.
ALTER TABLE emergency_requests ADD COLUMN coupon_code TEXT;
ALTER TABLE emergency_requests ADD COLUMN coupon_discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN coupon_code TEXT;
ALTER TABLE payments ADD COLUMN coupon_discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
