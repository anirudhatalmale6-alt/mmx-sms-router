-- MMX DirectTEXT routing portal — database schema (Cloudflare D1 / SQLite)
--
-- Design notes:
--   * One inbound endpoint receives every MO and DR from MMX.
--   * MO routing picks the most specific matching rule (Sender ID + Keyword
--     beats Keyword beats Sender ID beats a catch-all default).
--   * DR routing fans out: a single receipt can match many rules and is
--     forwarded to every matching URL.
--   * Every forward attempt is recorded in `deliveries`; the scheduled
--     retry worker re-drives rows whose status is 'pending' and whose
--     next_attempt_at is due, following the customer's retry policy.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Customers (an MMX account, e.g. 19871-115)
-- ---------------------------------------------------------------------------
-- MMX does not put the account in the callback body; it identifies the
-- customer by which registered URL it posts to. So each customer gets a unique
-- inbound_key and hands MMX the URLs /inbound/mo/<key> and /inbound/dr/<key>.
CREATE TABLE IF NOT EXISTS customers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_ref       TEXT NOT NULL UNIQUE,          -- MMX account reference (label)
  inbound_key       TEXT NOT NULL UNIQUE,          -- secret path segment for callbacks
  name              TEXT NOT NULL,
  -- message_id format applied when forwarding (spec 9.4):
  --   'uuid'  = 128-bit UUID (default), 'num12' = numeric up to 12 digits,
  --   'num19' = numeric up to 19 digits, 'passthrough' = leave as received
  message_id_format TEXT NOT NULL DEFAULT 'passthrough',
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Retry policies (spec 9.5). stages is a JSON array of
--   [{ "retryDelay": 10, "retryDuration": 100 }, ...]
-- A NULL sender_id makes the policy the customer default; a set sender_id
-- overrides retries for that specific Sender ID.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS retry_policies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  sender_id    TEXT,                               -- NULL = customer default
  stages       TEXT NOT NULL DEFAULT '[{"retryDelay":60,"retryDuration":172800}]',
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_retry_cust ON retry_policies(customer_id, sender_id);

-- ---------------------------------------------------------------------------
-- MO routing rules (spec 9.2). match_sender_id / match_keyword may each be
-- NULL. specificity is derived and stored so the router can ORDER BY it:
--   3 = sender+keyword, 2 = keyword only, 1 = sender only, 0 = default.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mo_routes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  match_sender_id   TEXT,
  match_keyword     TEXT,
  -- how match_keyword is tested against the message body:
  --   'first_word' (default SMS shortcode convention), 'contains', 'exact'
  keyword_match     TEXT NOT NULL DEFAULT 'first_word',
  dest_url          TEXT NOT NULL,
  specificity       INTEGER NOT NULL DEFAULT 0,
  priority          INTEGER NOT NULL DEFAULT 0,    -- tie-breaker, higher wins
  retry_policy_id   INTEGER REFERENCES retry_policies(id) ON DELETE SET NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mo_cust ON mo_routes(customer_id, enabled);
CREATE INDEX IF NOT EXISTS idx_mo_sender ON mo_routes(match_sender_id);

-- ---------------------------------------------------------------------------
-- DR routing rules (spec 9.3). Fan-out: every enabled rule for the account
-- whose (optional) sender_id matches receives the receipt.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dr_routes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  match_sender_id   TEXT,                          -- NULL = all sender IDs
  dest_url          TEXT NOT NULL,
  retry_policy_id   INTEGER REFERENCES retry_policies(id) ON DELETE SET NULL,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dr_cust ON dr_routes(customer_id, enabled);

-- ---------------------------------------------------------------------------
-- Raw inbound log — every MO/DR MMX posts to us, before routing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inbound_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,                     -- 'MO' | 'DR'
  account_ref   TEXT,
  sender_id     TEXT,
  keyword       TEXT,
  message_id    TEXT,
  raw           TEXT NOT NULL,                     -- JSON of the received body
  matched_count INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inbound_created ON inbound_events(created_at);

-- ---------------------------------------------------------------------------
-- Delivery log / retry queue — one row per (inbound event -> destination).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deliveries (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  inbound_id        INTEGER REFERENCES inbound_events(id) ON DELETE SET NULL,
  direction         TEXT NOT NULL,                 -- 'MO' | 'DR'
  customer_id       INTEGER,
  route_id          INTEGER,
  dest_url          TEXT NOT NULL,
  message_id        TEXT,
  payload           TEXT NOT NULL,                 -- exact body string we forward
  content_type      TEXT NOT NULL DEFAULT 'application/x-www-form-urlencoded',
  status            TEXT NOT NULL DEFAULT 'pending', -- pending|success|failed
  attempts          INTEGER NOT NULL DEFAULT 0,
  stage_index       INTEGER NOT NULL DEFAULT 0,    -- current retry stage
  stage_attempts    INTEGER NOT NULL DEFAULT 0,    -- attempts within stage
  retry_policy_id   INTEGER,
  next_attempt_at   TEXT,                          -- datetime; NULL when done
  first_attempt_at  TEXT,
  last_status_code  INTEGER,
  last_error        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deliv_due ON deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_deliv_cust ON deliveries(customer_id, created_at);
