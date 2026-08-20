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
 * Deliberately opens nothing new when nothing is open: health is a report on the
 * process as it is, and a check that establishes the connection it is checking
 * would report success on a system nobody had used yet.
 *
 * @returns {Promise<boolean>}
 */
export async function redisReachable() {
  try {
    const result = await redisConnection().ping();
    return result === 'PONG';
  } catch {
    return false;
  }
}
