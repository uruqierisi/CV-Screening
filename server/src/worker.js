/**
 * The screening worker. A separate process from the API, on purpose.
 *
 * Plan section 4's argument, restated in one line: the work does not fit in an
 * HTTP request, so the request records intent and returns, and this process does
 * the work. Everything about this file follows from that split.
 *
 * ## This is still the worker's entry point
 *
 * `RUN_WORKER_IN_PROCESS` lets `server.js` host the worker inside the API
 * process, because free hosting tiers do not offer a second always-on process.
 * That flag changes **where** {@link startScreeningWorker} is called and nothing
 * else: the same builder, the same concurrency, the same lock duration, the same
 * drain. `npm run worker` runs this file, development runs this file, and any
 * deployment with two processes runs this file.
 *
 * The composition is deliberately one-directional - `server.js` imports from
 * here, never the reverse - so the standalone worker never acquires a dependency
 * on the HTTP layer in order to support the co-located mode.
 *
 * ## The concurrency dial
 *
 * `SCREENING_CONCURRENCY` is the number below, and it is the single value that
 * bounds in-flight Anthropic calls for the whole system. A 50-CV batch becomes
 * 50 queued jobs and this many API calls - which is the difference between a
 * batch that completes and a wall of 429s. An operator turns it down to 1 during
 * an incident without a deploy and without touching the queue.
 *
 * ## Lock duration and the 240s deadline
 *
 * The agent layer enforces a hard 240s per-candidate deadline (plan section
 * 5.4), and plan section 4 requires the queue's own timeout to exceed it. BullMQ
 * expresses that as `lockDuration`: a job whose lock expires is considered
 * stalled and handed to another worker, so a lock shorter than the deadline
 * would produce two workers on one candidate - double spend, and the exact race
 * the queue exists to prevent. `LOCK_DURATION_MS` is set above the deadline with
 * room, and a test asserts the inequality rather than trusting the comment.
 *
 * ## Draining
 *
 * On a signal the worker stops taking new jobs and lets the in-flight ones
 * finish, aborting the model calls through a shared signal if they outlast the
 * grace period. A candidate cut short mid-screening surfaces as a retryable
 * `AGENT_TIMEOUT`, which the processor's ordinary failure path releases back to
 * `pending` - so a deploy stalls a screening rather than stranding it. That
 * release is the load-bearing part of the drain and it has its own test.
 */

import { pathToFileURL } from 'node:url';
import { Worker } from 'bullmq';
import pino from 'pino';
import { CANDIDATE_DEADLINE_MS, createAnthropicClient } from './agents/index.js';
import { env } from './config/env.js';
import { closePool, pool } from './db/pool.js';
import { closeRedis, redisConnection } from './queue/connection.js';
import { makeScreeningProcessor } from './queue/processors/screenCandidate.processor.js';
import { SCREENING_QUEUE_NAME } from './queue/screeningQueue.js';
import { closeStorage } from './storage/index.js';
import { REDACTED_LOG_PATHS } from './util/logging.js';

/**
 * How long BullMQ holds a job's lock. Must exceed the agent layer's hard
 * per-candidate deadline, or a slow-but-healthy candidate is declared stalled
 * and screened twice.
 */
export const LOCK_DURATION_MS = CANDIDATE_DEADLINE_MS + 60_000;

/**
 * A stalled check must not run more often than the lock it is checking, or every
 * long candidate looks stalled.
 */
export const STALLED_INTERVAL_MS = LOCK_DURATION_MS;

/** How long a draining worker waits for in-flight candidates before aborting them. */
export const DRAIN_GRACE_MS = 30_000;

/**
 * Builds the worker without starting the process around it, so a test can hold
 * one and close it.
 *
 * @param {object} [options]
 * @param {{ messages: { create: Function, parse: Function } }} [options.client]
 * @param {any} [options.logger]
 * @param {AbortSignal} [options.signal]
 * @returns {Worker}
 */
export function buildScreeningWorker({ client, logger, signal } = {}) {
  const log = logger ?? pino({ level: env.LOG_LEVEL, redact: { paths: [...REDACTED_LOG_PATHS], censor: '[redacted]' } });

  return new Worker(
    SCREENING_QUEUE_NAME,
    makeScreeningProcessor({
      db: pool,
      // Constructed here, once. `createAnthropicClient` throws with a message
      // naming ANTHROPIC_API_KEY if the key is absent - which is why the key is
      // optional in the env schema and fatal here: this is the only process that
      // spends a token.
      client: client ?? createAnthropicClient({ apiKey: env.ANTHROPIC_API_KEY }),
      logger: log,
      signal,
    }),
    {
      connection: redisConnection(),
      // THE DIAL.
      concurrency: env.SCREENING_CONCURRENCY,
      // How long to block on an empty queue. A cost control on a metered Redis,
      // not a latency knob: raising it divides the idle command rate
      // proportionally, and a job added meanwhile wakes the blocked `bzpopmin`
      // immediately rather than waiting the timeout out. See the note in
      // `config/env.js` and the measurements in `test/queue/idleCost.test.js`.
      drainDelay: env.SCREENING_DRAIN_DELAY_S,
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      // One stall is a crashed worker and worth re-running. Repeated stalls on
      // the same candidate are a candidate that kills workers, and re-running it
      // forever would take the queue down with it.
      maxStalledCount: 1,
    },
  );
}

/**
 * Builds a worker, attaches its logging, and returns it with the drain that
 * stops it cleanly.
 *
 * This exists so that `main()` below and `server.js`'s co-located mode run
 * **identical** shutdown code rather than two similar-looking copies. The drain
 * is the part with the subtle ordering in it, and a second copy of it is a
 * second thing to get wrong on the day somebody edits one.
 *
 * It deliberately does **not** close the Redis connection, the pool or the
 * storage client. Those are process-wide and belong to whoever owns the process:
 * `main()` here, `server.js` there. A worker that closed the pool out from under
 * an API still answering requests would be the co-located mode's first bug.
 *
 * @param {object} [options]
 * @param {any} [options.logger]
 * @param {{ messages: { create: Function, parse: Function } }} [options.client]
 * @param {number} [options.graceMs] overridable for tests; never in production
 * @returns {{ worker: Worker, close: () => Promise<void> }}
 */
export function startScreeningWorker({ logger, client, graceMs = DRAIN_GRACE_MS } = {}) {
  const log = logger ?? pino({ level: env.LOG_LEVEL, redact: { paths: [...REDACTED_LOG_PATHS], censor: '[redacted]' } });

  // One controller for every in-flight candidate's model calls, so a drain that
  // runs out of patience cancels them all at once rather than waiting for the
  // slowest.
  const drain = new AbortController();
  const worker = buildScreeningWorker({ client, logger: log, signal: drain.signal });

  worker.on('failed', (job, error) => {
    log.error(
      { jobId: job?.id, candidateId: job?.data?.candidateId, attempts: job?.attemptsMade, err: error },
      'screening job failed',
    );
  });
  worker.on('error', (error) => {
    log.error({ err: error }, 'worker error');
  });

  log.info(
    {
      queue: SCREENING_QUEUE_NAME,
      concurrency: env.SCREENING_CONCURRENCY,
      lockDurationMs: LOCK_DURATION_MS,
      candidateDeadlineMs: CANDIDATE_DEADLINE_MS,
    },
    'screening worker started',
  );

  return {
    worker,
    close: async () => {
      log.info({ graceMs }, 'draining screening worker');

      const abortTimer = setTimeout(() => {
        log.warn('drain grace expired; aborting in-flight candidates');
        drain.abort();
      }, graceMs);
      // Do not hold the process open just to fire the abort.
      abortTimer.unref?.();

      try {
        // `false` means "wait for in-flight jobs"; the abort above is what
        // bounds that wait. An aborted model call raises a retryable
        // AGENT_TIMEOUT, and the processor releases the candidate back to
        // `pending` on its ordinary failure path - which is why a drained
        // candidate is re-screenable rather than stranded in `evaluating`.
        await worker.close(false);
      } finally {
        clearTimeout(abortTimer);
      }
    },
  };
}

async function main() {
  const log = pino({
    level: env.LOG_LEVEL,
    redact: { paths: [...REDACTED_LOG_PATHS], censor: '[redacted]' },
  });

  const { close } = startScreeningWorker({ logger: log });

  let closing = false;
  const shutdown = async (/** @type {string} */ signal) => {
    if (closing) return;
    closing = true;

    log.info({ signal }, 'shutting down');
    try {
      await close();
    } finally {
      await closeStorage();
      await closeRedis();
      await closePool();
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }
}

// Only when executed directly, so a test can import `buildScreeningWorker`
// without starting a worker.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`worker failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
}
