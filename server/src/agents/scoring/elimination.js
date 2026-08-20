/**
 * Hard requirements, evaluated in code against the extracted profile.
 *
 * The union of rule types is **closed**, in three places that a test asserts are
 * the same set: the CHECK constraint in migration 0003, the discriminated union
 * in `role.schema.js`, and the evaluator registry below. A rule type with no
 * evaluator cannot be stored, and an unknown type arriving here **throws**. It
 * never silently passes - "we could not check it" must never read as "they meet
 * the requirement".
 *
 * Every rule yields one of three outcomes, and the third is the point of the
 * design (plan section 7-C):
 *
 * - `pass` - the profile positively satisfies the requirement.
 * - `fail` - the profile positively contradicts it. This is the only outcome that
 *   eliminates by default.
 * - `indeterminate` - the fact the rule needs is not in the profile at all.
 *
 * Elimination requires **positive evidence of failure**. The alternative - absent
 * fact means rejection - silently drops every image-only, two-column and
 * non-English CV into the bottom tier, where no human ever looks. That is a
 * discrimination pattern with a purely technical cause. The accepted cost is that
 * unqualified candidates reach tier 2 and recruiters filter more.
 *
 * Per-rule `on_missing: 'eliminate'` is the opt-out, for requirements where "we
 * could not tell" genuinely has to mean no - a licence, a work authorisation.
 * That is a recruiter's decision, made per rule, not a default.
 *
 * An empty list counts as an absent fact. A profile whose `skills` array came
 * back empty is far more often a parsing failure than a person with no skills,
 * and by the argument above the benefit of the doubt goes to the candidate.
 */

import {
  EDUCATION_LEVELS,
  ELIMINATION_RULE_TYPES,
  MONTHS_PER_YEAR,
} from '../constants.js';
import { InvalidRoleError, UnknownRuleTypeError } from '../errors.js';
import { ELIMINATION_RULE_VALUE_SCHEMAS } from '../schemas/role.schema.js';
import { explainMissingExperience, parseCvDate } from '../extraction/compute-experience.js';
import { containsTokenSequence, equalsExact } from '../util/text.js';

/**
 * @typedef {import('../schemas/profile.schema.js').VerifiedProfile} VerifiedProfile
 * @typedef {import('../schemas/role.schema.js').EliminationRule} EliminationRule
 * @typedef {import('../constants.js').RuleOutcome} RuleOutcome
 *
 * @typedef {object} RuleEvaluation
 * @property {RuleOutcome} outcome
 * @property {string} detail one line, recruiter-readable, safe to store and log
 *
 * @typedef {object} RuleResult
 * @property {string} ruleId
 * @property {string} label
 * @property {string} type
 * @property {import('../constants.js').OnMissing} onMissing
 * @property {RuleOutcome} outcome
 * @property {string} detail
 * @property {boolean} eliminates whether THIS rule removes the candidate
 *
 * @typedef {object} EliminationReport
 * @property {boolean} eliminated
 * @property {string | null} eliminatedBy label of the first eliminating rule
 * @property {RuleResult[]} results every rule, in the order given
 * @property {RuleResult[]} failures outcome === 'fail'
 * @property {RuleResult[]} indeterminate outcome === 'indeterminate', both on_missing modes
 */

/**
 * @param {unknown} list
 * @returns {boolean} true when the fact this list represents is simply absent
 */
function isAbsentList(list) {
  return !Array.isArray(list) || list.length === 0;
}

/**
 * @param {string} candidate a value from the profile
 * @param {string} target the value the rule asks for
 * @param {import('../constants.js').MatchMode} matchMode
 * @returns {boolean}
 */
function matchesName(candidate, target, matchMode) {
  // `exact` is a trimmed, case-sensitive equality: the recruiter typed the string
  // they want and does not want it interpreted. `normalized` matches on whole
  // token boundaries, so "PostgreSQL" matches "PostgreSQL administration" but
  // "Java" does not match "JavaScript".
  return matchMode === 'exact'
    ? equalsExact(candidate, target)
    : containsTokenSequence(candidate, target);
}

/**
 * @param {string | null} expiryDate
 * @param {Date} now
 * @returns {boolean} true only when the CV positively says the credential has lapsed
 */
function isExpired(expiryDate, now) {
  if (expiryDate === null) {
    // No stated expiry is not evidence of expiry.
    return false;
  }

  const parsed = parseCvDate(expiryDate);
  if (parsed === null) {
    // An unparseable expiry date cannot falsify anything either.
    return false;
  }

  // Year-only expiry is read as the end of that year, and the comparison is at
  // month granularity, so a credential expiring this month is still current.
  const expiryIndex = parsed.year * MONTHS_PER_YEAR + ((parsed.month ?? MONTHS_PER_YEAR) - 1);
  const nowIndex = now.getUTCFullYear() * MONTHS_PER_YEAR + now.getUTCMonth();
  return expiryIndex < nowIndex;
}

/**
 * The registry. Null-prototype so that a rule type of `constructor` or
 * `toString` resolves to nothing and throws, rather than finding an inherited
 * property and being called.
 *
 * @type {Record<string, (profile: VerifiedProfile, value: any, ctx: { now: Date }) => RuleEvaluation>}
 */
export const ELIMINATION_RULE_EVALUATORS = Object.freeze(
  Object.assign(Object.create(null), {
    /**
     * Reads `computedYearsExperience` - derived from dates by
     * `compute-experience.js` - and never `statedYearsExperience`. The claim on
     * the CV is not the fact.
     *
     * A null computed value is an **unknown fact**, not a zero, and takes the
     * 7-C path like every other unknown: `indeterminate`, and `on_missing`
     * decides. The detail says so in words and then says *why*, naming the entry
     * responsible - because "we could not tell" with no cause attached is a
     * badge a recruiter cannot act on. `explainMissingExperience` is pure and
     * takes the same injected `now`.
     */
    min_years_experience(profile, value, { now }) {
      const years = profile.computedYearsExperience;
      if (typeof years !== 'number') {
        return {
          outcome: 'indeterminate',
          detail: `years of experience could not be determined from the CV: ${explainMissingExperience(profile.workHistory, { now })} (rule asks for ${value.years} years)`,
        };
      }

      return years >= value.years
        ? { outcome: 'pass', detail: `${years} years computed from dates, minimum ${value.years}` }
        : { outcome: 'fail', detail: `${years} years computed from dates, minimum ${value.years}` };
    },

    required_skill(profile, value) {
      if (isAbsentList(profile.skills)) {
        return {
          outcome: 'indeterminate',
          detail: `no skills were extracted, so "${value.skill}" could not be checked`,
        };
      }

      const matches = /** @type {import('../schemas/profile.schema.js').VerifiedSkill[]} */ (
        profile.skills
      ).filter((skill) => matchesName(skill.name, value.skill, value.matchMode));

      if (matches.length === 0) {
        return { outcome: 'fail', detail: `no skill matching "${value.skill}"` };
      }

      if (!value.mustBeDemonstrated) {
        return { outcome: 'pass', detail: `skill "${matches[0].name}" is listed` };
      }

      // `evidenceType` here is post-verification: `verify-evidence.js` has already
      // downgraded any `demonstrated` claim whose quote is not in the CV. This is
      // the payoff for that work.
      const demonstrated = matches.find((skill) => skill.evidenceType === 'demonstrated');
      return demonstrated === undefined
        ? {
            outcome: 'fail',
            detail: `skill "${matches[0].name}" is listed but never shown being used`,
          }
        : { outcome: 'pass', detail: `skill "${demonstrated.name}" is demonstrated in the CV` };
    },

    required_education_level(profile, value) {
      if (isAbsentList(profile.education)) {
        return {
          outcome: 'indeterminate',
          detail: `no education was extracted, so "${value.level}" could not be checked`,
        };
      }

      const ranks = /** @type {import('../schemas/profile.schema.js').Education[]} */ (
        profile.education
      )
        .map((entry) => (entry.level === null ? -1 : EDUCATION_LEVELS.indexOf(entry.level)))
        .filter((rank) => rank >= 0);

      if (ranks.length === 0) {
        return {
          outcome: 'indeterminate',
          detail: 'education is listed but none of it maps to a known level',
        };
      }

      const highestRank = Math.max(...ranks);
      const highest = EDUCATION_LEVELS[highestRank];
      const requiredRank = EDUCATION_LEVELS.indexOf(value.level);

      return highestRank >= requiredRank
        ? { outcome: 'pass', detail: `highest education ${highest}, minimum ${value.level}` }
        : { outcome: 'fail', detail: `highest education ${highest}, minimum ${value.level}` };
    },

    required_certification(profile, value, { now }) {
      if (isAbsentList(profile.certifications)) {
        return {
          outcome: 'indeterminate',
          detail: `no certifications were extracted, so "${value.name}" could not be checked`,
        };
      }

      const matches = /** @type {import('../schemas/profile.schema.js').Certification[]} */ (
        profile.certifications
      ).filter((certification) => matchesName(certification.name, value.name, value.matchMode));

      if (matches.length === 0) {
        return { outcome: 'fail', detail: `no certification matching "${value.name}"` };
      }

      // An expiry date the CV states and that has passed is positive evidence the
      // credential is not currently held - which is what a rule named "current RN
      // licence" is actually asking. An absent or unreadable expiry date is not.
      const current = matches.find((certification) => !isExpired(certification.expiryDate, now));
      return current === undefined
        ? {
            outcome: 'fail',
            detail: `certification "${matches[0].name}" expired on ${matches[0].expiryDate}`,
          }
        : { outcome: 'pass', detail: `certification "${current.name}" is held` };
    },

    location_allowlist(profile, value) {
      const countryCode = profile.location === null ? null : profile.location.countryCode;
      if (typeof countryCode !== 'string' || countryCode.trim().length === 0) {
        return {
          outcome: 'indeterminate',
          detail: `no country could be determined from the CV (allowed: ${value.countryCodes.join(', ')})`,
        };
      }

      const normalized = countryCode.trim().toUpperCase();
      return value.countryCodes.includes(normalized)
        ? { outcome: 'pass', detail: `location ${normalized} is allowed` }
        : {
            outcome: 'fail',
            detail: `location ${normalized} is not in ${value.countryCodes.join(', ')}`,
          };
    },
  }),
);

/**
 * @param {VerifiedProfile} profile
 * @param {EliminationRule} rule
 * @param {{ now: Date }} ctx
 * @returns {RuleEvaluation}
 */
function evaluateRule(profile, rule, ctx) {
  const evaluator = ELIMINATION_RULE_EVALUATORS[rule.type];
  if (typeof evaluator !== 'function') {
    throw new UnknownRuleTypeError(rule.type, ELIMINATION_RULE_TYPES);
  }

  // The value is re-validated against the schema for its own type rather than
  // trusted. It is jsonb in the database, so nothing between the role form and
  // here guarantees its shape, and a predicate comparing against `undefined`
  // would quietly return false - which for an elimination rule means rejecting
  // somebody because of a typo in a config field.
  const parsed = ELIMINATION_RULE_VALUE_SCHEMAS[rule.type].safeParse(rule.value);
  if (!parsed.success) {
    throw new InvalidRoleError(`elimination rule "${rule.label}" has a malformed value`, {
      ruleId: rule.id,
      type: rule.type,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  return evaluator(profile, parsed.data, ctx);
}

/**
 * Evaluates every rule for a role against one profile.
 *
 * @param {VerifiedProfile} profile the verified profile, carrying `computedYearsExperience`
 * @param {EliminationRule[]} rules the role rules, in the role order
 * @param {object} params
 * @param {Date} params.now injected; used to decide whether a stated expiry has passed
 * @returns {EliminationReport}
 * @throws {UnknownRuleTypeError} a rule type with no evaluator
 * @throws {InvalidRoleError} a rule whose value does not match its type
 * @throws {TypeError} a missing profile, rule list or clock
 */
export function evaluateEliminationRules(profile, rules, { now } = /** @type {any} */ ({})) {
  if (profile === null || typeof profile !== 'object') {
    throw new TypeError('evaluateEliminationRules requires a profile object');
  }
  if (!Array.isArray(rules)) {
    throw new TypeError('evaluateEliminationRules requires an array of rules');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('evaluateEliminationRules requires an injected `now` Date');
  }

  const results = rules.map((rule) => {
    const { outcome, detail } = evaluateRule(profile, rule, { now });
    return {
      ruleId: rule.id,
      label: rule.label,
      type: rule.type,
      onMissing: rule.onMissing,
      outcome,
      detail,
      // A failure always eliminates. An indeterminate eliminates only where the
      // recruiter said it should - decision 7-C, made per rule.
      eliminates: outcome === 'fail' || (outcome === 'indeterminate' && rule.onMissing === 'eliminate'),
    };
  });

  const eliminatingRule = results.find((result) => result.eliminates);

  return {
    eliminated: eliminatingRule !== undefined,
    // The first eliminating rule in the role order, which is what
    // `candidates.eliminated_by` shows under the candidate name. Deterministic
    // because the role order is deterministic.
    eliminatedBy: eliminatingRule === undefined ? null : eliminatingRule.label,
    results,
    failures: results.filter((result) => result.outcome === 'fail'),
    // Every indeterminate, whichever on_missing mode it carries. The badge says
    // "unchecked", and the recruiter needs to see it whether or not it also
    // eliminated.
    indeterminate: results.filter((result) => result.outcome === 'indeterminate'),
  };
}
