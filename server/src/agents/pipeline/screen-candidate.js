/**
 * One candidate, end to end: CV text in, a scored candidate out.
 *
 * This is the whole agent layer composed, and it is the only function the worker
 * needs to know about. It takes plain data and returns plain data. There is no
 * `req`, no `res`, no connection pool, no file system and no queue in here - the
 * worker reads the row, calls this, and writes the result back.
 *
 * ```
 *   guard text -> extract -> normalize -> verify -> compute experience
 *              -> redact -> evaluate -> score, eliminate, assign tier
 * ```
 *
 * Two of those steps are model calls. Everything after `evaluate` is the pure
 * core from phase 2a, and the number a recruiter sees comes only from there.
 *
 * ## The hard deadline
 *
 * The two calls carry timeouts of 120s and 90s, and underneath each the SDK
 * retries transport failures twice - so the arithmetic worst case is six HTTP
 * requests and a wall-clock far past either figure. An AbortController over the
 * whole candidate is what actually bounds it, at 240s (plan section 5.4). The
 * BullMQ job timeout must exceed that, which is section 4's job to arrange.
 *
 * A caller may pass its own signal - a worker draining for shutdown, typically -
 * and it is combined with the deadline. Either source reports as a
 * candidate-scope `AGENT_TIMEOUT`, because from this candidate's point of view
 * both mean the same thing: the work was cancelled before it finished, and it is
 * worth attempting again.
 *
 * ## Failure is per candidate
 *
 * Nothing is caught here. Every failure below is already a typed `AgentError`
 * carrying a `code` from the worker-side namespace and a `retryable` label, and
 * swallowing one to return a partial result would produce exactly the outcome
 * the whole design refuses: a candidate with a number nobody can account for. One
 * bad CV fails on its own, loudly, with a reason.
 */

import { extractProfile } from '../extraction/extract-profile.js';
import { evaluateCandidate } from '../evaluation/evaluate-candidate.js';
import { scoreCandidate } from '../scoring/score-candidate.js';
import { NOOP_LOGGER } from '../util/logger.js';

/**
 * The hard per-candidate deadline, section 5.4. Milliseconds.
 *
 * Not the sum of the two call timeouts (210s) - deliberately close to it, so a
 * candidate that spends its whole budget on retries is stopped rather than left
 * to accumulate, and generous enough that a merely slow pair of calls finishes.
 */
export const CANDIDATE_DEADLINE_MS = 240_000;

/**
 * @typedef {object} ScreeningResult
 * @property {import('../schemas/profile.schema.js').VerifiedProfile} profile the
 *   **complete** profile, identity intact. Redaction applies to the copy handed
 *   to the evaluation call and to nothing else - the recruiter sees the whole
 *   person.
 * @property {import('../schemas/evaluation.schema.js').Evaluation} evaluation the
 *   model's ratings and prose, stored verbatim as the audit record
 * @property {import('../scoring/score-candidate.js').ScoredCandidate} scored the
 *   score, tier, elimination verdict and matrix - all computed in code
 * @property {object} diagnostics per-stage token usage, attempts and repairs
 */

/**
 * @param {object} params
 * @param {{ messages: { create: Function, parse: Function } }} params.client
 *   injected; the only thing in this call graph that knows an SDK exists. Both
 *   methods, because extraction sends no schema and evaluation does
 *   (`client/call-structured.js`)
 * @param {unknown} params.role straight from the repository
 * @param {string} params.cvText raw text, from phase 3's document parsing
 * @param {Date} params.now injected clock: experience, certification expiry and
 *   every audit timestamp read it, and a screening must not depend on when the
 *   worker happened to run
 * @param {AbortSignal} [params.signal] the caller's own cancellation
 * @param {number} [params.deadlineMs] overridable for tests; never in production
 * @param {import('../util/logger.js').AgentLogger} [params.logger]
 * @returns {Promise<ScreeningResult>}
 */
export async function screenCandidate({
  client,
  role,
  cvText,
  now,
  signal,
  deadlineMs = CANDIDATE_DEADLINE_MS,
  logger = NOOP_LOGGER,
}) {
  // `AbortSignal.timeout` uses an unref'd timer, so a candidate that finishes
  // early leaves nothing behind holding the process open - which is why there is
  // no `clearTimeout` in a `finally` here, and no `finally` at all.
  const deadline = AbortSignal.timeout(deadlineMs);
  const combined =
    signal === undefined ? deadline : AbortSignal.any([deadline, signal]);

  const extraction = await extractProfile({
    client,
    cvText,
    now,
    signal: combined,
    deadlineMs,
    logger,
  });

  const evaluation = await evaluateCandidate({
    client,
    role,
    // The un-redacted profile is handed over, and `evaluateCandidate` redacts it
    // on the way into the prompt. The alternative - redacting here - would put
    // the decision one call further from the prompt it protects, where a future
    // caller could reasonably not know it was needed.
    profile: extraction.profile,
    signal: combined,
    deadlineMs,
    logger,
  });

  // From here on nothing is uncertain. Same role, same profile, same ratings,
  // same `now` produces the same bytes on every run.
  const scored = scoreCandidate({
    role,
    profile: extraction.profile,
    evaluation: evaluation.evaluation,
    now,
    logger,
  });

  return {
    profile: extraction.profile,
    evaluation: evaluation.evaluation,
    scored,
    diagnostics: {
      deadlineMs,
      extraction: extraction.diagnostics,
      evaluation: evaluation.diagnostics,
      usage: totalUsage([extraction.diagnostics.usage, evaluation.diagnostics.usage]),
    },
  };
}

/**
 * Adds up what the candidate cost.
 *
 * `null` propagates rather than counting as zero: a missing usage figure means
 * the API did not report one, and a total that silently understates spend is
 * worse than no total at all.
 *
 * @param {{ inputTokens: number | null, outputTokens: number | null }[]} usages
 * @returns {{ inputTokens: number | null, outputTokens: number | null }}
 */
function totalUsage(usages) {
  const add = (/** @type {'inputTokens' | 'outputTokens'} */ key) =>
    usages.reduce(
      (sum, usage) => (sum === null || usage[key] === null ? null : sum + usage[key]),
      /** @type {number | null} */ (0),
    );

  return { inputTokens: add('inputTokens'), outputTokens: add('outputTokens') };
}
