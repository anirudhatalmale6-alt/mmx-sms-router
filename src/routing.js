// Core routing logic for MMX MO/DR callbacks.
//
// These functions are deliberately pure (no D1, no fetch) so they can be
// unit-tested in plain Node. index.js loads rules from D1 and hands them here.

/**
 * Extract the keyword token from an SMS message body.
 * SMS shortcode convention: the keyword is the first whitespace-delimited word.
 */
export function firstWord(text) {
  if (!text) return '';
  return String(text).trim().split(/\s+/)[0] || '';
}

/**
 * Test whether an MO body matches a rule's keyword according to keyword_match.
 * Matching is case-insensitive. A rule with no keyword always passes this test
 * (it is a Sender-ID-only or default rule).
 */
export function keywordMatches(rule, body) {
  if (!rule.match_keyword) return true;
  const kw = String(rule.match_keyword).trim().toLowerCase();
  const text = String(body || '').toLowerCase();
  switch (rule.keyword_match) {
    case 'contains':
      return text.includes(kw);
    case 'exact':
      return text.trim() === kw;
    case 'first_word':
    default:
      return firstWord(text) === kw;
  }
}

/**
 * Test whether a rule's Sender ID matches. A rule with no sender_id passes
 * (it is a Keyword-only or default rule).
 */
export function senderMatches(rule, senderId) {
  if (!rule.match_sender_id) return true;
  return String(rule.match_sender_id) === String(senderId || '');
}

/**
 * Derived specificity used to order MO rules:
 *   3 sender+keyword, 2 keyword only, 1 sender only, 0 default.
 */
export function specificityOf(rule) {
  const hasSender = !!rule.match_sender_id;
  const hasKeyword = !!rule.match_keyword;
  if (hasSender && hasKeyword) return 3;
  if (hasKeyword) return 2;
  if (hasSender) return 1;
  return 0;
}

/**
 * Pick the single best MO route for an inbound message.
 * Rules are filtered to those that match, then the most specific wins;
 * ties break on the explicit `priority` column (higher first), then newest id.
 * Returns the chosen rule or null when nothing (not even a default) matches.
 */
export function selectMoRoute(rules, { senderId, body }) {
  const matched = rules
    .filter((r) => r.enabled)
    .filter((r) => senderMatches(r, senderId))
    .filter((r) => keywordMatches(r, body));
  if (matched.length === 0) return null;
  matched.sort((a, b) => {
    const sa = specificityOf(a);
    const sb = specificityOf(b);
    if (sa !== sb) return sb - sa;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return b.id - a.id;
  });
  return matched[0];
}

/**
 * Select every DR route that should receive this receipt (fan-out).
 * A rule matches when it is enabled and its optional sender_id matches.
 */
export function selectDrRoutes(rules, { senderId }) {
  return rules
    .filter((r) => r.enabled)
    .filter((r) => !r.match_sender_id || String(r.match_sender_id) === String(senderId || ''));
}

/**
 * Produce a message_id in the customer's configured format (spec 9.4).
 * `seed` is used to derive deterministic numeric ids from the original id so a
 * given inbound message keeps a stable forwarded id across retries.
 *
 * NOTE: crypto.randomUUID() is provided by the Workers runtime. For numeric
 * formats we hash the original id into digits of the requested length.
 */
export function formatMessageId(format, originalId, uuidFn) {
  switch (format) {
    case 'uuid':
      return uuidFn ? uuidFn() : originalId;
    case 'num12':
      return numericFromSeed(originalId, 12);
    case 'num19':
      return numericFromSeed(originalId, 19);
    case 'passthrough':
    default:
      return originalId;
  }
}

// Deterministic numeric string of exactly `len` digits derived from a seed.
function numericFromSeed(seed, len) {
  const s = String(seed ?? '');
  // FNV-1a style rolling hash -> BigInt, then take the low `len` digits.
  let h = 1469598103934665603n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 1099511628211n) & 0xffffffffffffffffn;
  }
  let digits = h.toString().replace(/^0+/, '');
  // Ensure length: pad by re-hashing tail if too short, trim if too long.
  while (digits.length < len) digits += (h % 10n).toString(), (h = h * 7n + 13n);
  digits = digits.slice(0, len);
  // Avoid a leading zero so the numeric length is honoured.
  if (digits[0] === '0') digits = '1' + digits.slice(1);
  return digits;
}
