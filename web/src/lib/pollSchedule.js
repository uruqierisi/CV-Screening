/**
 * When to poll again, and when to stop. Pure functions, no React, no timers.
 *
 * This is the decision half of `usePolledResource`, split out because it is the
 * part with all the rules in it and the part most worth testing directly. Plan
 * section 6 calls hand-rolled polling "honestly the likeliest home of a real bug
 * in the submission", so the rules are written as data a test can walk rather
 * than as branches inside an effect.
 */

/** Why polling stopped. Rendered to the user, so each one has a reason attached. */
export const POLL_STOP_REASONS = Object.freeze({
  COMPLETE: 'complete',
  FAILURES: 'failures',
  TIMEOUT: 'timeout',
  NOT_FOUND: 'not_found',
});

/**
 * Consecutive failed polls before giving up. Four, not one: a single blip on a
 * developer laptop is not a reason to stop updating a screen.
 */
export const MAX_CONSECUTIVE_FAILURES = 4;

/** Nothing polls for more than ten minutes, whatever the data says. */
export const HARD_CAP_MS = 10 * 60 * 1000;

/** How long the payload must be unchanged before the interval steps up. */
export const NO_CHANGE_BEFORE_BACKOFF_MS = 60 * 1000;

/**
 * The backoff ladder above the base interval. Plan section 6: 3 -> 8 -> 20,
 * capped at 30.
 *
 * The first rung is the caller's base interval, so the dashboard's 5s and the
 * detail view's 3s both climb the same ladder without a second copy of it.
 */
export const BACKOFF_LADDER_MS = Object.freeze([8000, 20000, 30000]);

/**
 * How long to wait before the next poll.
 *
 * The clock that drives this is **time since the payload last changed**, not
 * time since polling started. A batch that is producing results every few
 * seconds stays at the base interval indefinitely; a batch that has looked
 * identical for two minutes is asked about less often.
 *
 * @param {object} input
 * @param {number} input.baseMs the caller's interval - the first rung
 * @param {number} input.msSinceLastChange
 * @returns {number}
 */
export function nextIntervalMs({ baseMs, msSinceLastChange }) {
  const steps = Math.floor(msSinceLastChange / NO_CHANGE_BEFORE_BACKOFF_MS);
  if (steps <= 0) return baseMs;
  const rung = BACKOFF_LADDER_MS[Math.min(steps, BACKOFF_LADDER_MS.length) - 1];
  // A base interval slower than the rung it would climb to is left alone. The
  // ladder exists to back off, never to speed up.
  return Math.max(baseMs, rung);
}

/**
 * Whether polling is finished, and why.
 *
 * `complete` is the data-driven stop and it is checked first: a set of
 * candidates that are all `done` or `failed` is finished regardless of how many
 * failures or how much time preceded it.
 *
 * @param {object} input
 * @param {boolean} input.complete every watched entity has reached a terminal state
 * @param {number} input.consecutiveFailures aborts excluded by the caller
 * @param {number} input.elapsedMs since polling started
 * @param {number | null} [input.lastErrorStatus] HTTP status of the most recent failure
 * @returns {string | null} a `POLL_STOP_REASONS` value, or null to keep going
 */
export function stopReasonFor({
  complete,
  consecutiveFailures,
  elapsedMs,
  lastErrorStatus = null,
}) {
  if (complete) return POLL_STOP_REASONS.COMPLETE;
  // A 404 means the thing being polled is gone. Retrying cannot bring it back,
  // and four more requests would only delay saying so.
  if (lastErrorStatus === 404) return POLL_STOP_REASONS.NOT_FOUND;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return POLL_STOP_REASONS.FAILURES;
  if (elapsedMs >= HARD_CAP_MS) return POLL_STOP_REASONS.TIMEOUT;
  return null;
}

/**
 * The sentence shown when live updates stop. Every one names a next action.
 *
 * @param {string | null} reason
 * @returns {string | null}
 */
export function stopReasonMessage(reason) {
  switch (reason) {
    case POLL_STOP_REASONS.FAILURES:
      return 'Live updates stopped after four failed attempts to reach the server. Press Refresh to try again.';
    case POLL_STOP_REASONS.TIMEOUT:
      return 'Live updates stopped after ten minutes. Press Refresh to check the latest status.';
    case POLL_STOP_REASONS.NOT_FOUND:
      return 'Live updates stopped: the server no longer has this record.';
    // `complete` deliberately has no message. Polling that stopped because the
    // work finished is not an incident, and a banner announcing it would train
    // people to ignore the banner that matters.
    default:
      return null;
  }
}
