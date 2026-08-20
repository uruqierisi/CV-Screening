/**
 * The whole deterministic core, composed: role in, ratings in, profile in, the
 * candidate's result out.
 *
 * Everything a recruiter sees on a candidate row and on the detail screen is
 * decided here, and none of it is decided by a model. The model contributed
 * ratings and reasons; this function contributes the score, the tier, the
 * elimination verdict and the audit trail that reconciles them.
 *
 * It is pure. Same role, same profile, same evaluation, same `now` gives the same
 * bytes - which is what the 100-run golden fixture test asserts, and what makes
 * "the score is a reproducible function of the ratings" an honest claim even
 * though the ratings themselves are not reproducible.
 *
 * Order of operations matters and is deliberate:
 *
 * 1. Validate the role. A broken role must fail before anything else runs, or
 *    the failure surfaces as a strange score instead of a bad configuration.
 * 2. Score. Elimination does not influence a single rating or point: an
 *    eliminated candidate keeps the score they earned, because the dashboard has
 *    to be able to say "eliminated, but would have scored 88". That sentence is
 *    the difference between a tool a recruiter trusts and a black box.
 * 3. Evaluate the rules.
 * 4. Assign the tier, elimination first.
 */

import { computeWeightedScore } from './compute-score.js';
import { evaluateEliminationRules } from './elimination.js';
import { assignTier } from './tiers.js';
import { parseRole } from '../schemas/role.schema.js';

/**
 * @typedef {import('../schemas/profile.schema.js').VerifiedProfile} VerifiedProfile
 * @typedef {import('../schemas/evaluation.schema.js').Evaluation} Evaluation
 *
 * @typedef {object} MatrixRow
 * @property {string} criterionId
 * @property {string} label
 * @property {number} weight
 * @property {number} rating integer 0..10
 * @property {number} weightedPoints rating * weight; these sum to scoreRaw exactly
 * @property {string} reason
 * @property {string | null} evidence
 *
 * @typedef {object} ScoredCandidate
 * @property {number} score one decimal, 0..100
 * @property {number} scoreRaw integer 0..1000
 * @property {import('../constants.js').FitCategory} fitCategory
 * @property {boolean} eliminated
 * @property {string | null} eliminatedBy
 * @property {number} scoredRoleVersion the role version this score was produced under
 * @property {string | null} aiJustification the model's prose summary, stored verbatim
 * @property {string[]} unknownCriterionIds ratings dropped because the role no longer defines them
 * @property {{ scoreRaw: number, criteria: MatrixRow[], computedAt: string }} evaluationMatrix
 * @property {object} eliminationDetails
 */

/**
 * @param {object} params
 * @param {unknown} params.role the role, straight from the repository
 * @param {VerifiedProfile} params.profile verified profile, carrying `computedYearsExperience`
 * @param {Evaluation} params.evaluation the model's ratings, in any order
 * @param {Date} params.now injected clock, stamped into the audit records
 * @param {import('../util/logger.js').AgentLogger} [params.logger]
 * @returns {ScoredCandidate}
 */
export function scoreCandidate({ role, profile, evaluation, now, logger }) {
  const scoringRole = parseRole(role);

  const { score, scoreRaw, breakdown, unknownIds } = computeWeightedScore(
    scoringRole.criteria,
    evaluation.ratings,
    { logger },
  );

  const elimination = evaluateEliminationRules(profile, scoringRole.eliminationRules, { now });
  const fitCategory = assignTier(score, elimination.eliminated);

  const timestamp = now.toISOString();
  const ratingById = new Map(evaluation.ratings.map((rating) => [rating.criterionId, rating]));
  const criteriaById = new Map(scoringRole.criteria.map((criterion) => [criterion.id, criterion]));

  return {
    score,
    scoreRaw,
    fitCategory,
    eliminated: elimination.eliminated,
    eliminatedBy: elimination.eliminatedBy,
    scoredRoleVersion: scoringRole.version,
    // Stored verbatim in `candidates.ai_justification`. Prose only; nothing reads
    // a number out of it, and the schema gives the model nowhere to put one.
    aiJustification: evaluation.summary ?? null,
    unknownCriterionIds: unknownIds,
    evaluationMatrix: {
      scoreRaw,
      // Built from `breakdown`, so the rows are in the role's criterion order and
      // their Contribution column sums to scoreRaw by construction rather than by
      // coincidence.
      criteria: breakdown.map((entry) => {
        const criterion = /** @type {any} */ (criteriaById.get(entry.criterionId));
        const rating = /** @type {any} */ (ratingById.get(entry.criterionId));
        return {
          criterionId: entry.criterionId,
          label: criterion.label,
          weight: entry.weight,
          rating: entry.rating,
          weightedPoints: entry.weightedPoints,
          reason: rating.reason,
          evidence: rating.evidence,
        };
      }),
      computedAt: timestamp,
    },
    // Stored verbatim in `candidates.elimination_details` (jsonb) and read by the
    // candidate detail view. `results` carries every rule with its `outcome`, so
    // an unchecked requirement is distinguishable from a satisfied one rather
    // than collapsing into "not eliminated" - which is the whole point of 7-C's
    // third outcome. `indeterminate` is the same rows pre-filtered, and
    // `hasIndeterminate` is the one key a row badge needs without walking the
    // blob. Both are derived rather than authoritative; `results` is the record.
    eliminationDetails: {
      eliminated: elimination.eliminated,
      eliminatedBy: elimination.eliminatedBy,
      results: elimination.results,
      failures: elimination.failures,
      indeterminate: elimination.indeterminate,
      hasIndeterminate: elimination.indeterminate.length > 0,
      evaluatedAt: timestamp,
    },
  };
}
