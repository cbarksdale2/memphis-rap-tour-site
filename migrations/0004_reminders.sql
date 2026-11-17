-- 0004_reminders: one row per booking per reminder (24h, 1h). The row is claimed (INSERT, or a retry of a
-- 'failed' row) in one statement before the email goes out, so overlapping cron runs can never both send.
-- Additive and idempotent.
CREATE TABLE IF NOT EXISTS reminder_sends (
  booking_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('24h','1h')),
  state TEXT NOT NULL CHECK (state IN ('sending','sent','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '',
  claimed_at INTEGER NOT NULL,
  done_at INTEGER,
  PRIMARY KEY (booking_id, kind)
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0004_reminders');
