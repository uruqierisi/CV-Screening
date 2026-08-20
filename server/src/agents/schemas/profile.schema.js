/**
 * The profile, in the two shapes it has: the one the model returns and the one
 * the rest of the system stores and reads.
 *
 * They used to be the same schema. They are not any more, and the reason is two
 * independent hard limits on the wire. Both were discovered the same way - by a
 * live request being rejected before it reached the model - and both are quoted
 * here verbatim, because a paraphrase of an API limit is how the next one gets
 * missed:
 *
 * > `400 invalid_request_error` - "Schemas contains too many parameters with
 * > union types (32 parameters with type arrays or anyOf). This causes
 * > exponential compilation cost. Reduce the number of nullable or union-typed
 * > parameters (limit: 16 parameters with unions)."
 *
 * > `400 invalid_request_error` - "Schemas contains too many optional parameters
 * > (31), which would make grammar compilation inefficient. Reduce the number of
 * > optional parameters in your tool schemas (limit: 24)."
 *
 * The API compiles the JSON Schema into a decoding grammar. A union costs it
 * exponentially and an optional parameter costs it a branch, so it caps each
 * separately: **unions <= 16, optionals <= 24.** They are separate budgets and a
 * field can only ever be one of three things:
 *
 * | Marking | Union budget | Optional budget |
 * |---|---|---|
 * | `.nullable()` | 1 | 0 |
 * | `.optional()` | 0 | 1 |
 * | required | 0 | 0 |
 *
 * Trading the first for the second is what fixed the union 400 and what caused
 * the optional one. **Only `required` is free**, and that is the whole shape of
 * the decision recorded below.
 *
 * ## The rule that decided which fields moved
 *
 * > Required costs neither budget, but a required scalar forces the model to
 * > produce something even when the CV does not have it - and invention is what
 * > this whole design exists to prevent. So **`required` is for fields where
 * > absence has a safe representation**, and **deletion is for fields nothing
 * > scores.**
 *
 * Applied field by field, from 31 optionals to 22:
 *
 * 1. **The four container arrays became required** - `workHistory`,
 *    `education`, `certifications`, `skills`. `[]` is a legitimate "I looked and
 *    found none": it invents nothing, and it removes an ambiguity the system was
 *    carrying anyway. **31 -> 27.**
 * 2. **`workHistory[].isCurrent` was deleted.** An absent `endDate` already
 *    means the role is ongoing, and two encodings of one fact is a drift
 *    surface. `compute-experience.js` reads absence that way where the rest of
 *    the history supports it, and as a gap where it does not - see its header,
 *    which is where the whole of that rule lives. **27 -> 26.**
 * 3. **`headline` was deleted.** Nothing scores it. **26 -> 25.**
 * 4. **`locationRaw` was deleted.** The `location_allowlist` rule reads
 *    `countryCode` and nothing else, and `locationCity` / `locationRegion` carry
 *    everything a recruiter reads. **25 -> 24.**
 * 5. **24 is the limit, which is no place to sit.** Profile-level `summary` and
 *    `education[].startDate` went by the same test - nothing reads either - to
 *    land at **22**, two under. `workHistory[].summary` and
 *    `skills[].evidenceQuote` were explicitly not touched: they carry the
 *    evidence the whole evaluation rests on.
 *
 * `employer` and `title` stayed optional deliberately. They are the fields a
 * badly-parsed CV most often loses, and forcing the model to emit a string for
 * one is forcing it to invent an employer.
 *
 * ## Postscript: this schema is no longer sent to the API
 *
 * Everything above is the record of how the wire shape was decided and is kept
 * for that reason, but the two caps stopped applying to it. The API's grammar
 * compiler could not compile this schema in a usable time **even at 0 unions and
 * 22 optionals** - far under both limits - so extraction now sends no
 * `output_config.format` at all and asks for JSON in the response body instead.
 * The bisect that established that is in plan section 5.2.1, and the summary is
 * on `EXTRACTION_RESPONSE_FORMAT` in `extraction/extract-profile.js`.
 *
 * **`extractedProfileSchema` is unchanged and is still what every extraction is
 * validated against.** That was always where the guarantee lived: the SDK
 * demotes `enum` into a description, so even the criterion-id constraint was
 * post-parse validation rather than decoding. What the wire stopped providing is
 * the shape; the extraction prompt now states it in words, and
 * `test/agents/prompts.test.js` walks this file to check the two agree.
 *
 * The optional markings stay, and are now a choice rather than a forced move.
 * The property they buy was never about the budget: the model needs a legal,
 * cheap, explicitly-blessed way to say "the CV does not say this", and an
 * omitted key says it.
 *
 * ## The two schemas
 *
 * - {@link extractedProfileSchema} - **what the model is asked for.** Every
 *   uncertain field `.optional()`, the four lists required, `location` flattened
 *   into three sibling strings.
 * - {@link profileSchema} - **what is stored** in `candidates.parsed_profile`
 *   and what `elimination.js`, `verify-evidence.js`, `compute-experience.js`,
 *   the evaluation prompt and the dashboard all read. Every field present,
 *   nullable, `location` nested.
 *
 * `normalize-profile.js` is the seam between them. It fills every absent field
 * with `null` and re-nests the location.
 *
 * **The two schemas describe the same fields.** That is not a convention, it is
 * asserted: `test/agents/schema-drift.test.js` walks both and fails unless the
 * field sets match, minus a named literal list of what the wire contract
 * deliberately drops. The wire/stored split is the right design and it created a
 * surface that did not exist before - a field added to one and forgotten on the
 * other would simply never arrive.
 *
 * ## An explicit `null` on the wire is accepted, not rejected
 *
 * Every optional field is wrapped in a `z.preprocess` that turns an explicit
 * `null` into an absent key. This is **not** silent repair of an error: on the
 * wire contract `null` and absent mean exactly the same thing - "the CV does not
 * say" - and `normalize-profile.js` fills absent with `null` a line later
 * anyway. Failing validation, burning a retry and real money over an equivalent
 * encoding would be brittle for no benefit.
 *
 * It cost nothing on either budget while a schema was still being sent:
 * `zod-to-json-schema` emits the *input* side of a preprocess, so the generated
 * JSON Schema was byte-identical to the one a plain `.optional()` produced. It
 * earns more now than it did then - with no grammar in front of the model, an
 * explicit `null` is a response it can actually produce, and this is what stops
 * that costing a retry.
 *
 * The four required arrays are **not** wrapped. There is no "absent" for them to
 * be equivalent to - the contract says always send an array, and `[]` is how you
 * say you found none - so a `null` there is a genuine mismatch and takes the
 * ordinary semantic retry.
 *
 * ## Decisions carried over unchanged
 *
 * 1. **`email` is a plain string, not `z.string().email()`.** Validation at this
 *    boundary is all-or-nothing: one mangled OCR address would null the entire
 *    extraction and burn a retry over a field nobody scores on. Format checks
 *    live in `normalize-profile.js`, which nulls the bad field and keeps the
 *    rest. Dates are plain strings for the same reason -
 *    `compute-experience.js` parses them defensively and reports what it could
 *    not use.
 *
 * 2. **`skills[].evidenceType` is a two-value enum sitting next to an optional
 *    `evidenceQuote`.** Redundant on paper; in practice a model handed a free
 *    text field fills it, and a model handed an honest option picks it.
 *
 * 3. **`skills[].name` and `certifications[].name` are required and
 *    non-optional.** The rule is about facts the CV may not state; the name of a
 *    list entry is not one. An entry with no name should not have been emitted.
 *
 * 4. **Objects are `.strict()`.** An unknown key is a loud validation failure
 *    rather than a silently stripped one, which is what stops a model quietly
 *    inventing a field - most importantly a score.
 */

import { z } from 'zod';
import { EDUCATION_LEVELS, EVIDENCE_TYPES } from '../constants.js';

/**
 * How each variant says "the CV does not say this".
 *
 * One shape definition per entity, two ways of marking a field absent, so the
 * wire schema and the stored schema cannot drift apart on which fields exist -
 * only on how absence is spelled.
 *
 * @typedef {(schema: import('zod').ZodTypeAny) => import('zod').ZodTypeAny} AbsenceMarker
 */

/**
 * Model-facing: the key is simply not there, and an explicit `null` is read as
 * the same claim. No union, one optional, no retry over an equivalent encoding.
 *
 * @type {AbsenceMarker}
 */
const omitted = (schema) =>
  z.preprocess((value) => (value === null ? undefined : value), schema.optional());

/**
 * Stored: the key is always there and carries `null`.
 *
 * @type {AbsenceMarker}
 */
const empty = (schema) => schema.nullable();

/**
 * Model-facing: the array is always there. `[]` is "I looked and found none",
 * which invents nothing and costs neither budget.
 *
 * @type {AbsenceMarker}
 */
const always = (schema) => schema;

/**
 * The flat location fields the model fills in, mapped to their key on the nested
 * `location` object everything downstream reads.
 *
 * Exported because `normalize-profile.js` re-nests using this map. Two lists of
 * field names would agree right up until somebody added one.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const EXTRACTED_LOCATION_FIELDS = Object.freeze({
  locationCity: 'city',
  locationRegion: 'region',
  /** ISO-3166-1 alpha-2 if the model can determine one, else absent. */
  locationCountryCode: 'countryCode',
});

/**
 * @param {AbsenceMarker} absent
 * @returns {Record<string, import('zod').ZodTypeAny>}
 */
function locationShape(absent) {
  return {
    city: absent(z.string()),
    region: absent(z.string()),
    countryCode: absent(z.string()),
  };
}

/**
 * A date as the CV writes it. Deliberately unvalidated: "2019", "2019-03",
 * "March 2019" and "Present" all arrive intact, and `compute-experience.js`
 * decides what it can turn into months.
 *
 * @param {AbsenceMarker} absent
 */
function workExperienceShape(absent) {
  return {
    employer: absent(z.string()),
    title: absent(z.string()),
    startDate: absent(z.string()),
    /**
     * Absent means the role is ongoing, and it is the *only* way to say so since
     * `isCurrent` was deleted; the extraction prompt states the encoding in those
     * words, so the model is not left to guess which absence it is spelling.
     *
     * `compute-experience.js` honours that reading **only where the CV supports
     * it**: an open entry is closed at `now` when nothing else starts later, and
     * is otherwise treated as an extraction gap that makes
     * `computedYearsExperience` null rather than a decade of invented tenure.
     * See its header - that rule is the reason this field is worth getting right.
     */
    endDate: absent(z.string()),
    summary: absent(z.string()),
  };
}

/** @param {AbsenceMarker} absent */
function educationShape(absent) {
  return {
    institution: absent(z.string()),
    degree: absent(z.string()),
    field: absent(z.string()),
    /**
     * Mapped onto our ladder by the model, because the model is the thing that
     * knows "Diplom-Ingenieur" is a masters. Absent when it cannot tell, which
     * makes the education rule indeterminate rather than a rejection.
     */
    level: absent(z.enum(EDUCATION_LEVELS)),
    /** Graduation. The start of a course is read by nothing and was dropped. */
    endDate: absent(z.string()),
  };
}

/** @param {AbsenceMarker} absent */
function certificationShape(absent) {
  return {
    name: z.string().min(1),
    issuer: absent(z.string()),
    issuedDate: absent(z.string()),
    /** Absent means "no expiry stated", which is not the same as "does not expire". */
    expiryDate: absent(z.string()),
  };
}

/** @param {AbsenceMarker} absent */
function skillShape(absent) {
  return {
    name: z.string().min(1),
    evidenceType: z.enum(EVIDENCE_TYPES),
    /**
     * A verbatim span from the CV when `evidenceType` is `demonstrated`.
     * `verify-evidence.js` substring-matches it against the source text and
     * downgrades the skill when it does not appear. It is the only claim in the
     * system a machine can falsify, and it was explicitly excluded from the
     * field deletions above for exactly that reason.
     */
    evidenceQuote: absent(z.string()),
  };
}

/**
 * The profile's own fields, in the order everything downstream renders them.
 *
 * `normalize-profile.js` emits its keys in this order too, so the JSON handed to
 * the evaluation prompt is stable regardless of the order the model happened to
 * generate.
 *
 * @param {AbsenceMarker} absent how a scalar says "the CV does not say this"
 * @param {AbsenceMarker} listed how a list is marked: required on the wire,
 *   nullable in storage
 * @param {Record<string, import('zod').ZodTypeAny>} location one nested object
 *   when stored, three flat strings on the wire
 * @param {Record<string, import('zod').ZodTypeAny>} entry the list item schemas
 *   for this variant
 */
function profileShape(absent, listed, location, entry) {
  return {
    fullName: absent(z.string()),
    email: absent(z.string()),
    phone: absent(z.string()),
    linkedinUrl: absent(z.string()),
    ...location,
    /**
     * What the CV literally claims ("10+ years of experience"). The model never
     * computes years from dates - `compute-experience.js` does, from the work
     * history, and the elimination rules read only that. This field survives as
     * a discrepancy signal: "CV claims 10 years; dates support 6.5".
     */
    statedYearsExperience: absent(z.number()),
    workHistory: listed(z.array(entry.workExperience)),
    education: listed(z.array(entry.education)),
    certifications: listed(z.array(entry.certification)),
    skills: listed(z.array(entry.skill)),
  };
}

/* --------------------------------------------------- what goes on the wire */

const extractedWorkExperienceSchema = z.object(workExperienceShape(omitted)).strict();
const extractedEducationSchema = z.object(educationShape(omitted)).strict();
const extractedCertificationSchema = z.object(certificationShape(omitted)).strict();
const extractedSkillSchema = z.object(skillShape(omitted)).strict();

/**
 * Location, flattened.
 *
 * Nested, it was five union-typed parameters: one for the optional object
 * itself and one per field. Flat and optional it is zero unions, and the model
 * is spared having to decide whether to emit the container before it can emit a
 * city. `normalize-profile.js` puts it back together.
 */
const extractedLocationFields = Object.fromEntries(
  Object.keys(EXTRACTED_LOCATION_FIELDS).map((field) => [field, omitted(z.string())]),
);

/**
 * **The extraction output schema - what the response is validated against.**
 *
 * Zero union-typed parameters and twenty-two optional ones, which was under both
 * of the API's caps and still did not compile into a grammar in a usable time.
 * It is therefore no longer sent: extraction asks for this shape in the prompt
 * and this schema judges what comes back. See the postscript in the file header.
 */
export const extractedProfileSchema = z
  .object(
    profileShape(omitted, always, extractedLocationFields, {
      workExperience: extractedWorkExperienceSchema,
      education: extractedEducationSchema,
      certification: extractedCertificationSchema,
      skill: extractedSkillSchema,
    }),
  )
  .strict();

/* ------------------------------------------------------ what gets stored */

export const locationSchema = z.object(locationShape(empty)).strict();
export const workExperienceSchema = z.object(workExperienceShape(empty)).strict();
export const educationSchema = z.object(educationShape(empty)).strict();
export const certificationSchema = z.object(certificationShape(empty)).strict();
export const skillSchema = z.object(skillShape(empty)).strict();

/**
 * The profile as `normalize-profile.js` emits it and as everything downstream
 * reads it.
 *
 * Every field present and nullable. Never sent to the API - it is the storage
 * and interchange shape, so neither budget applies to it and the explicit `null`
 * that a database column, a dashboard cell and an elimination rule all want is
 * kept.
 *
 * **Every list stays nullable here even though the wire contract now requires
 * them.** `null` is "there is no such section in this profile at all" and `[]`
 * is "extraction looked and found nothing". The wire can no longer produce the
 * first, but `parsed_profile` is jsonb read by three other lanes and a profile
 * that reached it by any other route may still carry it. The elimination
 * evaluators treat both as an absent fact, because in practice an empty list is
 * far more often a parsing failure than a genuine emptiness - and decision 7-C
 * says the cost of a false `indeterminate` (a recruiter filters more) is much
 * lower than the cost of a false elimination.
 */
export const profileSchema = z
  .object(
    profileShape(empty, empty, { location: locationSchema.nullable() }, {
      workExperience: workExperienceSchema,
      education: educationSchema,
      certification: certificationSchema,
      skill: skillSchema,
    }),
  )
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
 * elimination evaluators read it: the normalized extraction plus the two facts
 * code derives from it.
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
 * @typedef {z.infer<typeof extractedProfileSchema>} ExtractedProfile
 * @typedef {z.infer<typeof profileSchema>} Profile
 * @typedef {z.infer<typeof verifiedProfileSchema>} VerifiedProfile
 * @typedef {z.infer<typeof skillSchema>} Skill
 * @typedef {z.infer<typeof verifiedSkillSchema>} VerifiedSkill
 * @typedef {z.infer<typeof workExperienceSchema>} WorkExperience
 * @typedef {z.infer<typeof educationSchema>} Education
 * @typedef {z.infer<typeof certificationSchema>} Certification
 */
