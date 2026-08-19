/**
 * CV text in, verified profile out. The first of the two model calls.
 *
 * The call itself is three lines of this file. The rest is the work that makes
 * its output trustworthy, and the order is the design:
 *
 * 1. **Guard the input.** Text that is not worth a token never becomes a call.
 * 2. **Extract**, seeing the CV and nothing else (no role, no criteria).
 * 3. **Normalize.** Field-level repair: bad email nulled, duplicate skills
 *    merged, implausible figures dropped. Nothing invented.
 * 4. **Verify.** Every `demonstrated` claim is checked against the source text
 *    and downgraded if its quote is not there. This is the only claim in the
 *    system a machine can falsify, and it runs on every candidate.
 * 5. **Compute experience** from the dates, with overlapping employment merged
 *    and an injected `now`. The model's `statedYearsExperience` is kept only as
 *    a discrepancy signal.
 *
 * Steps 3 to 5 are pure and were proven in phase 2a. What this file adds is the
 * one non-deterministic step and the order the deterministic ones run in.
 *
 * Plan section 8 records the honest limitation this sits on top of: extraction
 * is a single point of failure. Every rating, elimination and score depends on
 * this one call, and evaluation cannot see past it.
 */

import { profileSchema } from '../schemas/profile.schema.js';
import { extractionPrompt, EXTRACTION_PROMPT_VERSION } from '../prompts/extraction.prompt.js';
import { callStructured } from '../client/call-structured.js';
import { AgentInputError } from '../client/errors.js';
import { NOOP_LOGGER } from '../util/logger.js';
import { assessCvText } from '../util/text.js';
import { normalizeProfile } from './normalize-profile.js';
import { verifyEvidence } from './verify-evidence.js';
import { withComputedExperience } from './compute-experience.js';

/** Named so the reader sees what this call is, not just what it costs. */
export const EXTRACTION_STAGE = 'extraction';

/**
 * Effort `low`, from plan section 5.2. This is transcription: thinking on it is
 * billed output tokens spent on nothing, and at high effort it is roughly 60% of
 * extraction's output (section 9). It is the single biggest cost lever in the
 * system and it costs no accuracy on this task.
 */
export const EXTRACTION_EFFORT = 'low';

/** Section 5.4. Milliseconds - the JS SDK's `timeout` is not seconds. */
export const EXTRACTION_TIMEOUT_MS = 120_000;

/**
 * Generous for a profile that runs to roughly 2,000 output tokens even for a
 * dense three-page CV. Set with room for the semantic retry to double it and
 * still sit inside the non-streaming output ceiling.
 */
export const EXTRACTION_MAX_TOKENS = 6_000;

/**
 * @typedef {import('../schemas/profile.schema.js').VerifiedProfile} VerifiedProfile
 *
 * @typedef {object} ExtractionResult
 * @property {VerifiedProfile} profile complete and un-redacted - this is what is
 *   stored and what the recruiter sees. Redaction happens on the way into
 *   evaluation and nowhere else.
 * @property {object} diagnostics everything a human would want when a profile
 *   looks wrong: what was repaired, what was downgraded, what the dates gave,
 *   and what the call cost
 */

/**
 * @param {object} params
 * @param {{ messages: { parse: Function } }} params.client injected
 * @param {string} params.cvText raw text of one CV
 * @param {Date} params.now injected clock, for the experience computation
 * @param {AbortSignal} [params.signal] the candidate-wide deadline
 * @param {number} [params.deadlineMs] what that deadline was, for the error message
 * @param {import('../util/logger.js').AgentLogger} [params.logger]
 * @returns {Promise<ExtractionResult>}
 * @throws {AgentInputError} before any API call, when the text is not worth one
 */
export async function extractProfile({
  client,
  cvText,
  now,
  signal,
  deadlineMs,
  logger = NOOP_LOGGER,
}) {
  const assessment = assessCvText(cvText);
  if (!assessment.usable) {
    // Cheapest possible failure: no tokens spent. `details` carries counts only,
    // never a span of the document.
    throw new AgentInputError('the document does not contain enough usable text to screen', {
      stage: EXTRACTION_STAGE,
      failures: assessment.failures,
      ...assessment.stats,
    });
  }

  const { data, attempts, usage } = await callStructured({
    client,
    schema: profileSchema,
    prompt: extractionPrompt({ cvText }),
    stage: EXTRACTION_STAGE,
    effort: EXTRACTION_EFFORT,
    maxTokens: EXTRACTION_MAX_TOKENS,
    timeoutMs: EXTRACTION_TIMEOUT_MS,
    signal,
    deadlineMs,
    logger,
  });

  const normalized = normalizeProfile(data);
  const verified = verifyEvidence(normalized.profile, cvText);
  const withExperience = withComputedExperience(verified.profile, { now });

  if (verified.downgraded.length > 0) {
    // Worth a line in the log every time. A model that suddenly starts
    // fabricating quotes shows up here first, and it shows up as a rate rather
    // than as a single odd candidate.
    logger.warn('extraction claimed evidence it could not support', {
      stage: EXTRACTION_STAGE,
      downgraded: verified.downgraded.length,
      verified: verified.verifiedCount,
    });
  }

  return {
    profile: withExperience.profile,
    diagnostics: {
      promptVersion: EXTRACTION_PROMPT_VERSION,
      attempts,
      usage,
      inputAssessment: assessment.stats,
      normalization: normalized.changes,
      evidence: {
        verifiedCount: verified.verifiedCount,
        downgraded: verified.downgraded,
      },
      experience: withExperience.experience,
    },
  };
}
