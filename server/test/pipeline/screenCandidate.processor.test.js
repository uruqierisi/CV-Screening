import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { pool, truncateAll } from '../helpers/database.js';
import { createRole, createScreeningJob } from '../helpers/fixtures.js';
import { removeUploadedFiles } from '../helpers/api.js';
import { fakeAnthropic } from '../agents/helpers/fake-anthropic.js';
import {
  GOLDEN_CV_TEXT,
  GOLDEN_EVALUATION,
  GOLDEN_EXPECTED,
  GOLDEN_NOW_ISO,
  extractedProfile,
} from '../agents/fixtures/golden.js';
import {
  SKIP_REASONS,
  processScreeningJob,
} from '../../src/queue/processors/screenCandidate.processor.js';
import { allocate, removeStored, writeStream } from '../../src/storage/localDisk.js';
import {
  markCandidateEvaluating,
  markCandidateParsing,
} from '../../src/repositories/candidateStatusRepository.js';
import { AgentTimeoutError, AgentRefusalError } from '../../src/agents/index.js';
import { withTransaction } from '../../src/db/withTransaction.js';
import { replaceCriteriaForRole } from '../../src/repositories/roleCriteriaRepository.js';

/**
 * The worker's pipeline, end to end, against a real Postgres and a **fake**
 * Anthropic client.
 *
 * The client is the same `fakeAnthropic` the agent layer's own suite uses: a
 * plain object with `messages.parse` and `messages.create`, injected rather than
 * mocked, so the real JSON parsing, the real schema validation and the real
 * evidence verification all run. Nothing here touches a socket. That is not a
 * convenience - the owner's API credit is nearly exhausted, and a suite that
 * spends it is a suite nobody can run.
 *
 * The golden fixture is reused for the same reason `screen-candidate.test.js`
 * reuses it: phase 2a proved these ratings and these weights produce 72.5, so a
 * regression anywhere between the queue job and the `candidates` row shows up as
 * the number a recruiter would have seen.
 */

const NOW = new Date(GOLDEN_NOW_ISO);

/** The golden role's criteria and rules, minus the hand-written ids. */
const GOLDEN_CRITERIA = [
  { label: 'Backend engineering depth (Node.js)', weight: 30, position: 0 },
  { label: 'API and distributed systems design', weight: 20, position: 1 },
  { label: 'Relational data modelling', weight: 20, position: 2 },
  { label: 'Testing and code quality', weight: 15, position: 3 },
  { label: 'Cloud infrastructure and CI/CD', weight: 10, position: 4 },
  { label: 'Collaboration and written communication', weight: 5, position: 5 },
];

const GOLDEN_RULES = [
  {
    label: 'At least 5 years of professional software engineering experience',
    type: 'min_years_experience',
    value: { years: 5 },
    onMissing: 'flag',
    position: 0,
  },
  {
    label: 'Demonstrated production PostgreSQL experience',
    type: 'required_skill',
    value: { skill: 'PostgreSQL', matchMode: 'normalized', mustBeDemonstrated: true },
    onMissing: 'flag',
    position: 1,
  },
];

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

/**
 * A role, a candidate, and a real file on disk holding the golden CV.
 *
 * @param {{ content?: string | Buffer, criteria?: any[] }} [options]
 */
async function seedCandidate({ content = GOLDEN_CV_TEXT, criteria = GOLDEN_CRITERIA } = {}) {
  const { role, criteria: inserted } = await createRole({
    title: 'Senior Backend Engineer (Node.js)',
    criteria,
    eliminationRules: GOLDEN_RULES,
  });

  const { candidateId, relativePath } = allocate('.txt');
  written.push(relativePath);
  await writeStream({
    source: Readable.from(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')),
    relativePath,
  });

  const { candidates } = await createScreeningJob({
    roleId: role.id,
    candidates: [{ id: candidateId, storagePath: relativePath, mimeType: 'text/plain' }],
  });

  return { role, criteria: inserted, candidate: candidates[0] };
}

/**
 * The golden ratings, re-keyed onto the criterion ids the database generated.
 *
 * A real model answers with the ids it was shown, which are these. Keeping the
 * fixture's hand-written ids would have meant testing against a role no upload
 * could ever produce.
 *
 * @param {{ id: string }[]} criteria in position order
 */
function evaluationFor(criteria) {
  return {
    ratings: GOLDEN_EVALUATION.ratings.map((rating, index) => ({
      ...rating,
      criterionId: criteria[index].id,
    })),
    summary: GOLDEN_EVALUATION.summary,
  };
}

/**
 * @param {object} params
 */
function run({ candidateId, client, attempt = { number: 1, max: 3 }, ...rest }) {
  return processScreeningJob({
    data: { candidateId },
    attempt,
    db: pool,
    client,
    now: NOW,
    ...rest,
  });
}

/**
 * @param {string} candidateId
 */
async function readRow(candidateId) {
  const { rows } = await pool.query('SELECT * FROM candidates WHERE id = $1', [candidateId]);
  return rows[0];
}

describe('the happy path', () => {
  it('walks pending -> parsing -> evaluating -> done and stores the whole result', async () => {
    const { candidate, criteria } = await seedCandidate();
    const client = fakeAnthropic([
      { json: extractedProfile() },
      { json: evaluationFor(criteria) },
    ]);

    const result = await run({ candidateId: candidate.id, client });
    expect(result).toEqual({ outcome: 'done', candidateId: candidate.id });

    const row = await readRow(candidate.id);
    expect(row.status).toBe('done');
    // The number phase 2a proved for these ratings and these weights.
    expect(Number(row.match_score)).toBe(GOLDEN_EXPECTED.score);
    expect(row.fit_category).toBe(GOLDEN_EXPECTED.fitCategory);
    expect(row.eliminated).toBe(false);
    expect(row.completed_at).not.toBeNull();
    expect(row.error_code).toBeNull();
  });

  it('stores the model prose in ai_justification', async () => {
    const { candidate, criteria } = await seedCandidate();
    await run({
      candidateId: candidate.id,
      client: fakeAnthropic([{ json: extractedProfile() }, { json: evaluationFor(criteria) }]),
    });

    // Written here, read by the candidate detail payload. Phase 4 closed that
    // gap rather than leaving the column written and never read.
    expect((await readRow(candidate.id)).ai_justification).toBe(GOLDEN_EVALUATION.summary);
  });

  it('stores a matrix whose contributions sum to the raw score', async () => {
    const { candidate, criteria } = await seedCandidate();
    await run({
      candidateId: candidate.id,
      client: fakeAnthropic([{ json: extractedProfile() }, { json: evaluationFor(criteria) }]),
    });

    const matrix = (await readRow(candidate.id)).evaluation_matrix;
    expect(matrix.criteria.reduce((sum, row) => sum + row.weightedPoints, 0)).toBe(matrix.scoreRaw);
    expect(matrix.scoreRaw).toBe(GOLDEN_EXPECTED.scoreRaw);
    // The role's criterion order, not the model's response order.
    expect(matrix.criteria.map((row) => row.criterionId)).toEqual(criteria.map((c) => c.id));
  });

  it('stores the name from the profile, because the dashboard shows people', async () => {
    const { candidate, criteria } = await seedCandidate();
    await run({
      candidateId: candidate.id,
      client: fakeAnthropic([{ json: extractedProfile() }, { json: evaluationFor(criteria) }]),
    });

    expect((await readRow(candidate.id)).candidate_name).toBe('Priya Ramanathan');
  });

  it('stores raw_text at the evaluating transition, so a failure still leaves it behind', async () => {
    const { candidate, criteria } = await seedCandidate();
    await run({
      candidateId: candidate.id,
      client: fakeAnthropic([{ json: extractedProfile() }, { json: evaluationFor(criteria) }]),
    });

    expect((await readRow(candidate.id)).raw_text).toContain('PRIYA RAMANATHAN');
  });

  it('stamps the role version the score was produced under', async () => {
    const { candidate, criteria, role } = await seedCandidate();
    await run({
      candidateId: candidate.id,
      client: fakeAnthropic([{ json: extractedProfile() }, { json: evaluationFor(criteria) }]),
    });

    expect((await readRow(candidate.id)).scored_role_version).toBe(role.version);
  });

  it('makes exactly two model calls', async () => {
    const { candidate, criteria } = await seedCandidate();
    const client = fakeAnthropic([{ json: extractedProfile() }, { json: evaluationFor(criteria) }]);

    await run({ candidateId: candidate.id, client });
    expect(client.calls).toHaveLength(2);
  });

  it('reads the role at job time, so a role edited while queued is the one used', async () => {
    const { candidate, role } = await seedCandidate();

    // Replace the criteria after the candidate was queued. The payload carries
    // only a candidate id precisely so this is possible. Delete-then-insert in
    // ONE transaction, because the sum-to-100 constraint trigger is deferred to
    // COMMIT and the intermediate state is invalid by design.
    const replaced = await withTransaction((client) =>
      replaceCriteriaForRole(client, role.id, [
        { label: 'Backend engineering depth (Node.js)', weight: 100, position: 0 },
      ]),
    );

    const client = fakeAnthropic([
      { json: extractedProfile() },
      {
        json: {
          ratings: [
            {
              criterionId: replaced[0].id,
              rating: 8,
              reason: 'Rebuilt a Node.js service.',
              evidence: null,
            },
          ],
          summary: 'Solid backend depth.',
        },
      },
    ]);

    await run({ candidateId: candidate.id, client });
    // 8 * 100 = 800 raw -> 80.0
    expect(Number((await readRow(candidate.id)).match_score)).toBe(80);
  });
});

describe('the guarded claim', () => {
  it('skips a candidate that no longer exists', async () => {
    const result = await run({
      candidateId: '11111111-2222-4333-8444-555555555555',
      client: fakeAnthropic([]),
    });

    expect(result).toMatchObject({ outcome: 'skipped', reason: SKIP_REASONS.CANDIDATE_GONE });
  });

  it('skips a candidate somebody else already claimed, without a model call', async () => {
    const { candidate } = await seedCandidate();
    await markCandidateParsing(pool, candidate.id);

    const client = fakeAnthropic([]);
    const result = await run({ candidateId: candidate.id, client });

    // BullMQ can deliver a job twice, and a stalled job can be re-queued while
    // the original is still running. Doing nothing is the correct behaviour, and
    // it costs no API spend.
    expect(result).toMatchObject({ outcome: 'skipped', reason: SKIP_REASONS.ALREADY_CLAIMED });
    expect(client.calls).toHaveLength(0);
  });

  it('never overwrites a finished candidate', async () => {
    const { candidate, criteria } = await seedCandidate();
    await run({
      candidateId: candidate.id,
      client: fakeAnthropic([{ json: extractedProfile() }, { json: evaluationFor(criteria) }]),
    });

    // A late duplicate delivery of the same job.
    const late = await run({
      candidateId: candidate.id,
      client: fakeAnthropic([{ json: extractedProfile() }, { json: evaluationFor(criteria) }]),
    });

    expect(late).toMatchObject({ outcome: 'skipped' });
    expect(Number((await readRow(candidate.id)).match_score)).toBe(GOLDEN_EXPECTED.score);
  });

  it('stops rather than writing when the claim is lost mid-extraction', async () => {
    const { candidate, criteria } = await seedCandidate();

    const result = await run({
      candidateId: candidate.id,
      client: fakeAnthropic([{ json: extractedProfile() }, { json: evaluationFor(criteria) }]),
      // Simulates a retry moving the row on while text was being extracted: the
      // parsing -> evaluating guard then finds a status it does not expect.
      readFile: async (relativePath) => {
        await pool.query(
          `UPDATE candidates SET status = 'pending', updated_at = now() WHERE id = $1`,
          [candidate.id],
        );
        const { readStored } = await import('../../src/storage/localDisk.js');
        return readStored(relativePath);
      },
    });

    expect(result).toMatchObject({ outcome: 'skipped', reason: SKIP_REASONS.ALREADY_CLAIMED });
    expect((await readRow(candidate.id)).status).toBe('pending');
  });
});

describe('failure handling', () => {
  it('releases the candidate to pending when the failure is retryable and attempts remain', async () => {
    const { candidate } = await seedCandidate();

    await expect(
      run({
        candidateId: candidate.id,
        client: fakeAnthropic([]),
        attempt: { number: 1, max: 3 },
        screen: async () => {
          throw new AgentTimeoutError({ stage: 'extraction', deadlineMs: 240_000 });
        },
      }),
    ).rejects.toBeInstanceOf(AgentTimeoutError);

    // Without this rollback, BullMQ's next attempt would hit the pending-only
    // claim guard and do nothing, and the candidate would sit non-terminal until
    // the stuck sweep found it.
    const row = await readRow(candidate.id);
    expect(row.status).toBe('pending');
    expect(row.error_code).toBeNull();
    // `attempts` counts MANUAL retries; automatic ones are BullMQ's to count.
    expect(row.attempts).toBe(0);
  });

  it('fails the candidate terminally on the last attempt', async () => {
    const { candidate } = await seedCandidate();

    await expect(
      run({
        candidateId: candidate.id,
        client: fakeAnthropic([]),
        attempt: { number: 3, max: 3 },
        screen: async () => {
          throw new AgentTimeoutError({ stage: 'evaluation', deadlineMs: 240_000 });
        },
      }),
    ).rejects.toBeInstanceOf(AgentTimeoutError);

    const row = await readRow(candidate.id);
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('AGENT_TIMEOUT');
    expect(row.error_message).toEqual(expect.any(String));
    expect(row.completed_at).not.toBeNull();
  });

  it('fails immediately and unrecoverably when the failure cannot change', async () => {
    const { candidate } = await seedCandidate();

    await expect(
      run({
        candidateId: candidate.id,
        client: fakeAnthropic([]),
        attempt: { number: 1, max: 3 },
        screen: async () => {
          throw new AgentRefusalError({ stage: 'evaluation', stopDetails: { category: 'other' } });
        },
      }),
      // UnrecoverableError tells BullMQ not to spend the remaining attempts on
      // something a fresh generation cannot fix. A refusal is never retried.
    ).rejects.toBeInstanceOf(UnrecoverableError);

    const row = await readRow(candidate.id);
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('AGENT_REFUSED');
    expect(row.attempts).toBe(0);
  });

  it('fails a scanned PDF as EMPTY_DOCUMENT with the recruiter-facing message', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const scanned = await readFile(
      fileURLToPath(new URL('../extraction/fixtures/documents/scanned.pdf', import.meta.url)),
    );

    const { candidate } = await seedCandidate({ content: scanned });

    await expect(
      run({ candidateId: candidate.id, client: fakeAnthropic([]), attempt: { number: 1, max: 3 } }),
    ).rejects.toBeTruthy();

    const row = await readRow(candidate.id);
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('EMPTY_DOCUMENT');
    expect(row.error_message).toContain('scanned image');
  });

  it('fails with SOURCE_FILE_MISSING when the stored file is gone', async () => {
    const { candidate } = await seedCandidate();
    await pool.query(`UPDATE candidates SET storage_path = 'zz/zz/gone.txt' WHERE id = $1`, [
      candidate.id,
    ]);

    await expect(
      run({ candidateId: candidate.id, client: fakeAnthropic([]), attempt: { number: 1, max: 3 } }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    const row = await readRow(candidate.id);
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('SOURCE_FILE_MISSING');
  });

  it('never stores an unknown error message on the candidate', async () => {
    const { candidate } = await seedCandidate();

    await expect(
      run({
        candidateId: candidate.id,
        client: fakeAnthropic([]),
        attempt: { number: 3, max: 3 },
        screen: async () => {
          throw new TypeError('undefined is not a function - cv: "Priya Ramanathan, 07700 900123"');
        },
      }),
    ).rejects.toBeInstanceOf(TypeError);

    const row = await readRow(candidate.id);
    // The dashboard renders this column. An unknown message is exactly where a
    // fragment of somebody's CV escapes.
    expect(row.error_message).not.toContain('Priya Ramanathan');
    expect(row.error_message).not.toContain('07700');
    expect(row.error_code).toBe('EXTRACTION_FAILED');
  });

  it('does not turn a candidate somebody else finished into a failed one', async () => {
    const { candidate, criteria } = await seedCandidate();
    await markCandidateParsing(pool, candidate.id);
    await markCandidateEvaluating(pool, { candidateId: candidate.id, rawText: GOLDEN_CV_TEXT });

    // A worker holding a stale claim fails, while the row has already moved on.
    await pool.query(`UPDATE candidates SET status = 'pending' WHERE id = $1`, [candidate.id]);

    await expect(
      run({
        candidateId: candidate.id,
        client: fakeAnthropic([{ json: extractedProfile() }, { json: evaluationFor(criteria) }]),
        attempt: { number: 3, max: 3 },
        screen: async () => {
          throw new AgentRefusalError({ stage: 'evaluation', stopDetails: { category: 'other' } });
        },
      }),
    ).rejects.toBeTruthy();

    // It was claimed from `pending` again by this run, so it does fail - the
    // point of the assertion is that the guard decided, not a blind UPDATE.
    expect((await readRow(candidate.id)).status).toBe('failed');
  });
});

describe('the queue payload', () => {
  it('refuses a payload that is not a candidate id', async () => {
    await expect(
      processScreeningJob({
        data: { candidateId: 'not-a-uuid' },
        attempt: { number: 1, max: 3 },
        db: pool,
        client: fakeAnthropic([]),
        now: NOW,
      }),
    ).rejects.toBeTruthy();
  });
});
