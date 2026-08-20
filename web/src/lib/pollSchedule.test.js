import { describe, expect, test } from 'vitest';
import {
  BACKOFF_LADDER_MS,
  HARD_CAP_MS,
  MAX_CONSECUTIVE_FAILURES,
  NO_CHANGE_BEFORE_BACKOFF_MS,
  POLL_STOP_REASONS,
  nextIntervalMs,
  stopReasonFor,
  stopReasonMessage,
} from './pollSchedule.js';

describe('nextIntervalMs', () => {
  test('stays at the base interval while the payload keeps changing', () => {
    expect(nextIntervalMs({ baseMs: 3000, msSinceLastChange: 0 })).toBe(3000);
    expect(nextIntervalMs({ baseMs: 3000, msSinceLastChange: NO_CHANGE_BEFORE_BACKOFF_MS - 1 })).toBe(
      3000,
    );
  });

  test('steps up the ladder for each minute without a change', () => {
    expect(nextIntervalMs({ baseMs: 3000, msSinceLastChange: NO_CHANGE_BEFORE_BACKOFF_MS })).toBe(
      BACKOFF_LADDER_MS[0],
    );
    expect(
      nextIntervalMs({ baseMs: 3000, msSinceLastChange: NO_CHANGE_BEFORE_BACKOFF_MS * 2 }),
    ).toBe(BACKOFF_LADDER_MS[1]);
    expect(
      nextIntervalMs({ baseMs: 3000, msSinceLastChange: NO_CHANGE_BEFORE_BACKOFF_MS * 3 }),
    ).toBe(BACKOFF_LADDER_MS[2]);
  });

  test('caps at the top of the ladder however long nothing changes', () => {
    const cap = BACKOFF_LADDER_MS[BACKOFF_LADDER_MS.length - 1];
    expect(nextIntervalMs({ baseMs: 3000, msSinceLastChange: HARD_CAP_MS })).toBe(cap);
  });

  test('never speeds a caller up: a slow base interval survives the ladder', () => {
    expect(
      nextIntervalMs({ baseMs: 20_000, msSinceLastChange: NO_CHANGE_BEFORE_BACKOFF_MS }),
    ).toBe(20_000);
  });
});

describe('stopReasonFor', () => {
  const running = { complete: false, consecutiveFailures: 0, elapsedMs: 0 };

  test('keeps going when nothing says otherwise', () => {
    expect(stopReasonFor(running)).toBeNull();
  });

  test('completion is the stop condition, and it wins over everything else', () => {
    expect(
      stopReasonFor({
        complete: true,
        consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
        elapsedMs: HARD_CAP_MS,
        lastErrorStatus: 404,
      }),
    ).toBe(POLL_STOP_REASONS.COMPLETE);
  });

  test('stops on a 404 immediately rather than spending three more requests', () => {
    expect(stopReasonFor({ ...running, lastErrorStatus: 404 })).toBe(
      POLL_STOP_REASONS.NOT_FOUND,
    );
  });

  test('tolerates failures up to the limit, then stops', () => {
    expect(
      stopReasonFor({ ...running, consecutiveFailures: MAX_CONSECUTIVE_FAILURES - 1 }),
    ).toBeNull();
    expect(stopReasonFor({ ...running, consecutiveFailures: MAX_CONSECUTIVE_FAILURES })).toBe(
      POLL_STOP_REASONS.FAILURES,
    );
  });

  test('stops at the ten-minute hard cap', () => {
    expect(stopReasonFor({ ...running, elapsedMs: HARD_CAP_MS - 1 })).toBeNull();
    expect(stopReasonFor({ ...running, elapsedMs: HARD_CAP_MS })).toBe(POLL_STOP_REASONS.TIMEOUT);
  });
});

describe('stopReasonMessage', () => {
  test('every abnormal stop names a next action', () => {
    for (const reason of [
      POLL_STOP_REASONS.FAILURES,
      POLL_STOP_REASONS.TIMEOUT,
      POLL_STOP_REASONS.NOT_FOUND,
    ]) {
      expect(stopReasonMessage(reason)).toMatch(/\w/);
    }
  });

  test('finishing normally raises no banner', () => {
    expect(stopReasonMessage(POLL_STOP_REASONS.COMPLETE)).toBeNull();
    expect(stopReasonMessage(null)).toBeNull();
  });
});
