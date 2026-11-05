-- 0003_promo: which promotion code (if any) a booking used, and how much it took off. Additive and idempotent.
CREATE TABLE IF NOT EXISTS booking_discounts (
  booking_id INTEGER PRIMARY KEY,
  code TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0003_promo');
