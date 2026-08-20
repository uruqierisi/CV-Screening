/**
 * Candidate reads, and the retry.
 *
 * The reads are thin - the interesting decisions about ordering and projection
 * are already in the repositories - so the weight of this file is the retry,
 * which is the only place the API writes to a candidate.
 */

import { AppError } from '../errors/AppError.js';
import { pool } from '../db/pool.js';
import {
  countCandidates,
  countCandidatesByFitCategory,
  findCandidateById,
  findCandidateStatusesByIds,
  listRankedCandidates,
} from '../repositories/candidatesRepository.js';
import { resetCandidateForRetry } from '../repositories/candidateStatusRepository.js';
import { storedFileExists } from '../storage/localDisk.js';
import { enqueueCandidate } from '../queue/screeningQueue.js';

/**
 * The ranked page, its total, and the tier counts across the whole filtered set.
 *
 * The counts are a third query rather than something derived from the page,
 * because a 25-row page cannot tell a recruiter how many Strong Matches exist -
 * and that number is the header of the filter control they are about to use.
 *
 * @param {object} options
 * @param {number} options.limit
 * @param {number} options.offset
 * @param {'desc'|'asc'} options.sort
 * @param {string} [options.roleId]
 * @param {string} [options.jobId]
 * @param {string} [options.fitCategory]
 * @param {string} [options.status]
 * @returns {Promise<{ candidates: any[], total: number, counts: Record<string, number> }>}
 */
export async function listCandidatesPage({ limit, offset, sort, ...filters }) {
  const [candidates, total, counts] = await Promise.all([
    listRankedCandidates(pool, { limit, offset, direction: sort, ...filters }),
    countCandidates(pool, filters),
    // Tier counts deliberately ignore a fitCategory filter: filtering to one tier
    // and then counting tiers returns that tier and two zeroes.
    countCandidatesByFitCategory(pool, { roleId: filters.roleId, jobId: filters.jobId, status: filters.status }),
  ]);

  return { candidates, total, counts };
}

/**
 * @param {string[]} ids
 * @returns {Promise<any[]>} only the ids that exist; a client that needs to
 *   detect a deleted candidate compares lengths
 */
export async function getCandidateStatuses(ids) {
  return findCandidateStatusesByIds(pool, ids);
}

/**
 * @param {string} candidateId
 * @param {{ includeRawText: boolean }} options
 * @returns {Promise<import('../repositories/candidateRow.js').Candidate>}
 * @throws {AppError} CANDIDATE_NOT_FOUND
 */
export async function getCandidate(candidateId, { includeRawText }) {
  const candidate = await findCandidateById(pool, candidateId, { includeRawText });
  if (candidate === null) {
    throw new AppError('CANDIDATE_NOT_FOUND', 'No candidate with that id.', {
      details: { candidateId },
    });
  }
  return candidate;
}

/**
 * `POST /api/v1/candidates/:candidateId/retry`.
 *
 * The order of the four steps is the whole design, so it is written out:
 *
 * 1. **Read the candidate.** A missing one is a 404, not a 409.
 * 2. **Check the file is still on disk**, *before* touching the row. A retry
 *    whose source file is gone can never succeed, and resetting the status first
 *    would leave a candidate in `pending` that no worker can complete - it would
 *    fail again, loudly, having spent a queue attempt to discover something we
 *    already knew. `410 SOURCE_FILE_MISSING`.
 * 3. **Reset, guarded.** `resetCandidateForRetry` moves `failed -> pending` and
 *    only `failed -> pending`, clearing `error_code`, `error_message` and
 *    `completed_at` and bumping `attempts`. A status conflict here is
 *    `409 CANDIDATE_NOT_RETRYABLE`; the read in step 1 is not a substitute for
 *    the guard, because two retries can race between the read and the write.
 * 4. **Enqueue under a fresh id.** `candidateId-retry-attempts`, because the
 *    original queue-job id has been consumed - BullMQ refuses an id that already
 *    exists, even a completed one, so re-adding under the candidate UUID would
 *    silently do nothing at all. (Plan section 3 wrote that id with a colon;
 *    BullMQ rejects a colon in a custom id, so the separator changed and the
 *    plan was corrected.)
 *
 * @param {string} candidateId
 * @param {{ enqueue?: typeof enqueueCandidate }} [deps] injectable, so the retry
 *   rules can be tested against a real database without a Redis
 * @returns {Promise<{ candidate: any, queueJobId: string }>}
 * @throws {AppError} CANDIDATE_NOT_FOUND, SOURCE_FILE_MISSING, CANDIDATE_NOT_RETRYABLE
 */
export async function retryCandidate(candidateId, { enqueue = enqueueCandidate } = {}) {
  const existing = await findCandidateById(pool, candidateId);
  if (existing === null) {
    throw new AppError('CANDIDATE_NOT_FOUND', 'No candidate with that id.', {
      details: { candidateId },
    });
  }

  if (existing.status !== 'failed') {
    throw new AppError(
      'CANDIDATE_NOT_RETRYABLE',
      'Only a candidate that failed screening can be retried.',
      { details: { candidateId, status: existing.status } },
    );
  }

  if (!(await storedFileExists(existing.storagePath))) {
    throw new AppError(
      'SOURCE_FILE_MISSING',
      'The uploaded file for this candidate is no longer on the server. Upload the CV again.',
      // The storage path is deliberately not in `details`: it is a server
      // filesystem layout, and a client can do nothing with it.
      { details: { candidateId } },
    );
  }

  const reset = await resetCandidateForRetry(pool, candidateId);
  if (!reset.ok) {
    if (reset.reason === 'not_found') {
      throw new AppError('CANDIDATE_NOT_FOUND', 'No candidate with that id.', {
        details: { candidateId },
      });
    }
    throw new AppError(
      'CANDIDATE_NOT_RETRYABLE',
      'Only a candidate that failed screening can be retried.',
      { details: { candidateId, status: reset.currentStatus } },
    );
  }

  const queueJobId = await enqueue({
    candidateId,
    attempt: reset.candidate.attempts,
  });

  return { candidate: reset.candidate, queueJobId };
}
