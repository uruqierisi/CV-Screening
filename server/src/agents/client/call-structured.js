/**
 * One structured call to the model, with the failure taxonomy of plan section
 * 5.4 applied to whatever comes back.
 *
 * This module never constructs a client and never imports the SDK. It is handed
 * one, calls `messages.parse` on it, and turns the result into either a
 * validated object or a typed error. That is what lets the entire suite exercise
 * every path in this file with a plain object as the client.
 *
 * ## Two retry layers, owned by different people
 *
 * | Layer | Owner | Retries |
 * |---|---|---|
 * | Transport - 408/409/429/5xx and connection errors | the SDK | 2, exponential, honours `retry-after` |
 * | Semantic - validation failure, truncation, a response a caller's own rule refused | this file | 1 |
 *
 * They do not overlap and they must not. A transport failure that survived the
 * SDK's two attempts is not going to be fixed by a third identical one from
 * here; a schema mismatch is not a transport problem and the SDK cannot see it.
 * Worst case is six HTTP requests, which is why the pipeline puts an
 * AbortController over the whole candidate rather than trusting the sum of the
 * timeouts.
 *
 * ## `stop_reason` is read before `parsed_output`
 *
 * Deliberate, and the ordering carries real weight. A missing `parsed_output`
 * caused by truncation and one caused by an unsatisfiable schema need opposite
 * responses - the first wants the same request with a bigger budget, the second
 * wants a corrected request - and by the time you are looking at a null there is
 * nothing left to tell them apart. `stop_reason` says definitively.
 *
 * `stop_details` is populated **only** when `stop_reason === 'refusal'` and is
 * `null` otherwise, so it is read only inside that branch.
 *
 * ## What is never sent
 *
 * No `temperature`, `top_p` or `top_k`: all three are removed on this model
 * family and return 400. No `thinking`: adaptive is the default and
 * `budget_tokens` is removed. No assistant prefill: it returns 400, and the
 * schema is a better way to constrain shape than a half-written turn. See the
 * note at the evaluation call site for what replaces `temperature: 0`.
 */

import { NOOP_LOGGER } from '../util/logger.js';
import { retryNotice } from '../prompts/shared-rules.js';
import {
  ANTHROPIC_ERROR_KINDS,
  MODEL_ID,
  classifyAnthropicError,
  retryAfterSeconds,
  toOutputFormat,
} from './anthropic-client.js';
import {
  AgentBadOutputError,
  AgentInputTooLargeError,
  AgentRateLimitError,
  AgentRefusalError,
  AgentTimeoutError,
  AgentUpstreamError,
} from './errors.js';

/**
 * One semantic retry, per section 5.4. Not two: a second identical failure is
 * evidence about the request or the model, not about luck, and each attempt is
 * a whole generation of real money.
 */
export const SEMANTIC_RETRIES = 1;

/** Stop reasons that mean the model finished saying what it had to say. */
const COMPLETED_STOP_REASONS = Object.freeze(['end_turn', 'stop_sequence']);

/**
 * A caller's own rule, refusing a response the schema was happy with.
 *
 * Two rules feed this today - the summary must be prose only, and every
 * criterion must be rated - and they share the one retry loop below rather than
 * each growing a mechanism. A second retry path would double the worst-case bill
 * and give two conditions two different answers to the same question.
 *
 * `finalError` is how a caller keeps ownership of its own taxonomy. This file
 * owns *when* to give up; it does not own what a domain failure is called. When
 * the retry is exhausted and the rejection carried one, that error is thrown
 * instead of the generic {@link AgentBadOutputError} - which is what lets a
 * missing criterion still surface as `IncompleteEvaluationError`, with its ids,
 * however it was detected.
 *
 * @typedef {object} ValidationRejection
 * @property {'rejected_summary' | 'incomplete_evaluation'} reason what to record
 *   if the retry also fails, and what a retry is warned about in the log
 * @property {string} problem one line for the model, in plain language
 * @property {Record<string, unknown>} context structural detail for the error
 * @property {{ path: string, message: string }[]} [issues] the specific fields at
 *   fault, fed back to the model exactly as the schema-mismatch path feeds back
 *   zod's. A retry that is told *which* criterion is missing usually returns it;
 *   one told only "something was missing" is a coin toss.
 * @property {() => Error} [finalError] built only when the retry is exhausted,
 *   so nothing is constructed on the happy path
 *
 * @typedef {object} StructuredResult
 * @property {any} data the validated response object
 * @property {number} attempts generations spent, 1 or 2
 * @property {{ inputTokens: number | null, outputTokens: number | null }} usage
 * @property {string | null} stopReason
 */

/**
 * @param {object} params
 * @param {{ messages: { parse: Function } }} params.client injected, never constructed here
 * @param {any} params.schema the zod schema the response must satisfy
 * @param {{ system: string, user: string }} params.prompt from a `prompts/` template
 * @param {string} params.stage `extraction` or `evaluation`, for errors and logs
 * @param {'low' | 'medium' | 'high' | 'xhigh' | 'max'} params.effort `output_config.effort`
 * @param {number} params.maxTokens doubled once if the first attempt truncates
 * @param {number} params.timeoutMs per-request deadline, **milliseconds**
 * @param {AbortSignal} [params.signal] the candidate-wide deadline
 * @param {number} [params.deadlineMs] what that signal's deadline was, for the error
 * @param {(data: any) => ValidationRejection | null} [params.validate] post-parse
 *   check that the schema cannot express. Returns a rejection instead of throwing,
 *   so that a caller's domain rule cannot accidentally look like a crash.
 * @param {import('../util/logger.js').AgentLogger} [params.logger]
 * @returns {Promise<StructuredResult>}
 */
export async function callStructured({
  client,
  schema,
  prompt,
  stage,
  effort,
  maxTokens,
  timeoutMs,
  signal,
  deadlineMs,
  validate,
  logger = NOOP_LOGGER,
}) {
  const format = toOutputFormat(schema);
  const inputCharacters = prompt.system.length + prompt.user.length;

  /** @type {{ problem: string, issues?: { path: string, message: string }[] } | null} */
  let correction = null;
  let tokenBudget = maxTokens;

  for (let attempt = 1; ; attempt += 1) {
    const message = await requestOnce({
      client,
      prompt,
      correction,
      format,
      effort,
      maxTokens: tokenBudget,
      timeoutMs,
      signal,
      deadlineMs,
      stage,
      inputCharacters,
    });

    const outcome = inspect({ message, stage, inputCharacters, validate });

    if (outcome.ok) {
      return {
        data: outcome.data,
        attempts: attempt,
        usage: {
          inputTokens: message.usage?.input_tokens ?? null,
          outputTokens: message.usage?.output_tokens ?? null,
        },
        // Not `?? null`: `inspect` has already refused every stop reason that
        // is not a completed one, null included, so by here it is a string.
        stopReason: message.stop_reason,
      };
    }

    const exhausted = attempt > SEMANTIC_RETRIES;
    if (exhausted || !outcome.retryable) {
      throw giveUp(outcome, { stage, attempts: attempt });
    }

    logger.warn('structured call rejected its own response; retrying once', {
      stage,
      attempt,
      reason: outcome.reason,
    });

    // One `correction` for every reason, so the model is always told what was
    // wrong in the same shape: a line of prose plus the specific fields at
    // fault. Schema mismatches fill `issues` from zod; a caller's rule fills it
    // from whatever it knows - the missing criterion ids, in practice.
    correction = { problem: outcome.problem, issues: outcome.issues };
    if (outcome.reason === 'truncated') {
      // The one failure where the *request* has to change rather than the
      // instruction. Doubling stays inside the non-streaming output ceiling for
      // both call sites, which is why their budgets are set where they are.
      tokenBudget *= 2;
    }
  }
}

/**
 * The error that ends the call once no further attempt will be made.
 *
 * A caller's rule may name its own failure - see `finalError` on
 * {@link ValidationRejection}. Everything else is an `AgentBadOutputError`: a
 * response this layer could not use, with `reason` saying which way.
 *
 * The split is about ownership rather than convenience. `IncompleteEvaluation`
 * is a fact about an evaluation, not about a structured call, and it carries the
 * missing ids that a human and a worker both act on; flattening it into
 * `AGENT_BAD_OUTPUT` here would lose both, and re-deriving it afterwards by
 * matching on a `reason` string would put the taxonomy back in two places.
 *
 * @param {Inspection & { ok: false }} outcome
 * @param {{ stage: string, attempts: number }} context
 * @returns {Error}
 */
function giveUp(outcome, { stage, attempts }) {
  if (outcome.finalError !== undefined) {
    return outcome.finalError();
  }

  return new AgentBadOutputError({
    stage,
    reason: outcome.reason,
    attempts,
    context: outcome.context,
  });
}

/**
 * One HTTP round trip, with every SDK failure mapped onto the taxonomy.
 *
 * @returns {Promise<any>} the parsed message
 */
async function requestOnce({
  client,
  prompt,
  correction,
  format,
  effort,
  maxTokens,
  timeoutMs,
  signal,
  deadlineMs,
  stage,
  inputCharacters,
}) {
  const user =
    correction === null ? prompt.user : `${prompt.user}\n${retryNotice(correction)}`;

  try {
    return await client.messages.parse(
      {
        model: MODEL_ID,
        max_tokens: maxTokens,
        system: prompt.system,
        messages: [{ role: 'user', content: user }],
        output_config: { format, effort },
      },
      { timeout: timeoutMs, signal },
    );
  } catch (error) {
    throw toAgentError(error, { stage, timeoutMs, deadlineMs, inputCharacters });
  }
}

/**
 * Maps an SDK error onto the worker-side taxonomy.
 *
 * Classification happens in `anthropic-client.js` because that is where the SDK
 * classes live; the policy - which of these is worth another attempt - lives
 * here, next to the retry loop it governs.
 *
 * @param {unknown} error
 * @param {{ stage: string, timeoutMs: number, deadlineMs?: number, inputCharacters: number }} context
 * @returns {Error}
 */
function toAgentError(error, { stage, timeoutMs, deadlineMs, inputCharacters }) {
  const { kind, status } = classifyAnthropicError(error);

  switch (kind) {
    case ANTHROPIC_ERROR_KINDS.TIMEOUT:
      return new AgentTimeoutError({ stage, scope: 'call', limitMs: timeoutMs });

    case ANTHROPIC_ERROR_KINDS.ABORTED:
      // The signal came from above - in practice the pipeline's hard
      // per-candidate deadline, which is the only thing that aborts a call.
      return new AgentTimeoutError({
        stage,
        scope: 'candidate',
        limitMs: deadlineMs ?? timeoutMs,
      });

    case ANTHROPIC_ERROR_KINDS.RATE_LIMIT:
      return new AgentRateLimitError({ stage, retryAfterSeconds: retryAfterSeconds(error) });

    case ANTHROPIC_ERROR_KINDS.CONNECTION:
    case ANTHROPIC_ERROR_KINDS.SERVER:
      return new AgentUpstreamError({ stage, status, kind, retryable: true });

    case ANTHROPIC_ERROR_KINDS.BAD_REQUEST:
      // A 400 for a request that is too long is a size problem, not a syntax
      // problem, and the two need different messages in front of a recruiter.
      // Any other 400 is a bug in this layer and repeating it changes nothing.
      return isContextOverflow(error)
        ? new AgentInputTooLargeError({ stage, inputCharacters })
        : new AgentUpstreamError({ stage, status, kind, retryable: false });

    default:
      // Authentication and anything unrecognised. Neither is worth a retry: a
      // 401 will still be a 401, and an unclassified failure is exactly the kind
      // that should surface rather than loop.
      return new AgentUpstreamError({ stage, status, kind, retryable: false });
  }
}

/**
 * Whether a 400 is the API saying the request did not fit.
 *
 * The one place this layer looks at a string from upstream, and it is confined
 * to an error *type* field rather than a message: `error.error.error.type` is the
 * API's own machine-readable code. A message can be reworded; this cannot.
 *
 * @param {any} error
 * @returns {boolean}
 */
function isContextOverflow(error) {
  const type = error?.error?.error?.type;
  return type === 'context_window_exceeded' || type === 'request_too_large';
}

/**
 * @typedef {{ ok: true, data: any }
 *   | { ok: false, reason: import('./errors.js').AgentBadOutputError['reason']
 *         | ValidationRejection['reason'],
 *       retryable: boolean, problem: string,
 *       issues?: { path: string, message: string }[],
 *       finalError?: () => Error,
 *       context: Record<string, unknown> }} Inspection
 */

/**
 * Decides what a response actually is. Pure: message in, verdict out, no I/O and
 * no throwing except for the two failures that end the call outright.
 *
 * @param {object} params
 * @param {any} params.message
 * @param {string} params.stage
 * @param {number} params.inputCharacters
 * @param {((data: any) => ValidationRejection | null) | undefined} params.validate
 * @returns {Inspection}
 * @throws {AgentRefusalError} never retried, at either layer
 * @throws {AgentInputTooLargeError} the same input overflows the same way twice
 */
function inspect({ message, stage, inputCharacters, validate }) {
  const stopReason = message.stop_reason ?? null;

  if (stopReason === 'refusal') {
    // `stop_details` is populated only here, so it is read only here. The
    // explanation is model-authored prose about the input and is deliberately
    // dropped; only the category survives into a log line.
    throw new AgentRefusalError({ stage, category: message.stop_details?.category ?? null });
  }

  if (stopReason === 'model_context_window_exceeded') {
    throw new AgentInputTooLargeError({ stage, inputCharacters });
  }

  if (stopReason === 'max_tokens') {
    return {
      ok: false,
      reason: 'truncated',
      retryable: true,
      problem:
        'the response was cut off before it was complete, so it could not be parsed as JSON',
      context: {},
    };
  }

  if (!COMPLETED_STOP_REASONS.includes(stopReason)) {
    // `pause_turn` is the live example. Treating a paused turn as a finished one
    // would hand a half-formed judgement to the scorer.
    return {
      ok: false,
      reason: 'unsupported_stop_reason',
      retryable: false,
      problem: 'the response did not complete',
      context: { stopReason },
    };
  }

  const parsed = message.parsed_output ?? null;

  if (parsed === null) {
    // No text block at all - a response made entirely of thinking, or an empty
    // content array. Worth one more attempt; there is nothing here to correct.
    return {
      ok: false,
      reason: 'no_output',
      retryable: true,
      problem: 'no JSON object was returned at all',
      context: {},
    };
  }

  if (parsed.ok === false) {
    if (parsed.kind === 'invalid_json') {
      return {
        ok: false,
        reason: 'invalid_json',
        retryable: true,
        problem: 'the response was not valid JSON',
        context: {},
      };
    }

    return {
      ok: false,
      reason: 'schema_mismatch',
      retryable: true,
      problem: 'the response did not match the required schema',
      // Messages go to the model, which is the only party that can act on them.
      issues: parsed.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      // Paths and codes go to the log. A zod message can echo the offending
      // value - the enum variant does - and a log line is not the place for it.
      context: { issues: parsed.issues.map((issue) => ({ path: issue.path, code: issue.code })) },
    };
  }

  const rejection = validate === undefined ? null : validate(parsed.data);
  if (rejection !== null) {
    return {
      ok: false,
      reason: rejection.reason,
      // Always. A caller's rule fires on a response the API and the schema both
      // accepted, which makes it a statement about this generation rather than
      // about the request - and a different generation is exactly what the one
      // retry below produces.
      retryable: true,
      problem: rejection.problem,
      issues: rejection.issues,
      finalError: rejection.finalError,
      context: rejection.context,
    };
  }

  return { ok: true, data: parsed.data };
}
