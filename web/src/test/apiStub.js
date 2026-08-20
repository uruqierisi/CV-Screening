/**
 * A stand-in for the API, wired at `fetch`.
 *
 * Stubbing `fetch` rather than the `src/api/` modules is deliberate: it exercises
 * the URL each screen actually builds, the query string it puts on it and the
 * envelope unwrapping in `client.js`. A stub at the module boundary would let a
 * screen ask for `/candidate/123` forever and still pass.
 *
 * Routes are matched on the path and query, so a test can assert which requests
 * a screen made as well as what it did with the answers.
 */

import { vi } from 'vitest';

/**
 * @param {Array<{ match: RegExp, status?: number, body: any }>} routes
 *   first match wins; `body` is the whole envelope, so a test can send an error
 * @returns {{ fetch: any, calls: string[] }}
 */
export function stubApi(routes) {
  /** @type {string[]} */
  const calls = [];

  const fetchStub = vi.fn(async (url) => {
    calls.push(String(url));
    const route = routes.find((candidate) => candidate.match.test(String(url)));

    if (route === undefined) {
      return jsonResponse(404, {
        error: {
          code: 'NOT_FOUND',
          message: `No stub for ${url}`,
          requestId: 'stub-req-0',
        },
      });
    }

    return jsonResponse(route.status ?? 200, route.body);
  });

  globalThis.fetch = fetchStub;
  return { fetch: fetchStub, calls };
}

/**
 * @param {number} status
 * @param {any} body
 * @returns {Response}
 */
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}
