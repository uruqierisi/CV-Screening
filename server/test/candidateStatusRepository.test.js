import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool, truncateAll } from './helpers/database.js';
import { createRole, createScreeningJob, driveCandidateToDone } from './helpers/fixtures.js';
import { findCandidateById } from '../src/repositories/candidatesRepository.js';
import {
  markCandidateDone,
  markCandidateEvaluating,
  markCandidateFailed,
  markCandidateParsing,
  resetCandidateForRetry,
} from '../src/repositories/candidateStatusRepository.js';

beforeEach(truncateAll);

/**
 * @returns {Promise<import('../src/repositories/candidateRow.js').Candidate>}
 */
async function aPendingCandidate() {
  const { role } = await createRole();
  const { candidates } = await createScreeningJob({ roleId: role.id });
  return candidates[0];
}

describe('guarded transitions', () => {
  it('walks the happy path pending -> parsing -> evaluating -> done', async () => {
    const candidate = await aPendingCandidate();

    const parsing = await markCandidateParsing(pool, candidate.id);
    expect(parsing).toMatchObject({ ok: true });

    const evaluating = await markCandidateEvaluating(pool, {
      candidateId: candidate.id,
      rawText: 'CV text',
    });
    expect(evaluating).toMatchObject({ ok: true });
    expect(evaluating.ok && evaluating.candidate.status).toBe('evaluating');
  });

  it('refuses a transition from the wrong status and names the current one', async () => {
    const candidate = await aPendingCandidate();

    // A duplicated queue job trying to claim a candidate that is already parsing.
    await markCandidateParsing(pool, candidate.id);
    const second = await markCandidateParsing(pool, candidate.id);

    expect(second).toEqual({ ok: false, reason: 'status_conflict', currentStatus: 'parsing' });
  });

  it('distinguishes a missing candidate from a status conflict', async () => {
    const result = await markCandidateParsing(pool, randomUUID());

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('does not let a late worker overwrite a finished candidate', async () => {
    const candidate = await aPendingCandidate();
    await driveCandidateToDone(candidate.id, { matchScore: 88.0 });

    // The stale worker replays the whole sequence. Every step is refused, and the
    // stored result is untouched - this is the reason the guards exist.
    expect(await markCandidateParsing(pool, candidate.id)).toMatchObject({
      reason: 'status_conflict',
      currentStatus: 'done',
    });
    expect(
      await markCandidateEvaluating(pool, { candidateId: candidate.id, rawText: 'stale' }),
    ).toMatchObject({ reason: 'status_conflict' });
    expect(
      await markCandidateFailed(pool, {
        candidateId: candidate.id,
        errorCode: 'AGENT_TIMEOUT',
        errorMessage: 'stale timeout',
      }),
    ).toMatchObject({ reason: 'status_conflict', currentStatus: 'done' });

    const stored = await findCandidateById(pool, candidate.id, { includeRawText: true });
    expect(stored).toMatchObject({ status: 'done', matchScore: 88.0, errorCode: null });
    expect(stored?.rawText).not.toBe('stale');
  });

  it('stores raw text at the evaluating step, so a later failure still has it on record', async () => {
    const candidate = await aPendingCandidate();
    await markCandidateParsing(pool, candidate.id);
    await markCandidateEvaluating(pool, { candidateId: candidate.id, rawText: 'extracted text' });
    await markCandidateFailed(pool, {
      candidateId: candidate.id,
      errorCode: 'AGENT_BAD_OUTPUT',
      errorMessage: 'model returned an unparseable evaluation',
    });

    const stored = await findCandidateById(pool, candidate.id, { includeRawText: true });
    expect(stored).toMatchObject({ status: 'failed', errorCode: 'AGENT_BAD_OUTPUT' });
    expect(stored?.rawText).toBe('extracted text');
  });
});

describe('markCandidateDone', () => {
  it('stores the whole result and stamps completed_at', async () => {
    const candidate = await aPendingCandidate();
    const done = await driveCandidateToDone(candidate.id, {
      matchScore: 84.7,
      fitCategory: 'potential_match',
      scoredRoleVersion: 3,
    });

    expect(done).toMatchObject({
      status: 'done',
      candidateName: 'Jane Doe',
      matchScore: 84.7,
      fitCategory: 'potential_match',
      scoredRoleVersion: 3,
    });
    expect(done.completedAt).toBeInstanceOf(Date);
  });

  it('keeps the score of an eliminated candidate while its tier is unmatched', async () => {
    const candidate = await aPendingCandidate();

    const done = await driveCandidateToDone(candidate.id, {
      matchScore: 88.0,
      fitCategory: 'unmatched',
      eliminated: true,
      eliminatedBy: 'Authorised to work in the UK, Ireland or Germany',
      eliminationDetails: { failures: [{ label: 'Right to work', reason: 'location: US' }] },
    });

    expect(done).toMatchObject({
      matchScore: 88.0,
      fitCategory: 'unmatched',
      eliminated: true,
      eliminatedBy: 'Authorised to work in the UK, Ireland or Germany',
    });
  });

  it('clears an error left behind by a previous failed attempt', async () => {
    const candidate = await aPendingCandidate();
    await markCandidateParsing(pool, candidate.id);
    await markCandidateFailed(pool, {
      candidateId: candidate.id,
      errorCode: 'AGENT_RATE_LIMIT',
      errorMessage: 'rate limited',
    });
    await resetCandidateForRetry(pool, candidate.id);

    const done = await driveCandidateToDone(candidate.id);

    expect(done.errorCode).toBeNull();
    expect(done.errorMessage).toBeNull();
  });
});

describe('resetCandidateForRetry', () => {
  it('returns a failed candidate to pending and bumps attempts', async () => {
    const candidate = await aPendingCandidate();
    await markCandidateParsing(pool, candidate.id);
    await markCandidateFailed(pool, {
      candidateId: candidate.id,
      errorCode: 'EXTRACTION_FAILED',
      errorMessage: 'could not read the PDF',
    });

    const result = await resetCandidateForRetry(pool, candidate.id);

    expect(result.ok).toBe(true);
    expect(result.ok && result.candidate).toMatchObject({
      status: 'pending',
      errorCode: null,
      errorMessage: null,
      completedAt: null,
      // The caller needs this to build a fresh queue-job id: the original
      // (the candidate uuid) is consumed by the completed BullMQ job.
      attempts: 1,
    });
  });

  it('refuses to retry a candidate that is not failed', async () => {
    const candidate = await aPendingCandidate();
    await driveCandidateToDone(candidate.id);

    const result = await resetCandidateForRetry(pool, candidate.id);

    // The caller maps this to 409 CANDIDATE_NOT_RETRYABLE.
    expect(result).toEqual({ ok: false, reason: 'status_conflict', currentStatus: 'done' });
  });
});

describe('database integrity constraints', () => {
  it('rejects a done candidate with no score or matrix', async () => {
    const candidate = await aPendingCandidate();
    await markCandidateParsing(pool, candidate.id);
    await markCandidateEvaluating(pool, { candidateId: candidate.id, rawText: 'text' });

    await expect(
      pool.query(
        `UPDATE candidates SET status = 'done', completed_at = now() WHERE id = $1`,
        [candidate.id],
      ),
    ).rejects.toMatchObject({ constraint: 'candidates_done_is_complete_check' });
  });

  it('rejects a failed candidate with no error code', async () => {
    const candidate = await aPendingCandidate();

    await expect(
      pool.query(
        `UPDATE candidates SET status = 'failed', completed_at = now() WHERE id = $1`,
        [candidate.id],
      ),
    ).rejects.toMatchObject({ constraint: 'candidates_failed_has_error_code_check' });
  });

  it('rejects an error code without a message, and a message without a code', async () => {
    const candidate = await aPendingCandidate();

    await expect(
      pool.query(`UPDATE candidates SET error_code = 'AGENT_TIMEOUT' WHERE id = $1`, [candidate.id]),
    ).rejects.toMatchObject({ constraint: 'candidates_error_pair_check' });

    await expect(
      pool.query(`UPDATE candidates SET error_message = 'orphan' WHERE id = $1`, [candidate.id]),
    ).rejects.toMatchObject({ constraint: 'candidates_error_pair_check' });
  });

  it('rejects a terminal candidate with no completed_at', async () => {
    const candidate = await aPendingCandidate();

    await expect(
      pool.query(
        `UPDATE candidates
            SET status = 'failed', error_code = 'AGENT_TIMEOUT', error_message = 'timed out'
          WHERE id = $1`,
        [candidate.id],
      ),
    ).rejects.toMatchObject({ constraint: 'candidates_terminal_has_completed_at_check' });
  });

  it('rejects a score outside 0..100 and an unknown tier', async () => {
    const candidate = await aPendingCandidate();

    await expect(
      pool.query('UPDATE candidates SET match_score = 100.1 WHERE id = $1', [candidate.id]),
    ).rejects.toMatchObject({ constraint: 'candidates_match_score_range_check' });

    await expect(
      pool.query(`UPDATE candidates SET fit_category = 'great' WHERE id = $1`, [candidate.id]),
    ).rejects.toMatchObject({ constraint: 'candidates_fit_category_check' });
  });

  it('rejects a status outside the five pipeline states', async () => {
    const candidate = await aPendingCandidate();

    await expect(
      pool.query(`UPDATE candidates SET status = 'queued' WHERE id = $1`, [candidate.id]),
    ).rejects.toMatchObject({ constraint: 'candidates_status_check' });
  });
});
