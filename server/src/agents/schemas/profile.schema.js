/**
 * The extraction output schema - shaped for the model, not for the type checker.
 *
 * Three decisions carry this file (plan section 5.1):
 *
 * 1. `.nullable()` everywhere and `.optional()` nowhere. A nullable-but-required
 *    field forces an explicit per-field decision and separates "the CV does not
 *    say" from "the model stopped generating". That distinction IS the
 *    anti-fabrication story; an optional field collapses the two into silence.
 *
 * 2. `email` is a plain string, not `z.string().email()`. Validation at this
 *    boundary is all-or-nothing: one mangled OCR address would null the entire
 *    extraction and burn a retry over a field nobody scores on. Format checks
 *    live in `normalize-profile.js` (phase 2b), which nulls the bad field and
 *    keeps the other forty. Dates are plain strings for exactly the same reason -
 *    `compute-experience.js` parses them defensively and reports what it could
 *    not use.
 *
 * 3. `skills[].evidenceType` is a two-value enum sitting next to a nullable
 *    `evidenceQuote`. Redundant on paper; in practice a model handed a nullable
 *    string fills it, and a model handed an honest option picks it.
 *
 * The one deliberate exception to rule 1: `skills[].name` and
 * `certifications[].name` are non-nullable. The rule exists to force a decision
 * per field, and for the name of a list entry the decision is already made -
 * null there does not mean "the CV is silent", it means the entry should not
 * have been emitted. Every other field on those entries is nullable.
 *
 * Objects are `.strict()`. An unknown key is a loud validation failure rather
 * than a silently stripped one, which is what stops a model quietly inventing a
 * field - most importantly a score.
 */

import { z } from 'zod';
import { EDUCATION_LEVELS, EVIDENCE_TYPES } from '../constants.js';

const nullableString = z.string().nullable();

/**
 * A date as the CV writes it. Deliberately unvalidated: "2019", "2019-03",
 * "March 2019" and "Present" all arrive here intact, and
 * `compute-experience.js` decides what it can turn into months.
 */
const nullableDateString = z.string().nullable();

export const locationSchema = z
  .object({
    raw: nullableString,
    city: nullableString,
    region: nullableString,
    /** ISO-3166-1 alpha-2 if the model can determine one, else null. */
    countryCode: nullableString,
  })
  .strict();

export const workExperienceSchema = z
  .object({
    employer: nullableString,
    title: nullableString,
    startDate: nullableDateString,
    endDate: nullableDateString,
    /**
     * Tri-state on purpose: `true` means the CV says this role is current, and
     * `null` means the CV does not say. `compute-experience.js` will close an
     * open interval at `now` for the first and refuse to guess for the second.
     */
    isCurrent: z.boolean().nullable(),
    summary: nullableString,
  })
  .strict();

export const educationSchema = z
  .object({
    institution: nullableString,
    degree: nullableString,
    field: nullableString,
    /**
     * Mapped onto our ladder by the model, because the model is the thing that
     * knows "Diplom-Ingenieur" is a masters. Null when it cannot tell, which
     * makes the education rule indeterminate rather than a rejection.
     */
    level: z.enum(EDUCATION_LEVELS).nullable(),
    startDate: nullableDateString,
    endDate: nullableDateString,
  })
  .strict();

export const certificationSchema = z
  .object({
    name: z.string().min(1),
    issuer: nullableString,
    issuedDate: nullableDateString,
    /** Null means "no expiry stated", which is not the same as "does not expire". */
    expiryDate: nullableDateString,
  })
  .strict();

export const skillSchema = z
  .object({
    name: z.string().min(1),
    evidenceType: z.enum(EVIDENCE_TYPES),
    /**
     * A verbatim span from the CV when `evidenceType` is `demonstrated`.
     * `verify-evidence.js` substring-matches it against the source text and
     * downgrades the skill when it does not appear. It is the only claim in the
     * system a machine can falsify.
     */
    evidenceQuote: nullableString,
  })
  .strict();

/**
 * The whole extraction.
 *
 * Every list is nullable, and that is not decoration: `null` is "extraction
 * could not find this section" and `[]` is "the model looked and found nothing".
 * The elimination evaluators treat both as an absent fact, because in practice an
 * empty list is far more often a parsing failure than a genuine emptiness - and
 * decision 7-C says the cost of a false `indeterminate` (a recruiter filters more)
 * is much lower than the cost of a false elimination.
 */
export const profileSchema = z
  .object({
    fullName: nullableString,
    email: nullableString,
    phone: nullableString,
    linkedinUrl: nullableString,
    location: locationSchema.nullable(),
    headline: nullableString,
    summary: nullableString,
    /**
     * What the CV literally claims ("10+ years of experience"). The model never
     * computes years from dates - `compute-experience.js` does, from the work
     * history, and the elimination rules read only that. This field survives as
     * a discrepancy signal: "CV claims 10 years; dates support 6.5".
     */
    statedYearsExperience: z.number().nullable(),
    workHistory: z.array(workExperienceSchema).nullable(),
    education: z.array(educationSchema).nullable(),
    certifications: z.array(certificationSchema).nullable(),
    skills: z.array(skillSchema).nullable(),
  })
  .strict();

/**
 * A skill after `verify-evidence.js` has been over it.
 *
 * `evidenceVerified` is set by code, never by the model: `true` when the quote
 * was found in the source, `false` when it was not (and the skill was therefore
 * downgraded to `listed_only`), `null` when there was nothing to check.
 */
export const verifiedSkillSchema = skillSchema.extend({
  evidenceVerified: z.boolean().nullable(),
});

/**
 * The profile as it is stored in `candidates.parsed_profile` and as the
 * elimination evaluators read it: the model's extraction plus the two facts code
 * derives from it.
 */
export const verifiedProfileSchema = profileSchema.extend({
  skills: z.array(verifiedSkillSchema).nullable(),
  /**
   * Derived from work-history dates with overlapping employment merged, never
   * summed. Null when no interval could be resolved - null, not zero, because
   * "we could not tell" and "no experience" are different answers and only one
   * of them should ever eliminate anybody.
   */
  computedYearsExperience: z.number().nullable(),
});

/**
 * @typedef {z.infer<typeof profileSchema>} Profile
 * @typedef {z.infer<typeof verifiedProfileSchema>} VerifiedProfile
 * @typedef {z.infer<typeof skillSchema>} Skill
 * @typedef {z.infer<typeof verifiedSkillSchema>} VerifiedSkill
 * @typedef {z.infer<typeof workExperienceSchema>} WorkExperience
 * @typedef {z.infer<typeof educationSchema>} Education
 * @typedef {z.infer<typeof certificationSchema>} Certification
 */
