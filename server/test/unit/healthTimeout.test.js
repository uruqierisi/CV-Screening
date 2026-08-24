import { describe, expect, it } from 'vitest';
import { withTimeout } from '../../src/queue/connection.js';

/**
 * **Why `/health` needs a timeout, and what it is protecting against.**
 *
 * The failure this fixes is specific and it is not "a slow dependency". The
 * Redis connection is built with `enableOfflineQueue: true`, which means a
 * command issued while ioredis is disconnected is *buffered* rather than
 * rejected - the client holds it and keeps retrying the connection. So a `ping()`
 * against an unreachable Redis **never settles**: it does not resolve, it does
 * not throw, and the `catch` that was supposed to answer `false` is unreachable.
 *
 * The consequence was a `/health` that hangs rather than answering 503. A health
 * check that hangs is strictly worse than one that is wrong, because a load
 * balancer, a platform health probe and a human with curl all get nothing they
 * can act on - which is the exact failure the endpoint exists to prevent.
 *
 * The first test below is that never-settling promise, reproduced directly. A
 * test that merely used a slow-but-settling probe would pass against the broken
 * version too, and would have caught nothing.
 */

describe('withTimeout', () => {
  it('answers false for a probe that never settles', async () => {
    // The buffered-command case, exactly: a promise with no path to resolution.
    // Without the timeout this test would hang the suite rather than fail it,
    // which is what the endpoint was doing to callers.
    const started = Date.now();
    const result = await withTimeout(() => new Promise(() => {}), 100);

    expect(result).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('answers false for a probe that rejects', async () => {
    // The ordinary case - connection refused, auth failure - which the original
    // try/catch already handled and which must keep working.
    expect(await withTimeout(async () => { throw new Error('ECONNREFUSED'); }, 500)).toBe(false);
  });

  it('passes a healthy probe through unchanged', async () => {
    expect(await withTimeout(async () => true, 500)).toBe(true);
  });

  it('does not turn a probe that answers false into a timeout', async () => {
    // `false` and "timed out" are the same answer to the caller, but conflating
    // them here would hide a probe that is working and reporting a real problem.
    expect(await withTimeout(async () => false, 500)).toBe(false);
  });

  it('resolves as soon as the probe does rather than waiting out the budget', async () => {
    const started = Date.now();
    expect(await withTimeout(async () => true, 5000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
