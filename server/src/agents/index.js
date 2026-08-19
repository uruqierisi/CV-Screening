/**
 * The agent layer's public surface.
 *
 * One import path for everything outside `src/agents/` - the worker, and phase
 * 2b's pipeline - so that callers never reach into a file path and the internal
 * layout stays ours to change.
 *
 * Phase 2a is the deterministic core: pure functions, hand-written inputs, exact
 * outputs. Nothing reachable from here imports an SDK, a web framework, a
 * database driver or an HTTP client, and a test asserts that. Phase 2b adds the
 * model-facing modules on top of a core that is already proven, and extends this
 * file rather than replacing it.
 */

export {
  AGENT_ERROR_CODES,
  EDUCATION_LEVELS,
  ELIMINATION_RULE_TYPES,
  EVIDENCE_TYPES,
  FIT_CATEGORIES,
  MATCH_MODES,
  ON_MISSING_MODES,
  RATING_MAX,
  RATING_MIN,
  REQUIRED_WEIGHT_SUM,
  RULE_OUTCOMES,
  SCORE_DIVISOR,
  SCORE_MAX,
  SCORE_MIN,
  SCORE_RAW_MAX,
  SCORE_RAW_MIN,
  TIERS,
  TIER_THRESHOLDS,
  WEIGHT_MAX,
  WEIGHT_MIN,
} from './constants.js';

export {
  AgentError,
  DuplicateRatingError,
  IncompleteEvaluationError,
  InvalidRatingError,
  InvalidRoleError,
  SummaryContainsScoreError,
  UnknownRuleTypeError,
} from './errors.js';

export {
  certificationSchema,
  educationSchema,
  locationSchema,
  profileSchema,
  skillSchema,
  verifiedProfileSchema,
  verifiedSkillSchema,
  workExperienceSchema,
} from './schemas/profile.schema.js';

export { EVALUATION_KEYS, RATING_KEYS, makeEvaluationSchema } from './schemas/evaluation.schema.js';

export {
  ELIMINATION_RULE_VALUE_SCHEMAS,
  criterionSchema,
  eliminationRuleSchema,
  parseRole,
  roleSchema,
} from './schemas/role.schema.js';

export { reconcileRatings } from './scoring/reconcile-ratings.js';
export {
  SCORE_FIGURE_PATTERNS,
  assertSummaryIsProseOnly,
  findScoreFigure,
} from './scoring/validate-summary.js';
export { computeWeightedScore } from './scoring/compute-score.js';
export { ELIMINATION_RULE_EVALUATORS, evaluateEliminationRules } from './scoring/elimination.js';
export { assignTier } from './scoring/tiers.js';
export { scoreCandidate } from './scoring/score-candidate.js';

export {
  computeExperience,
  monthsToYears,
  parseCvDate,
  withComputedExperience,
} from './extraction/compute-experience.js';
export { verifyEvidence } from './extraction/verify-evidence.js';

export { NOOP_LOGGER } from './util/logger.js';
export {
  containsNormalized,
  containsTokenSequence,
  equalsExact,
  normalizeForMatch,
  normalizeWhitespace,
  tokenize,
} from './util/text.js';
