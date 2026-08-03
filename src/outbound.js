// Outbound MT (Mobile Terminated) sending via the MMX DirectTEXT send API.
//
// Used by the auto-responder to send HELP / STOP / START compliance replies back
// to the handset. Per MMX API Guide v2.5 §2:
//   POST https://dtxt.na.kaleyra.ai/a2w_preRouter/httpApiRouter
//   Content-Type: application/x-www-form-urlencoded
//   Authorization: Basic base64(user:pass)
//   body params: reply_to (sender ID), recipient (E.164 mobile), body (text)
// Success = HTTP 200 with an XML <code>100</code>.
//
// The endpoint is read from env.MMX_SEND_URL so it can be pointed at a test
// receiver during verification; it defaults to the production NA URL.

export const DEFAULT_MMX_SEND_URL = 'https://dtxt.na.kaleyra.ai/a2w_preRouter/httpApiRouter';

// Build the form-urlencoded MT request body. URLSearchParams handles the
// percent-encoding MMX requires for the message text.
export function buildMtBody({ reply_to, recipient, body, reporting_key1 }) {
  const p = new URLSearchParams();
  p.set('reply_to', reply_to == null ? '' : String(reply_to));
  p.set('recipient', recipient == null ? '' : String(recipient));
  p.set('body', body == null ? '' : String(body));
  if (reporting_key1) p.set('reporting_key1', String(reporting_key1));
  return p.toString();
}

export function basicAuth(user, pass) {
  const raw = `${user || ''}:${pass || ''}`;
  const b64 = typeof btoa === 'function' ? btoa(raw) : Buffer.from(raw).toString('base64');
  return `Basic ${b64}`;
}

// Parse the MMX XML response. A success carries <code>100</code>; we also treat
// a 2xx with no parseable code as success (defensive), and surface the message id.
export function parseMtResponse(httpStatus, text) {
  const t = text || '';
  const codeM = /<code>\s*(\d+)\s*<\/code>/i.exec(t);
  const code = codeM ? codeM[1] : null;
  const idM = /<messageId>\s*([^<]+?)\s*<\/messageId>/i.exec(t);
  const descM = /<description>\s*([^<]+?)\s*<\/description>/i.exec(t);
  const httpOk = httpStatus >= 200 && httpStatus < 300;
  const ok = httpOk && (code === null || code === '100');
  return { ok, code, messageId: idM ? idM[1].trim() : null, description: descM ? descM[1].trim() : null };
}

// Resolve which credentials to use: a per-customer override wins over the global
// encrypted secret. Returns { user, pass, configured }.
export function resolveSendCreds(env, customer) {
  const user = (customer && customer.send_username) || (env && env.MMX_SEND_USER) || '';
  const pass = (customer && customer.send_secret) || (env && env.MMX_SEND_PASS) || '';
  return { user, pass, configured: !!(user && pass) };
}

// Send one MT message. Returns a plain result object (never throws) so the caller
// can log the outcome. When credentials are absent it returns skipped:'no_credentials'
// rather than attempting an unauthenticated call.
export async function sendMt(env, customer, { reply_to, recipient, body, reporting_key1 }, timeoutMs = 15000) {
  const url = (env && env.MMX_SEND_URL) || DEFAULT_MMX_SEND_URL;
  const { user, pass, configured } = resolveSendCreds(env, customer);
  if (!configured) {
    return { ok: false, skipped: 'no_credentials', error: 'MMX send credentials not configured' };
  }
  if (!recipient) {
    return { ok: false, skipped: 'no_recipient', error: 'no recipient mobile number on the inbound message' };
  }
  const payload = buildMtBody({ reply_to, recipient, body, reporting_key1 });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'authorization': basicAuth(user, pass),
        'user-agent': 'MMX-Router/1.0',
      },
      body: payload,
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    const parsed = parseMtResponse(res.status, text);
    return {
      ok: parsed.ok,
      httpStatus: res.status,
      code: parsed.code,
      messageId: parsed.messageId,
      description: parsed.description,
      response: text.slice(0, 500),
    };
  } catch (e) {
    return { ok: false, httpStatus: 0, error: String(e && e.message ? e.message : e) };
  } finally {
    clearTimeout(t);
  }
}
