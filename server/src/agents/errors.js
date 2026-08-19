/**
 * Typed errors thrown by the deterministic core.
 *
 * Plan section 5.4 puts the *transport* failure taxonomy in `client/errors.js`.
 * These are different animals: they are thrown by pure functions, they are never
 * retryable, and they must be importable by code that has no idea an SDK exists.
 * Hence a separate module at the root of the agent layer rather than a `client/`
 * file 2a would otherwise have to create early.
 *
 * Phase 2b built `client/errors.js` on top of {@link AgentError} rather than as
 * a second hierarchy - the dependency runs 2b -> 2a and never back, so this file
 * still knows nothing about an SDK. The reason is the worker: when a candidate
 * fails it stores one `code`, shows one message and makes one retry decision,
 * and it should be able to do that with a single `instanceof` however the
 * failure arose.
 *
 * Every error carries:
 * - `code`, from the worker-side namespace in section 5.4, which the worker
 *   stores verbatim in `candidates.error_code`;
 * - `retryable`, because the agent layer *labels* retryability and the worker
 *   *decides* retry policy. The default is false: re-running a pure function
 *   over the same input produces the same failure. Two members are exceptions -
 *   `IncompleteEvaluationError` and `SummaryContainsScoreError` - and they are
 *   exceptions for the same single reason, which is why they now agree: the
 *   input a retry changes for either is not the *argument* but the *generation*
 *   that produced it. Both describe a response the model got wrong, not a value
 *   this layer computed wrong. See their own notes;
 * - `details`, structured and safe to log.
 *
 * No error message here interpolates CV text or profile free-text. Ids, labels
 * and counts only - the message ends up in logs, and logs must not become a
 * second copy of somebody's CV.
 */

import { AGENT_ERROR_CODES } from './constants.js';

/**
 * Base class for every deterministic-core failure.
 */
export class AgentError extends Error {
  /**
   * @param {string} message
   * @param {object} params
   * @param {string} params.code worker-side candidate error code
   * @param {Record<string, unknown>} params.details structured, log-safe context
   * @param {boolean} [params.retryable] opt-in, and opting in needs a reason: the
   *   default of false is right for every failure of a pure function over data
   *   that will not change.
   */
  constructor(message, { code, details, retryable = false }) {
    super(message);
    this.name = new.target.name;
    /** @type {string} */
    this.code = code;
    /** @type {Record<string, unknown>} */
    this.details = details;
    /** @type {boolean} */
    this.retryable = retryable;
  }

  /**
   * Log-safe serialization. Deliberately does not include a stack: this is what
   * goes into a structured log line, and the stack is attached by the logger.
   *
   * @returns {{ name: string, code: string, message: string, retryable: boolean, details: Record<string, unknown> }}
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

/**
 * The evaluation response is missing a rating for at least one criterion.
 *
 * A hard failure on purpose (plan section 5.3): substituting 0 silently depresses
 * the score and renormalizing over the criteria that did arrive silently inflates
 * it, and both are invisible to a recruiter reading the number. A visibly failed
 * candidate is recoverable; a quietly mis-scored one is not.
 *
 * **Retryable, and the second of the two exceptions in this file.** Phase 2a
 * labelled this one `false` on the general rule that re-running a pure function
 * over the same input produces the same failure. That rule is true of the
 * *argument* and false of the *generation*, and this failure is a property of
 * the generation: the model returned five ratings where six were asked for.
 * Nothing about the criteria, the profile or the code was wrong, so a fresh
 * generation - told exactly which ids it omitted - is very likely to be
 * complete. That is the same reasoning already written down for
 * {@link SummaryContainsScoreError}, and holding the two to different labels was
 * an inconsistency rather than a distinction.
 *
 * The costs are asymmetric and that is what settles it: one extra call, against
 * discarding an otherwise complete evaluation and showing a recruiter a failed
 * candidate.
 *
 * Two things this label does **not** mean. It does not retry anything by itself -
 * `evaluate-candidate.js` feeds the missing ids into `call-structured.js`'s
 * single semantic retry, and the worker owns attempt counts and backoff beyond
 * that. And it does not soften the failure: a second incomplete response still
 * fails the candidate, loudly, naming the ids.
 */
export class IncompleteEvaluationError extends AgentError {
  /**
   * @param {string[]} missingCriterionIds the exact ids with no rating
   */
  constructor(missingCriterionIds) {
    super(
      `evaluation is missing a rating for ${missingCriterionIds.length} criterion/criteria: ${missingCriterionIds.join(', ')}`,
      {
        code: AGENT_ERROR_CODES.INCOMPLETE_EVAL,
        details: { missingCriterionIds },
        retryable: true,
      },
    );
    /** @type {string[]} */
    this.missingCriterionIds = missingCriterionIds;
  }
}

/**
 * The evaluation response rated the same criterion twice.
 *
 * Also a hard failure: there is no defensible way to choose between two
 * contradictory ratings of the same thing, and picking the first is a coin toss
 * dressed as a rule.
 */
export class DuplicateRatingError extends AgentError {
  /**
   * @param {string[]} duplicateCriterionIds ids rated more than once
   */
  constructor(duplicateCriterionIds) {
    super(
      `evaluation rated the same criterion more than once: ${duplicateCriterionIds.join(', ')}`,
      {
        code: AGENT_ERROR_CODES.BAD_OUTPUT,
        details: { duplicateCriterionIds },
      },
    );
    /** @type {string[]} */
    this.duplicateCriterionIds = duplicateCriterionIds;
  }
}

/**
 * The model's `summary` states a figure on the score itself - a percentage, an
 * x/10 or x/100, or a number attached to a scoring word.
 *
 * The failure this prevents is a recruiter reading *"roughly an 80% match"* next
 * to a computed 73.4 and having no way to tell which figure is real (plan
 * section 5.1). The summary is not repaired: stripping the number silently would
 * hide a model that is drifting.
 *
 * **Retryable, on the same grounds as {@link IncompleteEvaluationError}.** The
 * remaining members of this file fail the same way however many times they are
 * re-run, because the input is fixed. Here the input a retry changes is the
 * *generation*, not the argument: this is a semantic
 * validation failure of a model response, which section 5.4 puts on
 * `call-structured.js`'s single semantic retry alongside the other validation
 * failures and truncation. A fresh generation is very likely to be clean, and
 * failing the candidate outright over a formatting slip in prose - when the
 * ratings themselves are sound - would be the more expensive mistake.
 */
export class SummaryContainsScoreError extends AgentError {
  /**
   * @param {{ patternId: string, description: string, match: string }} figure the
   *   pattern that matched and the span it matched, both bounded and drawn from
   *   the pattern's own alphabet - no CV or profile free text reaches the log.
   */
  constructor({ patternId, description, match }) {
    super(
      `evaluation summary must be prose only, but states ${description}: "${match}"`,
      {
        code: AGENT_ERROR_CODES.BAD_OUTPUT,
        details: { patternId, match },
        retryable: true,
      },
    );
    /** @type {string} */
    this.patternId = patternId;
    /** @type {string} */
    this.match = match;
  }
}

/**
 * A rating that is not an integer in 0..10 reached the scorer.
 *
 * The schema already forbids this, so this throw means something bypassed the
 * schema. Defence in depth at the only point where a rating becomes a number a
 * human will act on.
 */
export class InvalidRatingError extends AgentError {
  /**
   * @param {string} criterionId
   * @param {unknown} rating the offending value, which is a number or nothing -
   *   never free text from a model
   */
  constructor(criterionId, rating) {
    super(`rating for criterion ${criterionId} must be an integer 0..10, received ${String(rating)}`, {
      code: AGENT_ERROR_CODES.BAD_OUTPUT,
      details: { criterionId, rating: typeof rating === 'number' ? rating : null },
    });
    /** @type {string} */
    this.criterionId = criterionId;
  }
}

/**
 * The role definition itself cannot be scored against: no criteria, weights that
 * do not sum to 100, duplicate criterion ids, or a rule whose `value` does not
 * match its `type`.
 *
 * This is an operator error rather than a model error, and it fails the candidate
 * loudly instead of producing a number from a broken denominator.
 */
export class InvalidRoleError extends AgentError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(message, details = {}) {
    super(message, { code: AGENT_ERROR_CODES.INVALID_ROLE, details });
  }
}

/**
 * An elimination rule arrived with a type that has no evaluator.
 *
 * The union is closed in three places - the CHECK constraint, the zod schema and
 * the evaluator registry - and this is what happens if they ever drift: the
 * candidate fails visibly. An unknown rule must never silently pass, because
 * "we could not check it" would then read as "they meet the requirement".
 */
export class UnknownRuleTypeError extends AgentError {
  /**
   * @param {string} type the unrecognised rule type
   * @param {readonly string[]} knownTypes the registry's key set
   */
  constructor(type, knownTypes) {
    super(`unknown elimination rule type "${type}"; known types are ${knownTypes.join(', ')}`, {
      code: AGENT_ERROR_CODES.UNKNOWN_RULE,
      details: { type, knownTypes: [...knownTypes] },
    });
    /** @type {string} */
    this.type = type;
  }
}
