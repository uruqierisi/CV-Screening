/**
 * The only claim in the system a machine can falsify.
 *
 * The model marks a skill `demonstrated` and copies a verbatim span out of the
 * CV to prove it. This module checks that the span is actually there. A miss
 * downgrades the skill to `listed_only`, which is exactly the distinction the
 * evaluation prompt leans on ("a skill with evidenceType: listed_only is a claim,
 * not a demonstration") and which a `required_skill` rule with
 * `mustBeDemonstrated` reads directly.
 *
 * Everything else in the extracted profile is unfalsifiable without a second
 * model call. This one is a substring search, so it is free, deterministic and
 * runs on every candidate.
 *
 * Matching folds only differences that are not differences: unicode dashes,
 * typographic quotes, zero-width characters, whitespace runs and case. A PDF text
 * layer routinely rewrites all five while copying a span faithfully, and failing
 * a candidate over an en dash would be a bug wearing the costume of rigour. It
 * does NOT fold word order, punctuation or paraphrase: those are the differences
 * that mean the quote was not copied.
 *
 * A `demonstrated` skill with no quote is downgraded too. The prompt requires a
 * quote when the model picks `demonstrated`, so its absence is the model
 * declining to substantiate a claim, and an unsubstantiated claim is a listing.
 */

import { containsNormalized } from '../util/text.js';

/**
 * @typedef {import('../schemas/profile.schema.js').Profile} Profile
 * @typedef {import('../schemas/profile.schema.js').VerifiedSkill} VerifiedSkill
 *
 * @typedef {object} Downgrade
 * @property {string} skill the skill name, which came from the CV and is not free prose
 * @property {'missing_quote' | 'quote_not_found'} reason
 *
 * @typedef {object} EvidenceVerification
 * @property {Profile & { skills: VerifiedSkill[] | null }} profile a copy, with
 *   `evidenceType` corrected and `evidenceVerified` set by code
 * @property {Downgrade[]} downgraded every claim that failed, for the logs
 * @property {number} verifiedCount claims that were checked and held up
 */

/**
 * @param {Profile} profile the extracted profile, straight from the schema
 * @param {string} sourceText the CV text the extraction was made from
 * @returns {EvidenceVerification}
 * @throws {TypeError} if there is no source text to verify against - verifying
 *   against nothing would downgrade every skill on the CV and look like a model
 *   failure rather than the plumbing failure it is
 */
export function verifyEvidence(profile, sourceText) {
  if (typeof sourceText !== 'string' || sourceText.trim().length === 0) {
    throw new TypeError('verifyEvidence requires the source text the profile was extracted from');
  }

  if (profile.skills === null) {
    return { profile: { ...profile, skills: null }, downgraded: [], verifiedCount: 0 };
  }

  /** @type {Downgrade[]} */
  const downgraded = [];
  let verifiedCount = 0;

  const skills = profile.skills.map((skill) => {
    if (skill.evidenceType !== 'demonstrated') {
      // Nothing was claimed, so there is nothing to verify. `null` rather than
      // `false`: "not checked" and "checked and failed" must stay distinguishable
      // in the stored profile.
      return { ...skill, evidenceVerified: null };
    }

    if (skill.evidenceQuote === null) {
      downgraded.push({ skill: skill.name, reason: 'missing_quote' });
      return { ...skill, evidenceType: 'listed_only', evidenceVerified: false };
    }

    if (!containsNormalized(sourceText, skill.evidenceQuote)) {
      // The quote is kept rather than nulled. It is the evidence that the model
      // fabricated one, and deleting it would erase the only trace.
      downgraded.push({ skill: skill.name, reason: 'quote_not_found' });
      return { ...skill, evidenceType: 'listed_only', evidenceVerified: false };
    }

    verifiedCount += 1;
    return { ...skill, evidenceVerified: true };
  });

  return { profile: { ...profile, skills }, downgraded, verifiedCount };
}
