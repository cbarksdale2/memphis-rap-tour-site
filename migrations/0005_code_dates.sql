-- 0005_code_dates: a discount code can be limited to chosen tour dates. No rows for a code = every date.
-- The code itself lives in Stripe (promotion code id); only the date rule lives here. Additive and idempotent.
CREATE TABLE IF NOT EXISTS code_dates (
  promotion_code_id TEXT NOT NULL,
  tour_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (promotion_code_id, tour_id)
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0005_code_dates');
