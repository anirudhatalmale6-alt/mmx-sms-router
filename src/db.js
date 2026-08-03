// Thin D1 query helpers. Keeping SQL in one place makes the routing/forwarding
// code read clearly and keeps the schema knowledge local.

export async function getCustomerByAccount(db, accountRef) {
  return db.prepare('SELECT * FROM customers WHERE account_ref = ? AND enabled = 1')
    .bind(accountRef).first();
}

// Primary lookup for live MMX traffic: the customer is identified by the secret
// path segment MMX posts to, since the callback body carries no account field.
export async function getCustomerByKey(db, key) {
  return db.prepare('SELECT * FROM customers WHERE inbound_key = ? AND enabled = 1')
    .bind(key).first();
}

export async function getCustomerById(db, id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
}

export async function getMoRoutes(db, customerId) {
  const { results } = await db
    .prepare('SELECT * FROM mo_routes WHERE customer_id = ? AND enabled = 1')
    .bind(customerId).all();
  return results || [];
}

export async function getDrRoutes(db, customerId) {
  const { results } = await db
    .prepare('SELECT * FROM dr_routes WHERE customer_id = ? AND enabled = 1')
    .bind(customerId).all();
  return results || [];
}

/**
 * Resolve which retry policy governs a delivery. Precedence:
 *   1. policy explicitly attached to the matched route
 *   2. a per-Sender-ID policy for the customer (spec 9.5 per-sender override)
 *   3. the customer's default policy (sender_id IS NULL)
 * Returns the policy row or null (caller then uses DEFAULT_STAGES).
 */
export async function resolveRetryPolicy(db, customerId, senderId, explicitPolicyId) {
  if (explicitPolicyId) {
    const p = await db.prepare('SELECT * FROM retry_policies WHERE id = ? AND enabled = 1')
      .bind(explicitPolicyId).first();
    if (p) return p;
  }
  if (senderId) {
    const p = await db
      .prepare('SELECT * FROM retry_policies WHERE customer_id = ? AND sender_id = ? AND enabled = 1')
      .bind(customerId, String(senderId)).first();
    if (p) return p;
  }
  return db
    .prepare('SELECT * FROM retry_policies WHERE customer_id = ? AND sender_id IS NULL AND enabled = 1 ORDER BY id LIMIT 1')
    .bind(customerId).first();
}

export async function logInbound(db, { type, accountRef, senderId, keyword, messageId, raw, matchedCount }) {
  const res = await db
    .prepare(`INSERT INTO inbound_events (type, account_ref, sender_id, keyword, message_id, raw, matched_count)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(type, accountRef ?? null, senderId ?? null, keyword ?? null, messageId ?? null,
          JSON.stringify(raw ?? {}), matchedCount ?? 0)
    .run();
  return res.meta.last_row_id;
}

export async function updateInboundMatched(db, inboundId, matchedCount) {
  await db.prepare('UPDATE inbound_events SET matched_count = ? WHERE id = ?')
    .bind(matchedCount, inboundId).run();
}

export async function createDelivery(db, d) {
  const res = await db.prepare(
    `INSERT INTO deliveries
      (inbound_id, direction, customer_id, route_id, dest_url, message_id, payload, content_type, auth_header,
       status, attempts, stage_index, stage_attempts, retry_policy_id,
       next_attempt_at, first_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, 0, ?, NULL, NULL, datetime('now'), datetime('now'))`
  ).bind(d.inboundId ?? null, d.direction, d.customerId ?? null, d.routeId ?? null,
         d.destUrl, d.messageId ?? null, d.payload, d.contentType || 'application/x-www-form-urlencoded',
         d.authHeader ?? null, d.retryPolicyId ?? null)
   .run();
  return res.meta.last_row_id;
}

/** Rows that are pending and due for an attempt (or have never been tried). */
export async function getDueDeliveries(db, limit = 50) {
  const { results } = await db.prepare(
    `SELECT * FROM deliveries
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
      ORDER BY id LIMIT ?`
  ).bind(limit).all();
  return results || [];
}

export async function markDeliverySuccess(db, id, statusCode) {
  await db.prepare(
    `UPDATE deliveries
        SET status='success', attempts=attempts+1, last_status_code=?, last_error=NULL,
            next_attempt_at=NULL, updated_at=datetime('now'),
            first_attempt_at=COALESCE(first_attempt_at, datetime('now'))
      WHERE id=?`
  ).bind(statusCode, id).run();
}

export async function markDeliveryRetry(db, id, { stageIndex, stageAttempts, nextAttemptAt, statusCode, error }) {
  await db.prepare(
    `UPDATE deliveries
        SET status='pending', attempts=attempts+1, stage_index=?, stage_attempts=?,
            next_attempt_at=?, last_status_code=?, last_error=?, updated_at=datetime('now'),
            first_attempt_at=COALESCE(first_attempt_at, datetime('now'))
      WHERE id=?`
  ).bind(stageIndex, stageAttempts, nextAttemptAt, statusCode ?? null, error ?? null, id).run();
}

export async function markDeliveryFailed(db, id, { statusCode, error }) {
  await db.prepare(
    `UPDATE deliveries
        SET status='failed', attempts=attempts+1, last_status_code=?, last_error=?,
            next_attempt_at=NULL, updated_at=datetime('now'),
            first_attempt_at=COALESCE(first_attempt_at, datetime('now'))
      WHERE id=?`
  ).bind(statusCode ?? null, error ?? null, id).run();
}

// ---------------------------------------------------------------------------
// Auto-responder (HELP/STOP/START) — rules, opt-out list, outbound send log.
// ---------------------------------------------------------------------------

export async function getAutoResponses(db, customerId) {
  const { results } = await db
    .prepare('SELECT * FROM auto_responses WHERE customer_id = ? AND enabled = 1')
    .bind(customerId).all();
  return results || [];
}

// Add a number to the opt-out list (idempotent via the unique index).
export async function addOptOut(db, customerId, deviceAddress, senderId, keyword) {
  await db.prepare(
    `INSERT OR IGNORE INTO opt_outs (customer_id, device_address, sender_id, keyword)
     VALUES (?, ?, ?, ?)`
  ).bind(customerId, deviceAddress, senderId ?? null, keyword ?? null).run();
}

// Remove a number from the opt-out list (opt back in). Clears both the
// sender-scoped row and any all-senders row for that number.
export async function removeOptOut(db, customerId, deviceAddress, senderId) {
  await db.prepare(
    `DELETE FROM opt_outs
      WHERE customer_id = ? AND device_address = ?
        AND (sender_id = ? OR sender_id IS NULL OR ? IS NULL)`
  ).bind(customerId, deviceAddress, senderId ?? null, senderId ?? null).run();
}

// Is this number opted out for the given sender (or across all senders)?
export async function isOptedOut(db, customerId, deviceAddress, senderId) {
  const row = await db.prepare(
    `SELECT 1 FROM opt_outs
      WHERE customer_id = ? AND device_address = ?
        AND (sender_id IS NULL OR sender_id = ?) LIMIT 1`
  ).bind(customerId, deviceAddress, senderId ?? null).first();
  return !!row;
}

export async function logOutbound(db, o) {
  const res = await db.prepare(
    `INSERT INTO outbound_messages
      (customer_id, inbound_id, keyword, action, reply_to, recipient, body,
       status, http_status, mmx_code, mmx_message_id, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(o.customerId ?? null, o.inboundId ?? null, o.keyword ?? null, o.action ?? null,
         o.replyTo ?? null, o.recipient ?? null, o.body ?? null,
         o.status ?? 'pending', o.httpStatus ?? null, o.mmxCode ?? null,
         o.mmxMessageId ?? null, o.error ?? null).run();
  return res.meta.last_row_id;
}
