/**
 * A resource that keeps asking until the data says to stop.
 *
 * ## The stop condition is the data
 *
 * Not "after N attempts" and not "on a timer forever". The caller supplies
 * `isComplete(data, meta)`, and for every screen in this application that
 * predicate is "every candidate I am watching has reached `done` or `failed`".
 * A dashboard that polls a finished batch forever is the bug this hook exists
 * not to have.
 *
 * Everything else is a guard around that one rule:
 *
 * - **chained `setTimeout`**, scheduled after each response settles - never
 *   `setInterval`, which queues a second request while the first is still out;
 * - **one `AbortController` per request**, and a **monotonic request id**, so a
 *   slow earlier response cannot overwrite a fresh one;
 * - **aborts are not failures.** They never increment the failure counter. This
 *   is the classic hand-rolled-polling bug: a tab switch or a re-render aborts a
 *   request, four of those look like four failures, and live updates die on a
 *   perfectly healthy server. It has a dedicated test;
 * - **a hidden tab does not poll at all**, and on return polls immediately at
 *   the base interval;
 * - **a failed poll never replaces rendered data.** It raises a quiet inline
 *   banner and leaves the last good payload on screen, because a table that
 *   turns into an error message because one request out of forty timed out is
 *   worse than a slightly stale table that says so.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePageVisibility } from './usePageVisibility.js';
import { nextIntervalMs, stopReasonFor } from '../lib/pollSchedule.js';

/**
 * @template T
 * @param {object} params
 * @param {(signal: AbortSignal) => Promise<{ data: T, meta?: any }>} params.fetcher
 * @param {(data: T, meta: any) => boolean} params.isComplete the stop condition
 * @param {(data: T, meta: any) => string} [params.signature] change detection,
 *   used only to decide when to back off
 * @param {number} params.intervalMs base interval
 * @param {boolean} [params.enabled]
 * @param {string} [params.resetKey] changing this restarts polling from scratch
 * @returns {{
 *   data: T | null,
 *   meta: any,
 *   loading: boolean,
 *   error: any,
 *   pollError: any,
 *   lastUpdatedAt: number | null,
 *   polling: boolean,
 *   stopReason: string | null,
 *   refresh: () => void,
 * }}
 */
export function usePolledResource({
  fetcher,
  isComplete,
  signature,
  intervalMs,
  enabled = true,
  resetKey = '',
}) {
  const [state, setState] = useState({ data: null, meta: null, loading: true, error: null });
  const [pollError, setPollError] = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [stopReason, setStopReason] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);

  // The callbacks are read through refs so that an inline arrow function in a
  // component does not restart polling on every render. `resetKey` is the
  // explicit, visible way to restart it.
  const callbacks = useRef({ fetcher, isComplete, signature });
  callbacks.current = { fetcher, isComplete, signature };

  const visible = usePageVisibility();

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;
    let timer = null;
    let controller = null;
    let requestId = 0;
    let latestRequestId = 0;
    let consecutiveFailures = 0;
    let lastErrorStatus = null;
    let lastSignature = null;
    let lastChangeAt = Date.now();
    const startedAt = Date.now();

    const schedule = (delay) => {
      if (cancelled) return;
      timer = setTimeout(run, delay);
    };

    const finish = (reason) => {
      if (cancelled) return;
      setStopReason(reason);
    };

    async function run() {
      if (cancelled) return;

      const thisController = new AbortController();
      controller = thisController;
      requestId += 1;
      latestRequestId = requestId;
      const thisRequest = requestId;

      try {
        const { data, meta = null } = await callbacks.current.fetcher(thisController.signal);
        if (cancelled || thisRequest !== latestRequestId) return;

        consecutiveFailures = 0;
        lastErrorStatus = null;
        setPollError(null);
        setState({ data, meta, loading: false, error: null });
        setLastUpdatedAt(Date.now());

        const nextSignature = callbacks.current.signature
          ? callbacks.current.signature(data, meta)
          : null;
        if (nextSignature !== lastSignature) {
          lastSignature = nextSignature;
          lastChangeAt = Date.now();
        }

        if (callbacks.current.isComplete(data, meta)) {
          finish('complete');
          return;
        }
      } catch (error) {
        if (cancelled || thisRequest !== latestRequestId) return;

        // **An abort is never a failure.** Two cases, and they differ only in
        // who owns what happens next:
        //
        //  - this hook's own controller aborted it, which only happens in the
        //    cleanup below, so the cleanup owns the continuation and there is
        //    nothing to schedule;
        //  - something else aborted it, in which case polling carries on at the
        //    normal interval without the failure counter moving.
        //
        // Counting an abort is the classic hand-rolled-polling bug: four tab
        // switches look like four dead requests and live updates stop on a
        // perfectly healthy server.
        if (error?.name === 'AbortError') {
          if (thisController.signal.aborted) return;
        } else {
          consecutiveFailures += 1;
          lastErrorStatus = error?.status ?? null;

          setState((previous) =>
            // Nothing on screen yet: this is the initial load and the error IS
            // the state. Something on screen: keep it, and raise the quiet
            // banner instead of replacing a table with an error message.
            previous.data === null
              ? { data: null, meta: null, loading: false, error }
              : { ...previous, loading: false },
          );
          setPollError(error);
        }
      }

      const reason = stopReasonFor({
        complete: false,
        consecutiveFailures,
        elapsedMs: Date.now() - startedAt,
        lastErrorStatus,
      });
      if (reason !== null) {
        finish(reason);
        return;
      }

      schedule(
        nextIntervalMs({ baseMs: intervalMs, msSinceLastChange: Date.now() - lastChangeAt }),
      );
    }

    if (visible) {
      setStopReason(null);
      // Immediately, at the base interval thereafter. A tab returning to the
      // foreground should not wait five seconds to tell someone what happened
      // while they were away.
      run();
    }

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      if (controller !== null) controller.abort();
    };
  }, [enabled, visible, intervalMs, resetKey, refreshToken]);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);

  return {
    ...state,
    pollError,
    lastUpdatedAt,
    // Live only when it is actually running: enabled, on screen, and not stopped.
    polling: enabled && visible && stopReason === null,
    stopReason,
    refresh,
  };
}
