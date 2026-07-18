import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMo, normalizeDr, buildForwardBody } from '../src/index.js';

// Real MMX MO payload fields (API Guide v2.5, section 8).
const MO = {
  a2w_mo_ref_id: '44xxxxxx1009', carrier: 'tmobile', channel: 'sms', country_code: '1',
  device_address: '112xxxxx890', inbound_address: '99069', message: 'word1 hello',
  message_id: '44xxxxxx1009', message_orig: 'word1 hello', message_subid: '0',
  router: 'MMX', status: 'MO Success', status_code: '100',
};

// Real MMX DR payload fields (API Guide v2.5, section 4).
const DR = {
  carrier: 'verizon', channel: 'sms', client_message_id: 'test_key2',
  device_address: '14045554900', inbound_address: '12345', message_id: '506180957019',
  message_subid: '0', router: 'MMX', smscid: 'f72e26d7-6b87', status: 'Carrier Success',
  status_code: '200',
};

test('normalizeMo reads inbound_address as Sender ID and message as body', () => {
  const mo = normalizeMo(MO);
  assert.equal(mo.senderId, '99069');
  assert.equal(mo.body, 'word1 hello');
  assert.equal(mo.messageId, '44xxxxxx1009');
  assert.equal(mo.deviceAddress, '112xxxxx890');
});

test('normalizeDr reads inbound_address as Sender ID', () => {
  const dr = normalizeDr(DR);
  assert.equal(dr.senderId, '12345');
  assert.equal(dr.messageId, '506180957019');
  assert.equal(dr.status, 'Carrier Success');
});

test('buildForwardBody passes the raw body through unchanged by default', () => {
  const raw = 'inbound_address=12345&message_id=506180957019&status=Carrier+Success';
  const out = buildForwardBody({ message_id_format: 'passthrough' }, DR, raw, 'application/x-www-form-urlencoded', '506180957019');
  assert.equal(out.body, raw); // faithful passthrough
  assert.equal(out.contentType, 'application/x-www-form-urlencoded');
  assert.equal(out.outId, '506180957019');
});

test('buildForwardBody re-encodes only when a message_id format is set', () => {
  const raw = 'inbound_address=12345&message_id=506180957019';
  const out = buildForwardBody({ message_id_format: 'num12' }, { inbound_address: '12345', message_id: '506180957019' }, raw, 'application/x-www-form-urlencoded', '506180957019');
  assert.match(out.outId, /^\d{12}$/);
  const parsed = Object.fromEntries(new URLSearchParams(out.body));
  assert.equal(parsed.inbound_address, '12345');
  assert.equal(parsed.message_id, out.outId); // rewritten
});
