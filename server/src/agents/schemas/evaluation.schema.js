/**
 * The evaluation output schema, built per role.
 *
 * The single most important property of this file is what is NOT in it: there is
 * no `score`, no `tier`, no `fitCategory`, no `overall` anything. A model cannot
 * report a number code did not compute if the response has nowhere to put one.
 * Absence is the enforcement, and `.strict()` turns an invented key into a loud
 * validation failure rather than a silently stripped one.
 *
 * `criterionId` is a dynamic `z.enum` of this role's actual ids, so constrained
 * decoding makes inventing a criterion structurally impossible - the strongest
 * guarantee available, because it is enforced during generation rather than
 * after it.
 *
 * There is deliberately NO completeness refine on `ratings`. A refine failure
 * yields `parsed_output === null` with no diagnostic; the same condition caught
 * in `reconcile-ratings.js` names the exact missing ids, which is what a retry
 * and a human both need. Put in the schema what the decoder can *enforce*; put in
 * code what it can only *reject*. An empty `ratings` array is left legal here for
 * that reason.
 */

import { z } from 'zod';
import { RATING_MAX, RATING_MIN } from '../constants.js';
import { InvalidRoleError } from '../errors.js';

/**
 * Builds the evaluation schema for one role.
 *
 * @param {{ criteria: { id: string }[] }} role a role, already through `parseRole`
 * @returns {import('zod').ZodType<Evaluation>}
 * @throws {InvalidRoleError} if the role has no criteria or repeats an id -
 *   either would make `criterionId` meaningless as a key
 */
export function makeEvaluationSchema(role) {
  const criteria = role && Array.isArray(role.criteria) ? role.criteria : null;
  if (criteria === null) {
    throw new InvalidRoleError('cannot build an evaluation schema: role has no criteria list');
  }
  if (criteria.length === 0) {
    throw new InvalidRoleError('cannot build an evaluation schema: role has zero criteria');
  }

  const criterionIds = criteria.map((criterion) => criterion.id);
  const duplicates = criterionIds.filter((id, index) => criterionIds.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new InvalidRoleError('cannot build an evaluation schema: duplicate criterion ids', {
      duplicateCriterionIds: [...new Set(duplicates)],
    });
  }

  const criterionIdSchema = z.enum(/** @type {[string, ...string[]]} */ (criterionIds));

  const ratingSchema = z
    .object({
      criterionId: criterionIdSchema,
      /**
       * An integer 0..10. Anchored bands live in the prompt (phase 2b); the type
       * lives here. A percentage or a 1-5 scale would both collapse into the
       * middle - and a float would invite the model to express a confidence it
       * does not have.
       */
      rating: z.number().int().min(RATING_MIN).max(RATING_MAX),
      /**
       * Non-nullable, and the only non-nullable free-text field in the layer. A
       * rating with no reason is precisely what this product exists not to
       * produce: the reason is what a recruiter reads next to the number.
       */
      reason: z.string().min(1),
      /**
       * Nullable, because a rating of 0 has nothing to cite. Making this
       * non-nullable would guarantee fabricated evidence on exactly the ratings
       * where the profile is silent.
       */
      evidence: z.string().nullable(),
    })
    .strict();

  return z
    .object({
      ratings: z.array(ratingSchema),
      /**
       * Free text for `candidates.ai_justification`. Prose only - it is never
       * parsed, never compared, and nothing downstream reads a number out of it.
       * Nullable so "I have nothing to add beyond the per-criterion reasons" is a
       * legal answer instead of an invitation to pad.
       */
      summary: z.string().nullable(),
    })
    .strict();
}

/**
 * The keys the evaluation object may have. Exported so a test can assert the
 * surface has not grown a `score`, and so the assertion lives next to the reason
 * it exists.
 *
 * @type {readonly string[]}
 */
export const EVALUATION_KEYS = Object.freeze(['ratings', 'summary']);

/** @type {readonly string[]} */
export const RATING_KEYS = Object.freeze(['criterionId', 'rating', 'reason', 'evidence']);

/**
 * @typedef {object} CriterionRating
 * @property {string} criterionId
 * @property {number} rating integer 0..10
 * @property {string} reason
 * @property {string | null} evidence
 *
 * @typedef {object} Evaluation
 * @property {CriterionRating[]} ratings
 * @property {string | null} summary
 */
