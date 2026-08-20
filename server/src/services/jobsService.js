/**
 * `GET /api/v1/jobs/:jobId` - the hot polling endpoint.
 *
 * Two queries: does the job exist, and what are its candidates doing. They are
 * separate because "no such job" and "a job with nothing in it" are different
 * answers at the HTTP layer, and the aggregate alone cannot tell them apart.
 */

import { AppError } from '../errors/AppError.js';
import { pool } from '../db/pool.js';
import {
  countCandidateStatuses,
  findScreeningJobById,
} from '../repositories/screeningJobsRepository.js';
import { deriveJobStatus, isTerminalJobStatus } from './jobStatus.js';

/**
 * @param {string} jobId
 * @returns {Promise<Record<string, unknown>>}
 * @throws {AppError} JOB_NOT_FOUND
 */
export async function getJobStatus(jobId) {
  const job = await findScreeningJobById(pool, jobId);
  if (job === null) {
    throw new AppError('JOB_NOT_FOUND', 'No screening job with that id.', { details: { jobId } });
  }

  const counts = await countCandidateStatuses(pool, jobId);
  const status = deriveJobStatus(counts);

  return {
    id: job.id,
    roleId: job.roleId,
    status,
    terminal: isTerminalJobStatus(status),
    // What was uploaded, versus what this job actually owns. They differ by the
    // number of files that turned out to be duplicates of CVs already on this
    // role: those candidates keep the job id of the upload that first created
    // them, so they are counted by that job and not by this one. Reporting the
    // difference explicitly is what keeps a 5-file upload showing 3 candidates
    // from looking like data loss.
    fileCount: job.fileCount,
    duplicateCount: job.fileCount - counts.total,
    counts: {
      pending: counts.pending,
      parsing: counts.parsing,
      evaluating: counts.evaluating,
      done: counts.done,
      failed: counts.failed,
      total: counts.total,
    },
    createdAt: job.createdAt.toISOString(),
  };
}
