// Retry policy engine (spec 9.5).
//
// A policy is a list of stages: [{ retryDelay, retryDuration }, ...]
//   retryDelay    - seconds between two consecutive retries in the stage
//   retryDuration - total seconds the stage runs, so the stage allows
//                   floor(retryDuration / retryDelay) retries.
// When a stage's retries are exhausted the next stage begins; when the last
// stage is exhausted the delivery is marked failed.
//
// The default MMX policy is a single stage retryDelay 60, retryDuration 172800
// (retry every 60s for 48h).

export const DEFAULT_STAGES = [{ retryDelay: 60, retryDuration: 172800 }];

/** Number of retry attempts a stage permits. */
export function retriesInStage(stage) {
  if (!stage || !stage.retryDelay || stage.retryDelay <= 0) return 0;
  return Math.floor(stage.retryDuration / stage.retryDelay);
}

/**
 * Parse a stages value that may be a JSON string, an array, or missing.
 * Falls back to the default policy when the input is empty or invalid.
 */
export function parseStages(stages) {
  let arr = stages;
  if (typeof stages === 'string') {
    try {
      arr = JSON.parse(stages);
    } catch {
      arr = null;
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return DEFAULT_STAGES;
  const clean = arr
    .map((s) => ({ retryDelay: Number(s.retryDelay), retryDuration: Number(s.retryDuration) }))
    .filter((s) => s.retryDelay > 0 && s.retryDuration > 0);
  return clean.length ? clean : DEFAULT_STAGES;
}

/**
 * Given the current retry position and that an attempt just FAILED, compute the
 * next position. `nowSec` is the current unix time in seconds.
 *
 * Returns:
 *   { done: true }                              -> no stages left, give up
 *   { done: false, stageIndex, stageAttempts,   -> schedule another retry
 *     nextAttemptSec }
 */
export function nextRetry(stages, stageIndex, stageAttempts, nowSec) {
  const list = parseStages(stages);
  let idx = stageIndex;
  let done = stageAttempts + 1; // retries completed in this stage after this failure

  // Current stage still has room?
  if (idx < list.length && done < retriesInStage(list[idx])) {
    return {
      done: false,
      stageIndex: idx,
      stageAttempts: done,
      nextAttemptSec: nowSec + list[idx].retryDelay,
    };
  }

  // Advance to the next stage that actually permits a retry.
  for (let next = idx + 1; next < list.length; next++) {
    if (retriesInStage(list[next]) > 0) {
      return {
        done: false,
        stageIndex: next,
        stageAttempts: 0,
        nextAttemptSec: nowSec + list[next].retryDelay,
      };
    }
  }

  return { done: true };
}

/** Convert a unix-seconds timestamp to the SQLite 'YYYY-MM-DD HH:MM:SS' form. */
export function toSqlTime(sec) {
  return new Date(sec * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}
