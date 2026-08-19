/**
 * The model-facing failure taxonomy - plan section 5.4.
 *
 * Everything in `../errors.js` is thrown by a pure function over data that will
 * not change, so re-running it produces the same failure. Everything here is
 * thrown because of something that happened between this process and Anthropic:
 * a socket, a status code, a stop reason, or a response that did not fit its
 * schema. Those are the failures where "try again" is sometimes the right
 * answer, so `retryable` is set per class rather than defaulting to false.
 *
 * These extend {@link AgentError} rather than starting a second hierarchy. The
 * worker has one job when a candidate fails - store `code`, store a
 * recruiter-safe message, decide whether to re-enqueue - and it should be able
 * to do that with one `instanceof` and two property reads regardless of which
 * half of the agent layer threw. The direction of the dependency is what
 * matters and it is unchanged: `../errors.js` still knows nothing about an SDK,
 * and nothing in it imports this file.
 *
 * **The agent layer labels retryability; the worker decides retry policy.**
 * `retryable: true` means "a fresh attempt could plausibly succeed", not "retry
 * this now" - the worker owns attempt counts and backoff.
 *
 * ## What is deliberately not in `details`
 *
 * `details` is written to logs. It therefore never carries:
 *
 * - CV text, profile free text, or anything a candidate wrote;
 * - the API key, a header bag, or a request body;
 * - a model-authored explanation. A refusal's `stop_details.explanation` is free
 *   text the model wrote *about the input*, which makes it the field most likely
 *   to quote a CV back; only the machine-readable `category` is kept.
 * - a zod issue *message*. Most are structural and harmless, but the enum
 *   variant echoes the offending value, so only `path` and `code` survive into
 *   `details`. The full messages are still fed back to the model on the semantic
 *   retry - see `call-structured.js` - because the model produced them, and
 *   telling it precisely what was wrong is the entire point of that retry.
 */

import { AGENT_ERROR_CODES } from '../constants.js';
import { AgentError } from '../errors.js';

/**
 * The process is misconfigured: no API key, or a client built without one.
 *
 * Deliberately **not** an {@link AgentError}, and deliberately carrying no
 * candidate error code. A missing key is not a property of a candidate and must
 * never be stored on one - storing it would produce a dashboard full of failed
 * CVs when the real failure is a deployment that never had credentials. It is
 * thrown where the client is constructed, which is process start-up, and it is
 * meant to be fatal there.
 */
export class AnthropicConfigurationError extends Error {
  /**
   * @param {string} message names the variable that is missing, never its value
   */
  constructor(message) {
    super(message);
    this.name = 'AnthropicConfigurationError';
  }
}

/**
 * The text handed to extraction is not worth spending a token on.
 *
 * The cheapest possible failure: no API call is made. Plan section 5.5 splits
 * ownership on purpose - `server/src/extraction/` (phase 3) answers "can I get
 * text out of this file", and this answers "is what came out worth screening".
 * The redundancy is the point.
 */
export class AgentInputError extends AgentError {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} details statistics only - character counts,
   *   ratios, and the names of the checks that failed. Never a span of the text.
   */
  constructor(message, details) {
    super(message, { code: AGENT_ERROR_CODES.EMPTY_DOCUMENT, details });
  }
}

/**
 * The request did not fit the model's context window.
 *
 * Not retryable: the same document produces the same overflow. Not
 * `AGENT_BAD_OUTPUT` either - the model produced nothing that could be bad. This
 * is a request we should not have sent, and blaming the output would send
 * whoever reads the log looking in the wrong place.
 */
export class AgentInputTooLargeError extends AgentError {
  /**
   * @param {object} params
   * @param {string} params.stage `extraction` or `evaluation`
   * @param {number} params.inputCharacters the size of what we sent, not the text
   */
  constructor({ stage, inputCharacters }) {
    super(`the ${stage} request exceeded the model's context window`, {
      code: AGENT_ERROR_CODES.INPUT_TOO_LARGE,
      details: { stage, inputCharacters },
    });
    /** @type {string} */
    this.stage = stage;
  }
}

/**
 * The call did not finish inside its deadline.
 *
 * Two deadlines produce this, and `details.scope` says which, because they mean
 * different things: a `call` timeout is usually one slow generation, and a
 * `candidate` timeout usually means the retry layers underneath consumed the
 * whole 240s budget.
 */
export class AgentTimeoutError extends AgentError {
  /**
   * @param {object} params
   * @param {string} params.stage `extraction` or `evaluation`
   * @param {'call' | 'candidate'} params.scope which deadline expired
   * @param {number} params.limitMs the deadline that expired, in milliseconds
   */
  constructor({ stage, scope, limitMs }) {
    super(`${stage} exceeded its ${scope} deadline of ${limitMs}ms`, {
      code: AGENT_ERROR_CODES.TIMEOUT,
      details: { stage, scope, limitMs },
      // A slow minute is not a permanent one. The worker's backoff is what keeps
      // this from becoming a hot loop.
      retryable: true,
    });
    /** @type {'call' | 'candidate'} */
    this.scope = scope;
  }
}

/**
 * Anthropic returned 429 after the SDK had already exhausted its own retries.
 *
 * Retryable, and the one error that carries advice about *when*:
 * `retryAfterSeconds` is the server's own `retry-after`, passed through for the
 * worker's backoff to respect. Null when the header was absent or unparseable -
 * never guessed at, because a guessed backoff is how a rate limit becomes a
 * rate-limit loop.
 */
export class AgentRateLimitError extends AgentError {
  /**
   * @param {object} params
   * @param {string} params.stage
   * @param {number | null} params.retryAfterSeconds
   */
  constructor({ stage, retryAfterSeconds }) {
    super(`${stage} was rate limited by the model API`, {
      code: AGENT_ERROR_CODES.RATE_LIMIT,
      details: { stage, retryAfterSeconds },
      retryable: true,
    });
    /** @type {number | null} */
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Anything else that went wrong upstream: a 5xx, a dropped connection, a 400 we
 * caused, or a 401.
 *
 * `retryable` is passed in because one class covers both halves of that split -
 * a 503 is worth another attempt and a 401 never will be - and a single class
 * with an explicit flag reads better in a log than four classes that differ only
 * in a boolean.
 *
 * `details.status` is the HTTP status where there was one and `null` for a
 * transport failure. The response body is not included: it is upstream text we
 * do not control, and it has no place in our logs.
 */
export class AgentUpstreamError extends AgentError {
  /**
   * @param {object} params
   * @param {string} params.stage
   * @param {number | null} params.status HTTP status, or null for a transport failure
   * @param {string} params.kind the classification from `classifyAnthropicError`
   * @param {boolean} params.retryable
   */
  constructor({ stage, status, kind, retryable }) {
    super(`${stage} failed upstream (${kind}${status === null ? '' : `, status ${status}`})`, {
      code: AGENT_ERROR_CODES.UPSTREAM,
      details: { stage, status, kind },
      retryable,
    });
    /** @type {number | null} */
    this.status = status;
    /** @type {string} */
    this.kind = kind;
  }
}

/**
 * The model refused to answer.
 *
 * **Never retried, at either layer.** Plan section 5.4 declines the SDK's
 * refusal-fallback middleware for v1: rescuing a refusal with a different model
 * would put non-comparable ratings into the same batch, and comparability is the
 * entire premise of the product. A visible failure on one candidate is the
 * cheaper outcome.
 *
 * Only `category` is kept - see the note on `details` at the top of this file.
 */
export class AgentRefusalError extends AgentError {
  /**
   * @param {object} params
   * @param {string} params.stage
   * @param {string | null} params.category the policy category, or null if absent
   */
  constructor({ stage, category }) {
    super(`the model refused the ${stage} request`, {
      code: AGENT_ERROR_CODES.REFUSED,
      details: { stage, category },
      retryable: false,
    });
    /** @type {string | null} */
    this.category = category;
  }
}

/**
 * The response could not be turned into a valid object, after the semantic retry
 * had its turn.
 *
 * `reason` distinguishes failures that need opposite responses, which is exactly
 * why plan section 5.4 checks `stop_reason` before `parsed_output`:
 *
 * - `truncated` - the model hit `max_tokens` mid-JSON. The retry doubles the
 *   budget, so seeing this means doubling was not enough.
 * - `invalid_json` - a text block that is not JSON at all.
 * - `schema_mismatch` - valid JSON the schema rejected. `context.issues` names
 *   the paths, without the messages.
 * - `no_output` - the response carried no text block to parse.
 * - `unsupported_stop_reason` - a stop reason this layer does not implement,
 *   `pause_turn` being the live example. Failing loudly beats treating a paused
 *   turn as a finished one.
 * - `rejected_summary` - the summary stated a figure on the score, and so did
 *   the retry.
 */
export class AgentBadOutputError extends AgentError {
  /**
   * @param {object} params
   * @param {string} params.stage
   * @param {'truncated' | 'invalid_json' | 'schema_mismatch' | 'no_output'
   *   | 'unsupported_stop_reason' | 'rejected_summary'} params.reason
   * @param {number} params.attempts generations spent before giving up
   * @param {Record<string, unknown>} [params.context] structural detail only
   */
  constructor({ stage, reason, attempts, context = {} }) {
    super(`${stage} produced output this layer could not use (${reason})`, {
      code: AGENT_ERROR_CODES.BAD_OUTPUT,
      details: { stage, reason, attempts, ...context },
      // The semantic retry has already run by the time this is thrown, so a
      // worker retry would repeat a whole call for a failure that just repeated
      // itself.
      retryable: false,
    });
    /** @type {string} */
    this.reason = reason;
    /** @type {number} */
    this.attempts = attempts;
  }
}
