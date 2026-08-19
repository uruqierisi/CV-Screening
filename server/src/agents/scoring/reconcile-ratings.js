/**
 * Lines up the model's ratings with the role's criteria - by id, in the role's
 * order - and decides what to do about every way the two sets can disagree.
 *
 * This is set algebra, not arithmetic. It answers "which rating belongs to which
 * criterion" and nothing else; `compute-score.js` does the multiplying. Splitting
 * them means the reconciliation policy below can be read and tested without a
 * single number in sight.
 *
 * The policy (plan section 5.3), three distinct behaviours that must not be
 * collapsed into one:
 *
 * - **A rating for a criterion that no longer exists** is dropped, recorded in
 *   `unknownIds` and warned. An extra rating cannot corrupt a weighted sum taken
 *   over a fixed criterion set, and a role edited between evaluation and scoring
 *   is a normal event, not a corrupt response.
 *
 * - **A criterion missing from the response** is a hard failure. Substituting 0
 *   silently depresses the score; renormalizing over the criteria that did arrive
 *   silently inflates it. Both are invisible to a recruiter reading the number,
 *   and a visibly failed candidate is recoverable where a quietly mis-scored one
 *   is not. The error names the exact ids.
 *
 * - **A duplicate criterionId** is a hard failure. There is no defensible way to
 *   choose between two contradictory ratings of the same thing.
 */

import { DuplicateRatingError, IncompleteEvaluationError } from '../errors.js';
import { NOOP_LOGGER } from '../util/logger.js';

/**
 * @typedef {import('../schemas/role.schema.js').RoleCriterion} RoleCriterion
 * @typedef {import('../schemas/evaluation.schema.js').CriterionRating} CriterionRating
 *
 * @typedef {object} ReconciledRating
 * @property {RoleCriterion} criterion the role's criterion, in the role's order
 * @property {CriterionRating} rating the model's rating for it
 *
 * @typedef {object} ReconciliationResult
 * @property {ReconciledRating[]} matched one per criterion, in the ROLE's order
 * @property {string[]} unknownIds rated ids the role does not define, dropped
 */

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {asserts value is unknown[]}
 */
function assertArray(value, name) {
  if (!Array.isArray(value)) {
    // Not an AgentError: the schema guarantees an array, so reaching this means a
    // caller inside our own code passed the wrong thing. That is a bug to fix,
    // not a candidate to fail.
    throw new TypeError(`${name} must be an array`);
  }
}

/**
 * @param {RoleCriterion[]} criteria the role's criteria, in the role's order
 * @param {CriterionRating[]} ratings the model's ratings, in any order
 * @param {object} [options]
 * @param {import('../util/logger.js').AgentLogger} [options.logger]
 * @returns {ReconciliationResult}
 * @throws {DuplicateRatingError} if any criterion is rated more than once
 * @throws {IncompleteEvaluationError} if any criterion has no rating
 */
export function reconcileRatings(criteria, ratings, { logger = NOOP_LOGGER } = {}) {
  assertArray(criteria, 'criteria');
  assertArray(ratings, 'ratings');

  const ratingById = new Map();
  const duplicateIds = [];

  for (const rating of ratings) {
    if (ratingById.has(rating.criterionId)) {
      duplicateIds.push(rating.criterionId);
      continue;
    }
    ratingById.set(rating.criterionId, rating);
  }

  if (duplicateIds.length > 0) {
    // Checked before completeness: a response that rates the same criterion twice
    // is malformed as a whole, and reporting "you are missing X" about a response
    // that is confused about what it already said would send a reader the wrong
    // way. Duplicates of an unrecognised id count too - the response is no less
    // malformed for having invented the id it repeated.
    throw new DuplicateRatingError([...new Set(duplicateIds)]);
  }

  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  const unknownIds = [...ratingById.keys()].filter((id) => !criterionIds.has(id));

  if (unknownIds.length > 0) {
    logger.warn('dropped ratings for criteria the role does not define', { unknownIds });
  }

  const missingIds = criteria
    .filter((criterion) => !ratingById.has(criterion.id))
    .map((criterion) => criterion.id);

  if (missingIds.length > 0) {
    throw new IncompleteEvaluationError(missingIds);
  }

  return {
    // The role's order, never the response's. This is the single reason a
    // shuffled response produces byte-identical output.
    matched: criteria.map((criterion) => ({
      criterion,
      rating: /** @type {CriterionRating} */ (ratingById.get(criterion.id)),
    })),
    unknownIds,
  };
}
