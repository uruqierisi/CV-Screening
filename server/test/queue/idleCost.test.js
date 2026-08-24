import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';

/**
 * What an idle worker costs, and what a longer block costs in latency.
 *
 * This exists because the deployment target's Redis is metered. Upstash's free
 * tier is 500,000 commands per **month**, and the question "does a worker that
 * is doing nothing fit inside that" turned out to have a surprising answer:
 * measured against `bullmq@6.1.2`, an idle worker at the library default issues
 * roughly 100 commands per minute, not the ~12 a single 5-second blocking pop
 * would suggest. Each idle cycle is a `bzpopmin`, an `evalsha`, the six inner
 * commands Redis attributes to that script, and a connection keepalive `ping`.
 *
 * `SCREENING_DRAIN_DELAY_S` is the dial that fixes it. These two tests are the
 * evidence for the two claims made about it in `config/env.js`:
 *
 * 1. raising it cuts the idle command rate, and
 * 2. it costs **nothing** in pickup latency, because a job added while the
 *    worker is blocked wakes the `bzpopmin` immediately.
 *
 * Claim 2 is the load-bearing one. If it were false, the dial would be trading
 * a recruiter's wait for a Redis bill, which is not a trade worth making.
 *
 * Each test owns a throwaway queue name so it never touches the queue a
 * developer's own worker is draining.
 *
 * ## Where this runs
 *
 * Counting commands needs `CONFIG RESETSTAT`, which managed Redis tiers refuse
 * because it is server-wide. Against one of those the first suite skips with
 * that as its reason rather than failing and reading as a broken test. The
 * latency suite needs no such thing and runs everywhere - which is the right way
 * round, because it is the one whose failure would mean the dial is trading a
 * recruiter's wait for a Redis bill.
 */

/** Deliberately short: enough cycles to compare, fast enough to live in a suite. */
const SAMPLE_MS = 12_000;

/** @type {Array<() => Promise<unknown>>} */
const cleanups = [];

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
});

/**
 * A connection of this test's own. The shared one is deliberately not used: this
 * file counts commands, and sharing a connection with the code under test would
 * mean counting the counter.
 *
 * @returns {IORedis}
 */
function adminConnection() {
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  cleanups.push(() => connection.quit());
  return connection;
}

/**
 * Total commands the Redis server has processed since the last RESETSTAT.
 *
 * `INFO commandstats` is the server's own counter, which is the only honest
 * source: counting client-side calls would miss that Redis attributes the six
 * inner commands of BullMQ's Lua script individually.
 *
 * @param {IORedis} connection
 * @returns {Promise<number>}
 */
async function totalCommands(connection) {
  const info = await connection.info('commandstats');
  let total = 0;
  for (const line of info.split('\n')) {
    const match = line.match(/^cmdstat_([a-z|]+):calls=(\d+)/i);
    // The measuring connection's own INFO and CONFIG calls are counted by the
    // server too, and must not be attributed to the worker.
    if (match && match[1] !== 'info' && !match[1].startsWith('config')) {
      total += Number(match[2]);
    }
  }
  return total;
}

/**
 * Whether this Redis will let the suite reset its command counters.
 *
 * Managed tiers refuse `CONFIG` outright - it is server-wide, and on a shared
 * instance one tenant resetting another's statistics is not a thing they are
 * going to allow. Upstash is the specific case that matters here, because it is
 * the deployment target this whole dial exists for.
 *
 * Distinguishing "refused" from "unreachable" is the point of connecting first.
 * A Redis that is simply down must stay a loud failure, exactly as it is for
 * `screeningQueue.test.js` next door; only a live Redis that says no to the
 * command gets the skip.
 *
 * @returns {Promise<boolean>}
 */
async function canResetStats() {
  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

  try {
    await connection.connect();
  } catch {
    // Unreachable, not refused. Let the suite run and fail on its own terms.
    await connection.quit().catch(() => {});
    return true;
  }

  try {
    await connection.config('RESETSTAT');
    return true;
  } catch {
    return false;
  } finally {
    await connection.quit().catch(() => {});
  }
}

const CAN_RESET_STATS = await canResetStats();

/**
 * Runs an idle worker for a fixed window and returns the commands it issued.
 *
 * @param {number} drainDelay seconds
 * @returns {Promise<number>}
 */
async function idleCommands(drainDelay) {
  const admin = adminConnection();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const queueName = `test-idle-${randomUUID()}`;

  const worker = new Worker(queueName, async () => undefined, {
    connection,
    drainDelay,
    concurrency: 1,
  });
  await worker.waitUntilReady();

  // Reset after the handshake and script loading, so the window measures
  // steady-state idling rather than startup.
  await admin.config('RESETSTAT');
  const before = await totalCommands(admin);
  await new Promise((resolve) => setTimeout(resolve, SAMPLE_MS));
  const after = await totalCommands(admin);

  await worker.close(true);
  await connection.quit();

  return after - before;
}

if (CAN_RESET_STATS) {
  describe('what an idle worker costs in Redis commands', () => {
    it('issues markedly fewer commands with a longer block, which is the whole dial', async () => {
      const brisk = await idleCommands(2);
      const patient = await idleCommands(12);

      // Not an exact ratio. The connection keepalive `ping` fires on its own
      // 3-second schedule and is unaffected by `drainDelay`, so the saving is
      // real but bounded - which is itself worth knowing, because it means this
      // dial cannot take an always-on worker under Upstash's free tier on its
      // own.
      expect(patient).toBeLessThan(brisk);

      // A floor rather than a precise figure: the point is that the reduction is
      // a multiple, not a rounding difference.
      expect(brisk / Math.max(patient, 1)).toBeGreaterThan(1.5);
    }, 60_000);
  });
} else {
  // Only this half needs the counters. The latency test below runs anywhere,
  // and it is the half that would make the dial a bad trade if it failed.
  describe('what an idle worker costs in Redis commands', () => {
    it.skip('needs a Redis that permits CONFIG RESETSTAT; this one refuses it', () => {});
  });
}

describe('what a longer block costs in latency', () => {
  it('picks up a job added mid-block without waiting out the timeout', async () => {
    // The claim under test: `drainDelay` bounds how long the worker waits on an
    // EMPTY queue, and a job arriving during that wait wakes the blocking pop
    // immediately. If this were false, raising the dial would make a recruiter
    // wait, and the dial would not be worth having.
    const drainDelay = 30;
    const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    const queueName = `test-wake-${randomUUID()}`;

    const queue = new Queue(queueName, { connection });
    /** @type {(value: number) => void} */
    let resolvePickedUp;
    const pickedUp = new Promise((resolve) => {
      resolvePickedUp = resolve;
    });

    const worker = new Worker(
      queueName,
      async () => {
        resolvePickedUp(Date.now());
        return undefined;
      },
      { connection, drainDelay, concurrency: 1 },
    );
    await worker.waitUntilReady();

    // Let the worker settle into the blocking read before the job is added, so
    // this measures a wake-up and not a startup.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const addedAt = Date.now();
    await queue.add('wake', {});
    const latencyMs = (await pickedUp) - addedAt;

    await worker.close(true);
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close();
    await connection.quit();

    // Generous by two orders of magnitude against the 30s block it could have
    // waited, and still decisive: anything near `drainDelay` would mean the
    // worker slept through the job.
    expect(latencyMs).toBeLessThan(3000);
  }, 60_000);
});
