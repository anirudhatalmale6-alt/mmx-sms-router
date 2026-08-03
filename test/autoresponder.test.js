import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchAutoResponse, ruleMatches, defaultRules, STANDARD_KEYWORDS, DEFAULT_TEMPLATES,
} from '../src/autoresponder.js';
import {
  buildMtBody, basicAuth, parseMtResponse, resolveSendCreds,
} from '../src/outbound.js';

const R = (id, kw, mode = 'first_word', action = 'reply', body = 'x') =>
  ({ id, match_keyword: kw, keyword_match: mode, action, reply_body: body, enabled: 1 });

test('ruleMatches: first_word is case-insensitive and ignores trailing text', () => {
  assert.equal(ruleMatches(R(1, 'STOP'), 'stop'), true);
  assert.equal(ruleMatches(R(1, 'STOP'), 'STOP please'), true);
  assert.equal(ruleMatches(R(1, 'STOP'), 'please STOP'), false); // not first word
  assert.equal(ruleMatches(R(1, 'STOP'), 'STOPPING'), false);    // whole first word must equal
});

test('ruleMatches: exact and contains modes', () => {
  assert.equal(ruleMatches(R(1, 'STOP', 'exact'), 'STOP'), true);
  assert.equal(ruleMatches(R(1, 'STOP', 'exact'), 'STOP now'), false);
  assert.equal(ruleMatches(R(1, 'HELP', 'contains'), 'i need HELP now'), true);
});

test('matchAutoResponse: picks the STOP rule for a STOP message', () => {
  const rules = defaultRules().map((r, i) => ({ ...r, id: i + 1, enabled: 1 }));
  const hit = matchAutoResponse(rules, 'STOP');
  assert.equal(hit.match_keyword, 'STOP');
  assert.equal(hit.action, 'optout');
});

test('matchAutoResponse: HELP -> reply, START -> optin', () => {
  const rules = defaultRules().map((r, i) => ({ ...r, id: i + 1, enabled: 1 }));
  assert.equal(matchAutoResponse(rules, 'help').action, 'reply');
  assert.equal(matchAutoResponse(rules, 'START').action, 'optin');
});

test('matchAutoResponse: no match returns null; disabled rules ignored', () => {
  const rules = [R(1, 'STOP')];
  assert.equal(matchAutoResponse(rules, 'hello world'), null);
  assert.equal(matchAutoResponse([{ ...R(1, 'STOP'), enabled: 0 }], 'STOP'), null);
});

test('matchAutoResponse: exact beats first_word beats contains', () => {
  const rules = [
    R(1, 'STOP', 'contains', 'reply', 'contains'),
    R(2, 'STOP', 'first_word', 'reply', 'first'),
    R(3, 'STOP', 'exact', 'reply', 'exact'),
  ];
  assert.equal(matchAutoResponse(rules, 'STOP').reply_body, 'exact');
});

test('standard keyword groups and templates are present', () => {
  assert.ok(STANDARD_KEYWORDS.optout.includes('STOP'));
  assert.ok(STANDARD_KEYWORDS.optin.includes('START'));
  assert.ok(STANDARD_KEYWORDS.help.includes('HELP'));
  assert.match(DEFAULT_TEMPLATES.STOP, /unsubscribed/i);
});

test('buildMtBody url-encodes the message and includes mandatory params', () => {
  const s = buildMtBody({ reply_to: '12345', recipient: '14045551234', body: 'Thanks 👍' });
  const p = new URLSearchParams(s);
  assert.equal(p.get('reply_to'), '12345');
  assert.equal(p.get('recipient'), '14045551234');
  assert.equal(p.get('body'), 'Thanks 👍');
  assert.ok(s.includes('body=Thanks')); // encoded, spaces as +
});

test('basicAuth builds a correct header', () => {
  assert.equal(basicAuth('user', 'pass'), 'Basic ' + Buffer.from('user:pass').toString('base64'));
});

test('parseMtResponse: 200 + <code>100</code> is success', () => {
  const xml = '<httpApiResponse><code>100</code><description>Success</description><recipients><recipient><mobileNumber>14045551234</mobileNumber><messageId>abc-123</messageId></recipient></recipients></httpApiResponse>';
  const r = parseMtResponse(200, xml);
  assert.equal(r.ok, true);
  assert.equal(r.code, '100');
  assert.equal(r.messageId, 'abc-123');
});

test('parseMtResponse: non-100 code or 401 is failure', () => {
  assert.equal(parseMtResponse(200, '<code>997</code>').ok, false);
  assert.equal(parseMtResponse(401, 'Unauthorized').ok, false);
});

test('resolveSendCreds: per-customer overrides the global secret', () => {
  const env = { MMX_SEND_USER: 'g', MMX_SEND_PASS: 'gp' };
  assert.deepEqual(resolveSendCreds(env, null), { user: 'g', pass: 'gp', configured: true });
  const cust = { send_username: 'c', send_secret: 'cp' };
  assert.deepEqual(resolveSendCreds(env, cust), { user: 'c', pass: 'cp', configured: true });
  assert.equal(resolveSendCreds({}, null).configured, false);
});
