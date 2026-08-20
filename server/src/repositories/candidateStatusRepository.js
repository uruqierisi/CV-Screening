import { CANDIDATE_FULL_COLUMNS, toCandidate } from './candidateRow.js';

/**
 * Guarded status transitions for `candidates`.
 *
 * Every write here is `WHERE id = $1 AND status = $expected`, never a blind
 * `WHERE id = $1`. The reason is concrete: BullMQ can deliver a job twice, and a
 * candidate that was retried after a failure may already have moved on. A blind
 * update lets a stale worker overwrite a fresh result with an old one, and
 * nothing in the data afterwards shows that it happened.
 *
 * The guard turning up empty is not an error at this layer. It is a fact the
 * caller has to act on - so these functions return a discriminated result rather
 * than throwing, and the decision to log-and-drop, retry, or return 409 belongs
 * above.
 *
 * @typedef {import('../db/pool.js').Queryable} Queryable
 * @typedef {import('./candidateRow.js').Candidate} Candidate
 *
 * @typedef {{ ok: true, candidate: Candidate }} TransitionApplied
 * @typedef {{ ok: false, reason: 'not_found' }} TransitionNotFound
 * @typedef {{ ok: false, reason: 'status_conflict', currentStatus: string }} TransitionConflict
 * @typedef {TransitionApplied | TransitionNotFound | TransitionConflict} TransitionResult
 */

/** Statuses a candidate can move out of. Terminal rows are not re-openable except via retry. */
const NON_TERMINAL_STATUSES = ['pending', 'parsing', 'evaluating'];

/**
 * Runs a guarded UPDATE and turns "no rows matched" into a reason the caller can
 * branch on.
 *
 * The follow-up SELECT is diagnostic only. It runs on the same connection but not
 * necessarily in the same transaction as the UPDATE, so the status it reports can
 * already be stale by the time it is read. That is acceptable: it exists to make
 * a log line and an error message useful, never to make a second decision.
 *
 * @param {Queryable} db
 * @param {{ candidateId: string, sql: string, params: any[] }} input
 * @returns {Promise<TransitionResult>}
 */
async function runGuardedTransition(db, { candidateId, sql, params }) {
  const { rows, rowCount } = await db.query(sql, params);

  if (rowCount === 1) {
    return { ok: true, candidate: toCandidate(rows[0]) };
  }

  const current = await db.query('SELECT status FROM candidates WHERE id = $1', [candidateId]);
  if (current.rows.length === 0) {
    return { ok: false, reason: 'not_found' };
  }

  return { ok: false, reason: 'status_conflict', currentStatus: current.rows[0].status };
}

/**
 * pending -> parsing. Claimed by a worker that is about to extract text.
 *
 * @param {Queryable} db
 * @param {string} candidateId
 * @returns {Promise<TransitionResult>}
 */
export async function markCandidateParsing(db, candidateId) {
  return runGuardedTransition(db, {
    candidateId,
    sql: `UPDATE candidates
             SET status = 'parsing',
                 updated_at = now()
           WHERE id = $1 AND status = 'pending'
           RETURNING ${CANDIDATE_FULL_COLUMNS}`,
    params: [candidateId],
  });
}

/**
 * parsing -> evaluating, storing the extracted text.
 *
 * `raw_text` is written here rather than at `done` so that a candidate which
 * fails inside the agent layer still has its extracted text on record - that is
 * the first thing anyone debugging a bad score wants to see.
 *
 * @param {Queryable} db
 * @param {{ candidateId: string, rawText: string }} input
 * @returns {Promise<TransitionResult>}
 */
export async function markCandidateEvaluating(db, { candidateId, rawText }) {
  return runGuardedTransition(db, {
    candidateId,
    sql: `UPDATE candidates
             SET status = 'evaluating',
                 raw_text = $2,
                 updated_at = now()
           WHERE id = $1 AND status = 'parsing'
           RETURNING ${CANDIDATE_FULL_COLUMNS}`,
    params: [candidateId, rawText],
  });
}

/**
 * evaluating -> done, with the full result.
 *
 * This repository stores what it is given and checks nothing about it. Forcing
 * `fitCategory` to 'unmatched' for an eliminated candidate is the scoring layer's
 * job (assignTier checks elimination first, unconditionally); duplicating that
 * rule in SQL would create a second place it could be changed.
 *
 * Note that `matchScore` is stored even when `eliminated` is true. The database's
 * done-completeness CHECK requires it, and the product requires it: a recruiter
 * has to be able to see "eliminated, but would have scored 88".
 *
 * @param {Queryable} db
 * @param {object} input
 * @param {string} input.candidateId
 * @param {string | null} input.candidateName
 * @param {Record<string, any>} input.parsedProfile
 * @param {Record<string, any>} input.evaluationMatrix
 * @param {Record<string, any> | null} input.eliminationDetails
 * @param {boolean} input.eliminated
 * @param {string | null} input.eliminatedBy failing rule label
 * @param {number} input.matchScore 0..100, one decimal
 * @param {'strong_match'|'potential_match'|'unmatched'} input.fitCategory
 * @param {string | null} input.aiJustification
 * @param {number} input.scoredRoleVersion role version this score was computed against
 * @returns {Promise<TransitionResult>}
 */
export async function markCandidateDone(db, input) {
  return runGuardedTransition(db, {
    candidateId: input.candidateId,
    sql: `UPDATE candidates
             SET status = 'done',
                 candidate_name = $2,
                 parsed_profile = $3::jsonb,
                 evaluation_matrix = $4::jsonb,
                 elimination_details = $5::jsonb,
                 eliminated = $6,
                 eliminated_by = $7,
                 match_score = $8,
                 fit_category = $9,
                 ai_justification = $10,
                 scored_role_version = $11,
                 -- A successful run clears any error left by a previous attempt;
                 -- the pair moves together or the paired-nullability CHECK fires.
                 error_code = NULL,
                 error_message = NULL,
                 completed_at = now(),
                 updated_at = now()
           WHERE id = $1 AND status = 'evaluating'
           RETURNING ${CANDIDATE_FULL_COLUMNS}`,
    params: [
      input.candidateId,
      input.candidateName,
      JSON.stringify(input.parsedProfile),
      JSON.stringify(input.evaluationMatrix),
      input.eliminationDetails === null ? null : JSON.stringify(input.eliminationDetails),
      input.eliminated,
      input.eliminatedBy,
      input.matchScore,
      input.fitCategory,
      input.aiJustification,
      input.scoredRoleVersion,
    ],
  });
}

/**
 * Any non-terminal status -> failed.
 *
 * The guard is a set rather than a single status because a candidate can fail at
 * any point in the pipeline, but it still excludes `done` and `failed`: a late
 * worker must not be able to turn a finished candidate into a failed one.
 *
 * @param {Queryable} db
 * @param {{ candidateId: string, errorCode: string, errorMessage: string }} input
 *   errorCode is a worker-side candidate code (EXTRACTION_FAILED, AGENT_TIMEOUT,
 *   ...), never an HTTP error code - the two namespaces are deliberately separate
 * @returns {Promise<TransitionResult>}
 */
export async function markCandidateFailed(db, { candidateId, errorCode, errorMessage }) {
  return runGuardedTransition(db, {
    candidateId,
    sql: `UPDATE candidates
             SET status = 'failed',
                 error_code = $2,
                 error_message = $3,
                 completed_at = now(),
                 updated_at = now()
           WHERE id = $1 AND status = ANY($4::text[])
           RETURNING ${CANDIDATE_FULL_COLUMNS}`,
    params: [candidateId, errorCode, errorMessage, NON_TERMINAL_STATUSES],
  });
}

/**
 * failed -> pending, for POST /candidates/:id/retry.
 *
 * Bumps `attempts` and returns the updated row, because the caller needs the new
 * attempt number to build a fresh queue-job id (`candidateId:attempts`) - the
 * original id is consumed by the completed BullMQ job.
 *
 * Deliberately does not clear parsed_profile / evaluation_matrix / match_score: a
 * failed candidate never reached `done`, so there is nothing there to clear, and
 * a blanket reset would silently discard partial diagnostics.
 *
 * @param {Queryable} db
 * @param {string} candidateId
 * @returns {Promise<TransitionResult>} status_conflict when the candidate is not
 *   `failed` - the caller maps that to 409 CANDIDATE_NOT_RETRYABLE
 */
export async function resetCandidateForRetry(db, candidateId) {
  return runGuardedTransition(db, {
    candidateId,
    sql: `UPDATE candidates
             SET status = 'pending',
                 error_code = NULL,
                 error_message = NULL,
                 completed_at = NULL,
                 attempts = attempts + 1,
                 updated_at = now()
           WHERE id = $1 AND status = 'failed'
           RETURNING ${CANDIDATE_FULL_COLUMNS}`,
    params: [candidateId],
  });
}

/**
 * parsing | evaluating -> pending, releasing a candidate for another queue
 * attempt.
 *
 * This is the worker's rollback, and it exists because the claim is guarded.
 * `markCandidateParsing` only moves `pending -> parsing`, so a candidate left in
 * `parsing` by a transient failure could never be re-claimed by BullMQ's next
 * attempt - the guard would reject it and the retry would do nothing. Rolling
 * the status back is what makes the guard and the retry policy compatible.
 *
 * Deliberately does **not** bump `attempts`. That column counts *manual* retries
 * (`POST /candidates/:id/retry`), because its value is what builds the fresh
 * queue-job id; automatic attempts are BullMQ's to count, and mixing the two
 * would produce a retry id colliding with one already used.
 *
 * Terminal rows are excluded, so this can never re-open a candidate that another
 * worker already finished.
 *
 * @param {Queryable} db
 * @param {string} candidateId
 * @returns {Promise<TransitionResult>}
 */
export async function releaseCandidateToPending(db, candidateId) {
  return runGuardedTransition(db, {
    candidateId,
    sql: `UPDATE candidates
             SET status = 'pending',
                 updated_at = now()
           WHERE id = $1 AND status = ANY($2::text[])
           RETURNING ${CANDIDATE_FULL_COLUMNS}`,
    params: [candidateId, ['parsing', 'evaluating']],
  });
}
