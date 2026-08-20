/**
 * The seam between the profile the model returns and the profile the system
 * stores. Two jobs, in this order:
 *
 * 1. **Fill.** Every field the model left out becomes `null`, and the three flat
 *    `location*` fields become the nested `location` object. After this step the
 *    profile satisfies `profileSchema`.
 * 2. **Repair.** Field-level checks the schema cannot express.
 *
 * ## Why there is a fill step at all
 *
 * `extractedProfileSchema` marks absence with an omitted key rather than an
 * explicit `null`, because a nullable field compiles to a union in the JSON
 * Schema and the API caps unions at sixteen - see the header of
 * `profile.schema.js` for that limit and for the second one, on optional
 * parameters, that decided which fields exist at all. Those are decisions about
 * the wire and nothing else: `elimination.js`, `verify-evidence.js`,
 * `compute-experience.js`, the evaluation prompt's profile rendering,
 * `screen-candidate.js`, the `parsed_profile` column and the dashboard all read
 * one shape, and this file is where it is produced.
 *
 * Filling is not repair and invents nothing. An absent key and an explicit
 * `null` are the same claim - "the CV does not say" - written two ways, and this
 * is where the second becomes the first.
 *
 * Keys are emitted in the order `profileShape` declares them rather than in
 * whatever order the model generated, so the JSON rendered into the evaluation
 * prompt is stable between two extractions of the same CV.
 *
 * ## Why there is a repair step at all
 *
 * A decision taken in `profile.schema.js`: `email` is a plain string rather than
 * `z.string().email()`. Validation at the schema boundary is all-or-nothing -
 * one mangled OCR address would null the entire extraction and burn a retry over
 * a field nobody scores on. So the schema accepts the string and this file
 * decides what to do with it, which is to null that one field and keep the other
 * forty.
 *
 * Every repair rule follows the same shape and it is worth stating once:
 *
 * > **A field that fails a check becomes `null`, and the failure is recorded.
 * > Nothing is repaired into a value it did not have.**
 *
 * Nulling is safe because the whole system already treats `null` as "we could
 * not tell" and decision 7-C forbids treating that as evidence of failure.
 * Guessing is not safe: an email repaired from `jane doe at acme.com` to
 * `jane.doe@acme.com` is an invented fact about a real person, and it looks
 * exactly like a real one.
 *
 * Pure, and total: no clock, no I/O, no throw. The output satisfies
 * `profileSchema`, which a test asserts, because the pipeline hands it straight
 * on to evidence verification.
 */

import { EXTRACTED_LOCATION_FIELDS } from '../schemas/profile.schema.js';
import { normalizeForMatch, normalizeWhitespace } from '../util/text.js';

/**
 * Deliberately loose. This is a plausibility check, not RFC 5322: something
 * before an `@`, something after it, and a dot in the domain. Its job is to
 * catch `see attached`, `jane.doe (at) acme.com` and a truncated OCR fragment,
 * not to adjudicate exotic-but-legal addresses. A stricter pattern would reject
 * real addresses, and the cost of that lands on a candidate.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** LinkedIn is the only profile URL the schema has a field for. */
const LINKEDIN_PATTERN = /(?:^|\.|\/\/)linkedin\.com\//i;

/** Enough digits to be a dialable number rather than an extension or a year. */
const MIN_PHONE_DIGITS = 7;

/** ISO-3166-1 alpha-2, which is what the location allowlist rule compares against. */
const COUNTRY_CODE_PATTERN = /^[A-Za-z]{2}$/;

/**
 * A stated total above this is not a career, it is a parsing artefact - a
 * salary, a postcode or a year read as a duration. 80 rather than 60 because the
 * point is to catch nonsense, not to adjudicate a long career.
 */
const MAX_PLAUSIBLE_STATED_YEARS = 80;

/**
 * @typedef {import('../schemas/profile.schema.js').Profile} Profile
 * @typedef {import('../schemas/profile.schema.js').ExtractedProfile} ExtractedProfile
 *
 * @typedef {object} NormalizationChange
 * @property {string} field dotted path, e.g. `email` or `skills[2].evidenceQuote`
 * @property {'nulled_invalid' | 'nulled_empty' | 'dropped_entry' | 'deduplicated'
 *   | 'normalized'} action
 * @property {string} [reason] why, in one word - never the offending value
 *
 * @typedef {object} NormalizationResult
 * @property {Profile} profile a copy; the input is never mutated
 * @property {NormalizationChange[]} changes every repair, for the logs
 */

/**
 * @param {string | null} value
 * @returns {string | null} trimmed, or null if there was nothing but whitespace
 */
function tidy(value) {
  if (value === null) {
    return null;
  }
  const trimmed = normalizeWhitespace(value);
  return trimmed === '' ? null : trimmed;
}

/**
 * An absent field and an explicit null are one claim written two ways.
 *
 * @template T
 * @param {T | undefined} value
 * @returns {T | null}
 */
function present(value) {
  return value === undefined ? null : value;
}

/**
 * Rebuilds the nested `location` from the three flat fields the model fills in.
 *
 * `null` when the model left all three out, which is the same answer the nested
 * shape used to give as an explicit `location: null`: the CV states no location
 * at all. One field present is enough to make the object real, because a city
 * with no country is an ordinary CV and decision 7-C wants the allowlist rule to
 * read that as indeterminate rather than as a rejection.
 *
 * @param {ExtractedProfile} extracted
 * @returns {Profile['location']}
 */
function nestLocation(extracted) {
  const flat = Object.keys(EXTRACTED_LOCATION_FIELDS);
  if (flat.every((field) => extracted[field] === undefined)) {
    return null;
  }

  return /** @type {Profile['location']} */ (
    Object.fromEntries(
      flat.map((field) => [EXTRACTED_LOCATION_FIELDS[field], present(extracted[field])]),
    )
  );
}

/**
 * Fills every absent field with `null` and re-nests the location, producing the
 * shape `profileSchema` describes.
 *
 * Written out field by field rather than spread from the input on purpose: the
 * spread would carry the flat `location*` keys through into a `.strict()` shape
 * that has no place for them, and it would leave the key order at the mercy of
 * whatever order the model generated.
 *
 * @param {ExtractedProfile} extracted
 * @returns {Profile}
 */
function fillAbsentFields(extracted) {
  return {
    fullName: present(extracted.fullName),
    email: present(extracted.email),
    phone: present(extracted.phone),
    linkedinUrl: present(extracted.linkedinUrl),
    location: nestLocation(extracted),
    statedYearsExperience: present(extracted.statedYearsExperience),
    workHistory: fillEntries(extracted.workHistory, (entry) => ({
      employer: present(entry.employer),
      title: present(entry.title),
      startDate: present(entry.startDate),
      endDate: present(entry.endDate),
      summary: present(entry.summary),
    })),
    education: fillEntries(extracted.education, (entry) => ({
      institution: present(entry.institution),
      degree: present(entry.degree),
      field: present(entry.field),
      level: present(entry.level),
      endDate: present(entry.endDate),
    })),
    certifications: fillEntries(extracted.certifications, (entry) => ({
      name: entry.name,
      issuer: present(entry.issuer),
      issuedDate: present(entry.issuedDate),
      expiryDate: present(entry.expiryDate),
    })),
    skills: fillEntries(extracted.skills, (entry) => ({
      name: entry.name,
      evidenceType: entry.evidenceType,
      evidenceQuote: present(entry.evidenceQuote),
    })),
  };
}

/**
 * A list the model left out becomes `null`, not `[]`.
 *
 * The wire schema now **requires** all four lists, so the model can no longer
 * leave one out: `[]` is how it says it looked and found nothing, and that was
 * the point of making them required - an empty array invents nothing and costs
 * neither of the API's two schema budgets.
 *
 * This branch survives anyway, and deliberately. It is what keeps the fill
 * total: `profileSchema` still allows a null list, because `null` ("there is no
 * such section in this profile at all") and `[]` ("extraction looked and found
 * nothing") are different claims and `parsed_profile` is read by three other
 * lanes. Collapsing an absent key to `[]` here would manufacture a claim the
 * model never made.
 *
 * @template T, U
 * @param {T[] | undefined} entries
 * @param {(entry: T) => U} fill
 * @returns {U[] | null}
 */
function fillEntries(entries, fill) {
  return entries === undefined ? null : entries.map(fill);
}

/**
 * Fills and normalizes a profile.
 *
 * @param {ExtractedProfile} extracted straight from `extractedProfileSchema`
 * @returns {NormalizationResult}
 */
export function normalizeProfile(extracted) {
  const profile = fillAbsentFields(extracted);

  /** @type {NormalizationChange[]} */
  const changes = [];

  /**
   * @param {string} field
   * @param {string | null} value
   * @returns {string | null}
   */
  const text = (field, value) => {
    const tidied = tidy(value);
    if (tidied === null && value !== null) {
      changes.push({ field, action: 'nulled_empty' });
    }
    return tidied;
  };

  const email = normalizeEmail(text('email', profile.email), changes);
  const phone = normalizePhone(text('phone', profile.phone), changes);
  const linkedinUrl = normalizeLinkedin(text('linkedinUrl', profile.linkedinUrl), changes);

  return {
    profile: {
      ...profile,
      fullName: text('fullName', profile.fullName),
      email,
      phone,
      linkedinUrl,
      location: normalizeLocation(profile.location, changes),
      statedYearsExperience: normalizeStatedYears(profile.statedYearsExperience, changes),
      workHistory: mapEntries(profile.workHistory, (entry, index) => ({
        ...entry,
        employer: text(`workHistory[${index}].employer`, entry.employer),
        title: text(`workHistory[${index}].title`, entry.title),
        startDate: text(`workHistory[${index}].startDate`, entry.startDate),
        endDate: text(`workHistory[${index}].endDate`, entry.endDate),
        summary: text(`workHistory[${index}].summary`, entry.summary),
      })),
      education: mapEntries(profile.education, (entry, index) => ({
        ...entry,
        institution: text(`education[${index}].institution`, entry.institution),
        degree: text(`education[${index}].degree`, entry.degree),
        field: text(`education[${index}].field`, entry.field),
        endDate: text(`education[${index}].endDate`, entry.endDate),
      })),
      certifications: normalizeNamedEntries(
        profile.certifications,
        'certifications',
        changes,
        (entry, index) => ({
          ...entry,
          issuer: text(`certifications[${index}].issuer`, entry.issuer),
          issuedDate: text(`certifications[${index}].issuedDate`, entry.issuedDate),
          expiryDate: text(`certifications[${index}].expiryDate`, entry.expiryDate),
        }),
      ),
      skills: normalizeSkills(profile.skills, changes),
    },
    changes,
  };
}

/**
 * `null` stays `null` and an array stays an array. The two are different answers
 * - "extraction found no such section" and "extraction looked and found nothing"
 * - and collapsing them here would undo a distinction the schema was shaped to
 * preserve.
 *
 * @template T
 * @param {T[] | null} entries
 * @param {(entry: T, index: number) => T} normalize
 * @returns {T[] | null}
 */
function mapEntries(entries, normalize) {
  return entries === null ? null : entries.map(normalize);
}

/**
 * @param {string | null} email
 * @param {NormalizationChange[]} changes
 * @returns {string | null}
 */
function normalizeEmail(email, changes) {
  if (email === null) {
    return null;
  }
  // Case-folded, because an address is not case-sensitive in practice and a
  // recruiter searching for one should not have to guess how the CV wrote it.
  const lowered = email.toLowerCase();
  if (!EMAIL_PATTERN.test(lowered)) {
    changes.push({ field: 'email', action: 'nulled_invalid', reason: 'not_an_address' });
    return null;
  }
  return lowered;
}

/**
 * @param {string | null} phone
 * @param {NormalizationChange[]} changes
 * @returns {string | null}
 */
function normalizePhone(phone, changes) {
  if (phone === null) {
    return null;
  }
  // Kept exactly as written apart from whitespace. Phone formatting is
  // international, inconsistent and nobody scores on it; the only question worth
  // asking is whether there are enough digits for this to be a number at all.
  const digits = phone.replace(/\D/g, '').length;
  if (digits < MIN_PHONE_DIGITS) {
    changes.push({ field: 'phone', action: 'nulled_invalid', reason: 'too_few_digits' });
    return null;
  }
  return phone;
}

/**
 * @param {string | null} url
 * @param {NormalizationChange[]} changes
 * @returns {string | null}
 */
function normalizeLinkedin(url, changes) {
  if (url === null) {
    return null;
  }
  if (!LINKEDIN_PATTERN.test(url)) {
    changes.push({ field: 'linkedinUrl', action: 'nulled_invalid', reason: 'not_a_linkedin_url' });
    return null;
  }
  return url;
}

/**
 * @param {import('../schemas/profile.schema.js').Profile['location']} location
 * @param {NormalizationChange[]} changes
 */
function normalizeLocation(location, changes) {
  if (location === null) {
    return null;
  }

  let countryCode = tidy(location.countryCode);
  if (countryCode !== null && !COUNTRY_CODE_PATTERN.test(countryCode)) {
    // The allowlist rule compares against ISO alpha-2 exactly. "United Kingdom"
    // in this field would silently never match, which is worse than an honest
    // null: a null makes the rule indeterminate and flags the candidate for a
    // human, and 7-C says that is the right failure.
    changes.push({
      field: 'location.countryCode',
      action: 'nulled_invalid',
      reason: 'not_iso_alpha_2',
    });
    countryCode = null;
  } else if (countryCode !== null) {
    countryCode = countryCode.toUpperCase();
  }

  return {
    city: tidy(location.city),
    region: tidy(location.region),
    countryCode,
  };
}

/**
 * @param {number | null} stated
 * @param {NormalizationChange[]} changes
 * @returns {number | null}
 */
function normalizeStatedYears(stated, changes) {
  if (stated === null) {
    return null;
  }
  if (!Number.isFinite(stated) || stated < 0 || stated > MAX_PLAUSIBLE_STATED_YEARS) {
    changes.push({
      field: 'statedYearsExperience',
      action: 'nulled_invalid',
      reason: 'implausible',
    });
    return null;
  }
  // One decimal, matching `computedYearsExperience`, so the discrepancy signal
  // compares like with like.
  return Math.round(stated * 10) / 10;
}

/**
 * Certifications, whose `name` the schema already requires to be non-empty - but
 * "  " passes `min(1)` and means nothing.
 *
 * @template {{ name: string }} T
 * @param {T[] | null} entries
 * @param {string} field
 * @param {NormalizationChange[]} changes
 * @param {(entry: T, index: number) => T} normalize
 * @returns {T[] | null}
 */
function normalizeNamedEntries(entries, field, changes, normalize) {
  if (entries === null) {
    return null;
  }

  /** @type {T[]} */
  const kept = [];
  entries.forEach((entry, index) => {
    const name = tidy(entry.name);
    if (name === null) {
      changes.push({ field: `${field}[${index}]`, action: 'dropped_entry', reason: 'blank_name' });
      return;
    }
    kept.push({ ...normalize(entry, index), name });
  });

  return kept;
}

/**
 * Skills, which get one rule the other lists do not: **duplicates are merged,
 * and the merge keeps the stronger evidence.**
 *
 * A CV that lists Python in a skills bar and again in a project bullet produces
 * two entries, one `listed_only` and one `demonstrated`. Left alone they would
 * both reach evaluation, where a `required_skill` rule with `mustBeDemonstrated`
 * could match whichever came first - so the same profile passes or fails on the
 * order the model happened to emit. Merging makes that order irrelevant.
 *
 * The merge only ever moves a skill *up*, and only on evidence the model
 * supplied for that same skill; it invents nothing. Verification still runs
 * afterwards, so a merged-in quote that is not in the CV is still downgraded.
 *
 * @param {import('../schemas/profile.schema.js').Skill[] | null} skills
 * @param {NormalizationChange[]} changes
 */
function normalizeSkills(skills, changes) {
  if (skills === null) {
    return null;
  }

  /** @type {Map<string, import('../schemas/profile.schema.js').Skill>} */
  const byName = new Map();

  skills.forEach((skill, index) => {
    const name = tidy(skill.name);
    if (name === null) {
      changes.push({ field: `skills[${index}]`, action: 'dropped_entry', reason: 'blank_name' });
      return;
    }

    // `listed_only` with a quote attached is a contradiction: the model chose the
    // weaker option and then supplied evidence for the stronger one. The choice
    // is authoritative and the quote goes, so that nothing downstream reads a
    // quote as proof of a demonstration the model did not claim.
    const demonstrated = skill.evidenceType === 'demonstrated';
    const quote = demonstrated ? tidy(skill.evidenceQuote) : null;
    if (!demonstrated && skill.evidenceQuote !== null) {
      changes.push({
        field: `skills[${index}].evidenceQuote`,
        action: 'nulled_invalid',
        reason: 'quote_without_demonstration',
      });
    }

    const key = normalizeForMatch(name);
    const existing = byName.get(key);
    if (existing === undefined) {
      byName.set(key, { ...skill, name, evidenceQuote: quote });
      return;
    }

    changes.push({ field: `skills[${index}]`, action: 'deduplicated' });
    if (demonstrated && existing.evidenceType !== 'demonstrated') {
      byName.set(key, { ...skill, name: existing.name, evidenceQuote: quote });
    }
  });

  return [...byName.values()];
}
