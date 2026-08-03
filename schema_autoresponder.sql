-- MMX SMS Router — auto-responder / compliance add-on schema.
--
-- Adds HELP/STOP/START auto-reply support (carrier certification requirement):
--   * auto_responses  — per-customer keyword rules that trigger an outbound reply
--                       and/or opt-out bookkeeping.
--   * opt_outs        — numbers that texted STOP; kept so downstream sends can be
--                       suppressed and so the opt-out state is auditable.
--   * outbound_messages — log of every MT (reply) we send back through MMX.
--
-- The MT send uses MMX's send API (API Guide v2.5 §2): POST form-urlencoded
-- reply_to / recipient / body to https://dtxt.na.kaleyra.ai/a2w_preRouter/httpApiRouter
-- with Basic Auth. Credentials are a global encrypted secret (MMX_SEND_USER /
-- MMX_SEND_PASS) with an optional per-customer override in the columns below.

PRAGMA foreign_keys = ON;

-- Per-customer MMX send credentials (optional override of the global secret).
ALTER TABLE customers ADD COLUMN send_username TEXT;
ALTER TABLE customers ADD COLUMN send_secret   TEXT;

-- ---------------------------------------------------------------------------
-- Auto-response rules. action is one of:
--   'reply'  — just send reply_body (e.g. HELP)
--   'optout' — add the sender to opt_outs, then send reply_body (e.g. STOP)
--   'optin'  — remove the sender from opt_outs, then send reply_body (e.g. START)
-- keyword_match mirrors mo_routes: 'first_word' (default) | 'exact' | 'contains'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auto_responses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  match_keyword TEXT NOT NULL,
  keyword_match TEXT NOT NULL DEFAULT 'first_word',
  action        TEXT NOT NULL DEFAULT 'reply',   -- 'reply' | 'optout' | 'optin'
  reply_body    TEXT,                             -- text sent back (NULL = no reply, bookkeeping only)
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ar_cust ON auto_responses(customer_id, enabled);

-- ---------------------------------------------------------------------------
-- Opt-out list. A NULL sender_id means opted out across all of the customer's
-- sender IDs. Uniqueness prevents duplicate rows for the same number+sender.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opt_outs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id    INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  device_address TEXT NOT NULL,                   -- the mobile number that opted out
  sender_id      TEXT,                            -- NULL = all senders
  keyword        TEXT,                            -- the keyword that triggered it
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_optout_uniq
  ON opt_outs(customer_id, device_address, IFNULL(sender_id,''));

-- ---------------------------------------------------------------------------
-- Outbound (MT) send log — every auto-reply we push back to MMX.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbound_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id     INTEGER,
  inbound_id      INTEGER,                        -- the MO that triggered this reply
  keyword         TEXT,
  action          TEXT,
  reply_to        TEXT,                           -- sender ID the reply is sent over
  recipient       TEXT,                           -- mobile number we reply to
  body            TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',-- sent | failed | skipped
  http_status     INTEGER,
  mmx_code        TEXT,                           -- MMX response <code> (100 = success)
  mmx_message_id  TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outbound_cust ON outbound_messages(customer_id, created_at);
