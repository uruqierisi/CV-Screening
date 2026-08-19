import { describe, expect, it } from 'vitest';
import {
  certificationSchema,
  educationSchema,
  profileSchema,
  skillSchema,
  verifiedProfileSchema,
  workExperienceSchema,
} from '../../src/agents/schemas/profile.schema.js';
import {
  EVALUATION_KEYS,
  RATING_KEYS,
  makeEvaluationSchema,
} from '../../src/agents/schemas/evaluation.schema.js';
import { eliminationRuleSchema, parseRole, roleSchema } from '../../src/agents/schemas/role.schema.js';
import { InvalidRoleError } from '../../src/agents/errors.js';

/**
 * Schemas are tested for the properties the plan argues for, not for "does zod
 * work". The three that matter: nullable everywhere so the model has a legal way
 * to say nothing, no escape hatch for a fabricated field, and nowhere at all to
 * put a score.
 */

/**
 * @param {Partial<Record<string, any>>} [overrides]
 */
function validProfile(overrides = {}) {
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
    ...overrides,
  };
}

describe('profileSchema', () => {
  it('accepts a profile in which the model knew nothing', () => {
    // The all-null profile is the honest answer for an unreadable CV, and it has
    // to be a legal one - otherwise the model is pushed into inventing.
    expect(profileSchema.safeParse(validProfile()).success).toBe(true);
  });

  it('makes every top-level field nullable and none of them optional', () => {
    for (const [name, field] of Object.entries(profileSchema.shape)) {
      expect(field.isNullable(), `${name} should be nullable`).toBe(true);
      expect(field.isOptional(), `${name} should not be optional`).toBe(false);
    }
  });

  it('rejects a profile with a field left out entirely', () => {
    const { email, ...missingEmail } = validProfile();
    expect(profileSchema.safeParse(missingEmail).success).toBe(false);
  });

  it('accepts an email that no validator would like', () => {
    // Deliberate: strict validation here is all-or-nothing, and one mangled OCR
    // address would null the entire extraction over a field nobody scores on.
    // normalize-profile.js nulls the bad field and keeps the other forty.
    for (const email of ['priya at example dot com', 'priya@@example', 'PRIYA @ EXAMPLE.COM']) {
      expect(profileSchema.safeParse(validProfile({ email })).success).toBe(true);
    }
  });

  it('accepts a date in whatever form the CV wrote it', () => {
    const parsed = profileSchema.safeParse(
      validProfile({
        workHistory: [
          {
            employer: null,
            title: null,
            startDate: 'Spring 2019',
            endDate: 'Present',
            isCurrent: true,
            summary: null,
          },
        ],
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown key rather than stripping it', () => {
    const parsed = profileSchema.safeParse(validProfile({ matchScore: 91 }));

    expect(parsed.success).toBe(false);
    expect(parsed.error.issues[0].message).toContain('Unrecognized key');
  });

  describe('skills', () => {
    it('requires the honest option to be chosen explicitly', () => {
      expect(
        skillSchema.safeParse({ name: 'Go', evidenceType: 'demonstrated', evidenceQuote: 'wrote Go' })
          .success,
      ).toBe(true);
      expect(
        skillSchema.safeParse({ name: 'Go', evidenceType: 'listed_only', evidenceQuote: null })
          .success,
      ).toBe(true);
    });

    it('has no third state for evidenceType', () => {
      expect(
        skillSchema.safeParse({ name: 'Go', evidenceType: null, evidenceQuote: null }).success,
      ).toBe(false);
      expect(
        skillSchema.safeParse({ name: 'Go', evidenceType: 'probably', evidenceQuote: null }).success,
      ).toBe(false);
    });

    it('will not accept a nameless skill', () => {
      expect(
        skillSchema.safeParse({ name: '', evidenceType: 'listed_only', evidenceQuote: null }).success,
      ).toBe(false);
      expect(
        skillSchema.safeParse({ name: null, evidenceType: 'listed_only', evidenceQuote: null })
          .success,
      ).toBe(false);
    });
  });

  describe('the other list entries', () => {
    it('lets every work-history field be null', () => {
      expect(
        workExperienceSchema.safeParse({
          employer: null,
          title: null,
          startDate: null,
          endDate: null,
          isCurrent: null,
          summary: null,
        }).success,
      ).toBe(true);
    });

    it('lets an education level be null when the model cannot map it', () => {
      const entry = {
        institution: 'Universität Karlsruhe',
        degree: 'Diplom-Ingenieur',
        field: null,
        level: null,
        startDate: null,
        endDate: null,
      };
      expect(educationSchema.safeParse(entry).success).toBe(true);
      expect(educationSchema.safeParse({ ...entry, level: 'masters' }).success).toBe(true);
      expect(educationSchema.safeParse({ ...entry, level: 'postgrad' }).success).toBe(false);
    });

    it('requires a certification to have a name', () => {
      expect(
        certificationSchema.safeParse({
          name: 'ACLS',
          issuer: null,
          issuedDate: null,
          expiryDate: null,
        }).success,
      ).toBe(true);
      expect(
        certificationSchema.safeParse({
          name: null,
          issuer: 'AHA',
          issuedDate: null,
          expiryDate: null,
        }).success,
      ).toBe(false);
    });
  });

  it('distinguishes a null list from an empty one', () => {
    // Not decoration: null is "extraction found no section" and [] is "the model
    // looked and found nothing". The elimination evaluators treat both as absent,
    // and both have to be expressible for that to be a decision rather than an
    // accident.
    expect(profileSchema.safeParse(validProfile({ skills: null })).success).toBe(true);
    expect(profileSchema.safeParse(validProfile({ skills: [] })).success).toBe(true);
  });
});

describe('verifiedProfileSchema', () => {
  it('adds the two facts code derives, and nothing else', () => {
    const parsed = verifiedProfileSchema.safeParse({
      ...validProfile({
        skills: [
          {
            name: 'Go',
            evidenceType: 'demonstrated',
            evidenceQuote: 'wrote Go',
            evidenceVerified: true,
          },
        ],
      }),
      computedYearsExperience: 6.5,
    });

    expect(parsed.success).toBe(true);
  });

  it('will not accept a computed value the model supplied instead of code', () => {
    // There is no path for the model to set this: it is not in profileSchema, and
    // profileSchema is strict.
    expect(
      profileSchema.safeParse({ ...validProfile(), computedYearsExperience: 12 }).success,
    ).toBe(false);
  });

  it('keeps evidenceVerified nullable, because "not checked" is a real answer', () => {
    const parsed = verifiedProfileSchema.safeParse({
      ...validProfile({
        skills: [
          {
            name: 'Go',
            evidenceType: 'listed_only',
            evidenceQuote: null,
            evidenceVerified: null,
          },
        ],
      }),
      computedYearsExperience: null,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('makeEvaluationSchema', () => {
  const role = {
    criteria: [{ id: 'c-a' }, { id: 'c-b' }],
  };

  /**
   * @param {string} criterionId
   * @param {number} rating
   */
  function rating(criterionId, rating_) {
    return { criterionId, rating: rating_, reason: 'because', evidence: null };
  }

  it('accepts ratings for the criteria this role actually has', () => {
    const schema = makeEvaluationSchema(role);
    expect(schema.safeParse({ ratings: [rating('c-a', 7), rating('c-b', 3)], summary: null }).success).toBe(
      true,
    );
  });

  it('makes inventing a criterion structurally impossible', () => {
    const schema = makeEvaluationSchema(role);
    const parsed = schema.safeParse({ ratings: [rating('c-invented', 10)], summary: null });

    expect(parsed.success).toBe(false);
    expect(parsed.error.issues[0].message).toContain('c-a');
  });

  it('is built per role, so one role cannot validate against another', () => {
    const otherSchema = makeEvaluationSchema({ criteria: [{ id: 'x-1' }] });
    expect(otherSchema.safeParse({ ratings: [rating('c-a', 7)], summary: null }).success).toBe(false);
    expect(otherSchema.safeParse({ ratings: [rating('x-1', 7)], summary: null }).success).toBe(true);
  });

  describe('has nowhere to put a number code did not compute', () => {
    const schema = makeEvaluationSchema(role);

    it('exposes exactly two keys', () => {
      expect(EVALUATION_KEYS).toEqual(['ratings', 'summary']);
      expect(Object.keys(schema.shape).sort()).toEqual([...EVALUATION_KEYS].sort());
    });

    for (const forbidden of ['score', 'matchScore', 'overallScore', 'overall', 'tier', 'fitCategory']) {
      it(`rejects a response carrying "${forbidden}"`, () => {
        const parsed = schema.safeParse({
          ratings: [rating('c-a', 7), rating('c-b', 3)],
          summary: null,
          [forbidden]: 88,
        });

        expect(parsed.success).toBe(false);
        expect(parsed.error.issues[0].message).toContain('Unrecognized key');
      });
    }

    it('exposes exactly four keys per rating', () => {
      const ratingShape = schema.shape.ratings.element.shape;
      expect(Object.keys(ratingShape).sort()).toEqual([...RATING_KEYS].sort());
    });
  });

  describe('the rating itself', () => {
    const schema = makeEvaluationSchema(role);

    /**
     * @param {unknown} value
     */
    function parseRating(value) {
      return schema.safeParse({
        ratings: [{ criterionId: 'c-a', rating: value, reason: 'r', evidence: null }, rating('c-b', 5)],
        summary: null,
      }).success;
    }

    it('accepts the integers 0 to 10', () => {
      for (let value = 0; value <= 10; value += 1) {
        expect(parseRating(value)).toBe(true);
      }
    });

    it('rejects anything else', () => {
      for (const value of [-1, 11, 7.5, '7', null, Number.NaN]) {
        expect(parseRating(value), `rating ${String(value)}`).toBe(false);
      }
    });

    it('requires a reason, because the reason is the product', () => {
      expect(
        schema.safeParse({
          ratings: [{ criterionId: 'c-a', rating: 7, reason: '', evidence: null }],
          summary: null,
        }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          ratings: [{ criterionId: 'c-a', rating: 7, reason: null, evidence: null }],
          summary: null,
        }).success,
      ).toBe(false);
    });

    it('lets evidence be null, because a zero has nothing to cite', () => {
      expect(
        schema.safeParse({
          ratings: [rating('c-a', 0), rating('c-b', 0)],
          summary: null,
        }).success,
      ).toBe(true);
    });
  });

  it('has no completeness refine, so the reconciler can name the missing ids', () => {
    // A refine failure yields parsed_output === null with no diagnostic. The same
    // condition in reconcile-ratings.js says which criteria are missing.
    const schema = makeEvaluationSchema(role);
    expect(schema.safeParse({ ratings: [], summary: null }).success).toBe(true);
  });

  describe('refuses to be built from a role it cannot key off', () => {
    it('throws for a role with no criteria list', () => {
      expect(() => makeEvaluationSchema(/** @type {any} */ (null))).toThrow(InvalidRoleError);
      expect(() => makeEvaluationSchema(/** @type {any} */ ({}))).toThrow(/no criteria list/);
    });

    it('throws for a role with zero criteria', () => {
      expect(() => makeEvaluationSchema({ criteria: [] })).toThrow(/zero criteria/);
    });

    it('throws for duplicate criterion ids', () => {
      let thrown;
      try {
        makeEvaluationSchema({ criteria: [{ id: 'c-a' }, { id: 'c-a' }] });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InvalidRoleError);
      expect(thrown.details.duplicateCriterionIds).toEqual(['c-a']);
    });
  });
});

describe('roleSchema', () => {
  /**
   * @param {Partial<Record<string, any>>} [overrides]
   */
  function validRole(overrides = {}) {
    return {
      id: 'role-1',
      title: 'Senior Backend Engineer',
      version: 2,
      criteria: [
        { id: 'c-a', label: 'A', description: '', weight: 60, position: 0 },
        { id: 'c-b', label: 'B', description: '', weight: 40, position: 1 },
      ],
      eliminationRules: [],
      ...overrides,
    };
  }

  it('accepts a role with no elimination rules at all', () => {
    expect(parseRole(validRole()).eliminationRules).toEqual([]);
  });

  it('returns criteria and rules in position order, whatever order they arrived in', () => {
    const role = parseRole(
      validRole({
        criteria: [
          { id: 'c-b', label: 'B', description: '', weight: 40, position: 1 },
          { id: 'c-a', label: 'A', description: '', weight: 60, position: 0 },
        ],
        eliminationRules: [
          {
            id: 'r-2',
            label: 'second',
            type: 'min_years_experience',
            value: { years: 3 },
            onMissing: 'flag',
            position: 1,
          },
          {
            id: 'r-1',
            label: 'first',
            type: 'required_education_level',
            value: { level: 'bachelors' },
            onMissing: 'flag',
            position: 0,
          },
        ],
      }),
    );

    expect(role.criteria.map((criterion) => criterion.id)).toEqual(['c-a', 'c-b']);
    expect(role.eliminationRules.map((rule) => rule.label)).toEqual(['first', 'second']);
  });

  it('does not mutate the role it was given', () => {
    const role = validRole();
    const original = JSON.stringify(role);
    parseRole(role);
    expect(JSON.stringify(role)).toBe(original);
  });

  it('strips repository columns it has no opinion about', () => {
    const parsed = parseRole({ ...validRole(), createdAt: new Date(), archivedAt: null });
    expect(parsed.createdAt).toBeUndefined();
  });

  describe('rejects a role that cannot produce an honest score', () => {
    it('when the weights do not sum to 100', () => {
      let thrown;
      try {
        parseRole(
          validRole({
            criteria: [{ id: 'c-a', label: 'A', description: '', weight: 99, position: 0 }],
          }),
        );
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(InvalidRoleError);
      expect(thrown.code).toBe('AGENT_INVALID_ROLE');
      expect(thrown.details.issues[0].message).toContain('must sum to 100');
    });

    it('when it has no criteria', () => {
      expect(() => parseRole(validRole({ criteria: [] }))).toThrow(InvalidRoleError);
    });

    it('when two criteria share an id', () => {
      const error = catchError(() =>
        parseRole(
          validRole({
            criteria: [
              { id: 'same', label: 'A', description: '', weight: 60, position: 0 },
              { id: 'same', label: 'B', description: '', weight: 40, position: 1 },
            ],
          }),
        ),
      );
      expect(error.details.issues.some((issue) => issue.message.includes('duplicate criterion ids'))).toBe(
        true,
      );
    });

    it('when two criteria share a position, which would make the order arbitrary', () => {
      const error = catchError(() =>
        parseRole(
          validRole({
            criteria: [
              { id: 'c-a', label: 'A', description: '', weight: 60, position: 0 },
              { id: 'c-b', label: 'B', description: '', weight: 40, position: 0 },
            ],
          }),
        ),
      );
      expect(
        error.details.issues.some((issue) => issue.message.includes('duplicate criterion positions')),
      ).toBe(true);
    });

    it('when a weight is outside 1..100', () => {
      expect(() =>
        parseRole(
          validRole({
            criteria: [
              { id: 'c-a', label: 'A', description: '', weight: 0, position: 0 },
              { id: 'c-b', label: 'B', description: '', weight: 100, position: 1 },
            ],
          }),
        ),
      ).toThrow(InvalidRoleError);
    });

    it('when a weight is fractional', () => {
      expect(() =>
        parseRole(
          validRole({
            criteria: [
              { id: 'c-a', label: 'A', description: '', weight: 60.5, position: 0 },
              { id: 'c-b', label: 'B', description: '', weight: 39.5, position: 1 },
            ],
          }),
        ),
      ).toThrow(InvalidRoleError);
    });

    it('when the version is missing', () => {
      const { version, ...withoutVersion } = validRole();
      expect(() => parseRole(withoutVersion)).toThrow(InvalidRoleError);
    });

    it('when it is not an object at all', () => {
      expect(() => parseRole(null)).toThrow(InvalidRoleError);
      expect(() => parseRole('a role')).toThrow(InvalidRoleError);
    });
  });

  describe('elimination rules', () => {
    /**
     * @param {string} type
     * @param {Record<string, any>} value
     */
    function ruleOf(type, value) {
      return { id: 'r-1', label: 'a rule', type, value, onMissing: 'flag', position: 0 };
    }

    it('accepts every type in the closed union with a well-formed value', () => {
      const valid = [
        ruleOf('min_years_experience', { years: 5 }),
        ruleOf('required_skill', {
          skill: 'PostgreSQL',
          matchMode: 'normalized',
          mustBeDemonstrated: true,
        }),
        ruleOf('required_education_level', { level: 'bachelors' }),
        ruleOf('required_certification', { name: 'ACLS', matchMode: 'exact' }),
        ruleOf('location_allowlist', { countryCodes: ['GB', 'IE'] }),
      ];

      for (const rule of valid) {
        expect(eliminationRuleSchema.safeParse(rule).success, rule.type).toBe(true);
      }
    });

    it('checks the value against the shape its own type requires', () => {
      expect(
        eliminationRuleSchema.safeParse(ruleOf('min_years_experience', { level: 'bachelors' }))
          .success,
      ).toBe(false);
      expect(eliminationRuleSchema.safeParse(ruleOf('min_years_experience', { years: 5.5 })).success).toBe(
        false,
      );
      expect(eliminationRuleSchema.safeParse(ruleOf('min_years_experience', { years: 61 })).success).toBe(
        false,
      );
      expect(
        eliminationRuleSchema.safeParse(
          ruleOf('required_skill', { skill: 'Go', matchMode: 'fuzzy', mustBeDemonstrated: true }),
        ).success,
      ).toBe(false);
      expect(
        eliminationRuleSchema.safeParse(ruleOf('location_allowlist', { countryCodes: ['GBR'] })).success,
      ).toBe(false);
      expect(
        eliminationRuleSchema.safeParse(ruleOf('location_allowlist', { countryCodes: [] })).success,
      ).toBe(false);
    });

    it('rejects an extra key in the value, which would be a setting nothing reads', () => {
      expect(
        eliminationRuleSchema.safeParse(ruleOf('min_years_experience', { years: 5, months: 6 }))
          .success,
      ).toBe(false);
    });

    it('rejects a type outside the closed union', () => {
      expect(eliminationRuleSchema.safeParse(ruleOf('required_language', { language: 'de' })).success).toBe(
        false,
      );
    });

    it('requires mustBeDemonstrated to be stated rather than defaulted', () => {
      expect(
        eliminationRuleSchema.safeParse(
          ruleOf('required_skill', { skill: 'Go', matchMode: 'exact' }),
        ).success,
      ).toBe(false);
    });

    it('requires onMissing to be stated, because 7-C is too consequential to infer', () => {
      const { onMissing, ...withoutOnMissing } = ruleOf('min_years_experience', { years: 5 });
      expect(eliminationRuleSchema.safeParse(withoutOnMissing).success).toBe(false);
      expect(
        eliminationRuleSchema.safeParse({ ...withoutOnMissing, onMissing: 'ignore' }).success,
      ).toBe(false);
    });
  });

  it('is exported as a schema as well as a parse function', () => {
    expect(roleSchema.safeParse(validRole()).success).toBe(true);
  });
});

/**
 * @param {() => unknown} fn
 * @returns {any}
 */
function catchError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, and it did not');
}
