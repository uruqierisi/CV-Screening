/**
 * The judging call: verified profile plus criteria in, per-criterion ratings
 * out.
 *
 * What this function refuses to pass to the model is more important than what it
 * passes (plan section 5.2). It sends the criteria and the redacted profile. It
 * does **not** send:
 *
 * - the weights, because a model that knows a criterion carries 40% rates it
 *   strategically and the ratings stop being independent observations;
 * - the elimination rules, because a model told "no degree means rejection"
 *   drags every rating down for such a candidate and corrupts the score shown
 *   next to the Unmatched badge;
 * - the raw CV, because passing it again doubles input cost and reintroduces
 *   fabrication at the point a claim becomes a number;
 * - the candidate's name, email, phone or linkedin (decision 7-D).
 *
 * The projection below is what enforces the first of those. It copies three
 * fields off each criterion, so a weight cannot reach the prompt by being
 * carried along inside an object somebody spread.
 *
 * Nothing here produces a score. The response schema has nowhere to put one, and
 * `computeWeightedScore` in phase 2a is the only code in the system that turns
 * ratings into a number.
 *
 * Two rules the schema cannot express are checked on the way out - every
 * criterion must be rated, and the summary must be prose only - and both feed
 * the one semantic retry in `call-structured.js`. See {@link checkResponse}.
 */

import { makeEvaluationSchema } from '../schemas/evaluation.schema.js';
import { parseRole } from '../schemas/role.schema.js';
import { IncompleteEvaluationError } from '../errors.js';
import { findScoreFigure } from '../scoring/validate-summary.js';
import { evaluationPrompt, EVALUATION_PROMPT_VERSION } from '../prompts/evaluation.prompt.js';
import { callStructured } from '../client/call-structured.js';
import { NOOP_LOGGER } from '../util/logger.js';
import { redactIdentity } from './redact-identity.js';
import { normalizeEvaluation } from './normalize-ratings.js';

export const EVALUATION_STAGE = 'evaluation';

/**
 * Effort `high`, from section 5.2. This is the judgement call, it is read by a
 * human next to a hiring decision, and it is the one place in the pipeline where
 * paying for more reasoning buys something real.
 */
export const EVALUATION_EFFORT = 'high';

/** Section 5.4. Milliseconds. */
export const EVALUATION_TIMEOUT_MS = 90_000;

/**
 * Higher than extraction's despite the smaller response, because at `high`
 * effort the adaptive thinking counts against `max_tokens` too. Doubling on a
 * truncation retry stays inside the non-streaming output ceiling.
 */
export const EVALUATION_MAX_TOKENS = 8_000;

/**
 * @typedef {import('../schemas/evaluation.schema.js').Evaluation} Evaluation
 *
 * @typedef {object} EvaluationResult
 * @property {Evaluation} evaluation ratings and prose, exactly as validated
 * @property {object} diagnostics prompt version, attempts and token usage
 */

/**
 * @param {object} params
 * @param {{ messages: { parse: Function } }} params.client injected
 * @param {unknown} params.role straight from the repository; parsed here
 * @param {Record<string, any>} params.profile the verified, **un-redacted**
 *   profile. Redaction happens inside this function so that no caller can forget.
 * @param {AbortSignal} [params.signal]
 * @param {number} [params.deadlineMs]
 * @param {import('../util/logger.js').AgentLogger} [params.logger]
 * @returns {Promise<EvaluationResult>}
 */
export async function evaluateCandidate({
  client,
  role,
  profile,
  signal,
  deadlineMs,
  logger = NOOP_LOGGER,
}) {
  const scoringRole = parseRole(role);

  // Three fields, copied by name. Not a spread with `weight` deleted afterwards:
  // that reads as a subtraction somebody could later "simplify" away, and this
  // reads as the whitelist it is.
  const criteria = scoringRole.criteria.map((criterion) => ({
    id: criterion.id,
    label: criterion.label,
    description: criterion.description,
  }));

  const { data, attempts, usage } = await callStructured({
    client,
    schema: makeEvaluationSchema(scoringRole),
    prompt: evaluationPrompt({
      criteria,
      roleTitle: scoringRole.title,
      profile: redactIdentity(profile),
    }),
    stage: EVALUATION_STAGE,
    effort: EVALUATION_EFFORT,
    // ---------------------------------------------------------------------
    // On the absence of `temperature: 0`.
    //
    // This is the call where a deterministic sampler would be worth having, and
    // it is not available: `temperature`, `top_p` and `top_k` are removed on
    // this model family and any of them returns a 400. Sending one to look
    // rigorous would break every evaluation in the system, and switching to an
    // older model to get the parameter back would trade a real property - the
    // judgement quality this whole call exists for - for a nominal one.
    //
    // So the absence is deliberate, and what replaces it is stated here rather
    // than assumed:
    //
    // - variance is controlled by `output_config.effort`, set to `high` above.
    //   More reasoning on the same profile is what actually narrows the spread
    //   between two runs;
    // - **determinism lives in `scoring/`, not in the sampler.** The same
    //   ratings always produce the same score, tier and breakdown, byte for
    //   byte - that is what the 100-run golden fixture test asserts. The claim
    //   the README makes is exactly that and no more: the score is a
    //   reproducible function of the ratings, and every rating is shown with the
    //   evidence behind it.
    //
    // Plan section 8 already records the residual honestly: the same CV run
    // twice can produce different ratings and therefore a different score. No
    // sampler setting available on any model would have made that claim
    // stronger than "reproducible given the ratings".
    // ---------------------------------------------------------------------
    maxTokens: EVALUATION_MAX_TOKENS,
    timeoutMs: EVALUATION_TIMEOUT_MS,
    signal,
    deadlineMs,
    logger,
    validate: checkResponse(criteria.map((criterion) => criterion.id)),
  });

  return {
    // Cleaned before it leaves this function, so nothing downstream has to know
    // that a quote copied out of the profile JSON can carry the JSON with it.
    // `scoring/` puts `evidence` straight into `evaluation_matrix`, which is
    // what the matrix screen renders.
    evaluation: normalizeEvaluation(data),
    diagnostics: {
      promptVersion: EVALUATION_PROMPT_VERSION,
      attempts,
      usage,
      criteriaCount: criteria.length,
    },
  };
}

/**
 * The two post-parse checks, in the order they are applied.
 *
 * Both are rules the schema cannot express, both fire on a response the API and
 * zod already accepted, and both are therefore statements about *this
 * generation* rather than about the request. So they share one retry - the one
 * in `call-structured.js` - instead of each acquiring a mechanism.
 *
 * Completeness is checked first because it is about the substance and the
 * summary is about the prose: a response missing two of six ratings has a bigger
 * problem than a sentence with a percentage in it, and telling the model about
 * the sentence first would spend the single retry on the smaller fault. Only the
 * first failing rule is reported, so a response that breaks both spends its
 * retry on the ratings and then fails on the summary - which is the honest
 * outcome, and visible in the error's `reason`.
 *
 * @param {string[]} criterionIds every id the role defines, in the role's order
 * @returns {(evaluation: Evaluation) => import('../client/call-structured.js').ValidationRejection | null}
 */
function checkResponse(criterionIds) {
  return (evaluation) =>
    rejectIncompleteRatings(evaluation, criterionIds) ??
    rejectSummaryStatingAScore(evaluation);
}

/**
 * Every criterion must be rated, and the check for that runs **here** - inside
 * the evaluation call - rather than downstream in the scorer.
 *
 * `reconcile-ratings.js` has always caught this, and still does. The difference
 * is what can be done about it at each point. By the time the scorer has the
 * response the generation is over, so re-running the pure function over the same
 * object fails identically and a retry there would buy nothing but latency. Here
 * the model is still in the loop: it can be told which ids it omitted and asked
 * again, and that is a different generation rather than the same one re-read.
 *
 * So the two checks are not a duplicate of one rule; they are one rule at two
 * boundaries, and the boundaries have different powers. This one is the
 * recovery. The scorer's is the guarantee - it holds for any caller who scores
 * an evaluation this function never produced, and nothing about its behaviour
 * changed.
 *
 * Duplicates are deliberately not checked here. `DuplicateRatingError` is a
 * response that contradicts itself rather than one that came up short, the
 * scorer refuses it on sight, and it is not labelled retryable.
 *
 * @param {Evaluation} evaluation
 * @param {string[]} criterionIds
 * @returns {import('../client/call-structured.js').ValidationRejection | null}
 */
function rejectIncompleteRatings(evaluation, criterionIds) {
  const rated = new Set(evaluation.ratings.map((rating) => rating.criterionId));
  const missing = criterionIds.filter((id) => !rated.has(id));

  if (missing.length === 0) {
    return null;
  }

  return {
    reason: 'incomplete_evaluation',
    problem: [
      `${missing.length} of the ${criterionIds.length} criteria you were given were not rated.`,
      'Return a rating for every criterion, exactly once each, using the',
      '`criterionId` values exactly as they were given to you. The ones that were',
      'missing are listed below.',
    ].join(' '),
    // The ids, one per line, in the shape the schema-mismatch path uses for
    // zod's issues - a retry told precisely which criterion it dropped usually
    // returns it, and one told only that something was missing is a coin toss.
    issues: missing.map((id) => ({
      path: `ratings.${id}`,
      message: 'no rating was returned for this criterion',
    })),
    // Ids and counts. The criterion labels are not here and nor is anything the
    // candidate wrote: this reaches a log line.
    context: { missingCriterionIds: missing },
    // Built only if the retry is also incomplete. The failure is a fact about
    // the evaluation, so it keeps the evaluation's error and its ids rather than
    // flattening into a generic bad-output error at the client boundary.
    finalError: () => new IncompleteEvaluationError(missing),
  };
}

/**
 * The post-parse check the schema cannot express: `summary` must be prose only.
 *
 * The prompt is the primary control (`prompts/shared-rules.js` carries the full
 * prohibition, including the spelled-out, verb and noun forms the detector
 * knowingly misses). This is the backstop for the literal forms a drifting model
 * actually produces, and it is deliberately narrow - it rejects a figure on the
 * score and leaves counts alone, because rejecting *"matches 4 of the 6
 * criteria"* would burn a retry, and real money, on a summary that was correct.
 *
 * Nothing is repaired. Stripping the number silently would hide the drift this
 * check exists to surface. A rejection takes the ordinary semantic retry path in
 * `call-structured.js`, and a second offending summary fails the candidate with
 * `AGENT_BAD_OUTPUT`.
 *
 * The matched span is fed back to the model, because the model wrote it and
 * telling it exactly which phrase was refused is what makes the retry work. Only
 * the pattern id reaches the log.
 *
 * @param {Evaluation} evaluation
 * @returns {import('../client/call-structured.js').ValidationRejection | null}
 */
function rejectSummaryStatingAScore(evaluation) {
  const figure = findScoreFigure(evaluation.summary);
  if (figure === null) {
    return null;
  }

  return {
    reason: 'rejected_summary',
    problem: [
      `the summary stated ${figure.description}: "${figure.match}".`,
      'The summary must not contain any figure expressing how well this candidate',
      'matches - in digits or in words. Rewrite that sentence without it. Counts of',
      'things in the profile are fine; a figure that grades the candidate is not.',
    ].join(' '),
    context: { patternId: figure.patternId },
  };
}
