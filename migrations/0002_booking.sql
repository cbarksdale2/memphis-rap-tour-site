-- 0002_booking: our own booking tool (tour dates, seats, bookings, Stripe events) and password-reset
-- links. Additive and idempotent only.

-- One row per tour departure. starts_at is a Unix time; times are shown in Memphis (America/Chicago).
CREATE TABLE IF NOT EXISTS tours (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  starts_at INTEGER NOT NULL UNIQUE,
  capacity INTEGER NOT NULL DEFAULT 30 CHECK (capacity >= 0),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at INTEGER NOT NULL
);

-- Every seat sold anywhere: this site (held → paid), or an outside seller (Viator, Eventnoire, Airbnb…).
-- One shared seat count: seats left = capacity − paid − live holds.
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tour_id INTEGER NOT NULL,
  ref TEXT NOT NULL UNIQUE,
  manage_hash TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  seats INTEGER NOT NULL CHECK (seats > 0),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  source TEXT NOT NULL DEFAULT 'site',
  status TEXT NOT NULL CHECK (status IN ('held','paid','expired','cancelled','refunded')),
  hold_expires_at INTEGER,
  stripe_session_id TEXT UNIQUE,
  stripe_payment_intent TEXT,
  email_status TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  cancelled_at INTEGER,
  checked_in_at INTEGER
);
CREATE INDEX IF NOT EXISTS bookings_tour ON bookings(tour_id, status);

-- Stripe webhook events already handled, so a repeated event changes nothing.
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL
);

-- Forgot-password links (SHA-256 of the token), single use, 30 minutes.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0002_booking');
