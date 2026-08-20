/**
 * The screening worker. A separate process from the API, on purpose.
 *
 * Plan section 4's argument, restated in one line: the work does not fit in an
 * HTTP request, so the request records intent and returns, and this process does
 * the work. Everything about this file follows from that split.
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
 * grace period. A candidate cut short mid-screening is released back to
 * `pending` by the processor's ordinary retryable path, so nothing is stranded
 * by a deploy.
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
      lockDuration: LOCK_DURATION_MS,
      stalledInterval: STALLED_INTERVAL_MS,
      // One stall is a crashed worker and worth re-running. Repeated stalls on
      // the same candidate are a candidate that kills workers, and re-running it
      // forever would take the queue down with it.
      maxStalledCount: 1,
    },
  );
}

async function main() {
  const log = pino({
    level: env.LOG_LEVEL,
    redact: { paths: [...REDACTED_LOG_PATHS], censor: '[redacted]' },
  });

  // One controller for the whole process: every in-flight candidate's model
  // calls hang off it, so a drain that runs out of patience cancels them all at
  // once rather than waiting for the slowest.
  const drain = new AbortController();

  const worker = buildScreeningWorker({ logger: log, signal: drain.signal });

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

  let closing = false;
  const shutdown = async (/** @type {string} */ signal) => {
    if (closing) return;
    closing = true;

    log.info({ signal, graceMs: DRAIN_GRACE_MS }, 'draining screening worker');

    const abortTimer = setTimeout(() => {
      log.warn('drain grace expired; aborting in-flight candidates');
      drain.abort();
    }, DRAIN_GRACE_MS);
    // Do not hold the process open just to fire the abort.
    abortTimer.unref?.();

    try {
      // `false` means "wait for in-flight jobs"; the abort above is what bounds
      // that wait.
      await worker.close(false);
    } finally {
      clearTimeout(abortTimer);
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
