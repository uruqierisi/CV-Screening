/**
 * The agent layer's public surface.
 *
 * One import path for everything outside `src/agents/` - the worker, and phase
 * 2b's pipeline - so that callers never reach into a file path and the internal
 * layout stays ours to change.
 *
 * Phase 2a is the deterministic core: pure functions, hand-written inputs, exact
 * outputs. Phase 2b adds the model-facing modules on top of it - one call to
 * extract, one to evaluate, and the pipeline that composes them with the core.
 *
 * The layering rule holds across both: nothing here imports a web framework, a
 * database driver or an HTTP client, and exactly one file
 * (`client/anthropic-client.js`) imports the Anthropic SDK. A test asserts both.
 *
 * The worker needs precisely one function from this file - `screenCandidate` -
 * and everything else is exported for tests, for the API's `/config` endpoint and
 * for the day somebody needs one stage without the other.
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
  EXTRACTED_LOCATION_FIELDS,
  certificationSchema,
  educationSchema,
  extractedProfileSchema,
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
  // Exported beside `computeExperience` because the two answer one question
  // between them: what the dates support, and - when they support nothing - why
  // not, in words a recruiter can act on.
  explainMissingExperience,
  monthsToYears,
  parseCvDate,
  withComputedExperience,
} from './extraction/compute-experience.js';
export { verifyEvidence } from './extraction/verify-evidence.js';

export { NOOP_LOGGER } from './util/logger.js';
export {
  CV_TEXT_THRESHOLDS,
  assessCvText,
  containsNormalized,
  containsTokenSequence,
  equalsExact,
  normalizeForMatch,
  normalizeWhitespace,
  tokenize,
} from './util/text.js';

/* ------------------------------------------------------------------ phase 2b */

export {
  ANTHROPIC_ERROR_KINDS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  MODEL_ID,
  classifyAnthropicError,
  createAnthropicClient,
  retryAfterSeconds,
  toOutputFormat,
} from './client/anthropic-client.js';

export { RESPONSE_FORMATS, SEMANTIC_RETRIES, callStructured } from './client/call-structured.js';

export {
  messageText,
  parseJsonResponse,
  parseMessageJson,
  stripCodeFences,
} from './client/json-response.js';

export {
  AgentBadOutputError,
  AgentInputError,
  AgentInputTooLargeError,
  AgentRateLimitError,
  AgentRefusalError,
  AgentSchemaRejectedError,
  AgentTimeoutError,
  AgentUpstreamError,
  AnthropicConfigurationError,
} from './client/errors.js';

export {
  noFabricationRule,
  outputContractRule,
  retryNotice,
  summaryMustNotStateAScore,
} from './prompts/shared-rules.js';
export { EXTRACTION_PROMPT_VERSION, extractionPrompt } from './prompts/extraction.prompt.js';
export { EVALUATION_PROMPT_VERSION, evaluationPrompt } from './prompts/evaluation.prompt.js';

export { normalizeProfile } from './extraction/normalize-profile.js';
export {
  EXTRACTION_EFFORT,
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_RESPONSE_FORMAT,
  EXTRACTION_TIMEOUT_MS,
  extractProfile,
} from './extraction/extract-profile.js';

export { REDACTED_IDENTITY_FIELDS, redactIdentity } from './evaluation/redact-identity.js';
export {
  EVALUATION_EFFORT,
  EVALUATION_MAX_TOKENS,
  EVALUATION_TIMEOUT_MS,
  evaluateCandidate,
} from './evaluation/evaluate-candidate.js';

export { CANDIDATE_DEADLINE_MS, screenCandidate } from './pipeline/screen-candidate.js';
