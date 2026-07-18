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
