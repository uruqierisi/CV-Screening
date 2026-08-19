/**
 * The role, as the deterministic core needs to see it.
 *
 * This schema validates data that came out of our own database, not out of a
 * model, so it is shaped differently from the model-facing schemas: unknown keys
 * are stripped rather than rejected (a repository row carries `createdAt` and
 * friends that scoring has no opinion about), and nothing is nullable, because
 * every column behind it is NOT NULL.
 *
 * What it does share with the model-facing schemas is that it refuses to guess.
 * A role with no criteria, weights that do not sum to 100, duplicate criterion
 * ids or a rule whose `value` does not match its `type` is not repaired here -
 * it throws, because every one of those produces a number that looks fine and
 * is wrong.
 *
 * `id` is a plain non-empty string rather than a uuid: the ids are opaque to
 * scoring, and requiring uuids would mean a reviewer cannot hand-write a role
 * fixture called `c1`.
 */

import { z } from 'zod';
import {
  EDUCATION_LEVELS,
  ELIMINATION_RULE_TYPES,
  MATCH_MODES,
  ON_MISSING_MODES,
  REQUIRED_WEIGHT_SUM,
  WEIGHT_MAX,
  WEIGHT_MIN,
} from '../constants.js';
import { InvalidRoleError } from '../errors.js';

const nonEmptyString = z.string().min(1);
const nonNegativeInt = z.number().int().min(0);

/** One weighted scoring criterion. */
export const criterionSchema = z.object({
  id: nonEmptyString,
  label: z.string().min(1).max(120),
  description: z.string(),
  weight: z.number().int().min(WEIGHT_MIN).max(WEIGHT_MAX),
  position: nonNegativeInt,
});

/**
 * The `value` shape for each rule type, keyed by type.
 *
 * Exported because `elimination.js` validates a rule's value with the schema for
 * its type immediately after looking the evaluator up - so the predicate can
 * assume its inputs, and a malformed rule fails as `AGENT_INVALID_ROLE` rather
 * than as an undefined property comparison that quietly returns false.
 */
export const ELIMINATION_RULE_VALUE_SCHEMAS = Object.freeze({
  min_years_experience: z
    .object({
      years: z.number().int().min(0).max(60),
    })
    .strict(),

  required_skill: z
    .object({
      skill: nonEmptyString,
      matchMode: z.enum(MATCH_MODES),
      // No default: "does a listed skill count?" is the whole point of this rule
      // type, and a default would decide it silently for whoever forgot to.
      mustBeDemonstrated: z.boolean(),
    })
    .strict(),

  required_education_level: z
    .object({
      level: z.enum(EDUCATION_LEVELS),
    })
    .strict(),

  required_certification: z
    .object({
      name: nonEmptyString,
      matchMode: z.enum(MATCH_MODES),
    })
    .strict(),

  location_allowlist: z
    .object({
      // ISO-3166-1 alpha-2, upper case. Stored that way, compared that way.
      countryCodes: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
    })
    .strict(),
});

/**
 * One elimination rule. A discriminated union on `type`, so `value` is checked
 * against the shape that type actually requires.
 *
 * `onMissing` is required, not defaulted. The column is NOT NULL DEFAULT 'flag'
 * and the repository always reads it back, so an absent value here means the
 * role was assembled by hand somewhere it should not have been - and decision
 * 7-C is too consequential to infer.
 */
export const eliminationRuleSchema = z.discriminatedUnion(
  'type',
  ELIMINATION_RULE_TYPES.map((type) =>
    z.object({
      id: nonEmptyString,
      label: nonEmptyString,
      type: z.literal(type),
      value: ELIMINATION_RULE_VALUE_SCHEMAS[type],
      onMissing: z.enum(ON_MISSING_MODES),
      position: nonNegativeInt,
    }),
  ),
);

/**
 * A role that can be scored against.
 *
 * The transform sorts both lists by `position`, which makes "the role's order"
 * a property of the role rather than of however the caller happened to build the
 * array. Criterion positions are unique (the database says so); rule positions
 * are not, and `Array.prototype.sort` is stable, so equal positions keep their
 * relative order instead of shuffling between reads.
 */
export const roleSchema = z
  .object({
    id: nonEmptyString,
    title: z.string().min(1).max(200),
    version: z.number().int().min(1),
    criteria: z.array(criterionSchema).min(1),
    // An empty rule list is a legitimate configuration: scoring with no hard
    // requirements is a normal way to screen.
    eliminationRules: z.array(eliminationRuleSchema),
  })
  .superRefine((role, ctx) => {
    const weightSum = role.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
    if (weightSum !== REQUIRED_WEIGHT_SUM) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria'],
        message: `criterion weights must sum to ${REQUIRED_WEIGHT_SUM}, received ${weightSum}`,
      });
    }

    const duplicateIds = findDuplicates(role.criteria.map((criterion) => criterion.id));
    if (duplicateIds.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria'],
        message: `duplicate criterion ids: ${duplicateIds.join(', ')}`,
      });
    }

    const duplicatePositions = findDuplicates(
      role.criteria.map((criterion) => String(criterion.position)),
    );
    if (duplicatePositions.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['criteria'],
        message: `duplicate criterion positions: ${duplicatePositions.join(', ')}`,
      });
    }
  })
  .transform((role) => ({
    ...role,
    criteria: [...role.criteria].sort((a, b) => a.position - b.position),
    eliminationRules: [...role.eliminationRules].sort((a, b) => a.position - b.position),
  }));

/**
 * @param {string[]} values
 * @returns {string[]} the values that appear more than once, in first-seen order
 */
function findDuplicates(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates];
}

/**
 * Validates a role and returns it in canonical order.
 *
 * @param {unknown} role
 * @returns {ScoringRole}
 * @throws {InvalidRoleError} with every zod issue in `details.issues`
 */
export function parseRole(role) {
  const result = roleSchema.safeParse(role);
  if (!result.success) {
    throw new InvalidRoleError('role definition cannot be scored against', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

/**
 * @typedef {z.infer<typeof criterionSchema>} RoleCriterion
 * @typedef {z.infer<typeof eliminationRuleSchema>} EliminationRule
 * @typedef {z.infer<typeof roleSchema>} ScoringRole
 */
