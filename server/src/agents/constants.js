/**
 * Every constant the deterministic core reads. Defined once, here, because a
 * threshold that appears in two files is a threshold that will eventually
 * disagree with itself.
 *
 * Nothing in this file imports anything. It is the bottom of the agent layer.
 */

/**
 * The three tiers a candidate can land in.
 *
 * @typedef {'strong_match' | 'potential_match' | 'unmatched'} FitCategory
 */

/** @type {{ STRONG_MATCH: 'strong_match', POTENTIAL_MATCH: 'potential_match', UNMATCHED: 'unmatched' }} */
export const TIERS = Object.freeze({
  STRONG_MATCH: 'strong_match',
  POTENTIAL_MATCH: 'potential_match',
  UNMATCHED: 'unmatched',
});

/** @type {readonly FitCategory[]} */
export const FIT_CATEGORIES = Object.freeze([
  TIERS.STRONG_MATCH,
  TIERS.POTENTIAL_MATCH,
  TIERS.UNMATCHED,
]);

/**
 * Half-open tier bands, plan section 7-B: [85, 100] strong, [65, 85) potential,
 * [0, 65) unmatched. Stated as inclusive lower bounds so there is no gap and no
 * overlap - 84.9 is Potential, 85.0 is Strong.
 */
export const TIER_THRESHOLDS = Object.freeze({
  STRONG_MATCH_MIN: 85,
  POTENTIAL_MATCH_MIN: 65,
});

/** A rating is an integer 0..10. The model is never asked for anything else. */
export const RATING_MIN = 0;
export const RATING_MAX = 10;

/** A single criterion weight is an integer 1..100 (mirrors the CHECK in migration 0002). */
export const WEIGHT_MIN = 1;
export const WEIGHT_MAX = 100;

/**
 * Weights for a role sum to exactly 100. Layer 3 of the three-layer invariant
 * (zod at the API boundary, a deferred CONSTRAINT TRIGGER in Postgres, and an
 * assertion in computeWeightedScore that throws rather than emit a score built
 * on a broken denominator).
 */
export const REQUIRED_WEIGHT_SUM = 100;

/**
 * scoreRaw = Sum(rating * weight) with rating in 0..10 and Sum(weight) = 100,
 * so scoreRaw lands in 0..1000 and score = scoreRaw / SCORE_DIVISOR is exact to
 * one decimal with no rounding step anywhere.
 */
export const SCORE_RAW_MIN = 0;
export const SCORE_RAW_MAX = 1000;
export const SCORE_DIVISOR = 10;
export const SCORE_MIN = 0;
export const SCORE_MAX = 100;

/**
 * The closed set of elimination rule types. Mirrors the CHECK constraint in
 * migration 0003 exactly; a unit test asserts this list, the migration and the
 * evaluator registry are the same set, so a type can never be storable without
 * an evaluator or evaluable without being storable.
 *
 * @typedef {'min_years_experience' | 'required_skill' | 'required_education_level'
 *   | 'required_certification' | 'location_allowlist'} EliminationRuleType
 * @type {readonly EliminationRuleType[]}
 */
export const ELIMINATION_RULE_TYPES = Object.freeze([
  'min_years_experience',
  'required_skill',
  'required_education_level',
  'required_certification',
  'location_allowlist',
]);

/**
 * What an absent fact means for one rule. Plan section 7-C: the default is
 * `flag`, because eliminating on absence turns every badly-parsed CV into a
 * rejection.
 *
 * @typedef {'flag' | 'eliminate'} OnMissing
 * @type {readonly OnMissing[]}
 */
export const ON_MISSING_MODES = Object.freeze(['flag', 'eliminate']);

/**
 * The outcome of one rule against one profile.
 *
 * @typedef {'pass' | 'fail' | 'indeterminate'} RuleOutcome
 * @type {readonly RuleOutcome[]}
 */
export const RULE_OUTCOMES = Object.freeze(['pass', 'fail', 'indeterminate']);

/**
 * How a rule's target string is compared with a profile value.
 * `exact` is a trimmed, case-sensitive equality; `normalized` folds case,
 * whitespace and unicode dashes and then matches on token boundaries.
 *
 * @typedef {'exact' | 'normalized'} MatchMode
 * @type {readonly MatchMode[]}
 */
export const MATCH_MODES = Object.freeze(['exact', 'normalized']);

/**
 * The education ladder, ordered weakest to strongest. Index in this array IS the
 * comparison - there is no separate rank table to fall out of step with it.
 *
 * @typedef {'none' | 'high_school' | 'associate' | 'bachelors' | 'masters' | 'doctorate'} EducationLevel
 * @type {readonly EducationLevel[]}
 */
export const EDUCATION_LEVELS = Object.freeze([
  'none',
  'high_school',
  'associate',
  'bachelors',
  'masters',
  'doctorate',
]);

/**
 * The forced choice that carries the anti-fabrication story: a model handed a
 * nullable evidence string fills it, and a model handed an honest option picks
 * it.
 *
 * @typedef {'demonstrated' | 'listed_only'} EvidenceType
 * @type {readonly EvidenceType[]}
 */
export const EVIDENCE_TYPES = Object.freeze(['demonstrated', 'listed_only']);

/**
 * Worker-side candidate error codes owned by the deterministic core. This is the
 * codes namespace from plan section 5.4, restricted to the codes 2a can raise -
 * they are stored in `candidates.error_code` and returned inside a 200, and are
 * deliberately kept apart from the HTTP error codes.
 */
export const AGENT_ERROR_CODES = Object.freeze({
  BAD_OUTPUT: 'AGENT_BAD_OUTPUT',
  INCOMPLETE_EVAL: 'AGENT_INCOMPLETE_EVAL',
  INVALID_ROLE: 'AGENT_INVALID_ROLE',
  UNKNOWN_RULE: 'AGENT_UNKNOWN_RULE',
});

/** Months in a year, named so the arithmetic in compute-experience reads. */
export const MONTHS_PER_YEAR = 12;
