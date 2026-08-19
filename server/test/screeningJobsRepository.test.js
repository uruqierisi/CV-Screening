import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool, truncateAll } from './helpers/database.js';
import { createRole, createScreeningJob, driveCandidateToDone } from './helpers/fixtures.js';
import {
  countCandidateStatuses,
  findScreeningJobById,
} from '../src/repositories/screeningJobsRepository.js';
import {
  markCandidateFailed,
  markCandidateParsing,
} from '../src/repositories/candidateStatusRepository.js';

beforeEach(truncateAll);

/**
 * Job status is derived, so this is the only place it is computed in Phase 1.
 * The rule lives in the service layer in Phase 4; reproducing it here keeps the
 * test honest about what the counts are actually for.
 *
 * @param {import('../src/repositories/screeningJobsRepository.js').CandidateStatusCounts} counts
 * @returns {'queued' | 'in_progress' | 'completed' | 'completed_with_failures'}
 */
function deriveJobStatus(counts) {
  if (counts.pending === counts.total) return 'queued';
  if (counts.pending + counts.parsing + counts.evaluating > 0) return 'in_progress';
  return counts.failed > 0 ? 'completed_with_failures' : 'completed';
}

describe('insertScreeningJob', () => {
  it('records the file count of the upload', async () => {
    const { role } = await createRole();
    const { job } = await createScreeningJob({ roleId: role.id, candidates: [{}, {}, {}] });

    expect(job.fileCount).toBe(3);
    expect(job.createdAt).toBeInstanceOf(Date);
  });

  it('creates a job of size one for a single upload, so polling has one shape', async () => {
    const { role } = await createRole();
    const { job, candidates } = await createScreeningJob({ roleId: role.id });

    expect(job.fileCount).toBe(1);
    expect(candidates).toHaveLength(1);
  });

  it('refuses a job for a role that does not exist', async () => {
    await expect(createScreeningJob({ roleId: randomUUID() })).rejects.toMatchObject({
      code: '23503',
    });
  });
});

describe('findScreeningJobById', () => {
  it('returns null for an unknown job', async () => {
    expect(await findScreeningJobById(pool, randomUUID())).toBeNull();
  });
});

describe('countCandidateStatuses', () => {
  it('returns zeroes for a job with no candidates', async () => {
    const counts = await countCandidateStatuses(pool, randomUUID());

    // Indistinguishable from a job that does not exist: the caller checks the job
    // separately, because "no such job" and "a job with nothing in it" are
    // different answers at the HTTP layer.
    expect(counts).toEqual({
      pending: 0,
      parsing: 0,
      evaluating: 0,
      done: 0,
      failed: 0,
      total: 0,
    });
  });

  it('derives queued while everything is still pending', async () => {
    const { role } = await createRole();
    const { job } = await createScreeningJob({ roleId: role.id, candidates: [{}, {}] });

    const counts = await countCandidateStatuses(pool, job.id);

    expect(counts).toMatchObject({ pending: 2, total: 2 });
    expect(deriveJobStatus(counts)).toBe('queued');
  });

  it('derives in_progress as soon as one candidate is claimed', async () => {
    const { role } = await createRole();
    const { job, candidates } = await createScreeningJob({
      roleId: role.id,
      candidates: [{}, {}],
    });
    await markCandidateParsing(pool, candidates[0].id);

    const counts = await countCandidateStatuses(pool, job.id);

    expect(counts).toMatchObject({ pending: 1, parsing: 1, total: 2 });
    expect(deriveJobStatus(counts)).toBe('in_progress');
  });

  it('derives completed_with_failures when a terminal batch contains a failure', async () => {
    const { role } = await createRole();
    const { job, candidates } = await createScreeningJob({
      roleId: role.id,
      candidates: [{}, {}],
    });
    await driveCandidateToDone(candidates[0].id);
    await markCandidateFailed(pool, {
      candidateId: candidates[1].id,
      errorCode: 'EMPTY_DOCUMENT',
      errorMessage: 'This PDF appears to be a scanned image.',
    });

    const counts = await countCandidateStatuses(pool, job.id);

    expect(counts).toMatchObject({ done: 1, failed: 1, total: 2 });
    expect(deriveJobStatus(counts)).toBe('completed_with_failures');
  });

  it('counts only the candidates of the job it was asked about', async () => {
    const { role } = await createRole();
    const first = await createScreeningJob({ roleId: role.id, candidates: [{}, {}] });
    await createScreeningJob({ roleId: role.id, candidates: [{}] });

    const counts = await countCandidateStatuses(pool, first.job.id);

    expect(counts.total).toBe(2);
  });
});

describe('screening job deletion', () => {
  it('cascades to its candidates', async () => {
    const { role } = await createRole();
    const { job } = await createScreeningJob({ roleId: role.id, candidates: [{}, {}] });

    await pool.query('DELETE FROM screening_jobs WHERE id = $1', [job.id]);

    expect((await countCandidateStatuses(pool, job.id)).total).toBe(0);
  });
});
