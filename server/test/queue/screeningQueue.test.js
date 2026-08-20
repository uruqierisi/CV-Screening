import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { redisConnection, closeRedis, redisReachable } from '../../src/queue/connection.js';
import {
  SCREEN_CANDIDATE_JOB,
  defaultJobOptions,
  enqueueCandidate,
  enqueueCandidates,
} from '../../src/queue/screeningQueue.js';

/**
 * The one group of tests that genuinely needs Redis.
 *
 * Everything else about the upload and retry paths is tested with an injected
 * fake, because the API's job is to record intent durably and hand it over, and
 * none of that needs a queue to be true. What *does* need a real queue is the
 * claim plan section 4 rests on: **the BullMQ `jobId` is the candidate UUID,
 * which makes a duplicate enqueue a no-op rather than a second set of LLM
 * calls.** That is a property of BullMQ, so it is asserted against BullMQ.
 *
 * A throwaway queue name per run keeps this out of the queue a developer's own
 * worker is draining.
 */

/** @type {Queue} */
let queue;
/** @type {string} */
let queueName;

beforeEach(async () => {
  queueName = `test-screening-${randomUUID()}`;
  queue = new Queue(queueName, {
    connection: redisConnection(),
    defaultJobOptions: defaultJobOptions(),
  });
  await queue.drain(true);
});

afterAll(async () => {
  await queue?.obliterate({ force: true }).catch(() => {});
  await queue?.close();
  await closeRedis();
});

describe('the connection', () => {
  it('answers a ping', async () => {
    expect(await redisReachable()).toBe(true);
  });
});

describe('enqueueCandidate', () => {
  it('adds one job under the candidate UUID', async () => {
    const candidateId = randomUUID();

    const jobId = await enqueueCandidate({ candidateId, queue });

    expect(jobId).toBe(candidateId);
    const job = await queue.getJob(candidateId);
    expect(job?.name).toBe(SCREEN_CANDIDATE_JOB);
    expect(job?.data).toEqual({ candidateId });
  });

  it('makes a duplicate enqueue a no-op rather than a second job', async () => {
    const candidateId = randomUUID();

    await enqueueCandidate({ candidateId, queue });
    await enqueueCandidate({ candidateId, queue });

    // The deduplication plan section 4 relies on, and the reason
    // `reconcileStuck.js` is safe to run twice: re-enqueueing something already
    // queued cannot produce a second screening or a second bill.
    expect(await queue.getWaitingCount()).toBe(1);
  });

  it('carries the retry policy from the environment onto the job', async () => {
    const candidateId = randomUUID();
    await enqueueCandidate({ candidateId, queue });

    const job = await queue.getJob(candidateId);
    expect(job?.opts.attempts).toBe(defaultJobOptions().attempts);
    expect(job?.opts.backoff).toMatchObject({ type: 'exponential' });
    // The dead-letter path: a candidate that exhausts its attempts stays in the
    // failed set with its error for an operator to read.
    expect(job?.opts.removeOnFail).toBe(false);
  });

  it('accepts a retry under a fresh id, because the original one is consumed', async () => {
    const candidateId = randomUUID();
    await enqueueCandidate({ candidateId, queue });

    const retryJobId = await enqueueCandidate({ candidateId, attempt: 1, queue });

    // A colon here would be rejected outright by BullMQ, which is how the
    // plan's original `candidateId:attempts` was found to be unusable.
    expect(retryJobId).toBe(`${candidateId}-retry-1`);
    expect(await queue.getWaitingCount()).toBe(2);
    expect((await queue.getJob(retryJobId))?.data).toEqual({ candidateId });
  });
});

describe('enqueueCandidates', () => {
  it('adds one job per candidate in a single round trip', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];

    expect(await enqueueCandidates({ candidateIds: ids, queue })).toEqual(ids);
    expect(await queue.getWaitingCount()).toBe(3);
    for (const id of ids) {
      expect((await queue.getJob(id))?.data).toEqual({ candidateId: id });
    }
  });

  it('de-duplicates a batch that overlaps one already queued', async () => {
    const shared = randomUUID();
    await enqueueCandidate({ candidateId: shared, queue });

    await enqueueCandidates({ candidateIds: [shared, randomUUID()], queue });

    expect(await queue.getWaitingCount()).toBe(2);
  });

  it('touches Redis not at all for an empty batch', async () => {
    await enqueueCandidates({ candidateIds: [], queue });
    expect(await queue.getWaitingCount()).toBe(0);
  });
});
