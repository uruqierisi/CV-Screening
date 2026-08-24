/**
 * The Redis connection BullMQ uses, created lazily and exactly once.
 *
 * Lazy because `src/config/env.js` gives `REDIS_URL` a default and the API
 * process, the worker process, the migration script and the test suite all
 * import different parts of this tree. Connecting at import time would mean a
 * machine with no Redis cannot run `npm run migrate` - the same reason the
 * Anthropic key is checked at the point of use rather than at startup.
 *
 * `maxRetriesPerRequest: null` is not a preference: BullMQ's blocking commands
 * require it, and ioredis' default of 20 makes a worker throw during a Redis
 * failover instead of waiting through it.
 */

import IORedis from 'ioredis';
import { env } from '../config/env.js';

/** @type {import('ioredis').Redis | null} */
let connection = null;

/**
 * @returns {import('ioredis').Redis} shared across every Queue and Worker in
 *   this process, which is what BullMQ expects and what keeps one process to one
 *   connection
 */
export function redisConnection() {
  if (connection === null) {
    connection = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      // Without this, a Redis that is down at startup produces an unhandled
      // rejection from the constructor rather than a retrying client.
      enableOfflineQueue: true,
    });

    // An 'error' event with no listener is an unhandled error event, which takes
    // the process down. Logged to stderr rather than swallowed: a Redis that
    // cannot be reached is the difference between "uploads queue work" and
    // "uploads silently do nothing".
    connection.on('error', (error) => {
      process.stderr.write(`redis connection error: ${error.message}\n`);
    });
  }

  return connection;
}

/**
 * Closes the shared connection, if one was ever opened.
 *
 * @returns {Promise<void>}
 */
export async function closeRedis() {
  if (connection === null) return;
  const current = connection;
  connection = null;
  await current.quit();
}

/**
 * Liveness for `GET /health`.
 *
 * **It must be bounded, and that is not a defensive nicety.** The connection
 * above is built with `enableOfflineQueue: true`, which means a command issued
 * while ioredis is disconnected is *buffered* rather than rejected - the client
 * holds it and keeps retrying the connection. So a `ping()` against an
 * unreachable Redis never settles: it does not throw, it does not resolve, and
 * the `catch` below is unreachable. Without the timeout, `/health` hangs instead
 * of answering 503, and a health check that hangs is one no load balancer and no
 * operator can act on - which is precisely the failure the endpoint exists to
 * prevent.
 *
 * The timeout is the whole fix. It converts "we cannot tell" into "not
 * reachable", which is the only answer a caller has a use for.
 *
 * Note that this **does** open the connection if none is open yet - it calls
 * `redisConnection()`, which is lazy. An earlier version of this comment claimed
 * otherwise; the code was always this way and the comment was wrong. Opening it
 * is the correct behaviour for a health check: a process that has not yet talked
 * to Redis has not yet proven it can, and reporting `true` on that basis would
 * be reporting on a connection nobody has tested.
 *
 * @param {number} [timeoutMs] defaults to `DEPENDENCY_CHECK_TIMEOUT_MS`
 * @returns {Promise<boolean>}
 */
export async function redisReachable(timeoutMs = env.DEPENDENCY_CHECK_TIMEOUT_MS) {
  return withTimeout(async () => (await redisConnection().ping()) === 'PONG', timeoutMs);
}

/**
 * Runs a probe, answering `false` if it throws or outruns the budget.
 *
 * Exported because `/health`'s database probe needs exactly the same bound for a
 * different reason - `pg` has its own `connectionTimeoutMillis`, but a socket
 * that connects and then goes quiet is not covered by it - and two health probes
 * with two different notions of "too long" is how one of them ends up unbounded.
 *
 * The timer is `unref`'d so a fast probe leaves nothing holding the event loop
 * open, and cleared so a slow one leaves nothing behind either.
 *
 * @param {() => Promise<boolean>} probe
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export async function withTimeout(probe, timeoutMs) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;

  try {
    return await Promise.race([
      probe().catch(() => false),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
