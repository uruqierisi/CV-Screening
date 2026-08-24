import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pool, truncateAll } from '../helpers/database.js';
import { createRole, createScreeningJob } from '../helpers/fixtures.js';
import { removeUploadedFiles } from '../helpers/api.js';
import { fakeAnthropic } from '../agents/helpers/fake-anthropic.js';
import { GOLDEN_CV_TEXT, extractedProfile } from '../agents/fixtures/golden.js';
import { allocate, removeStored, writeStream } from '../../src/storage/localDisk.js';
import { processScreeningJob } from '../../src/queue/processors/screenCandidate.processor.js';
import { findCandidateById } from '../../src/repositories/candidatesRepository.js';

/**
 * **What a deploy does to a candidate that is mid-screening.**
 *
 * This is the test behind a claim the README makes and the free-tier deployment
 * depends on: the co-located worker drains on SIGTERM, and a candidate whose
 * model call is cut short comes back to `pending` rather than being stranded.
 *
 * The distinction is not academic, and it is worth stating why it is the thing
 * worth testing. Every status transition in the processor is guarded by
 * `WHERE status = $expected`, and the claim that starts a screening accepts only
 * `pending`. So a candidate abandoned in `parsing` or `evaluating` is not merely
 * delayed - **no future job can ever claim it.** BullMQ redelivers the job, the
 * guard refuses it, the job reports `skipped`, and the row sits there until
 * somebody runs `npm run reconcile` by hand. On a free tier that restarts on
 * every deploy, that is the difference between "the screening resumes" and "the
 * reviewer watches a row say Evaluating forever".
 *
 * The chain being asserted is four links long and every one of them is real:
 *
 * ```
 *   the drain aborts the shared signal
 *     -> the SDK call rejects with APIUserAbortError
 *     -> the agent layer raises a retryable AgentTimeoutError
 *     -> handleFailure calls releaseCandidateToPending
 * ```
 *
 * Both model calls are covered, because the abort can land in either. Both leave
 * the candidate in `evaluating` - the processor moves it there before
 * `screenCandidate` runs, so `parsing` covers only the local text extraction and
 * is over in a millisecond. `evaluating` is therefore the only status a drain
 * can realistically strand, which is why every case below asserts it.
 *
 * ## What this test does NOT cover, stated plainly
 *
 * It drives the drain by aborting the signal directly rather than by sending a
 * real POSIX signal to a real `node src/server.js`. That is a deliberate limit
 * with a specific cause: `server.js` builds its Anthropic client from the
 * environment, so a spawned process would make a **real, paid** API call, and a
 * suite that spends the owner's remaining credit is a suite nobody can run.
 * Adding a test-only client seam to production code is a worse trade than this
 * gap.
 *
 * So: the release path is verified end to end against a real Postgres and the
 * real processor. The one line in `server.js` that calls `screening.close()`
 * when SIGTERM arrives is verified by reading it.
 */

/** Files this file wrote, unlinked afterwards. */
const written = [];

beforeEach(async () => {
  await truncateAll();
});

afterEach(async () => {
  await Promise.all(written.splice(0).map((relativePath) => removeStored(relativePath)));
  await removeUploadedFiles();
});

afterAll(async () => {
  await pool.end();
});

/** A role, a candidate, and a real file on disk holding the golden CV. */
async function seedCandidate() {
  const { role } = await createRole({
    title: 'Senior Backend Engineer (Node.js)',
    criteria: [
      { label: 'Backend engineering depth (Node.js)', weight: 60, position: 0 },
      { label: 'Testing and code quality', weight: 40, position: 1 },
    ],
    eliminationRules: [],
  });

  const { candidateId, relativePath } = allocate('.txt');
  written.push(relativePath);
  await writeStream({
    source: Readable.from(Buffer.from(GOLDEN_CV_TEXT, 'utf8')),
    relativePath,
  });

  const { candidates } = await createScreeningJob({
    roleId: role.id,
    candidates: [{ id: candidateId, storagePath: relativePath, mimeType: 'text/plain' }],
  });

  return candidates[0];
}

/**
 * Waits until the fake client has been entered `count` times, so the drain lands
 * on a genuinely in-flight model call rather than on a sleep-and-hope.
 *
 * Waiting on the call log rather than on the candidate's status is deliberate,
 * and the reason is a fact about the pipeline worth writing down: **both model
 * calls happen while the candidate is `evaluating`.** `parsing` covers only
 * `extractDocumentText`, which is local, synchronous work on a text file and is
 * over in a millisecond - the processor moves the row to `evaluating` *before*
 * `screenCandidate` makes either call. So a test that waited for `parsing` would
 * be waiting for a window that is effectively closed, and the status alone
 * cannot say which of the two calls is in flight.
 *
 * @param {{ calls: unknown[] }} client
 * @param {number} count
 * @returns {Promise<void>}
 */
async function waitForCalls(client, count) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (client.calls.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`the client was never called ${count} time(s)`);
}

/**
 * Runs one screening that will hang, aborts it, and returns the row afterwards.
 *
 * @param {object} params
 * @param {string} params.candidateId
 * @param {any} params.client
 * @param {number} params.hangsOnCall 1 for extraction, 2 for evaluation
 * @param {{ number: number, max: number }} [params.attempt]
 */
async function drainDuring({ candidateId, client, hangsOnCall, attempt = { number: 1, max: 3 } }) {
  const drain = new AbortController();

  const finished = processScreeningJob({
    data: { candidateId },
    attempt,
    db: pool,
    client,
    now: new Date(),
    signal: drain.signal,
  });

  await waitForCalls(client, hangsOnCall);

  // Whichever call is hanging, the row is `evaluating` - which is the status the
  // claim guard refuses, and therefore the one a failed release would strand.
  const inFlight = await findCandidateById(pool, candidateId);
  expect(inFlight?.status).toBe('evaluating');

  drain.abort();

  // The processor rethrows so BullMQ can count the attempt. The durable
  // consequence is the row, which is what the deployment cares about.
  await expect(finished).rejects.toThrow();

  return /** @type {any} */ (await findCandidateById(pool, candidateId));
}

describe('draining a worker mid-screening', () => {
  it('releases a candidate aborted during the extraction call back to pending', async () => {
    const candidate = await seedCandidate();

    const row = await drainDuring({
      candidateId: candidate.id,
      // The first model call. Only one response is scripted, because the drain
      // means the second call never happens - and the fake throws if it did,
      // which is the assertion that the pipeline really did stop here.
      client: fakeAnthropic([{ hangs: true }]),
      hangsOnCall: 1,
    });

    expect(row.status).toBe('pending');
    // Not a terminal failure, and nothing recorded against the candidate: a
    // deploy is not the candidate's fault and must not look like one on the row
    // a recruiter reads.
    expect(row.errorCode).toBeNull();
    expect(row.completedAt).toBeNull();
  }, 30_000);

  it('releases a candidate aborted during evaluation back to pending', async () => {
    const candidate = await seedCandidate();

    const row = await drainDuring({
      candidateId: candidate.id,
      // Extraction succeeded, so its raw text is already stored when the abort
      // lands on the second call. This is the longer of the two windows and the
      // one a deploy is most likely to interrupt.
      client: fakeAnthropic([{ json: extractedProfile() }, { hangs: true }]),
      hangsOnCall: 2,
    });

    expect(row.status).toBe('pending');
    expect(row.errorCode).toBeNull();
    expect(row.completedAt).toBeNull();
  }, 30_000);

  it('re-screens a released candidate when the queue redelivers it', async () => {
    // The point of releasing to `pending` is that the *next* attempt can claim
    // it. Asserting the status alone would pass even if some other guard made
    // the row unclaimable, so this drives a second attempt through the same
    // processor and checks it gets past the claim and reaches the model.
    const candidate = await seedCandidate();

    await drainDuring({
      candidateId: candidate.id,
      client: fakeAnthropic([{ json: extractedProfile() }, { hangs: true }]),
      hangsOnCall: 2,
    });

    const redelivered = await drainDuring({
      candidateId: candidate.id,
      client: fakeAnthropic([{ json: extractedProfile() }, { hangs: true }]),
      hangsOnCall: 2,
      attempt: { number: 2, max: 3 },
    });

    // Reaching `evaluating` a second time is the proof: it means the claim
    // accepted the row, extraction ran again and the candidate is screenable.
    expect(redelivered.status).toBe('pending');
  }, 45_000);

  it('fails a candidate terminally when the drain lands on its last attempt', async () => {
    // The other side of the same branch. On the final attempt there is nothing
    // left to release the candidate *for*, so the drain must write the terminal
    // row instead - otherwise a candidate abandoned by the last attempt would
    // sit in `pending` looking like work that is about to happen.
    const candidate = await seedCandidate();

    const row = await drainDuring({
      candidateId: candidate.id,
      client: fakeAnthropic([{ json: extractedProfile() }, { hangs: true }]),
      hangsOnCall: 2,
      attempt: { number: 3, max: 3 },
    });

    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('AGENT_TIMEOUT');
    expect(row.completedAt).not.toBeNull();
  }, 30_000);
});
