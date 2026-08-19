/**
 * The tripwire. If a unit test reaches the network, it fails here.
 *
 * The agent layer's boundary discipline is dependency injection: only
 * `client/anthropic-client.js` imports the SDK, and every other function takes
 * `{ client, now, logger }`. That is what makes the suite network-free *without
 * module mocking* - but "makes" is a claim about code somebody will edit later,
 * and a claim nobody has tested is a wish.
 *
 * So `fetch` is replaced with something that throws, and a test asserts it
 * throws. If a future change constructs a real client, or a fixture forgets to
 * inject one, the failure is immediate and says exactly what happened - rather
 * than a suite that mysteriously takes eleven seconds, or worse, one that quietly
 * spends money on a CI runner that happens to have a key in its environment.
 *
 * Why `fetch` specifically: it is the transport the Anthropic SDK uses. This is
 * not a general network jail - a determined `node:net` socket would walk past it
 * - and it does not pretend to be one. It guards the one route the code under
 * test could plausibly take.
 *
 * **Installed on the `unit` project only.** The `db` project is *supposed* to
 * open a socket; it talks to a real Postgres from docker-compose, and a tripwire
 * there would be theatre. Postgres does not speak HTTP, so the two projects need
 * different rules and get them.
 */

import { beforeEach } from 'vitest';

/**
 * Thrown instead of making a request. A distinct class so a test can assert on
 * the type rather than on the wording of a message.
 */
export class NetworkAccessInTestError extends Error {
  /**
   * @param {string} target where the call was headed, for the report
   */
  constructor(target) {
    super(
      [
        `Network access from a unit test: fetch("${target}").`,
        '',
        'No test in the `unit` project may reach the network. The agent layer takes',
        'its client by injection precisely so that it does not have to: pass a fake',
        '`{ messages: { parse } }` object instead of constructing a real one.',
        '',
        'If you are seeing this from library code, something now constructs an',
        'Anthropic client where it used to be handed one.',
      ].join('\n'),
    );
    this.name = 'NetworkAccessInTestError';
    /** @type {string} */
    this.target = target;
  }
}

/**
 * The replacement for `globalThis.fetch`. Exported so the test that proves the
 * tripwire fires can call it directly as well as through the global.
 *
 * Synchronously throwing rather than returning a rejected promise: an
 * unhandled-rejection warning three ticks later is a much worse failure report
 * than a stack trace pointing at the caller.
 *
 * @param {unknown} input
 * @returns {never}
 */
export function forbiddenFetch(input) {
  const target =
    typeof input === 'string'
      ? input
      : ((/** @type {any} */ (input))?.url ?? String(input));
  throw new NetworkAccessInTestError(target);
}

globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (forbiddenFetch));

// Re-armed before every test, so a test that deliberately stubs `fetch` cannot
// leave the next one unguarded. Order matters: a `beforeEach` registered in a
// setup file runs before the ones in the test file itself.
beforeEach(() => {
  globalThis.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (forbiddenFetch));
});
