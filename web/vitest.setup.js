/**
 * The one global the suite needs, and a tripwire.
 *
 * `matchMedia` is not implemented by jsdom and nothing here uses it, so it is
 * absent rather than stubbed - if a component starts calling it, the failure
 * should say so.
 *
 * The tripwire mirrors the server's: no test in this suite may reach the
 * network. Every test that needs an API response injects one. A `fetch` that
 * escapes a test double is a test that passes or fails depending on whether the
 * API happens to be running, which is not a test.
 */
import { afterEach, beforeEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = () => {
    throw new Error('A test performed a real fetch(). Inject a response instead.');
  };
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

expect.extend({});
