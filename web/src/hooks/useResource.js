/**
 * One fetch, three states, and a way to do it again.
 *
 * This is the hook behind every screen that reads something once. It exists so
 * that "loading, empty, error" is the *default* shape of a data view rather than
 * something each page remembers to write - the empty case is the caller's, since
 * only the caller knows what empty means, but loading and error are here.
 *
 * Server data lives in here and nowhere else. Nothing copies `data` into its own
 * `useState`, because the copy is what drifts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * @template T
 * @param {(signal: AbortSignal) => Promise<{ data: T, meta?: any }>} fetcher
 *   must be stable - wrap it in `useCallback` with the values it closes over
 * @returns {{
 *   data: T | null,
 *   meta: any,
 *   loading: boolean,
 *   error: import('../api/client.js').ApiError | null,
 *   reload: () => void,
 * }}
 */
export function useResource(fetcher) {
  const [state, setState] = useState({ data: null, meta: null, loading: true, error: null });
  const [reloadToken, setReloadToken] = useState(0);
  // A monotonic id, so a slow earlier response cannot overwrite a fresh one.
  const requestIdRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    setState((previous) => ({ ...previous, loading: true, error: null }));

    fetcher(controller.signal)
      .then(({ data, meta }) => {
        if (requestId !== requestIdRef.current) return;
        setState({ data, meta: meta ?? null, loading: false, error: null });
      })
      .catch((error) => {
        // An abort is this hook cancelling its own work. It is not a failure and
        // must not become an error state, or unmounting a screen would flash one.
        if (error?.name === 'AbortError') return;
        if (requestId !== requestIdRef.current) return;
        setState({ data: null, meta: null, loading: false, error });
      });

    return () => controller.abort();
  }, [fetcher, reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  return { ...state, reload };
}
