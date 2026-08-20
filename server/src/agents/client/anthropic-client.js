/**
 * The one file in the repository that imports `@anthropic-ai/sdk`.
 *
 * Everything else in the agent layer takes `{ client, now, logger }` as an
 * argument. That single rule is what makes the whole test suite network-free
 * *without module mocking*: a test hands in a plain object with `messages.parse`
 * and `messages.create` methods and every code path above this file runs
 * unchanged. Mocking a module would test the mock's shape; injecting a client
 * tests the code.
 *
 * Two methods rather than one because the two calls ask for their JSON
 * differently: evaluation sends a schema and uses `messages.parse`, extraction
 * sends none and uses `messages.create`. Plan section 5.2 records the measurement
 * that forced the split.
 *
 * The file does three things and no more, all of them local and none of them
 * I/O:
 *
 * 1. **Constructs** the client (plan section 5.4).
 * 2. **Converts** a zod schema into the `output_config.format` the API expects.
 *    This has to live here because it needs the SDK's own JSON-Schema transform,
 *    and reimplementing that transform would be a copy of somebody else's rules
 *    that silently goes stale.
 * 3. **Classifies** an SDK error into a stable string. This has to live here for
 *    the same reason: `instanceof RateLimitError` is the correct way to identify
 *    a rate limit, string-matching a message is not, and the `instanceof` needs
 *    the classes. `call-structured.js` imports one small function instead of the
 *    SDK, and stays testable with hand-built errors.
 *
 * Importing this module opens no socket. Only calling a method on a constructed
 * client does.
 *
 * ## Verified API facts this file depends on
 *
 * - Model id is `claude-opus-5`, with no date suffix.
 * - `timeout` in the TypeScript/JS SDK is in **milliseconds**.
 * - `maxRetries` defaults to 2 and covers 408/409/429/5xx and connection errors,
 *   so worst-case wall clock is `timeout x (maxRetries + 1)`. The pipeline's
 *   AbortController is what actually bounds that.
 * - Structured output goes in `output_config: { format, effort }`. The top-level
 *   `output_format` parameter is deprecated and is not used here.
 * - `temperature`, `top_p` and `top_k` are removed on this model family and
 *   return 400. None of them is ever sent - see the note at the evaluation call
 *   site in `../evaluation/evaluate-candidate.js`.
 * - Thinking is adaptive by default; `budget_tokens` is removed and returns 400.
 *   No `thinking` parameter is sent at all, which is the documented equivalent of
 *   `{ type: 'adaptive' }`.
 * - Assistant prefill returns 400. Output shape is controlled by the schema.
 */

import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
// Kept rather than dropped for `zodOutputFormat`: that helper needs a zod v4
// schema, this project's schemas are v3, and migrating them reopens phase 2a - a
// committed phase at 100% coverage - for no functional gain. Mechanics below.
import { zodToJsonSchema } from 'zod-to-json-schema';
import { AnthropicConfigurationError } from './errors.js';
import { parseJsonResponse } from './json-response.js';

/**
 * The model, as a constant rather than an environment variable.
 *
 * A configurable model id looks like flexibility and behaves like a way to
 * silently downgrade a running system: every score in the database is stamped
 * with a role version but not with a model, so a batch scored by two different
 * models would be indistinguishable afterwards. Changing this is a code change,
 * a review and a commit.
 */
export const MODEL_ID = 'claude-opus-5';

/**
 * Default per-request timeout, in **milliseconds**. Each agent overrides it with
 * the figures from plan section 5.4 - extraction 120s, evaluation 90s - so this
 * only applies to a caller that asked for neither.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Transport retries, owned by the SDK: 408/409/429/5xx and connection errors,
 * exponential, honouring `retry-after`. The semantic layer in
 * `call-structured.js` retries once more for reasons the transport cannot see.
 * Two plus one is the six-HTTP-request worst case section 5.4 describes.
 */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * The classifications `call-structured.js` switches on. Strings rather than the
 * SDK's classes, so that nothing above this file needs the SDK to reason about a
 * failure - and so that a test can drive every branch without constructing an
 * exotic error.
 */
export const ANTHROPIC_ERROR_KINDS = Object.freeze({
  TIMEOUT: 'timeout',
  ABORTED: 'aborted',
  CONNECTION: 'connection',
  RATE_LIMIT: 'rate_limit',
  AUTHENTICATION: 'authentication',
  BAD_REQUEST: 'bad_request',
  SERVER: 'server',
  UNKNOWN: 'unknown',
});

/**
 * Builds the Anthropic client.
 *
 * @param {object} params
 * @param {string | undefined} params.apiKey from `config/env.js`, never a literal
 * @param {number} [params.timeoutMs] per-request timeout in milliseconds
 * @param {number} [params.maxRetries] transport retries owned by the SDK
 * @param {string} [params.baseURL] pointed elsewhere only by a proxy deployment
 * @returns {Anthropic}
 * @throws {AnthropicConfigurationError} when no key was supplied. Loud and early
 *   beats a 401 per candidate, and the message names the variable, never a value.
 */
export function createAnthropicClient({ apiKey, timeoutMs, maxRetries, baseURL } = {}) {
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new AnthropicConfigurationError(
      'ANTHROPIC_API_KEY is not set; the screening worker cannot start without it',
    );
  }

  return new Anthropic({
    apiKey,
    // Milliseconds. The SDK's own retries sit inside this, per request.
    timeout: timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: maxRetries ?? DEFAULT_MAX_RETRIES,
    ...(baseURL === undefined ? {} : { baseURL }),
  });
}

/**
 * @typedef {import('./json-response.js').StructuredParseResult} StructuredParseResult
 */

/**
 * Turns a zod schema into the object handed to `output_config.format`.
 *
 * **Only the evaluation call reaches this function now.** Extraction sends no
 * schema at all - see `call-structured.js` and plan section 5.2 for the measured
 * reason - so the grammar is compiled for the one task that is structured
 * reasoning rather than transcription.
 *
 * Two decisions here, and both are worth stating because neither is the obvious
 * one.
 *
 * **The JSON Schema is derived, not written.** `zod-to-json-schema` converts the
 * schema we already validate with, so there is exactly one definition of the
 * shape. The alternative - a hand-written JSON Schema next to a zod schema - is
 * two definitions that agree until the day somebody edits one. The official
 * `zodOutputFormat` helper would do the same job, but it requires a zod v4
 * schema (`import * as z from 'zod/v4'`) and this project's schemas are zod v3;
 * converting them is a phase 2a change with its own test surface, so the
 * converter is the cheaper equivalent. `jsonSchemaOutputFormat` then applies the
 * SDK's own transform, so the bytes on the wire are the bytes the official
 * helper would have sent.
 *
 * **`parse` never throws.** The SDK calls it inside `messages.parse` and wraps
 * anything thrown in a generic `AnthropicError` whose only diagnostic is a
 * string - which would leave the semantic retry with nothing to feed back.
 * Returning a discriminated result instead puts the failure in `parsed_output`,
 * where `call-structured.js` can read the zod issues, name them in a retry, and
 * name their paths in an error. A validation failure is a *value* here, not an
 * exception, because it is an expected outcome rather than an exceptional one.
 *
 * Note on `enum`: the SDK's transform lifts unsupported JSON Schema keywords -
 * `enum` among them - out of the schema and into the field's `description`. That
 * is the behaviour of the official helper too, so a criterion id is constrained
 * by instruction rather than by decoding. The zod enum still rejects an invented
 * id after the fact, and `reconcile-ratings.js` records it, so the guarantee
 * degrades from "structurally impossible" to "cannot reach the score".
 *
 * @param {{ safeParse: (value: unknown) => { success: boolean, data?: any, error?: any } }} schema
 * @returns {{ type: 'json_schema', schema: Record<string, unknown>, parse: (content: string) => StructuredParseResult }}
 */
export function toOutputFormat(schema) {
  const jsonSchema = zodToJsonSchema(schema, {
    // 2020-12 emits `$defs`, which is what the SDK's transform understands.
    target: 'jsonSchema2020-12',
    // Inline everything. Refs save bytes on a schema this small and cost a whole
    // class of resolution bug; the profile schema inlines to about 2.5kB.
    $refStrategy: 'none',
  });

  const format = jsonSchemaOutputFormat(/** @type {any} */ (jsonSchema));

  return {
    type: 'json_schema',
    schema: format.schema,
    // The same parse the unstructured path uses, deliberately: one JSON parse,
    // one schema validation and one discriminated result for both calls, so a
    // failure means the same thing and takes the same retry whichever way the
    // text arrived. Fence-stripping is *not* applied here - a grammar-decoded
    // response cannot carry a fence, and stripping one would be dead code
    // pretending to be a safeguard.
    parse: (content) => parseJsonResponse(schema, content),
  };
}

/**
 * Classifies an SDK error, most-specific-first.
 *
 * Order is the whole substance of this function: `APIConnectionTimeoutError`
 * extends `APIConnectionError`, and every status-specific class extends
 * `APIError`, so a general-first chain would collapse every failure into one
 * bucket and the retry decisions built on it would all be the same decision.
 *
 * Nothing here reads `error.message`. A message is upstream prose that can be
 * reworded without warning; a class and a status cannot.
 *
 * @param {unknown} error
 * @returns {{ kind: string, status: number | null }}
 */
export function classifyAnthropicError(error) {
  const { TIMEOUT, ABORTED, CONNECTION, RATE_LIMIT, AUTHENTICATION, BAD_REQUEST, SERVER, UNKNOWN } =
    ANTHROPIC_ERROR_KINDS;

  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return { kind: TIMEOUT, status: null };
  }
  if (error instanceof Anthropic.APIUserAbortError) {
    // The caller's AbortController fired - a candidate deadline, or a shutting
    // down worker. The pipeline decides which; this only reports that it was us.
    return { kind: ABORTED, status: null };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { kind: CONNECTION, status: null };
  }
  // No `?? 429` fallbacks below: each of these classes is constructed by the SDK
  // with its own status, so a default would be a branch nothing can reach and a
  // reader would waste a minute working out when it fires.
  if (error instanceof Anthropic.RateLimitError) {
    return { kind: RATE_LIMIT, status: error.status };
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return { kind: AUTHENTICATION, status: error.status };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { kind: BAD_REQUEST, status: error.status };
  }
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : null;
    return { kind: status !== null && status >= 500 ? SERVER : UNKNOWN, status };
  }

  // A `DOMException` from an AbortSignal that fired before the SDK saw it, or
  // anything else entirely. Unknown is not retryable, which is the safe default
  // for a failure nobody has classified.
  if (error instanceof Error && error.name === 'AbortError') {
    return { kind: ABORTED, status: null };
  }

  return { kind: UNKNOWN, status: null };
}

/**
 * Reads `retry-after` off a rate-limit error.
 *
 * Passed to the worker so its backoff can respect the server's own advice. Null
 * whenever the header is absent, non-numeric or negative - a guessed backoff is
 * how a rate limit turns into a rate-limit loop.
 *
 * @param {unknown} error
 * @returns {number | null} seconds
 */
export function retryAfterSeconds(error) {
  if (!(error instanceof Anthropic.APIError) || !error.headers) {
    return null;
  }

  const raw = error.headers.get('retry-after');
  if (raw === null) {
    return null;
  }

  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
