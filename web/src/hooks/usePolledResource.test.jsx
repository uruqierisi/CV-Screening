/**
 * The most thorough test in this suite, because `usePolledResource` is the
 * likeliest home of a real bug in the client: hand-rolled polling with a stop
 * condition, a backoff, an abort and a visibility rule in it.
 *
 * Every test here asserts a behaviour named in plan section 6 rather than an
 * implementation detail, so a rewrite of the hook that keeps the behaviour keeps
 * the suite.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { usePolledResource } from './usePolledResource.js';
import { allCandidatesTerminal } from '../lib/candidateStatus.js';
import { POLL_STOP_REASONS } from '../lib/pollSchedule.js';

const INTERVAL = 3000;

/** Advances the fake clock and lets every resulting promise and render settle. */
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** @param {'visible'|'hidden'} value */
function setVisibility(value) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** An error shaped like the one `api/client.js` throws. */
function apiError(status) {
  const error = new Error(`server said ${status}`);
  error.status = status;
  return error;
}

/** An abort that did NOT come from this hook's own controller. */
function foreignAbort() {
  const error = new Error('aborted elsewhere');
  error.name = 'AbortError';
  return error;
}

function poll(fetcher, overrides = {}) {
  return renderHook(() =>
    usePolledResource({
      fetcher,
      isComplete: (rows) => allCandidatesTerminal(rows ?? []),
      signature: (rows) => (rows ?? []).map((row) => `${row.id}:${row.status}`).join('|'),
      intervalMs: INTERVAL,
      ...overrides,
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the stop condition is the data', () => {
  test('stops after one poll when everything is already terminal', async () => {
    const fetcher = vi.fn(async () => ({ data: [{ id: '1', status: 'done' }] }));
    const { result } = poll(fetcher);

    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.stopReason).toBe(POLL_STOP_REASONS.COMPLETE);

    // Ten minutes of clock, and not one more request.
    await tick(600_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.polling).toBe(false);
  });

  test('keeps polling while one candidate is still working, and stops the moment it finishes', async () => {
    let status = 'pending';
    const fetcher = vi.fn(async () => ({
      data: [
        { id: '1', status: 'done' },
        { id: '2', status },
      ],
    }));
    const { result } = poll(fetcher);

    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.stopReason).toBeNull();

    await tick(INTERVAL);
    expect(fetcher).toHaveBeenCalledTimes(2);

    status = 'evaluating';
    await tick(INTERVAL);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.current.stopReason).toBeNull();

    status = 'failed';
    await tick(INTERVAL);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(result.current.stopReason).toBe(POLL_STOP_REASONS.COMPLETE);

    // A batch that ends in a failure is finished, not still working.
    await tick(120_000);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  test('a finished batch polled again by an explicit refresh stops again immediately', async () => {
    const fetcher = vi.fn(async () => ({ data: [{ id: '1', status: 'done' }] }));
    const { result } = poll(fetcher);

    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => result.current.refresh());
    await tick();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.stopReason).toBe(POLL_STOP_REASONS.COMPLETE);
  });
});

describe('aborts are not failures', () => {
  test('six aborted requests neither stop polling nor raise an error state', async () => {
    // This is the classic hand-rolled-polling bug: an abort counted as a failure
    // means four tab switches kill live updates on a healthy server.
    const fetcher = vi.fn(async () => {
      throw foreignAbort();
    });
    const { result } = poll(fetcher);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await tick(attempt === 0 ? 0 : INTERVAL);
    }

    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(result.current.stopReason).toBeNull();
    expect(result.current.pollError).toBeNull();
    expect(result.current.error).toBeNull();
  });

  test('unmounting aborts the request in flight and schedules nothing further', async () => {
    const fetcher = vi.fn(async (signal) => {
      if (signal.aborted) throw foreignAbort();
      return { data: [{ id: '1', status: 'pending' }] };
    });
    const { unmount } = poll(fetcher);

    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);

    unmount();
    await tick(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('failures', () => {
  test('stops after four consecutive failures, and not before', async () => {
    const fetcher = vi.fn(async () => {
      throw apiError(500);
    });
    const { result } = poll(fetcher);

    await tick();
    expect(result.current.stopReason).toBeNull();

    await tick(INTERVAL);
    await tick(INTERVAL);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.current.stopReason).toBeNull();

    await tick(INTERVAL);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(result.current.stopReason).toBe(POLL_STOP_REASONS.FAILURES);
  });

  test('one failure among successes does not accumulate', async () => {
    let failNext = false;
    const fetcher = vi.fn(async () => {
      if (failNext) {
        failNext = false;
        throw apiError(503);
      }
      return { data: [{ id: '1', status: 'pending' }] };
    });
    const { result } = poll(fetcher);

    await tick();
    for (let round = 0; round < 8; round += 1) {
      failNext = round % 2 === 0;
      await tick(INTERVAL);
    }

    expect(result.current.stopReason).toBeNull();
  });

  test('a failed poll never replaces the data already on screen', async () => {
    let shouldFail = false;
    const fetcher = vi.fn(async () => {
      if (shouldFail) throw apiError(502);
      return { data: [{ id: '1', status: 'parsing' }] };
    });
    const { result } = poll(fetcher);

    await tick();
    expect(result.current.data).toEqual([{ id: '1', status: 'parsing' }]);

    shouldFail = true;
    await tick(INTERVAL);

    // The table stays. A quiet banner says the updates are stale.
    expect(result.current.data).toEqual([{ id: '1', status: 'parsing' }]);
    expect(result.current.error).toBeNull();
    expect(result.current.pollError).not.toBeNull();
    expect(result.current.lastUpdatedAt).not.toBeNull();
  });

  test('a failure with nothing on screen yet IS the error state', async () => {
    const fetcher = vi.fn(async () => {
      throw apiError(500);
    });
    const { result } = poll(fetcher);

    await tick();
    expect(result.current.data).toBeNull();
    expect(result.current.error).not.toBeNull();
    expect(result.current.loading).toBe(false);
  });

  test('stops on a 404 without spending three more requests', async () => {
    const fetcher = vi.fn(async () => {
      throw apiError(404);
    });
    const { result } = poll(fetcher);

    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.stopReason).toBe(POLL_STOP_REASONS.NOT_FOUND);

    await tick(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('page visibility', () => {
  test('a hidden tab does not poll at all', async () => {
    setVisibility('hidden');
    const fetcher = vi.fn(async () => ({ data: [{ id: '1', status: 'pending' }] }));
    poll(fetcher);

    await tick(60_000);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('returning to the foreground polls immediately rather than waiting out the interval', async () => {
    const fetcher = vi.fn(async () => ({ data: [{ id: '1', status: 'pending' }] }));
    poll(fetcher);

    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => setVisibility('hidden'));
    await tick(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => setVisibility('visible'));
    await tick(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('backoff', () => {
  test('an unchanging payload is asked about less often after a minute', async () => {
    const fetcher = vi.fn(async () => ({ data: [{ id: '1', status: 'pending' }] }));
    poll(fetcher);

    await tick();
    // One minute at the 3s base interval: the initial call plus twenty more.
    await tick(60_000);
    const callsAfterOneMinute = fetcher.mock.calls.length;
    expect(callsAfterOneMinute).toBeGreaterThan(15);

    // The next minute is spent on the 8s rung, so far fewer requests.
    await tick(60_000);
    expect(fetcher.mock.calls.length - callsAfterOneMinute).toBeLessThan(callsAfterOneMinute);
  });
});

describe('enabled', () => {
  test('nothing is polled when there is nothing to poll', async () => {
    const fetcher = vi.fn(async () => ({ data: [] }));
    poll(fetcher, { enabled: false });

    await tick(60_000);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
