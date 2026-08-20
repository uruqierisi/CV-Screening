/**
 * The screening queue: one named job, one typed payload, one retry policy.
 *
 * Plan section 4 argues why a queue exists at all. This file is the five
 * properties it argues for, made concrete:
 *
 * 1. **Handover without loss** - the candidate row is committed before anything
 *    here is called. Postgres is the durable record; Redis is rebuildable.
 * 2. **Exactly one worker at a time** - the BullMQ `jobId` *is* the candidate
 *    UUID, so a duplicate enqueue is a no-op rather than a second job, and the
 *    queue's own in-flight lock does the rest.
 * 3. **Retry with backoff, and a place for the dead** - `attempts` and
 *    exponential `backoff` from the env schema, and `removeOnFail: false` so a
 *    candidate that exhausted its attempts is still in Redis' failed set with
 *    its error attached. That set is the dead-letter path.
 * 4. **Concurrency you can turn down** - not here; it is the Worker's, in
 *    `worker.js`, from `SCREENING_CONCURRENCY`.
 * 5. **Failure isolation** - one job per candidate, so one malformed PDF fails
 *    one candidate.
 *
 * ## What happens on the last failure
 *
 * Stated plainly, because "it goes to a dead-letter queue" is not an answer. The
 * processor marks the candidate `failed` in Postgres **before** it rethrows, so
 * the durable record of the failure - status, `error_code`, `error_message`,
 * `completed_at` - is correct whether or not anybody ever looks at Redis. The
 * job then lands in BullMQ's failed set and stays there (`removeOnFail: false`),
 * which is where an operator reads the stack. Nothing retries it automatically
 * after that: recovery is `POST /candidates/:id/retry`, which is a human
 * deciding to spend the API budget again.
 */

import { Queue } from 'bullmq';
import { z } from 'zod';
import { env } from '../config/env.js';
import { redisConnection } from './connection.js';

/** The queue's name in Redis. Changing it strands anything already queued. */
export const SCREENING_QUEUE_NAME = 'candidate-screening';

/** The one job name on this queue. */
export const SCREEN_CANDIDATE_JOB = 'screen-candidate';

/**
 * The typed payload.
 *
 * One field, on purpose. Everything else the worker needs - the role, the
 * criteria, the file path - is read from Postgres at the moment the job runs, so
 * a job that sat in the queue while a role was edited screens against the role
 * as it is now rather than against a stale copy embedded in Redis. The cost,
 * accepted: one extra round trip per candidate.
 */
export const screeningJobPayloadSchema = z
  .object({
    candidateId: z.string().uuid(),
  })
  .strict();

/**
 * @typedef {import('zod').infer<typeof screeningJobPayloadSchema>} ScreeningJobPayload
 */

/**
 * Default job options, exported so the worker's lock duration can be checked
 * against the agent layer's deadline in a test rather than by eye.
 *
 * `removeOnComplete` keeps a bounded window of successes for debugging without
 * letting Redis grow without limit. `removeOnFail: false` keeps failures
 * indefinitely - they are the thing anybody actually goes looking for.
 */
export function defaultJobOptions() {
  return {
    attempts: env.SCREENING_JOB_ATTEMPTS,
    backoff: { type: 'exponential', delay: env.SCREENING_JOB_BACKOFF_MS },
    removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
    removeOnFail: false,
  };
}

/**
 * The queue-job id for a manual retry.
 *
 * Exported so the shape is asserted in one place rather than rebuilt by a test
 * that could agree with a bug.
 *
 * @param {string} candidateId
 * @param {number} attempt `candidates.attempts` after the retry bump
 * @returns {string}
 */
export function retryJobId(candidateId, attempt) {
  return `${candidateId}-retry-${attempt}`;
}

/** @type {Queue | null} */
let queue = null;

/**
 * The shared queue instance. Lazy for the same reason the connection is.
 *
 * @returns {Queue}
 */
export function screeningQueue() {
  if (queue === null) {
    queue = new Queue(SCREENING_QUEUE_NAME, {
      connection: redisConnection(),
      defaultJobOptions: defaultJobOptions(),
    });
  }
  return queue;
}

/**
 * Enqueues one candidate.
 *
 * **Called strictly after COMMIT** (plan section 4), so a worker can never pick
 * up a row that is not yet visible. The cost of that ordering is recorded there
 * too: a crash between commit and enqueue leaves the candidate `pending` until
 * `scripts/reconcileStuck.js` runs, and that script is manual.
 *
 * `jobId` is the candidate UUID for a first attempt. A **retry** must pass
 * `attempt`, because the original job id has been consumed - BullMQ will not
 * accept a job whose id already exists, even a completed one, so a retry under
 * the same id would silently do nothing.
 *
 * **The separator is a hyphen, not the colon plan section 3 specified.** BullMQ
 * rejects a custom job id containing `:` outright - `Error: Custom Id cannot
 * contain :` - because it builds its own Redis keys with that separator. The
 * plan was written before this was known and has been corrected rather than
 * left describing an id this queue will not accept. The shape and the reasoning
 * are unchanged: one fresh, deterministic id per manual retry, derived from the
 * candidate and its attempt count, so a double-clicked Retry cannot produce two
 * screenings either.
 *
 * @param {object} input
 * @param {string} input.candidateId
 * @param {number} [input.attempt] `candidates.attempts` after the retry bump;
 *   omit for a first enqueue
 * @param {Queue} [input.queue] injectable, for tests
 * @returns {Promise<string>} the queue-job id actually used
 */
export async function enqueueCandidate({ candidateId, attempt, queue: injected }) {
  const jobId = attempt === undefined ? candidateId : retryJobId(candidateId, attempt);

  await (injected ?? screeningQueue()).add(
    SCREEN_CANDIDATE_JOB,
    { candidateId },
    { jobId },
  );

  return jobId;
}

/**
 * Enqueues a batch, one job per candidate.
 *
 * `addBulk` rather than a loop of `add`: one round trip instead of N, and - more
 * to the point - a 50-CV upload should not spend 50 sequential Redis round trips
 * inside the request that is about to return 202.
 *
 * A failure here does **not** roll anything back. The candidates are already
 * committed, in `pending`; `reconcileStuck.js` is the recovery path, and the
 * upload still returns 202 because the work was durably recorded. The caller
 * logs the failure.
 *
 * @param {object} input
 * @param {string[]} input.candidateIds
 * @param {Queue} [input.queue] injectable, for tests
 * @returns {Promise<string[]>} the queue-job ids
 */
export async function enqueueCandidates({ candidateIds, queue: injected }) {
  if (candidateIds.length === 0) return [];

  await (injected ?? screeningQueue()).addBulk(
    candidateIds.map((candidateId) => ({
      name: SCREEN_CANDIDATE_JOB,
      data: { candidateId },
      opts: { jobId: candidateId },
    })),
  );

  return [...candidateIds];
}

/**
 * Closes the shared queue, if one was opened.
 *
 * @returns {Promise<void>}
 */
export async function closeScreeningQueue() {
  if (queue === null) return;
  const current = queue;
  queue = null;
  await current.close();
}
