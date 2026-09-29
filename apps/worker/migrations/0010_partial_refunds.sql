-- Partial refunds: track how much of a payment has been refunded so a payment
-- can be refunded in instalments without exceeding the paid amount.
ALTER TABLE payments ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0;
