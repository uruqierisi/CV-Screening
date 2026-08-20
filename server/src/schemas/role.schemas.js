/**
 * The role write contract.
 *
 * This is the first of the three layers plan section 2 puts behind
 * "weights sum to 100". It is the one that produces a message a person can act
 * on: a `WEIGHTS_MUST_SUM_TO_100` naming the total they actually sent, before
 * anything touches the database. The other two - a DEFERRABLE constraint trigger
 * at COMMIT, and an assertion inside `computeWeightedScore` - are guarantees
 * rather than messages, and they exist because a boundary check protects only
 * the paths that go through the boundary.
 *
 * Unknown keys are stripped rather than rejected. A client that sends `id` or
 * `createdAt` back in a PUT body is doing something reasonable; failing the
 * request over a field we would have ignored anyway buys nothing.
 *
 * The elimination-rule union is imported from the agent layer rather than
 * restated. `ELIMINATION_RULE_VALUE_SCHEMAS` is the same object the evaluator
 * registry is checked against, so a rule type this API accepts is by
 * construction a rule type the scoring layer can evaluate - and a rule with no
 * evaluator cannot be stored, which is the closed-union property section 2 asks
 * for.
 */

import { z } from 'zod';
import {
  ELIMINATION_RULE_TYPES,
  ELIMINATION_RULE_VALUE_SCHEMAS,
  ON_MISSING_MODES,
  REQUIRED_WEIGHT_SUM,
  WEIGHT_MAX,
  WEIGHT_MIN,
} from '../agents/index.js';
import { paginationQuery } from './common.schemas.js';

/** Matches the `label text NOT NULL` (1-120) column and its per-role uniqueness. */
const criterionInput = z.object({
  label: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  weight: z.number().int().min(WEIGHT_MIN).max(WEIGHT_MAX),
});

const eliminationRuleInput = z.discriminatedUnion(
  'type',
  ELIMINATION_RULE_TYPES.map((type) =>
    z.object({
      label: z.string().trim().min(1).max(200),
      type: z.literal(type),
      value: ELIMINATION_RULE_VALUE_SCHEMAS[type],
      onMissing: z.enum(ON_MISSING_MODES).default('flag'),
    }),
  ),
);

/**
 * The shared body of POST and PUT. They are the same shape because PUT is a full
 * replacement (plan section 3): a partial weight edit turns sum-to-100 into a
 * merge problem, and there is no defensible way to merge somebody else's
 * concurrent edit into a weighted total.
 *
 * `position` is deliberately not a client field. Order is the order of the
 * array, which is what a form actually produces, and inventing a second way to
 * express it invites the two to disagree.
 */
export const roleBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10_000).default(''),
    // At least one criterion, because the sum-to-100 constraint trigger never
    // fires for a role with none - a criteria-less role would slip past the
    // database's guarantee entirely, and then fail at upload as
    // ROLE_NOT_SCOREABLE, which is a worse place to find out.
    criteria: z.array(criterionInput).min(1).max(50),
    eliminationRules: z.array(eliminationRuleInput).max(50).default([]),
  })
  .superRefine((role, ctx) => {
    const total = role.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
    if (total !== REQUIRED_WEIGHT_SUM) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria'],
        // The number they sent, not just the number we wanted. "Weights must sum
        // to 100" with no total attached makes a recruiter add up their own form.
        message: `criterion weights must sum to ${REQUIRED_WEIGHT_SUM}, received ${total}`,
        params: { code: 'WEIGHTS_MUST_SUM_TO_100', total },
      });
    }

    const seen = new Set();
    role.criteria.forEach((criterion, index) => {
      // Case-insensitive: "Communication" and "communication" are one criterion
      // to a person, and the unique constraint on (role_id, label) is not, so
      // the two would land as a driver error instead of a message.
      const key = criterion.label.toLocaleLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['criteria', index, 'label'],
          message: `duplicate criterion label "${criterion.label}"`,
          params: { code: 'DUPLICATE_CRITERION_LABEL' },
        });
      }
      seen.add(key);
    });
  });

/**
 * The two `422` codes in plan section 3 are refinements of one zod failure, so
 * the controller needs a way to tell which one fired. Reading it off the issue's
 * `params` keeps the decision beside the rule that made it rather than
 * re-deriving it from a message string.
 *
 * @param {import('zod').ZodError} error
 * @returns {string | null} `WEIGHTS_MUST_SUM_TO_100`, `DUPLICATE_CRITERION_LABEL`, or null
 */
export function specificRoleErrorCode(error) {
  for (const issue of error.issues) {
    const code = /** @type {any} */ (issue).params?.code;
    if (typeof code === 'string') return code;
  }
  return null;
}

/** `GET /roles`. `includeArchived` exists so an archived role is still reachable. */
export const listRolesQuerySchema = paginationQuery.extend({
  includeArchived: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

/**
 * @typedef {import('zod').infer<typeof roleBodySchema>} RoleBody
 */
