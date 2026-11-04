-- 0001_init: everything the site and admin need. Additive and idempotent only.
CREATE TABLE IF NOT EXISTS schema_version (
  migration TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Admin users. Passwords: pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('owner','editor')),
  pw_hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 1,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Sessions: id is the SHA-256 of the cookie token, so a database read cannot be replayed as a cookie.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- One-time recovery codes (SHA-256 of the code), shown once to their owner.
CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id INTEGER NOT NULL,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS recovery_user ON recovery_codes(user_id);

-- Who changed what, and when.
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

-- Visits and Book clicks per day and page. No cookies, no IPs.
CREATE TABLE IF NOT EXISTS counts (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path, kind)
);

-- Failed logins and sign-ups per hashed key (IP, or IP + account), for rate limits.
CREATE TABLE IF NOT EXISTS attempts (
  kind TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attempts_lookup ON attempts(kind, ip_hash, at);

-- Small key/value settings: draft_version and published_version pointers.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Every save of the site content, as one JSON document. Restore = publish an old one again.
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  user_id INTEGER,
  kind TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL
);

-- Photos. storage is 'kv:<key>' (uploaded) or 'asset:<path>' (shipped with the site).
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  storage TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  alt TEXT NOT NULL CHECK (length(trim(alt)) > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- Email list. No emails are sent from this site yet.
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  consent_text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  unsubscribed_at INTEGER
);

-- Private / group tour requests from the form on /private-tours. Nothing is emailed.
CREATE TABLE IF NOT EXISTS tour_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  date_wanted TEXT NOT NULL DEFAULT '',
  group_size TEXT NOT NULL DEFAULT '',
  occasion TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  handled_at INTEGER,
  handled_by INTEGER,
  email_status TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0001_init');
