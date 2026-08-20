/**
 * One candidate, from a queue job to a row in `done` or `failed`.
 *
 * This is the pipeline plan section 4 describes, and it is deliberately a
 * *composition*: text extraction is phase 3's, screening is the agent layer's,
 * scoring is phase 2a's, and the writes are phase 1's repositories. Nothing in
 * this file parses a PDF, prompts a model or computes a score. What it owns is
 * the order, the status transitions, and what happens when a step throws.
 *
 * ```
 *   claim (pending -> parsing)
 *     -> read the file       -> extract text
 *     -> parsing -> evaluating, storing raw_text
 *     -> load the role       -> screenCandidate()  [two model calls]
 *     -> evaluating -> done, with score, tier, matrix and justification
 * ```
 *
 * ## Every transition is guarded, and the guard is the point
 *
 * The repositories only ever write `WHERE id = $1 AND status = $expected`, and
 * this file checks `rowCount` by branching on the discriminated result. A guard
 * that comes back empty is **not** an error here - it is a fact, and the fact is
 * almost always "somebody else already dealt with this candidate". BullMQ can
 * deliver a job twice, a stalled job can be re-queued while the original is
 * still running, and a retry can move a candidate on underneath a slow worker.
 * In each of those cases the correct behaviour is to stop, quietly, having
 * changed nothing - and never to overwrite a fresh result with a stale one.
 *
 * ## Rolling back to `pending` before a retry
 *
 * A transient failure leaves the candidate in `parsing` or `evaluating`, and the
 * claim only accepts `pending`. So a retryable failure explicitly releases the
 * candidate back to `pending` before rethrowing; without that, BullMQ's next
 * attempt would hit the guard and do nothing, and the candidate would sit
 * non-terminal until the stuck sweep found it. This is the one place the guard
 * and the retry policy have to be made compatible on purpose.
 *
 * ## The last attempt
 *
 * A failure that is not retryable, or a retryable one on the final attempt,
 * writes the terminal row first - status `failed`, `error_code`,
 * `error_message`, `completed_at` - and *then* rethrows, so Postgres carries the
 * durable truth whether or not anybody looks at Redis, and the job still lands
 * in BullMQ's failed set with its stack for whoever does. A non-retryable
 * failure rethrows `UnrecoverableError`, which tells BullMQ not to spend the
 * remaining attempts on something that cannot change.
 */

import { UnrecoverableError } from 'bullmq';
import { screenCandidate } from '../../agents/index.js';
import { extractDocumentText } from '../../extraction/index.js';
import {
  markCandidateDone,
  markCandidateEvaluating,
  markCandidateFailed,
  markCandidateParsing,
  releaseCandidateToPending,
} from '../../repositories/candidateStatusRepository.js';
import { listCriteriaByRoleId } from '../../repositories/roleCriteriaRepository.js';
import { listEliminationRulesByRoleId } from '../../repositories/roleEliminationRulesRepository.js';
import { findRoleById } from '../../repositories/rolesRepository.js';
import { readStored } from '../../storage/localDisk.js';
import { toAgentLogger } from '../../util/logging.js';
import { screeningJobPayloadSchema } from '../screeningQueue.js';
import { SOURCE_FILE_MISSING_CODE, toCandidateFailure } from '../candidateFailure.js';

/**
 * Why a job did nothing. Returned rather than thrown, because none of these is a
 * failure of the job - the job ran, correctly, and found there was nothing left
 * for it to do.
 */
export const SKIP_REASONS = Object.freeze({
  CANDIDATE_GONE: 'candidate_gone',
  ALREADY_CLAIMED: 'already_claimed',
});

/**
 * A file that is not on disk, shaped like the errors everything else throws so
 * `toCandidateFailure` needs no special case for it.
 */
class MissingSourceFileError extends Error {
  /** @param {string} candidateId */
  constructor(candidateId) {
    super(`source file missing for candidate ${candidateId}`);
    this.name = 'MissingSourceFileError';
    this.code = SOURCE_FILE_MISSING_CODE;
    this.userMessage =
      'The uploaded file for this candidate is no longer on the server. Upload the CV again.';
    // A file that is gone does not come back on its own.
    this.retryable = false;
  }
}

/**
 * Runs one screening.
 *
 * Every dependency is injected, which is what lets the whole pipeline be tested
 * against a real Postgres and a **fake** Anthropic client - exactly the way the
 * agent layer's own suite does it, with no module mocking and no socket.
 *
 * @param {object} params
 * @param {{ candidateId: string }} params.data the queue job's payload, unparsed
 * @param {object} params.attempt
 * @param {number} params.attempt.number 1-based; `job.attemptsMade + 1`
 * @param {number} params.attempt.max `job.opts.attempts`
 * @param {import('../../db/pool.js').Queryable} params.db
 * @param {{ messages: { create: Function, parse: Function } }} params.client
 * @param {Date} params.now injected clock; experience, certification expiry and
 *   every audit timestamp read it
 * @param {AbortSignal} [params.signal] the worker's shutdown signal
 * @param {any} [params.logger] pino-style: `(mergingObject, message)`. Adapted
 *   before it is handed to the agent layer, whose interface is the other way
 *   round - see `util/logging.js`.
 * @param {(input: any) => Promise<any>} [params.screen] injectable pipeline, for
 *   tests that need to drive a failure the fake client cannot express
 * @param {(relativePath: string) => Promise<Buffer>} [params.readFile]
 * @returns {Promise<{ outcome: 'done' | 'skipped', reason?: string, candidateId: string }>}
 */
export async function processScreeningJob({
  data,
  attempt,
  db,
  client,
  now,
  signal,
  logger = {},
  screen = screenCandidate,
  readFile = readStored,
}) {
  // The payload is external input to this process - it came out of Redis, which
  // is rebuildable and therefore not trusted to have the shape we last wrote.
  const { candidateId } = screeningJobPayloadSchema.parse(data);

  const claim = await markCandidateParsing(db, candidateId);
  if (!claim.ok) {
    // Not an error. Either the row is gone (the role was deleted, the database
    // was reset) or somebody else has it.
    const reason =
      claim.reason === 'not_found' ? SKIP_REASONS.CANDIDATE_GONE : SKIP_REASONS.ALREADY_CLAIMED;
    logger.warn?.(
      { candidateId, reason, currentStatus: claim.reason === 'not_found' ? null : claim.currentStatus },
      'screening job skipped',
    );
    return { outcome: 'skipped', reason, candidateId };
  }

  const candidate = claim.candidate;

  try {
    const bytes = await readBytes(readFile, candidate.storagePath, candidateId);

    const document = await extractDocumentText({
      bytes,
      declaredMimeType: candidate.mimeType,
    });

    const evaluating = await markCandidateEvaluating(db, {
      candidateId,
      rawText: document.text,
    });
    if (!evaluating.ok) {
      // Somebody moved the candidate while text was being extracted. Stop
      // without writing: whatever they did is newer than what this job knows.
      logger.warn?.({ candidateId, transition: 'evaluating' }, 'screening job lost its claim');
      return { outcome: 'skipped', reason: SKIP_REASONS.ALREADY_CLAIMED, candidateId };
    }

    const role = await loadScoringRole(db, candidate.roleId);

    const result = await screen({
      client,
      role,
      cvText: document.text,
      now,
      signal,
      logger: toAgentLogger(logger),
    });

    const done = await markCandidateDone(db, {
      candidateId,
      // The dashboard shows people, not filenames. Null when extraction could
      // not find a name, which the column allows.
      candidateName: result.profile.fullName ?? null,
      parsedProfile: result.profile,
      evaluationMatrix: result.scored.evaluationMatrix,
      eliminationDetails: result.scored.eliminationDetails,
      eliminated: result.scored.eliminated,
      eliminatedBy: result.scored.eliminatedBy,
      // Kept even when eliminated: "eliminated, but would have scored 88" is the
      // whole point of showing the work.
      matchScore: result.scored.score,
      fitCategory: result.scored.fitCategory,
      aiJustification: result.scored.aiJustification,
      scoredRoleVersion: result.scored.scoredRoleVersion,
    });

    if (!done.ok) {
      logger.warn?.({ candidateId, transition: 'done' }, 'screening job lost its claim');
      return { outcome: 'skipped', reason: SKIP_REASONS.ALREADY_CLAIMED, candidateId };
    }

    logger.info?.(
      {
        candidateId,
        score: result.scored.score,
        fitCategory: result.scored.fitCategory,
        eliminated: result.scored.eliminated,
        usage: result.diagnostics.usage,
      },
      'candidate screened',
    );

    return { outcome: 'done', candidateId };
  } catch (error) {
    const { unrecoverable } = await handleFailure({ error, candidateId, attempt, db, logger });

    if (unrecoverable) {
      // Tells BullMQ not to spend the remaining attempts on something that
      // cannot change. The message carries the code and the candidate id and
      // nothing else - the original error, with its stack, has already been
      // logged in full above, and BullMQ's failed set is readable by an
      // operator, not by a client.
      throw new UnrecoverableError(
        `candidate ${candidateId} failed permanently: ${errorCodeOf(error)}`,
      );
    }

    throw error;
  }
}

/**
 * @param {any} error
 * @returns {string}
 */
function errorCodeOf(error) {
  return toCandidateFailure(error).errorCode;
}

/**
 * Reads the CV bytes, turning "not on disk" into a typed failure.
 *
 * @param {(relativePath: string) => Promise<Buffer>} readFile
 * @param {string} storagePath
 * @param {string} candidateId
 * @returns {Promise<Buffer>}
 */
async function readBytes(readFile, storagePath, candidateId) {
  try {
    return await readFile(storagePath);
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') {
      throw new MissingSourceFileError(candidateId);
    }
    throw error;
  }
}

/**
 * The role as the scoring layer wants it: one object, three lists flattened into
 * two.
 *
 * Read at job time rather than embedded in the queue payload, so a candidate
 * that waited behind a batch is scored against the role as it is now. The role
 * cannot be missing - `candidates.role_id` is `ON DELETE RESTRICT` - but the
 * check is here anyway, because "cannot happen" is how a null reaches
 * `parseRole` and fails as `AGENT_INVALID_ROLE` two frames later with no clue
 * why.
 *
 * @param {import('../../db/pool.js').Queryable} db
 * @param {string} roleId
 * @returns {Promise<object>}
 */
async function loadScoringRole(db, roleId) {
  const [role, criteria, eliminationRules] = await Promise.all([
    findRoleById(db, roleId),
    listCriteriaByRoleId(db, roleId),
    listEliminationRulesByRoleId(db, roleId),
  ]);

  if (role === null) {
    throw new Error(`role ${roleId} not found for a candidate that references it`);
  }

  return {
    id: role.id,
    title: role.title,
    version: role.version,
    criteria,
    eliminationRules,
  };
}

/**
 * Decides between "release it for another attempt" and "this candidate is
 * finished, and it failed".
 *
 * The agent layer labels retryability; this is the worker deciding policy from
 * that label plus the attempt budget - the split plan section 5.4 asks for.
 *
 * @param {object} params
 * @param {any} params.error
 * @param {string} params.candidateId
 * @param {{ number: number, max: number }} params.attempt
 * @param {import('../../db/pool.js').Queryable} params.db
 * @param {any} params.logger
 * @returns {Promise<{ unrecoverable: boolean }>} whether BullMQ should stop
 *   spending attempts on this candidate
 */
async function handleFailure({ error, candidateId, attempt, db, logger }) {
  const failure = toCandidateFailure(error);
  const attemptsRemain = attempt.number < attempt.max;

  // The whole error, once, here. Nothing below this line puts an unknown
  // message anywhere a client can read it.
  logger.error?.(
    {
      err: error,
      candidateId,
      errorCode: failure.errorCode,
      retryable: failure.retryable,
      attempt: attempt.number,
      maxAttempts: attempt.max,
    },
    'candidate screening failed',
  );

  if (failure.retryable && attemptsRemain) {
    const released = await releaseCandidateToPending(db, candidateId);
    if (!released.ok) {
      // Somebody else has already moved it on. Leave their result alone.
      logger.warn?.({ candidateId }, 'could not release candidate for retry');
    }
    return { unrecoverable: false };
  }

  const failed = await markCandidateFailed(db, {
    candidateId,
    errorCode: failure.errorCode,
    errorMessage: failure.errorMessage,
  });

  if (!failed.ok) {
    logger.warn?.({ candidateId, reason: failed.reason }, 'candidate was already terminal');
  }

  // A retryable failure that simply ran out of attempts is still a genuine
  // failure; it just does not need BullMQ told to stop, because BullMQ already
  // has. Only a fault that cannot change gets the unrecoverable label.
  return { unrecoverable: !failure.retryable };
}

/**
 * The BullMQ processor. Thin on purpose: it unpacks what BullMQ knows and hands
 * it to the function above, which knows nothing about a job object.
 *
 * @param {object} deps
 * @param {import('../../db/pool.js').Queryable} deps.db
 * @param {{ messages: { create: Function, parse: Function } }} deps.client
 * @param {() => Date} [deps.clock]
 * @param {AbortSignal} [deps.signal]
 * @param {any} [deps.logger]
 * @returns {(job: any) => Promise<any>}
 */
export function makeScreeningProcessor({ db, client, clock = () => new Date(), signal, logger }) {
  return async function processor(job) {
    const result = await processScreeningJob({
      data: job.data,
      attempt: {
        number: job.attemptsMade + 1,
        max: job.opts?.attempts ?? 1,
      },
      db,
      client,
      now: clock(),
      signal,
      logger,
    });
    return result;
  };
}
