// MMX DirectTEXT routing portal — Cloudflare Worker entrypoint.
//
//   MMX  --POST-->  /inbound/mo | /inbound/dr  -->  routing  -->  customer URL(s)
//
// A single Worker receives every MO and DR, chooses the destination(s), forwards
// immediately, and records the attempt. A cron trigger re-drives failed
// forwards per the customer's retry policy.

import { Hono } from 'hono';
import * as R from './routing.js';
import * as RETRY from './retry.js';
import * as DB from './db.js';
import { mountAdmin } from './admin.js';
import { dashboardHtml } from './dashboard.js';

const app = new Hono();

// ---------------------------------------------------------------------------
// Inbound payload normalisation.
// MMX's exact field names are confirmed with their provisioning team; we accept
// the common aliases so the endpoint works regardless of casing/naming, and the
// raw body is always logged so nothing is lost.
// ---------------------------------------------------------------------------
async function readBody(c) {
  const ct = c.req.header('content-type') || '';
  try {
    if (ct.includes('application/json')) return await c.req.json();
    if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
      const form = await c.req.parseBody();
      return { ...form };
    }
    // Fall back to query string (some gateways GET the callback).
    const url = new URL(c.req.url);
    const q = {};
    for (const [k, v] of url.searchParams) q[k] = v;
    if (Object.keys(q).length) return q;
    const text = await c.req.text();
    try { return JSON.parse(text); } catch { return { _raw: text }; }
  } catch {
    return {};
  }
}

const pick = (o, keys) => {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
    // case-insensitive fallback
    const found = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase());
    if (found && o[found] !== '') return o[found];
  }
  return undefined;
};

function normalizeMo(body) {
  return {
    accountRef: pick(body, ['account', 'account_ref', 'accountId', 'account_id']),
    senderId: pick(body, ['sender_id', 'senderId', 'source', 'from', 'sender', 'oadc', 'sourceaddr']),
    body: pick(body, ['message', 'text', 'body', 'msg', 'content', 'message_text']) || '',
    messageId: pick(body, ['message_id', 'messageId', 'id', 'msgid', 'mid']),
  };
}

function normalizeDr(body) {
  return {
    accountRef: pick(body, ['account', 'account_ref', 'accountId', 'account_id']),
    senderId: pick(body, ['sender_id', 'senderId', 'source', 'from', 'sender', 'oadc']),
    messageId: pick(body, ['message_id', 'messageId', 'id', 'msgid', 'mid']),
    status: pick(body, ['status', 'dlr', 'dlr_status', 'delivery_status', 'state']),
  };
}

// ---------------------------------------------------------------------------
// Forwarder — one HTTP attempt to a destination URL.
// Returns { ok, statusCode, error }. Any non-2xx (or network error / timeout)
// is a failure that the retry engine will re-drive.
// ---------------------------------------------------------------------------
async function attemptForward(destUrl, payload, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(destUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'MMX-Router/1.0' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    return { ok: res.status >= 200 && res.status < 300, statusCode: res.status };
  } catch (e) {
    return { ok: false, statusCode: 0, error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(t);
  }
}

// Run the first attempt for a freshly created delivery row and record result.
async function driveDelivery(env, deliveryRow) {
  const payload = JSON.parse(deliveryRow.payload);
  const { ok, statusCode, error } = await attemptForward(deliveryRow.dest_url, payload);
  const nowSec = Math.floor(Date.now() / 1000);

  if (ok) {
    await DB.markDeliverySuccess(env.DB, deliveryRow.id, statusCode);
    return 'success';
  }

  // Load the governing retry policy's stages.
  let stages = RETRY.DEFAULT_STAGES;
  if (deliveryRow.retry_policy_id) {
    const p = await env.DB.prepare('SELECT stages FROM retry_policies WHERE id = ?')
      .bind(deliveryRow.retry_policy_id).first();
    if (p) stages = RETRY.parseStages(p.stages);
  }

  const step = RETRY.nextRetry(stages, deliveryRow.stage_index, deliveryRow.stage_attempts, nowSec);
  if (step.done) {
    await DB.markDeliveryFailed(env.DB, deliveryRow.id, { statusCode, error });
    return 'failed';
  }
  await DB.markDeliveryRetry(env.DB, deliveryRow.id, {
    stageIndex: step.stageIndex,
    stageAttempts: step.stageAttempts,
    nextAttemptAt: RETRY.toSqlTime(step.nextAttemptSec),
    statusCode,
    error,
  });
  return 'retry';
}

// ---------------------------------------------------------------------------
// Inbound: MO
// ---------------------------------------------------------------------------
app.post('/inbound/mo', async (c) => {
  const body = await readBody(c);
  const mo = normalizeMo(body);
  const keyword = R.firstWord(mo.body);

  const customer = mo.accountRef ? await DB.getCustomerByAccount(c.env.DB, mo.accountRef) : null;
  const inboundId = await DB.logInbound(c.env.DB, {
    type: 'MO', accountRef: mo.accountRef, senderId: mo.senderId,
    keyword, messageId: mo.messageId, raw: body, matchedCount: 0,
  });

  if (!customer) {
    return c.json({ ok: false, error: 'unknown_account', account: mo.accountRef ?? null }, 202);
  }

  const rules = await DB.getMoRoutes(c.env.DB, customer.id);
  const route = R.selectMoRoute(rules, { senderId: mo.senderId, body: mo.body });
  if (!route) {
    return c.json({ ok: true, routed: 0, note: 'no matching MO route' }, 200);
  }

  const outId = R.formatMessageId(customer.message_id_format, mo.messageId, () => crypto.randomUUID());
  const payload = { ...body, message_id: outId, _mmx_router: { type: 'MO', matched_route: route.id } };
  const policy = await DB.resolveRetryPolicy(c.env.DB, customer.id, mo.senderId, route.retry_policy_id);

  const deliveryId = await DB.createDelivery(c.env.DB, {
    inboundId, direction: 'MO', customerId: customer.id, routeId: route.id,
    destUrl: route.dest_url, messageId: outId, payload, retryPolicyId: policy ? policy.id : null,
  });
  await DB.updateInboundMatched(c.env.DB, inboundId, 1);

  // Forward immediately; retries (if needed) happen on the cron tick.
  const row = await c.env.DB.prepare('SELECT * FROM deliveries WHERE id = ?').bind(deliveryId).first();
  c.executionCtx.waitUntil(driveDelivery(c.env, row));

  return c.json({ ok: true, routed: 1, dest: route.dest_url, delivery_id: deliveryId, message_id: outId });
});

// ---------------------------------------------------------------------------
// Inbound: DR (fan-out)
// ---------------------------------------------------------------------------
app.post('/inbound/dr', async (c) => {
  const body = await readBody(c);
  const dr = normalizeDr(body);

  const customer = dr.accountRef ? await DB.getCustomerByAccount(c.env.DB, dr.accountRef) : null;
  const inboundId = await DB.logInbound(c.env.DB, {
    type: 'DR', accountRef: dr.accountRef, senderId: dr.senderId,
    keyword: null, messageId: dr.messageId, raw: body, matchedCount: 0,
  });

  if (!customer) {
    return c.json({ ok: false, error: 'unknown_account', account: dr.accountRef ?? null }, 202);
  }

  const rules = await DB.getDrRoutes(c.env.DB, customer.id);
  const routes = R.selectDrRoutes(rules, { senderId: dr.senderId });
  if (routes.length === 0) {
    return c.json({ ok: true, routed: 0, note: 'no matching DR route' }, 200);
  }

  const outId = R.formatMessageId(customer.message_id_format, dr.messageId, () => crypto.randomUUID());
  const ids = [];
  for (const route of routes) {
    const payload = { ...body, message_id: outId, _mmx_router: { type: 'DR', matched_route: route.id } };
    const policy = await DB.resolveRetryPolicy(c.env.DB, customer.id, dr.senderId, route.retry_policy_id);
    const deliveryId = await DB.createDelivery(c.env.DB, {
      inboundId, direction: 'DR', customerId: customer.id, routeId: route.id,
      destUrl: route.dest_url, messageId: outId, payload, retryPolicyId: policy ? policy.id : null,
    });
    ids.push(deliveryId);
    const row = await c.env.DB.prepare('SELECT * FROM deliveries WHERE id = ?').bind(deliveryId).first();
    c.executionCtx.waitUntil(driveDelivery(c.env, row));
  }
  await DB.updateInboundMatched(c.env.DB, inboundId, routes.length);

  return c.json({ ok: true, routed: routes.length, delivery_ids: ids, message_id: outId });
});

// Health check.
app.get('/', (c) => c.json({ service: 'mmx-sms-router', status: 'ok' }));

// Admin dashboard (static HTML shell; talks to /admin API with the token).
app.get('/dashboard', (c) => c.html(dashboardHtml()));

// Admin JSON API (customers, routes, policies, logs).
mountAdmin(app);

// ---------------------------------------------------------------------------
// Worker export: fetch handler + scheduled retry handler.
// ---------------------------------------------------------------------------
export default {
  fetch: app.fetch,

  // Cron: re-drive every due pending delivery.
  async scheduled(event, env, ctx) {
    const due = await DB.getDueDeliveries(env.DB, 100);
    for (const row of due) {
      await driveDelivery(env, row);
    }
  },
};

// Exported for tests.
export { attemptForward, driveDelivery, normalizeMo, normalizeDr };
