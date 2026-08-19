import { describe, expect, it } from 'vitest';
import {
  ELIMINATION_RULE_EVALUATORS,
  evaluateEliminationRules,
} from '../../src/agents/scoring/elimination.js';
import { InvalidRoleError, UnknownRuleTypeError } from '../../src/agents/errors.js';

/**
 * Elimination is the only mechanism in the system that can reject a candidate
 * outright, so the tests are organised around the thing that matters most:
 * which inputs produce `fail` (positive evidence of not meeting a requirement)
 * and which produce `indeterminate` (the fact is simply not there). Getting that
 * line wrong is what turns a badly-parsed CV into a rejection, which is the
 * failure mode decision 7-C exists to prevent.
 */

const NOW = new Date('2026-03-15T00:00:00Z');

/**
 * @param {Partial<Record<string, any>>} overrides
 */
function profileWith(overrides) {
  return {
    fullName: null,
    email: null,
    phone: null,
    linkedinUrl: null,
    location: null,
    headline: null,
    summary: null,
    statedYearsExperience: null,
    workHistory: null,
    education: null,
    certifications: null,
    skills: null,
    computedYearsExperience: null,
    ...overrides,
  };
}

/**
 * @param {string} type
 * @param {Record<string, any>} value
 * @param {'flag' | 'eliminate'} [onMissing]
 */
function rule(type, value, onMissing = 'flag') {
  return { id: `rule-${type}`, label: `rule for ${type}`, type, value, onMissing, position: 0 };
}

/**
 * @param {Record<string, any>} profile
 * @param {Record<string, any>} eliminationRule
 */
function evaluateOne(profile, eliminationRule) {
  return evaluateEliminationRules(profile, [eliminationRule], { now: NOW }).results[0];
}

/**
 * @param {string} name
 * @param {Partial<Record<string, any>>} [overrides]
 */
function skill(name, overrides = {}) {
  return { name, evidenceType: 'listed_only', evidenceQuote: null, ...overrides };
}

describe('min_years_experience', () => {
  const fiveYears = rule('min_years_experience', { years: 5 });

  it('passes when the computed years meet the minimum', () => {
    const result = evaluateOne(profileWith({ computedYearsExperience: 5 }), fiveYears);
    expect(result.outcome).toBe('pass');
    expect(result.detail).toContain('minimum 5');
  });

  it('fails when the computed years fall short', () => {
    const result = evaluateOne(profileWith({ computedYearsExperience: 4.9 }), fiveYears);
    expect(result.outcome).toBe('fail');
  });

  it('is indeterminate when no dates could be resolved', () => {
    const result = evaluateOne(profileWith({ computedYearsExperience: null }), fiveYears);
    expect(result.outcome).toBe('indeterminate');
    expect(result.detail).toContain('no usable employment dates');
  });

  it('reads the computed value, never what the CV claims', () => {
    // The CV says fifteen years; the dates support none. The rule must not see
    // the claim.
    const profile = profileWith({ statedYearsExperience: 15, computedYearsExperience: null });
    expect(evaluateOne(profile, fiveYears).outcome).toBe('indeterminate');
  });
});

describe('required_skill', () => {
  const demonstratedPostgres = rule('required_skill', {
    skill: 'PostgreSQL',
    matchMode: 'normalized',
    mustBeDemonstrated: true,
  });
  const listedPostgres = rule('required_skill', {
    skill: 'PostgreSQL',
    matchMode: 'normalized',
    mustBeDemonstrated: false,
  });

  it('is indeterminate when no skills were extracted', () => {
    expect(evaluateOne(profileWith({ skills: null }), listedPostgres).outcome).toBe(
      'indeterminate',
    );
  });

  it('treats an empty skills list as absent, not as evidence of absence', () => {
    const result = evaluateOne(profileWith({ skills: [] }), listedPostgres);
    expect(result.outcome).toBe('indeterminate');
    expect(result.detail).toContain('no skills were extracted');
  });

  it('fails when the skill is genuinely not in a populated list', () => {
    const profile = profileWith({ skills: [skill('MySQL'), skill('Redis')] });
    expect(evaluateOne(profile, listedPostgres).outcome).toBe('fail');
  });

  it('passes on a listed skill when demonstration is not required', () => {
    const profile = profileWith({ skills: [skill('PostgreSQL')] });
    const result = evaluateOne(profile, listedPostgres);
    expect(result.outcome).toBe('pass');
    expect(result.detail).toContain('is listed');
  });

  it('fails a listed-only skill when the rule demands demonstration', () => {
    const profile = profileWith({ skills: [skill('PostgreSQL')] });
    const result = evaluateOne(profile, demonstratedPostgres);
    expect(result.outcome).toBe('fail');
    expect(result.detail).toContain('never shown being used');
  });

  it('passes when at least one match is demonstrated', () => {
    const profile = profileWith({
      skills: [
        skill('PostgreSQL tuning'),
        skill('PostgreSQL', { evidenceType: 'demonstrated', evidenceQuote: 'ran the migration' }),
      ],
    });
    expect(evaluateOne(profile, demonstratedPostgres).outcome).toBe('pass');
  });

  describe('matching', () => {
    it('matches on whole tokens under normalized mode', () => {
      const profile = profileWith({ skills: [skill('PostgreSQL administration')] });
      expect(evaluateOne(profile, listedPostgres).outcome).toBe('pass');
    });

    it('does not match a substring across a token boundary', () => {
      // The classic false positive: "Java" must not be found inside "JavaScript".
      const javaRule = rule('required_skill', {
        skill: 'Java',
        matchMode: 'normalized',
        mustBeDemonstrated: false,
      });
      const profile = profileWith({ skills: [skill('JavaScript')] });
      expect(evaluateOne(profile, javaRule).outcome).toBe('fail');
    });

    it('folds case and unicode dashes under normalized mode', () => {
      const ciRule = rule('required_skill', {
        skill: 'CI/CD',
        matchMode: 'normalized',
        mustBeDemonstrated: false,
      });
      const profile = profileWith({ skills: [skill('ci–cd pipelines')] });
      expect(evaluateOne(profile, ciRule).outcome).toBe('pass');
    });

    it('requires the string as typed under exact mode', () => {
      const exactRule = rule('required_skill', {
        skill: 'PostgreSQL',
        matchMode: 'exact',
        mustBeDemonstrated: false,
      });

      expect(evaluateOne(profileWith({ skills: [skill('postgresql')] }), exactRule).outcome).toBe(
        'fail',
      );
      expect(
        evaluateOne(profileWith({ skills: [skill('PostgreSQL')] }), exactRule).outcome,
      ).toBe('pass');
      expect(
        evaluateOne(profileWith({ skills: [skill('  PostgreSQL  ')] }), exactRule).outcome,
      ).toBe('pass');
    });
  });
});

describe('required_education_level', () => {
  const bachelors = rule('required_education_level', { level: 'bachelors' });

  /**
   * @param {string | null} level
   */
  function education(level) {
    return {
      institution: 'A University',
      degree: null,
      field: null,
      level,
      startDate: null,
      endDate: null,
    };
  }

  it('is indeterminate when no education was extracted', () => {
    expect(evaluateOne(profileWith({ education: null }), bachelors).outcome).toBe('indeterminate');
  });

  it('is indeterminate for an empty education list', () => {
    expect(evaluateOne(profileWith({ education: [] }), bachelors).outcome).toBe('indeterminate');
  });

  it('is indeterminate when education is listed but no level could be mapped', () => {
    const result = evaluateOne(profileWith({ education: [education(null)] }), bachelors);
    expect(result.outcome).toBe('indeterminate');
    expect(result.detail).toContain('none of it maps to a known level');
  });

  it('compares on the ordered ladder, using the highest qualification', () => {
    const profile = profileWith({
      education: [education('high_school'), education('masters'), education(null)],
    });
    const result = evaluateOne(profile, bachelors);
    expect(result.outcome).toBe('pass');
    expect(result.detail).toContain('highest education masters');
  });

  it('passes on an exact match of the required level', () => {
    expect(
      evaluateOne(profileWith({ education: [education('bachelors')] }), bachelors).outcome,
    ).toBe('pass');
  });

  it('fails when the highest level is below the requirement', () => {
    const result = evaluateOne(profileWith({ education: [education('associate')] }), bachelors);
    expect(result.outcome).toBe('fail');
    expect(result.detail).toContain('highest education associate');
  });

  it('orders the whole ladder correctly', () => {
    const ladder = ['none', 'high_school', 'associate', 'bachelors', 'masters', 'doctorate'];

    ladder.forEach((required, requiredIndex) => {
      ladder.forEach((held, heldIndex) => {
        const result = evaluateOne(
          profileWith({ education: [education(held)] }),
          rule('required_education_level', { level: required }),
        );
        expect(result.outcome).toBe(heldIndex >= requiredIndex ? 'pass' : 'fail');
      });
    });
  });
});

describe('required_certification', () => {
  const acls = rule('required_certification', {
    name: 'Advanced Cardiovascular Life Support',
    matchMode: 'normalized',
  });

  /**
   * @param {string} name
   * @param {string | null} [expiryDate]
   */
  function certification(name, expiryDate = null) {
    return { name, issuer: null, issuedDate: null, expiryDate };
  }

  it('is indeterminate when no certifications were extracted', () => {
    expect(evaluateOne(profileWith({ certifications: null }), acls).outcome).toBe('indeterminate');
  });

  it('is indeterminate for an empty certification list', () => {
    expect(evaluateOne(profileWith({ certifications: [] }), acls).outcome).toBe('indeterminate');
  });

  it('fails when a populated list does not contain it', () => {
    const profile = profileWith({ certifications: [certification('Basic Life Support')] });
    expect(evaluateOne(profile, acls).outcome).toBe('fail');
  });

  it('passes on a normalized name match', () => {
    const profile = profileWith({
      certifications: [certification('advanced cardiovascular life support (ACLS)')],
    });
    expect(evaluateOne(profile, acls).outcome).toBe('pass');
  });

  it('passes when the expiry date has not been reached', () => {
    const profile = profileWith({ certifications: [certification('ACLS', '2027-01')] });
    const result = evaluateOne(
      profile,
      rule('required_certification', { name: 'ACLS', matchMode: 'normalized' }),
    );
    expect(result.outcome).toBe('pass');
  });

  it('treats a credential that expired as not held', () => {
    const profile = profileWith({ certifications: [certification('ACLS', '2024-06')] });
    const result = evaluateOne(
      profile,
      rule('required_certification', { name: 'ACLS', matchMode: 'normalized' }),
    );
    expect(result.outcome).toBe('fail');
    expect(result.detail).toContain('expired on 2024-06');
  });

  it('counts the month of expiry itself as still current', () => {
    const profile = profileWith({ certifications: [certification('ACLS', '2026-03')] });
    expect(
      evaluateOne(profile, rule('required_certification', { name: 'ACLS', matchMode: 'normalized' }))
        .outcome,
    ).toBe('pass');
  });

  it('reads a year-only expiry as the end of that year', () => {
    const current = profileWith({ certifications: [certification('ACLS', '2026')] });
    const lapsed = profileWith({ certifications: [certification('ACLS', '2025')] });
    const acronym = rule('required_certification', { name: 'ACLS', matchMode: 'normalized' });

    expect(evaluateOne(current, acronym).outcome).toBe('pass');
    expect(evaluateOne(lapsed, acronym).outcome).toBe('fail');
  });

  it('does not treat an unstated or unreadable expiry as expiry', () => {
    const acronym = rule('required_certification', { name: 'ACLS', matchMode: 'normalized' });

    expect(
      evaluateOne(profileWith({ certifications: [certification('ACLS', null)] }), acronym).outcome,
    ).toBe('pass');
    expect(
      evaluateOne(profileWith({ certifications: [certification('ACLS', 'renews annually')] }), acronym)
        .outcome,
    ).toBe('pass');
  });

  it('prefers a current credential over a lapsed duplicate', () => {
    const profile = profileWith({
      certifications: [certification('ACLS', '2024-01'), certification('ACLS', '2028-01')],
    });
    expect(
      evaluateOne(profile, rule('required_certification', { name: 'ACLS', matchMode: 'normalized' }))
        .outcome,
    ).toBe('pass');
  });

  it('supports exact matching', () => {
    const exact = rule('required_certification', { name: 'ACLS', matchMode: 'exact' });
    expect(
      evaluateOne(profileWith({ certifications: [certification('acls')] }), exact).outcome,
    ).toBe('fail');
    expect(
      evaluateOne(profileWith({ certifications: [certification('ACLS')] }), exact).outcome,
    ).toBe('pass');
  });
});

describe('location_allowlist', () => {
  const allowlist = rule('location_allowlist', { countryCodes: ['GB', 'IE', 'DE'] });

  /**
   * @param {string | null} countryCode
   */
  function location(countryCode) {
    return { raw: null, city: null, region: null, countryCode };
  }

  it('is indeterminate when there is no location at all', () => {
    const result = evaluateOne(profileWith({ location: null }), allowlist);
    expect(result.outcome).toBe('indeterminate');
    expect(result.detail).toContain('GB, IE, DE');
  });

  it('is indeterminate when the location has no country code', () => {
    expect(evaluateOne(profileWith({ location: location(null) }), allowlist).outcome).toBe(
      'indeterminate',
    );
  });

  it('is indeterminate for a blank country code', () => {
    expect(evaluateOne(profileWith({ location: location('   ') }), allowlist).outcome).toBe(
      'indeterminate',
    );
  });

  it('passes for a member of the allowlist, whatever the case', () => {
    expect(evaluateOne(profileWith({ location: location('de') }), allowlist).outcome).toBe('pass');
    expect(evaluateOne(profileWith({ location: location(' GB ') }), allowlist).outcome).toBe('pass');
  });

  it('fails for a country that is not on it', () => {
    const result = evaluateOne(profileWith({ location: location('US') }), allowlist);
    expect(result.outcome).toBe('fail');
    expect(result.detail).toContain('US is not in GB, IE, DE');
  });
});

describe('evaluateEliminationRules', () => {
  it('eliminates on a failure', () => {
    const report = evaluateEliminationRules(
      profileWith({ computedYearsExperience: 2 }),
      [rule('min_years_experience', { years: 5 })],
      { now: NOW },
    );

    expect(report.eliminated).toBe(true);
    expect(report.eliminatedBy).toBe('rule for min_years_experience');
    expect(report.failures).toHaveLength(1);
    expect(report.indeterminate).toHaveLength(0);
  });

  it('does not eliminate on an indeterminate rule by default', () => {
    const report = evaluateEliminationRules(
      profileWith({}),
      [rule('min_years_experience', { years: 5 })],
      { now: NOW },
    );

    expect(report.eliminated).toBe(false);
    expect(report.eliminatedBy).toBeNull();
    expect(report.indeterminate).toHaveLength(1);
    expect(report.results[0].eliminates).toBe(false);
  });

  it('eliminates on an indeterminate rule when the recruiter opted in', () => {
    const report = evaluateEliminationRules(
      profileWith({}),
      [rule('location_allowlist', { countryCodes: ['GB'] }, 'eliminate')],
      { now: NOW },
    );

    expect(report.eliminated).toBe(true);
    expect(report.eliminatedBy).toBe('rule for location_allowlist');
    // Still reported as indeterminate: the candidate was not shown to fail, and
    // the badge has to say "unchecked" rather than "rejected on the evidence".
    expect(report.indeterminate).toHaveLength(1);
    expect(report.failures).toHaveLength(0);
  });

  it('names the first eliminating rule in the role order', () => {
    const rules = [
      { ...rule('min_years_experience', { years: 1 }), id: 'r1', label: 'first', position: 0 },
      { ...rule('location_allowlist', { countryCodes: ['GB'] }), id: 'r2', label: 'second', position: 1 },
      { ...rule('required_education_level', { level: 'masters' }), id: 'r3', label: 'third', position: 2 },
    ];
    const profile = profileWith({
      computedYearsExperience: 10,
      location: { raw: null, city: null, region: null, countryCode: 'US' },
      education: [
        { institution: null, degree: null, field: null, level: 'bachelors', startDate: null, endDate: null },
      ],
    });

    const report = evaluateEliminationRules(profile, rules, { now: NOW });

    expect(report.eliminated).toBe(true);
    expect(report.eliminatedBy).toBe('second');
    expect(report.failures.map((failure) => failure.label)).toEqual(['second', 'third']);
  });

  it('returns a clean report for a role with no rules', () => {
    const report = evaluateEliminationRules(profileWith({}), [], { now: NOW });

    expect(report).toEqual({
      eliminated: false,
      eliminatedBy: null,
      results: [],
      failures: [],
      indeterminate: [],
    });
  });

  it('carries every rule into results, whatever the outcome', () => {
    const report = evaluateEliminationRules(
      profileWith({ computedYearsExperience: 10 }),
      [rule('min_years_experience', { years: 5 }), rule('required_certification', { name: 'ACLS', matchMode: 'exact' })],
      { now: NOW },
    );

    expect(report.results.map((result) => result.outcome)).toEqual(['pass', 'indeterminate']);
    expect(report.results[0]).toMatchObject({
      ruleId: 'rule-min_years_experience',
      type: 'min_years_experience',
      onMissing: 'flag',
      eliminates: false,
    });
  });

  describe('the closed union', () => {
    it('throws on a rule type with no evaluator', () => {
      let thrown;
      try {
        evaluateEliminationRules(profileWith({}), [rule('required_language', { language: 'de' })], {
          now: NOW,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UnknownRuleTypeError);
      expect(thrown.code).toBe('AGENT_UNKNOWN_RULE');
      expect(thrown.type).toBe('required_language');
      expect(thrown.details.knownTypes).toContain('min_years_experience');
    });

    it('never lets an unknown rule pass silently', () => {
      // The whole point: an unchecked hard requirement must not read as a met one.
      expect(() =>
        evaluateEliminationRules(profileWith({}), [rule('anything_at_all', {})], { now: NOW }),
      ).toThrow(UnknownRuleTypeError);
    });

    it('does not resolve inherited object properties as evaluators', () => {
      expect(() =>
        evaluateEliminationRules(profileWith({}), [rule('constructor', {})], { now: NOW }),
      ).toThrow(UnknownRuleTypeError);
      expect(() =>
        evaluateEliminationRules(profileWith({}), [rule('toString', {})], { now: NOW }),
      ).toThrow(UnknownRuleTypeError);
    });
  });

  describe('a rule whose value does not match its type', () => {
    it('throws rather than comparing against undefined', () => {
      let thrown;
      try {
        evaluateEliminationRules(
          profileWith({ computedYearsExperience: 10 }),
          [rule('min_years_experience', { yearz: 5 })],
          { now: NOW },
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(InvalidRoleError);
      expect(thrown.code).toBe('AGENT_INVALID_ROLE');
      expect(thrown.details.type).toBe('min_years_experience');
      expect(thrown.details.issues.length).toBeGreaterThan(0);
    });

    it('rejects an out-of-range value', () => {
      expect(() =>
        evaluateEliminationRules(profileWith({}), [rule('min_years_experience', { years: 61 })], {
          now: NOW,
        }),
      ).toThrow(InvalidRoleError);
    });

    it('rejects a country code that is not ISO alpha-2', () => {
      expect(() =>
        evaluateEliminationRules(
          profileWith({}),
          [rule('location_allowlist', { countryCodes: ['United Kingdom'] })],
          { now: NOW },
        ),
      ).toThrow(InvalidRoleError);
    });
  });

  describe('programmer errors', () => {
    it('requires a profile object', () => {
      expect(() => evaluateEliminationRules(null, [], { now: NOW })).toThrow(
        /requires a profile object/,
      );
      expect(() => evaluateEliminationRules(/** @type {any} */ ('nope'), [], { now: NOW })).toThrow(
        TypeError,
      );
    });

    it('requires an array of rules', () => {
      expect(() =>
        evaluateEliminationRules(profileWith({}), /** @type {any} */ (null), { now: NOW }),
      ).toThrow(/array of rules/);
    });

    it('requires an injected clock', () => {
      expect(() => evaluateEliminationRules(profileWith({}), [])).toThrow(/injected `now` Date/);
      expect(() =>
        evaluateEliminationRules(profileWith({}), [], { now: /** @type {any} */ ('2026-03-15') }),
      ).toThrow(TypeError);
      expect(() => evaluateEliminationRules(profileWith({}), [], { now: new Date('nonsense') })).toThrow(
        TypeError,
      );
    });
  });

  it('exposes the evaluator registry for the closed-union test', () => {
    expect(Object.keys(ELIMINATION_RULE_EVALUATORS).sort()).toEqual([
      'location_allowlist',
      'min_years_experience',
      'required_certification',
      'required_education_level',
      'required_skill',
    ]);
  });
});
