import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  fixtureBytes,
  multipartBody,
  recordingQueue,
  removeUploadedFiles,
} from '../helpers/api.js';
import { pool, truncateAll } from '../helpers/database.js';
import { createRole, createScreeningJob, driveCandidateToDone } from '../helpers/fixtures.js';
import {
  markCandidateFailed,
  markCandidateParsing,
} from '../../src/repositories/candidateStatusRepository.js';
import { removeStored } from '../../src/storage/localDisk.js';

/**
 * `GET /jobs/:jobId` and `POST /candidates/:id/retry`.
 *
 * These two share a file because they share a subject: what the API says about
 * work that has not finished, and what it does when some of it did not.
 */

/** @type {import('fastify').FastifyInstance} */
let app;
/** @type {ReturnType<typeof recordingQueue>} */
let queue;

beforeEach(async () => {
  await truncateAll();
  queue = recordingQueue();
  app = await buildTestApp({ queue });
});

afterEach(async () => {
  await removeUploadedFiles();
});

afterAll(async () => {
  await pool.end();
});

describe('GET /api/v1/jobs/:jobId', () => {
  it('is queued while every candidate is pending', async () => {
    const { role } = await createRole();
    const { job } = await createScreeningJob({ roleId: role.id, candidates: [{}, {}] });

    const response = await app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      status: 'queued',
      terminal: false,
      fileCount: 2,
      duplicateCount: 0,
      counts: { pending: 2, parsing: 0, evaluating: 0, done: 0, failed: 0, total: 2 },
    });
  });

  it('is in_progress once one candidate is being worked on', async () => {
    const { role } = await createRole();
    const { job, candidates } = await createScreeningJob({ roleId: role.id, candidates: [{}, {}] });
    await markCandidateParsing(pool, candidates[0].id);

    const response = await app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });
    expect(response.json().data.status).toBe('in_progress');
  });

  it('is completed when every candidate is done', async () => {
    const { role } = await createRole();
    const { job, candidates } = await createScreeningJob({ roleId: role.id, candidates: [{}] });
    await driveCandidateToDone(candidates[0].id);

    const response = await app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });
    expect(response.json().data).toMatchObject({ status: 'completed', terminal: true });
  });

  it('is completed_with_failures when one candidate failed', async () => {
    const { role } = await createRole();
    const { job, candidates } = await createScreeningJob({ roleId: role.id, candidates: [{}, {}] });
    await driveCandidateToDone(candidates[0].id);
    await markCandidateParsing(pool, candidates[1].id);
    await markCandidateFailed(pool, {
      candidateId: candidates[1].id,
      errorCode: 'AGENT_TIMEOUT',
      errorMessage: 'The screening timed out.',
    });

    const response = await app.inject({ method: 'GET', url: `/api/v1/jobs/${job.id}` });
    expect(response.json().data).toMatchObject({
      status: 'completed_with_failures',
      terminal: true,
      counts: { done: 1, failed: 1, total: 2 },
    });
  });

  it('explains the gap when an upload was entirely duplicates', async () => {
    const { role } = await createRole();
    const pdf = await fixtureBytes('clean.pdf');

    /** @param {string} filename */
    const upload = (filename) => {
      const { payload, headers } = multipartBody([{ filename, content: pdf }]);
      return app.inject({
        method: 'POST',
        url: `/api/v1/roles/${role.id}/candidates`,
        headers,
        payload,
      });
    };

    await upload('jane.pdf');
    const second = await upload('jane-copy.pdf');
    const jobId = second.json().data.jobId;

    const response = await app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}` });

    // The duplicate keeps the job id of the upload that first created it -
    // re-pointing it would corrupt the older job's aggregate. So this job owns
    // no candidates, and `duplicateCount` is what stops a 1-file upload showing
    // 0 candidates from looking like data loss.
    expect(response.json().data).toMatchObject({
      status: 'completed',
      terminal: true,
      fileCount: 1,
      duplicateCount: 1,
      counts: { total: 0 },
    });
  });

  it('404s an unknown job', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/jobs/11111111-2222-4333-8444-555555555555',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('JOB_NOT_FOUND');
  });
});

describe('POST /api/v1/candidates/:candidateId/retry', () => {
  /**
   * A failed candidate whose file really is on disk, uploaded through the API so
   * that the storage path is a real one.
   *
   * @returns {Promise<{ candidateId: string, storagePath: string }>}
   */
  async function failedCandidate() {
    const { role } = await createRole();
    const pdf = await fixtureBytes('clean.pdf');
    const { payload, headers } = multipartBody([{ filename: 'jane.pdf', content: pdf }]);

    const upload = await app.inject({
      method: 'POST',
      url: `/api/v1/roles/${role.id}/candidates`,
      headers,
      payload,
    });
    const candidateId = upload.json().data.candidates[0].id;

    await markCandidateParsing(pool, candidateId);
    await markCandidateFailed(pool, {
      candidateId,
      errorCode: 'AGENT_UPSTREAM',
      errorMessage: 'The screening service was unavailable.',
    });

    const { rows } = await pool.query('SELECT storage_path FROM candidates WHERE id = $1', [
      candidateId,
    ]);
    return { candidateId, storagePath: rows[0].storage_path };
  }

  it('202s, clears the error, bumps attempts and enqueues a fresh queue-job id', async () => {
    const { candidateId } = await failedCandidate();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/candidates/${candidateId}/retry`,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().data).toMatchObject({ status: 'pending', errorCode: null });
    expect(response.json().meta).toEqual({ queueJobId: `${candidateId}-retry-1`, attempts: 1 });

    const { rows } = await pool.query(
      'SELECT status, error_code, error_message, completed_at, attempts FROM candidates WHERE id = $1',
      [candidateId],
    );
    expect(rows[0]).toEqual({
      status: 'pending',
      error_code: null,
      error_message: null,
      completed_at: null,
      attempts: 1,
    });

    // The original queue-job id is consumed - BullMQ refuses an id that already
    // exists, even a completed one - so the retry has to be a new id.
    expect(queue.singles).toEqual([{ candidateId, attempt: 1 }]);
  });

  it('409s CANDIDATE_NOT_RETRYABLE for a candidate that is not failed', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id, candidates: [{}] });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/candidates/${candidates[0].id}/retry`,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CANDIDATE_NOT_RETRYABLE');
    expect(response.json().error.details).toMatchObject({ status: 'pending' });
    expect(queue.singles).toEqual([]);
  });

  it('409s a candidate that already succeeded', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id, candidates: [{}] });
    await driveCandidateToDone(candidates[0].id);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/candidates/${candidates[0].id}/retry`,
    });
    expect(response.statusCode).toBe(409);
  });

  it('410s SOURCE_FILE_MISSING when the stored file is gone, and does not touch the row', async () => {
    const { candidateId, storagePath } = await failedCandidate();
    await removeStored(storagePath);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/candidates/${candidateId}/retry`,
    });

    expect(response.statusCode).toBe(410);
    expect(response.json().error.code).toBe('SOURCE_FILE_MISSING');
    // The file check runs BEFORE the reset. Resetting first would leave a
    // candidate in `pending` that no worker can complete, having spent a queue
    // attempt to discover something we already knew.
    const { rows } = await pool.query('SELECT status, attempts FROM candidates WHERE id = $1', [
      candidateId,
    ]);
    expect(rows[0]).toEqual({ status: 'failed', attempts: 0 });
    expect(queue.singles).toEqual([]);
  });

  it('does not leak the server filesystem layout in the 410', async () => {
    const { candidateId, storagePath } = await failedCandidate();
    await removeStored(storagePath);

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/candidates/${candidateId}/retry`,
    });

    expect(response.body).not.toContain(storagePath);
    expect(response.body).not.toContain('uploads');
  });

  it('404s an unknown candidate', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/candidates/11111111-2222-4333-8444-555555555555/retry',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('CANDIDATE_NOT_FOUND');
  });

  it('refuses a second retry of a candidate the first retry already reset', async () => {
    const { candidateId } = await failedCandidate();

    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/candidates/${candidateId}/retry`,
    });
    expect(first.statusCode).toBe(202);

    // The guard is what makes this safe under a double-clicked Retry button:
    // the second request sees `pending`, not `failed`.
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/candidates/${candidateId}/retry`,
    });
    expect(second.statusCode).toBe(409);
    expect(queue.singles).toHaveLength(1);
  });
});
