// MMX DirectTEXT routing portal — Cloudflare Worker entrypoint.
//
//   MMX  --POST-->  /inbound/mo/<key> | /inbound/dr/<key>  -->  routing  -->  customer URL(s)
//
// MMX posts form-encoded MO and DR callbacks. It does NOT include the account in
// the body, so each customer is identified by the secret <key> path segment MMX
// posts to. The router chooses the destination(s) and forwards the payload
// FAITHFULLY (same content-type / body MMX sent) so the customer endpoint sees
// exactly what it would from MMX directly. A cron trigger re-drives failed
// forwards per the customer's retry policy.
//
// Real MMX field names (API Guide v2.5):
//   Sender ID (for routing) = inbound_address   (short code / sender ID)
//   MO body                 = message / message_orig
//   Message id              = message_id
//   Mobile number           = device_address

import { Hono } from 'hono';
import * as R from './routing.js';
import * as RETRY from './retry.js';
import * as DB from './db.js';
import { mountAdmin } from './admin.js';
import { dashboardHtml } from './dashboard.js';

const app = new Hono();

// ---------------------------------------------------------------------------
// Read the inbound body once. Returns the parsed fields (for routing/logging),
// the exact raw body string and the content-type (for faithful forwarding).
// MMX uses application/x-www-form-urlencoded; JSON and query-string are also
// accepted for flexibility and testing.
// ---------------------------------------------------------------------------
async function readBody(c) {
  const contentType = c.req.header('content-type') || '';
  let raw = '';
  try { raw = await c.req.text(); } catch { raw = ''; }

  let parsed = {};
  if (contentType.includes('application/json')) {
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  } else if (contentType.includes('x-www-form-urlencoded')) {
    parsed = Object.fromEntries(new URLSearchParams(raw));
  } else if (raw) {
    try { parsed = JSON.parse(raw); }
    catch { parsed = Object.fromEntries(new URLSearchParams(raw)); }
  }
  // Merge any query-string params (some gateways append them).
  const url = new URL(c.req.url);
  for (const [k, v] of url.searchParams) if (!(k in parsed)) parsed[k] = v;

  return { parsed, raw, contentType: contentType || 'application/x-www-form-urlencoded' };
}

const pick = (o, keys) => {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
    const found = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase());
    if (found && o[found] !== '') return o[found];
  }
  return undefined;
};

// Sender ID is `inbound_address` in real MMX traffic; aliases kept for safety.
const SENDER_KEYS = ['inbound_address', 'sender_id', 'senderId', 'source', 'from', 'sender', 'oadc'];

export function normalizeMo(body) {
  return {
    accountRef: pick(body, ['account', 'account_ref', 'accountId']),
    senderId: pick(body, SENDER_KEYS),
    body: pick(body, ['message', 'message_orig', 'text', 'body', 'content']) || '',
    messageId: pick(body, ['message_id', 'messageId', 'a2w_mo_ref_id', 'id']),
    deviceAddress: pick(body, ['device_address', 'msisdn', 'from_number']),
  };
}

export function normalizeDr(body) {
  return {
    accountRef: pick(body, ['account', 'account_ref', 'accountId']),
    senderId: pick(body, SENDER_KEYS),
    messageId: pick(body, ['message_id', 'messageId', 'smscid', 'id']),
    status: pick(body, ['status', 'status_code', 'dlr_status', 'state']),
  };
}

// ---------------------------------------------------------------------------
// Build the body to forward. Default is a faithful passthrough of exactly what
// MMX sent. Only when the customer opts into a message_id reformat (spec 9.4)
// do we rewrite that one field and re-encode as form-urlencoded.
// ---------------------------------------------------------------------------
function buildForwardBody(customer, parsed, raw, contentType, originalMessageId) {
  const fmt = customer.message_id_format;
  if (fmt && fmt !== 'passthrough') {
    const outId = R.formatMessageId(fmt, originalMessageId, () => crypto.randomUUID());
    const p = { ...parsed, message_id: outId };
    return {
      body: new URLSearchParams(p).toString(),
      contentType: 'application/x-www-form-urlencoded',
      outId,
    };
  }
  return { body: raw, contentType, outId: originalMessageId };
}

// ---------------------------------------------------------------------------
// Forwarder — one HTTP attempt. Any non-2xx / network error / timeout is a
// failure the retry engine re-drives.
// ---------------------------------------------------------------------------
async function attemptForward(destUrl, body, contentType, authHeader, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {
      'content-type': contentType || 'application/x-www-form-urlencoded',
      'user-agent': 'MMX-Router/1.0',
    };
    if (authHeader) headers['authorization'] = authHeader;
    const res = await fetch(destUrl, {
      method: 'POST',
      headers,
      body,
      signal: ctrl.signal,
    });
    return { ok: res.status >= 200 && res.status < 300, statusCode: res.status };
  } catch (e) {
    return { ok: false, statusCode: 0, error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(t);
  }
}

// Run one attempt for a delivery row and record the result / schedule a retry.
async function driveDelivery(env, row) {
  const { ok, statusCode, error } = await attemptForward(row.dest_url, row.payload, row.content_type, row.auth_header);
  const nowSec = Math.floor(Date.now() / 1000);

  if (ok) {
    await DB.markDeliverySuccess(env.DB, row.id, statusCode);
    return 'success';
  }

  let stages = RETRY.DEFAULT_STAGES;
  if (row.retry_policy_id) {
    const p = await env.DB.prepare('SELECT stages FROM retry_policies WHERE id = ?')
      .bind(row.retry_policy_id).first();
    if (p) stages = RETRY.parseStages(p.stages);
  }

  const step = RETRY.nextRetry(stages, row.stage_index, row.stage_attempts, nowSec);
  if (step.done) {
    await DB.markDeliveryFailed(env.DB, row.id, { statusCode, error });
    return 'failed';
  }
  await DB.markDeliveryRetry(env.DB, row.id, {
    stageIndex: step.stageIndex,
    stageAttempts: step.stageAttempts,
    nextAttemptAt: RETRY.toSqlTime(step.nextAttemptSec),
    statusCode,
    error,
  });
  return 'retry';
}

// ---------------------------------------------------------------------------
// MO handler (shared by keyed and legacy routes).
// ---------------------------------------------------------------------------
async function handleMo(c, customer) {
  const { parsed, raw, contentType } = await readBody(c);
  const mo = normalizeMo(parsed);
  const keyword = R.firstWord(mo.body);

  if (!customer && mo.accountRef) customer = await DB.getCustomerByAccount(c.env.DB, mo.accountRef);

  const inboundId = await DB.logInbound(c.env.DB, {
    type: 'MO', accountRef: customer ? customer.account_ref : mo.accountRef,
    senderId: mo.senderId, keyword, messageId: mo.messageId, raw: parsed, matchedCount: 0,
  });

  if (!customer) return c.json({ ok: false, error: 'unknown_customer' }, 202);

  const rules = await DB.getMoRoutes(c.env.DB, customer.id);
  const route = R.selectMoRoute(rules, { senderId: mo.senderId, body: mo.body });
  if (!route) return c.json({ ok: true, routed: 0, note: 'no matching MO route' }, 200);

  const fwd = buildForwardBody(customer, parsed, raw, contentType, mo.messageId);
  const policy = await DB.resolveRetryPolicy(c.env.DB, customer.id, mo.senderId, route.retry_policy_id);
  const authHeader = R.computeAuthHeader(route.auth_type, route.auth_username, route.auth_secret);

  const deliveryId = await DB.createDelivery(c.env.DB, {
    inboundId, direction: 'MO', customerId: customer.id, routeId: route.id,
    destUrl: route.dest_url, messageId: fwd.outId, payload: fwd.body, contentType: fwd.contentType,
    authHeader, retryPolicyId: policy ? policy.id : null,
  });
  await DB.updateInboundMatched(c.env.DB, inboundId, 1);

  const row = await c.env.DB.prepare('SELECT * FROM deliveries WHERE id = ?').bind(deliveryId).first();
  c.executionCtx.waitUntil(driveDelivery(c.env, row));

  return c.json({ ok: true, routed: 1, dest: route.dest_url, delivery_id: deliveryId });
}

// ---------------------------------------------------------------------------
// DR handler (fan-out).
// ---------------------------------------------------------------------------
async function handleDr(c, customer) {
  const { parsed, raw, contentType } = await readBody(c);
  const dr = normalizeDr(parsed);

  if (!customer && dr.accountRef) customer = await DB.getCustomerByAccount(c.env.DB, dr.accountRef);

  const inboundId = await DB.logInbound(c.env.DB, {
    type: 'DR', accountRef: customer ? customer.account_ref : dr.accountRef,
    senderId: dr.senderId, keyword: null, messageId: dr.messageId, raw: parsed, matchedCount: 0,
  });

  if (!customer) return c.json({ ok: false, error: 'unknown_customer' }, 202);

  const rules = await DB.getDrRoutes(c.env.DB, customer.id);
  const routes = R.selectDrRoutes(rules, { senderId: dr.senderId });
  if (routes.length === 0) return c.json({ ok: true, routed: 0, note: 'no matching DR route' }, 200);

  const fwd = buildForwardBody(customer, parsed, raw, contentType, dr.messageId);
  const ids = [];
  for (const route of routes) {
    const policy = await DB.resolveRetryPolicy(c.env.DB, customer.id, dr.senderId, route.retry_policy_id);
    const authHeader = R.computeAuthHeader(route.auth_type, route.auth_username, route.auth_secret);
    const deliveryId = await DB.createDelivery(c.env.DB, {
      inboundId, direction: 'DR', customerId: customer.id, routeId: route.id,
      destUrl: route.dest_url, messageId: fwd.outId, payload: fwd.body, contentType: fwd.contentType,
      authHeader, retryPolicyId: policy ? policy.id : null,
    });
    ids.push(deliveryId);
    const row = await c.env.DB.prepare('SELECT * FROM deliveries WHERE id = ?').bind(deliveryId).first();
    c.executionCtx.waitUntil(driveDelivery(c.env, row));
  }
  await DB.updateInboundMatched(c.env.DB, inboundId, routes.length);

  return c.json({ ok: true, routed: routes.length, delivery_ids: ids });
}

// ---- Inbound routes --------------------------------------------------------
// Primary (live MMX): customer resolved by the secret path key.
app.post('/inbound/mo/:key', async (c) => handleMo(c, await DB.getCustomerByKey(c.env.DB, c.req.param('key'))));
app.post('/inbound/dr/:key', async (c) => handleDr(c, await DB.getCustomerByKey(c.env.DB, c.req.param('key'))));
// Legacy/testing: customer resolved by an `account` field in the body.
app.post('/inbound/mo', async (c) => handleMo(c, null));
app.post('/inbound/dr', async (c) => handleDr(c, null));

// GET on the callback URLs is a health check only — MMX delivers via POST.
// Opening the URL in a browser (a GET) confirms the endpoint is live and the
// key is valid, instead of showing a bare 404 that looks broken.
async function inboundHealth(c, kind) {
  const customer = await DB.getCustomerByKey(c.env.DB, c.req.param('key'));
  if (!customer) {
    return c.json({ service: 'mmx-sms-router', endpoint: kind, status: 'unknown_key',
      message: 'This callback URL is live but the key is not recognised. Check the URL against the dashboard.' }, 404);
  }
  return c.json({ service: 'mmx-sms-router', endpoint: kind, status: 'ready',
    customer: customer.name,
    message: `This ${kind.toUpperCase()} callback endpoint is live and ready. MMX should deliver ${kind.toUpperCase()} callbacks here via HTTP POST.` });
}
app.get('/inbound/mo/:key', (c) => inboundHealth(c, 'mo'));
app.get('/inbound/dr/:key', (c) => inboundHealth(c, 'dr'));

// Health check.
app.get('/', (c) => c.json({ service: 'mmx-sms-router', status: 'ok' }));

// Admin dashboard + JSON API.
app.get('/dashboard', (c) => c.html(dashboardHtml()));
mountAdmin(app);

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    const due = await DB.getDueDeliveries(env.DB, 100);
    for (const row of due) await driveDelivery(env, row);
  },
};

export { attemptForward, driveDelivery, buildForwardBody };
