import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  firstWord, keywordMatches, senderMatches, specificityOf,
  selectMoRoute, selectDrRoutes, formatMessageId,
} from '../src/routing.js';

const rule = (o) => ({ enabled: 1, keyword_match: 'first_word', priority: 0, id: 1, ...o });

test('firstWord extracts the leading token', () => {
  assert.equal(firstWord('  HELP me now '), 'HELP');
  assert.equal(firstWord(''), '');
});

test('keywordMatches respects match mode and is case-insensitive', () => {
  assert.ok(keywordMatches(rule({ match_keyword: 'word1' }), 'WORD1 extra text'));
  assert.ok(!keywordMatches(rule({ match_keyword: 'word1' }), 'nope word1'));
  assert.ok(keywordMatches(rule({ match_keyword: 'word1', keyword_match: 'contains' }), 'nope word1'));
  assert.ok(keywordMatches(rule({ match_keyword: 'stop', keyword_match: 'exact' }), 'STOP'));
  assert.ok(keywordMatches(rule({ match_keyword: null }), 'anything')); // no keyword = pass
});

test('senderMatches compares as strings and passes when unset', () => {
  assert.ok(senderMatches(rule({ match_sender_id: '12345' }), 12345));
  assert.ok(!senderMatches(rule({ match_sender_id: '12345' }), '33377'));
  assert.ok(senderMatches(rule({ match_sender_id: null }), 'whatever'));
});

test('specificity ordering', () => {
  assert.equal(specificityOf(rule({ match_sender_id: '1', match_keyword: 'k' })), 3);
  assert.equal(specificityOf(rule({ match_keyword: 'k' })), 2);
  assert.equal(specificityOf(rule({ match_sender_id: '1' })), 1);
  assert.equal(specificityOf(rule({})), 0);
});

test('selectMoRoute: Sender ID routing (spec 9.2)', () => {
  const rules = [
    rule({ id: 1, match_sender_id: '12345', dest_url: 'A' }),
    rule({ id: 2, match_sender_id: '33377', dest_url: 'B' }),
  ];
  assert.equal(selectMoRoute(rules, { senderId: '12345', body: 'hi' }).dest_url, 'A');
  assert.equal(selectMoRoute(rules, { senderId: '33377', body: 'hi' }).dest_url, 'B');
  assert.equal(selectMoRoute(rules, { senderId: '99999', body: 'hi' }), null);
});

test('selectMoRoute: multiple Sender IDs to the same URL', () => {
  const rules = [
    rule({ id: 1, match_sender_id: '12345', dest_url: 'A' }),
    rule({ id: 2, match_sender_id: '33377', dest_url: 'A' }),
    rule({ id: 3, match_sender_id: '38272', dest_url: 'B' }),
    rule({ id: 4, match_sender_id: '12367', dest_url: 'B' }),
  ];
  assert.equal(selectMoRoute(rules, { senderId: '33377' }).dest_url, 'A');
  assert.equal(selectMoRoute(rules, { senderId: '38272' }).dest_url, 'B');
});

test('selectMoRoute: Keyword routing', () => {
  const rules = [
    rule({ id: 1, match_keyword: 'word1', dest_url: 'A' }),
    rule({ id: 2, match_keyword: 'word2', dest_url: 'B' }),
  ];
  assert.equal(selectMoRoute(rules, { senderId: 'x', body: 'word1 hello' }).dest_url, 'A');
  assert.equal(selectMoRoute(rules, { senderId: 'x', body: 'word2 hello' }).dest_url, 'B');
});

test('selectMoRoute: Sender ID + Keyword beats less specific rules', () => {
  const rules = [
    rule({ id: 1, match_sender_id: '12345', dest_url: 'SENDER_ONLY' }),
    rule({ id: 2, match_keyword: 'word3', dest_url: 'KW_ONLY' }),
    rule({ id: 3, match_sender_id: '12345', match_keyword: 'word3', dest_url: 'BOTH' }),
  ];
  assert.equal(selectMoRoute(rules, { senderId: '12345', body: 'word3 go' }).dest_url, 'BOTH');
  // keyword present but different sender -> keyword-only rule
  assert.equal(selectMoRoute(rules, { senderId: '99999', body: 'word3 go' }).dest_url, 'KW_ONLY');
  // sender matches but keyword absent -> sender-only rule
  assert.equal(selectMoRoute(rules, { senderId: '12345', body: 'hello' }).dest_url, 'SENDER_ONLY');
});

test('selectMoRoute: catch-all default when set', () => {
  const rules = [
    rule({ id: 1, match_sender_id: '12345', dest_url: 'A' }),
    rule({ id: 2, dest_url: 'DEFAULT' }),
  ];
  assert.equal(selectMoRoute(rules, { senderId: '00000', body: 'x' }).dest_url, 'DEFAULT');
});

test('selectDrRoutes: fan-out to all matching URLs (spec 9.3)', () => {
  const rules = [
    rule({ id: 1, dest_url: 'A' }),
    rule({ id: 2, dest_url: 'B' }),
    rule({ id: 3, match_sender_id: '12345', dest_url: 'C' }),
  ];
  // no sender scope -> only the two unscoped + none of the scoped
  assert.deepEqual(selectDrRoutes(rules, { senderId: '99999' }).map(r => r.dest_url), ['A', 'B']);
  // sender 12345 -> unscoped A,B plus scoped C
  assert.deepEqual(selectDrRoutes(rules, { senderId: '12345' }).map(r => r.dest_url), ['A', 'B', 'C']);
});

test('formatMessageId honours per-customer format (spec 9.4)', () => {
  assert.equal(formatMessageId('passthrough', 'abc'), 'abc');
  assert.equal(formatMessageId('uuid', 'abc', () => 'the-uuid'), 'the-uuid');
  const n12 = formatMessageId('num12', 'seed');
  assert.match(n12, /^\d{12}$/);
  const n19 = formatMessageId('num19', 'seed');
  assert.match(n19, /^\d{19}$/);
  // deterministic for a given seed
  assert.equal(formatMessageId('num12', 'seed'), n12);
});
