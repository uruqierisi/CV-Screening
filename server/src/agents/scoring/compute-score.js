/**
 * The only code in the system that produces the number.
 *
 * scoreRaw = Sum(rating * weight), with rating an integer 0..10 and the weights
 * summing to exactly 100, so scoreRaw is an integer in 0..1000 and
 * score = scoreRaw / 10 is exact to one decimal with no rounding step anywhere.
 * Every intermediate value is an integer; the single division happens once, at
 * the end, on a value small enough that the result is the nearest double to a
 * one-decimal number and serializes byte-identically on every run.
 *
 * That range - 0..1000 - is a theorem given the two assertions below, not a
 * runtime check. A defensive clamp here would be unreachable code pretending to
 * be a safety net; the invariant is asserted in the tests instead, over a sweep
 * of generated inputs.
 *
 * `breakdown` is returned in the ROLE's criterion order, never the response
 * order, which is what makes a shuffled evaluation produce identical output. It
 * carries `weightedPoints` per criterion, and Sum(weightedPoints) === scoreRaw
 * exactly - that identity is what lets the detail screen show a Contribution
 * column reconciling to the final score, turning the matrix from a list of
 * opinions into an audit trail.
 */

import { RATING_MAX, RATING_MIN, REQUIRED_WEIGHT_SUM, SCORE_DIVISOR } from '../constants.js';
import { InvalidRatingError, InvalidRoleError } from '../errors.js';
import { reconcileRatings } from './reconcile-ratings.js';

/**
 * @typedef {import('../schemas/role.schema.js').RoleCriterion} RoleCriterion
 * @typedef {import('../schemas/evaluation.schema.js').CriterionRating} CriterionRating
 *
 * @typedef {object} BreakdownEntry
 * @property {string} criterionId
 * @property {number} rating integer 0..10
 * @property {number} weight integer 1..100
 * @property {number} weightedPoints rating * weight
 *
 * @typedef {object} WeightedScore
 * @property {number} score scoreRaw / 10, one decimal, 0..100
 * @property {number} scoreRaw integer 0..1000
 * @property {number} weightSum always 100, returned so a caller can assert it
 * @property {BreakdownEntry[]} breakdown in the role criterion order
 * @property {string[]} unknownIds rated ids the role does not define, dropped
 */

/**
 * Layer 3 of the sum-to-100 invariant (zod at the API boundary is layer 1, the
 * deferred CONSTRAINT TRIGGER in Postgres is layer 2). It throws rather than emit
 * a score computed over a broken denominator: an 80-point role would silently
 * produce a maximum of 80.0 and nobody reading the dashboard would know.
 *
 * @param {RoleCriterion[]} criteria
 * @returns {number}
 */
function assertWeightsSumTo100(criteria) {
  if (criteria.length === 0) {
    throw new InvalidRoleError('cannot score against a role with zero criteria');
  }

  const weightSum = criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
  if (weightSum !== REQUIRED_WEIGHT_SUM) {
    throw new InvalidRoleError(
      `criterion weights must sum to ${REQUIRED_WEIGHT_SUM}, received ${weightSum}`,
      { weightSum, criterionCount: criteria.length },
    );
  }

  return weightSum;
}

/**
 * Defence in depth at the one place a rating becomes a number a human acts on.
 * The schema already constrains ratings to integers 0..10, but the schema is not
 * the only door: a rating can also arrive from a fixture, a repaired response or
 * a future caller.
 *
 * @param {string} criterionId
 * @param {unknown} rating
 * @returns {number}
 */
function assertRating(criterionId, rating) {
  if (
    typeof rating !== 'number' ||
    !Number.isInteger(rating) ||
    rating < RATING_MIN ||
    rating > RATING_MAX
  ) {
    throw new InvalidRatingError(criterionId, rating);
  }
  return rating;
}

/**
 * @param {RoleCriterion[]} criteria the role criteria, in the role order
 * @param {CriterionRating[]} ratings the model ratings, in any order
 * @param {object} [options]
 * @param {import('../util/logger.js').AgentLogger} [options.logger]
 * @returns {WeightedScore}
 * @throws {InvalidRoleError} zero criteria, or weights that do not sum to 100
 * @throws {InvalidRatingError} a rating that is not an integer 0..10
 * @throws {import('../errors.js').IncompleteEvaluationError} a criterion with no rating
 * @throws {import('../errors.js').DuplicateRatingError} a criterion rated twice
 */
export function computeWeightedScore(criteria, ratings, options = {}) {
  const weightSum = assertWeightsSumTo100(criteria);
  const { matched, unknownIds } = reconcileRatings(criteria, ratings, options);

  const breakdown = matched.map(({ criterion, rating }) => {
    const value = assertRating(criterion.id, rating.rating);
    return {
      criterionId: criterion.id,
      rating: value,
      weight: criterion.weight,
      weightedPoints: value * criterion.weight,
    };
  });

  const scoreRaw = breakdown.reduce((sum, entry) => sum + entry.weightedPoints, 0);

  return {
    score: scoreRaw / SCORE_DIVISOR,
    scoreRaw,
    weightSum,
    breakdown,
    unknownIds,
  };
}
