/**
 * True once something has been loading for longer than it should.
 *
 * This exists for one specific, honest purpose: the deployed API runs on a free
 * tier that suspends the service after fifteen minutes of inactivity, and the
 * next request pays a cold start of up to a minute. An unexplained spinner for
 * fifty seconds reads as broken software. A spinner that says *"waking the
 * free-tier API - this takes up to a minute on first load"* reads as software
 * whose author knew what they deployed.
 *
 * **It is a threshold, not a label.** The message must not be shown to everyone
 * on every load, because the overwhelming majority of requests answer in
 * milliseconds and an apology attached to those is noise that trains people to
 * ignore the one time it matters. So nothing appears until the wait is already
 * abnormal, and then it explains itself.
 *
 * The timer is cleared when loading stops, so a fast load never schedules a
 * state update that would land after the component has moved on.
 */

import { useEffect, useState } from 'react';

/**
 * How long a request may take before it is worth explaining. Comfortably longer
 * than any healthy request to a warm API, and comfortably shorter than the cold
 * start it is describing - so the message appears while the user is still
 * wondering, rather than after they have given up.
 */
export const SLOW_REQUEST_MS = 2500;

/**
 * @param {boolean} loading whether a request is currently in flight
 * @param {number} [thresholdMs]
 * @returns {boolean} true once `loading` has been true for longer than the threshold
 */
export function useSlowRequest(loading, thresholdMs = SLOW_REQUEST_MS) {
  const [isSlow, setIsSlow] = useState(false);

  useEffect(() => {
    if (!loading) {
      // Reset on the way out, so a later reload starts from "not slow" rather
      // than inheriting the previous attempt's verdict.
      setIsSlow(false);
      return undefined;
    }

    const timer = setTimeout(() => setIsSlow(true), thresholdMs);
    return () => clearTimeout(timer);
  }, [loading, thresholdMs]);

  return isSlow;
}
