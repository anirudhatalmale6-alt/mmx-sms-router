// Auto-responder logic for HELP / STOP / START compliance replies.
//
// Pure (no D1, no fetch) so it can be unit-tested in plain Node. index.js loads
// the customer's auto_responses rules from D1 and hands them here to pick the one
// that matches an inbound MO.

import { firstWord } from './routing.js';

// Standard SMS compliance keyword groups (used to seed sensible defaults).
export const STANDARD_KEYWORDS = {
  optout: ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT'],
  optin: ['START', 'UNSTOP', 'YES', 'OPTIN'],
  help: ['HELP', 'INFO'],
};

// Default compliant reply text (the client can edit any of these in the dashboard).
export const DEFAULT_TEMPLATES = {
  STOP: 'You are unsubscribed and will receive no more messages. Reply START to re-subscribe. Reply HELP for help.',
  HELP: 'Help: reply STOP to unsubscribe at any time. Msg & data rates may apply. Contact your provider for support.',
  START: 'You are re-subscribed and will receive messages again. Reply STOP to unsubscribe at any time.',
};

// Does a single rule match the message body?
export function ruleMatches(rule, body) {
  if (!rule.match_keyword) return false;
  const kw = String(rule.match_keyword).trim().toUpperCase();
  const text = String(body || '').trim().toUpperCase();
  switch (rule.keyword_match) {
    case 'contains':
      return text.includes(kw);
    case 'exact':
      return text === kw;
    case 'first_word':
    default:
      return firstWord(text).toUpperCase() === kw;
  }
}

// Pick the auto-response rule that should fire for this MO, or null.
// When several match, prefer the most explicit: exact match beats first_word
// beats contains, then the longest keyword, then the newest rule.
export function matchAutoResponse(rules, body) {
  const modeRank = { exact: 3, first_word: 2, contains: 1 };
  const matched = (rules || [])
    .filter((r) => r.enabled)
    .filter((r) => ruleMatches(r, body));
  if (matched.length === 0) return null;
  matched.sort((a, b) => {
    const ma = modeRank[a.keyword_match] || 2;
    const mb = modeRank[b.keyword_match] || 2;
    if (ma !== mb) return mb - ma;
    const la = String(a.match_keyword || '').length;
    const lb = String(b.match_keyword || '').length;
    if (la !== lb) return lb - la;
    return (b.id || 0) - (a.id || 0);
  });
  return matched[0];
}

// The default rule set seeded for a new customer: STOP/HELP/START with standard
// text, using first_word matching so "STOP", "STOP ALL" etc. all trigger.
export function defaultRules() {
  return [
    { match_keyword: 'STOP', keyword_match: 'first_word', action: 'optout', reply_body: DEFAULT_TEMPLATES.STOP },
    { match_keyword: 'STOPALL', keyword_match: 'first_word', action: 'optout', reply_body: DEFAULT_TEMPLATES.STOP },
    { match_keyword: 'UNSUBSCRIBE', keyword_match: 'first_word', action: 'optout', reply_body: DEFAULT_TEMPLATES.STOP },
    { match_keyword: 'CANCEL', keyword_match: 'first_word', action: 'optout', reply_body: DEFAULT_TEMPLATES.STOP },
    { match_keyword: 'END', keyword_match: 'first_word', action: 'optout', reply_body: DEFAULT_TEMPLATES.STOP },
    { match_keyword: 'QUIT', keyword_match: 'first_word', action: 'optout', reply_body: DEFAULT_TEMPLATES.STOP },
    { match_keyword: 'HELP', keyword_match: 'first_word', action: 'reply', reply_body: DEFAULT_TEMPLATES.HELP },
    { match_keyword: 'INFO', keyword_match: 'first_word', action: 'reply', reply_body: DEFAULT_TEMPLATES.HELP },
    { match_keyword: 'START', keyword_match: 'first_word', action: 'optin', reply_body: DEFAULT_TEMPLATES.START },
    { match_keyword: 'UNSTOP', keyword_match: 'first_word', action: 'optin', reply_body: DEFAULT_TEMPLATES.START },
  ];
}
