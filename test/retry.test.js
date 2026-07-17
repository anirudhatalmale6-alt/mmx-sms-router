import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retriesInStage, parseStages, nextRetry, DEFAULT_STAGES } from '../src/retry.js';

test('retriesInStage = floor(duration / delay)', () => {
  assert.equal(retriesInStage({ retryDelay: 10, retryDuration: 100 }), 10);
  assert.equal(retriesInStage({ retryDelay: 30, retryDuration: 300 }), 10);
  assert.equal(retriesInStage({ retryDelay: 60, retryDuration: 172800 }), 2880);
  assert.equal(retriesInStage({ retryDelay: 0, retryDuration: 100 }), 0);
});

test('parseStages accepts JSON string, array, and falls back to default', () => {
  assert.deepEqual(parseStages('[{"retryDelay":10,"retryDuration":100}]'), [{ retryDelay: 10, retryDuration: 100 }]);
  assert.deepEqual(parseStages([{ retryDelay: 5, retryDuration: 50 }]), [{ retryDelay: 5, retryDuration: 50 }]);
  assert.deepEqual(parseStages('garbage'), DEFAULT_STAGES);
  assert.deepEqual(parseStages([]), DEFAULT_STAGES);
  assert.deepEqual(parseStages(null), DEFAULT_STAGES);
});

test('nextRetry schedules within a stage until it is exhausted', () => {
  const stages = [{ retryDelay: 10, retryDuration: 100 }]; // 10 retries
  // first failure -> retry #1 scheduled 10s out
  let s = nextRetry(stages, 0, 0, 1000);
  assert.deepEqual(s, { done: false, stageIndex: 0, stageAttempts: 1, nextAttemptSec: 1010 });
  // after 9 retries done, the 10th failure exhausts the only stage
  s = nextRetry(stages, 0, 9, 1000);
  assert.equal(s.done, true);
});

test('nextRetry advances to the next stage (spec 9.5 example)', () => {
  const stages = [
    { retryDelay: 10, retryDuration: 100 }, // 10 retries
    { retryDelay: 30, retryDuration: 300 }, // 10 retries
  ];
  // exhaust stage 0 (already did 9, this failure is the 10th) -> move to stage 1
  const s = nextRetry(stages, 0, 9, 5000);
  assert.deepEqual(s, { done: false, stageIndex: 1, stageAttempts: 0, nextAttemptSec: 5030 });
  // within stage 1
  const s2 = nextRetry(stages, 1, 0, 5000);
  assert.deepEqual(s2, { done: false, stageIndex: 1, stageAttempts: 1, nextAttemptSec: 5030 });
  // exhaust stage 1 -> done
  const s3 = nextRetry(stages, 1, 9, 5000);
  assert.equal(s3.done, true);
});

test('nextRetry skips zero-retry stages', () => {
  const stages = [
    { retryDelay: 10, retryDuration: 100 },
    { retryDelay: 100, retryDuration: 50 }, // floor(50/100)=0 retries, skip
    { retryDelay: 20, retryDuration: 40 },  // 2 retries
  ];
  const s = nextRetry(stages, 0, 9, 0); // exhaust stage 0, skip stage 1 -> stage 2
  assert.deepEqual(s, { done: false, stageIndex: 2, stageAttempts: 0, nextAttemptSec: 20 });
});
