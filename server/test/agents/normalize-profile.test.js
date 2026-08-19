import { describe, expect, it } from 'vitest';
import { normalizeProfile } from '../../src/agents/extraction/normalize-profile.js';
import { profileSchema } from '../../src/agents/schemas/profile.schema.js';

/**
 * One rule, tested from every side: **a field that fails a check becomes `null`,
 * and nothing is repaired into a value it did not have.**
 *
 * The second half is what these tests are really about. Nulling a mangled email
 * costs nothing - `null` already means "we could not tell" everywhere in this
 * system. Repairing `jane doe at acme.com` into `jane.doe@acme.com` would invent
 * a fact about a real person that looks exactly like a real one.
 */

/** @param {Partial<import('../../src/agents/schemas/profile.schema.js').Profile>} overrides */
function profile(overrides = {}) {
  return {
    fullName: 'A. Candidate',
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

describe('normalizeProfile', () => {
  it('does not mutate what it is given', () => {
    const input = Object.freeze(profile({ email: '  JANE@ACME.COM ' }));
    const { profile: output } = normalizeProfile(input);

    expect(input.email).toBe('  JANE@ACME.COM ');
    expect(output.email).toBe('jane@acme.com');
    expect(output).not.toBe(input);
  });

  it('still satisfies the schema it came from', () => {
    const { profile: output } = normalizeProfile(
      profile({
        email: 'not an address',
        skills: [{ name: ' Python ', evidenceType: 'listed_only', evidenceQuote: 'stray' }],
        certifications: [{ name: '  ', issuer: null, issuedDate: null, expiryDate: null }],
      }),
    );

    expect(profileSchema.safeParse(output).success).toBe(true);
  });
});

describe('email', () => {
  it('folds case, because an address is not case-sensitive', () => {
    expect(normalizeProfile(profile({ email: 'Jane.Doe@Acme.CO.UK' })).profile.email).toBe(
      'jane.doe@acme.co.uk',
    );
  });

  it.each([
    ['no at sign', 'jane.doe.acme.com'],
    ['spelled-out at', 'jane.doe (at) acme.com'],
    ['no dot in the domain', 'jane@acme'],
    ['a whole sentence', 'see attached CV for contact details'],
    ['an OCR fragment', 'jane@'],
  ])('nulls %s rather than guessing at it', (_what, value) => {
    const { profile: output, changes } = normalizeProfile(profile({ email: value }));

    expect(output.email).toBeNull();
    expect(changes).toContainEqual({
      field: 'email',
      action: 'nulled_invalid',
      reason: 'not_an_address',
    });
  });

  it('keeps the other forty fields when the email is the broken one', () => {
    // The entire reason `email` is a plain string in the schema: an
    // all-or-nothing check here would null the whole extraction and burn a retry
    // over a field nobody scores on.
    const { profile: output } = normalizeProfile(
      profile({ email: 'rubbish', fullName: 'A. Candidate', headline: 'Staff Engineer' }),
    );

    expect(output.email).toBeNull();
    expect(output.fullName).toBe('A. Candidate');
    expect(output.headline).toBe('Staff Engineer');
  });
});

describe('phone and linkedin', () => {
  it('keeps a phone number exactly as the CV wrote it', () => {
    // International formatting is inconsistent and nobody scores on it. The only
    // question worth asking is whether it is a number at all.
    expect(normalizeProfile(profile({ phone: '+44 (0)161 496 0000' })).profile.phone).toBe(
      '+44 (0)161 496 0000',
    );
  });

  it('nulls something with too few digits to dial', () => {
    const { profile: output, changes } = normalizeProfile(profile({ phone: 'ext. 4021' }));
    expect(output.phone).toBeNull();
    expect(changes[0].reason).toBe('too_few_digits');
  });

  it('keeps a linkedin URL and nulls anything that is not one', () => {
    expect(
      normalizeProfile(profile({ linkedinUrl: 'https://www.linkedin.com/in/acandidate' })).profile
        .linkedinUrl,
    ).toBe('https://www.linkedin.com/in/acandidate');

    const { profile: output, changes } = normalizeProfile(
      profile({ linkedinUrl: 'github.com/acandidate' }),
    );
    expect(output.linkedinUrl).toBeNull();
    expect(changes[0].reason).toBe('not_a_linkedin_url');
  });
});

describe('whitespace', () => {
  it('trims, collapses runs, and turns a blank string into null', () => {
    const { profile: output, changes } = normalizeProfile(
      profile({ headline: '  Staff   Engineer  ', summary: '   ' }),
    );

    expect(output.headline).toBe('Staff Engineer');
    expect(output.summary).toBeNull();
    expect(changes).toContainEqual({ field: 'summary', action: 'nulled_empty' });
  });

  it('reaches into the list entries too', () => {
    const { profile: output } = normalizeProfile(
      profile({
        workHistory: [
          {
            employer: '  Northwind   Logistics ',
            title: null,
            startDate: ' 2021-03 ',
            endDate: null,
            isCurrent: true,
            summary: '',
          },
        ],
        education: [
          {
            institution: ' University  of Leeds ',
            degree: null,
            field: null,
            level: 'bachelors',
            startDate: null,
            endDate: null,
          },
        ],
      }),
    );

    expect(output.workHistory[0].employer).toBe('Northwind Logistics');
    expect(output.workHistory[0].startDate).toBe('2021-03');
    expect(output.workHistory[0].summary).toBeNull();
    expect(output.education[0].institution).toBe('University of Leeds');
  });
});

describe('lists', () => {
  it('keeps null as null and an empty array as an empty array', () => {
    // "Extraction found no such section" and "extraction looked and found
    // nothing" are different answers, and the schema was shaped to keep them
    // apart.
    const nulls = normalizeProfile(profile()).profile;
    expect(nulls.skills).toBeNull();
    expect(nulls.workHistory).toBeNull();
    expect(nulls.certifications).toBeNull();

    const empties = normalizeProfile(
      profile({ skills: [], workHistory: [], education: [], certifications: [] }),
    ).profile;
    expect(empties.skills).toEqual([]);
    expect(empties.certifications).toEqual([]);
  });

  it('drops a certification whose name is only whitespace', () => {
    const { profile: output, changes } = normalizeProfile(
      profile({
        certifications: [
          { name: ' ', issuer: null, issuedDate: null, expiryDate: null },
          { name: '  RN Licence ', issuer: ' NMC ', issuedDate: null, expiryDate: '2027-01' },
        ],
      }),
    );

    expect(output.certifications).toHaveLength(1);
    expect(output.certifications[0]).toMatchObject({ name: 'RN Licence', issuer: 'NMC' });
    expect(changes).toContainEqual({
      field: 'certifications[0]',
      action: 'dropped_entry',
      reason: 'blank_name',
    });
  });
});

describe('skills', () => {
  it('merges a duplicate and keeps the stronger evidence, whichever order it arrived in', () => {
    // Without this, a `required_skill` rule with `mustBeDemonstrated` could match
    // whichever entry came first, so the same profile would pass or fail on the
    // order the model happened to emit.
    const listedFirst = normalizeProfile(
      profile({
        skills: [
          { name: 'Python', evidenceType: 'listed_only', evidenceQuote: null },
          { name: 'python', evidenceType: 'demonstrated', evidenceQuote: 'built it in Python' },
        ],
      }),
    ).profile.skills;

    const demonstratedFirst = normalizeProfile(
      profile({
        skills: [
          { name: 'Python', evidenceType: 'demonstrated', evidenceQuote: 'built it in Python' },
          { name: 'python', evidenceType: 'listed_only', evidenceQuote: null },
        ],
      }),
    ).profile.skills;

    expect(listedFirst).toHaveLength(1);
    expect(demonstratedFirst).toHaveLength(1);
    expect(listedFirst[0].evidenceType).toBe('demonstrated');
    expect(demonstratedFirst[0].evidenceType).toBe('demonstrated');
    // The first spelling seen wins the display name, so the output is stable.
    expect(listedFirst[0].name).toBe('Python');
    expect(demonstratedFirst[0].name).toBe('Python');
  });

  it('does not merge two genuinely different skills', () => {
    const skills = normalizeProfile(
      profile({
        skills: [
          { name: 'Java', evidenceType: 'listed_only', evidenceQuote: null },
          { name: 'JavaScript', evidenceType: 'listed_only', evidenceQuote: null },
        ],
      }),
    ).profile.skills;

    expect(skills.map((skill) => skill.name)).toEqual(['Java', 'JavaScript']);
  });

  it('records the merge without recording the skill twice', () => {
    const { changes } = normalizeProfile(
      profile({
        skills: [
          { name: 'SQL', evidenceType: 'listed_only', evidenceQuote: null },
          { name: 'SQL', evidenceType: 'listed_only', evidenceQuote: null },
        ],
      }),
    );

    expect(changes).toContainEqual({ field: 'skills[1]', action: 'deduplicated' });
  });

  it('strips a quote attached to a listed_only skill', () => {
    // The model chose the weaker option and then supplied evidence for the
    // stronger one. The choice is authoritative, so nothing downstream can read
    // the quote as proof of a demonstration nobody claimed.
    const { profile: output, changes } = normalizeProfile(
      profile({
        skills: [{ name: 'Rust', evidenceType: 'listed_only', evidenceQuote: 'wrote Rust once' }],
      }),
    );

    expect(output.skills[0].evidenceQuote).toBeNull();
    expect(output.skills[0].evidenceType).toBe('listed_only');
    expect(changes).toContainEqual({
      field: 'skills[0].evidenceQuote',
      action: 'nulled_invalid',
      reason: 'quote_without_demonstration',
    });
  });

  it('drops a skill whose name is only whitespace', () => {
    const { profile: output, changes } = normalizeProfile(
      profile({ skills: [{ name: '   ', evidenceType: 'listed_only', evidenceQuote: null }] }),
    );

    expect(output.skills).toEqual([]);
    expect(changes).toContainEqual({
      field: 'skills[0]',
      action: 'dropped_entry',
      reason: 'blank_name',
    });
  });
});

describe('location and stated years', () => {
  it('upper-cases a country code and nulls anything that is not ISO alpha-2', () => {
    expect(
      normalizeProfile(profile({ location: { raw: null, city: null, region: null, countryCode: 'gb' } }))
        .profile.location.countryCode,
    ).toBe('GB');

    const { profile: output, changes } = normalizeProfile(
      profile({
        location: { raw: ' Manchester, UK ', city: null, region: null, countryCode: 'United Kingdom' },
      }),
    );

    // "United Kingdom" would silently never match an allowlist of alpha-2 codes.
    // A null makes the rule indeterminate and flags the candidate for a human,
    // which decision 7-C says is the right failure.
    expect(output.location.countryCode).toBeNull();
    expect(output.location.raw).toBe('Manchester, UK');
    expect(changes).toContainEqual({
      field: 'location.countryCode',
      action: 'nulled_invalid',
      reason: 'not_iso_alpha_2',
    });
  });

  it('leaves a null location alone', () => {
    expect(normalizeProfile(profile({ location: null })).profile.location).toBeNull();
  });

  it('keeps a location whose country the model could not determine', () => {
    // A present location with a null country is the ordinary case for a CV that
    // says "Remote" or "North West". It is not an error and produces no change
    // record - the allowlist rule will read it as indeterminate, which is what
    // decision 7-C asks for.
    const { profile: output, changes } = normalizeProfile(
      profile({ location: { raw: 'Remote', city: null, region: null, countryCode: null } }),
    );

    expect(output.location).toEqual({
      raw: 'Remote',
      city: null,
      region: null,
      countryCode: null,
    });
    expect(changes).toEqual([]);
  });

  it.each([
    [12, 12],
    [10.55, 10.6],
    [0, 0],
  ])('keeps a plausible stated total (%s)', (input, expected) => {
    expect(normalizeProfile(profile({ statedYearsExperience: input })).profile
      .statedYearsExperience).toBe(expected);
  });

  it.each([[-1], [81], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    'nulls an implausible stated total (%s)',
    (value) => {
      const { profile: output, changes } = normalizeProfile(
        profile({ statedYearsExperience: value }),
      );

      expect(output.statedYearsExperience).toBeNull();
      expect(changes).toContainEqual({
        field: 'statedYearsExperience',
        action: 'nulled_invalid',
        reason: 'implausible',
      });
    },
  );
});
