import { describe, expect, it } from 'vitest';
import { normalizeProfile } from '../../src/agents/extraction/normalize-profile.js';
import {
  extractedProfileSchema,
  profileSchema,
} from '../../src/agents/schemas/profile.schema.js';
import { GOLDEN_EXTRACTED, GOLDEN_PROFILE } from './fixtures/golden.js';

/**
 * Two rules, tested from every side.
 *
 * **Fill: every field the model left out comes back as `null`, and the four flat
 * `location*` fields come back as one nested object.** That is what keeps this
 * refactor invisible to the four consumers downstream of it, and the first
 * describe block below asserts the whole output shape rather than one field of
 * it.
 *
 * **Repair: a field that fails a check becomes `null`, and nothing is repaired
 * into a value it did not have.** Nulling a mangled email costs nothing - `null`
 * already means "we could not tell" everywhere in this system. Repairing
 * `jane doe at acme.com` into `jane.doe@acme.com` would invent a fact about a
 * real person that looks exactly like a real one.
 */

/**
 * A profile in the shape the **model** returns it: absent keys where the CV says
 * nothing, flat location, and the four lists always present because the wire
 * schema requires them.
 *
 * Every fixture is put through `extractedProfileSchema` first, so a test can
 * never assert something about a response the API would not have let through.
 *
 * @param {Record<string, unknown>} [overrides]
 */
function profile(overrides = {}) {
  const candidate = {
    fullName: 'A. Candidate',
    workHistory: [],
    education: [],
    certifications: [],
    skills: [],
    ...overrides,
  };
  const parsed = extractedProfileSchema.safeParse(candidate);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return parsed.data;
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
        certifications: [{ name: '  ' }],
      }),
    );

    expect(profileSchema.safeParse(output).success).toBe(true);
  });
});

describe('the stored shape, which this refactor was not allowed to change', () => {
  /**
   * The stored profile shape, written out by hand.
   *
   * This is the safety net for the wire/stored split. `verify-evidence.js`,
   * `compute-experience.js`, the evaluation prompt's profile rendering,
   * `screen-candidate.js`, the `parsed_profile` column and every dashboard cell
   * read this object. A derived expectation would only prove the code agrees
   * with itself, so the expected value is a literal.
   *
   * **It changed this round, and here is exactly how.** It used to carry
   * `headline` and `summary` between `location` and `statedYearsExperience`;
   * both are gone. Three fields inside the nested shapes went with them -
   * `workHistory[].isCurrent`, `education[].startDate` and `location.raw`.
   * Nothing in the system read any of the five, and each was costing an optional
   * parameter out of an API budget of 24. They were deleted from the stored
   * shape rather than kept as permanently-null keys, because a field that can
   * never be anything but null is dead weight in `parsed_profile` and reads to
   * the next person like a bug. `parsed_profile` is jsonb, so no migration is
   * involved either way.
   */
  const STORED_SHAPE = Object.freeze([
    'fullName',
    'email',
    'phone',
    'linkedinUrl',
    'location',
    'statedYearsExperience',
    'workHistory',
    'education',
    'certifications',
    'skills',
  ]);

  it('emits exactly these keys, in this order', () => {
    // Order matters and is not incidental: the evaluation prompt renders this
    // object with `JSON.stringify`, so a reshuffle would change the bytes sent to
    // the model for an unchanged CV.
    expect(Object.keys(normalizeProfile(profile()).profile)).toEqual(STORED_SHAPE);
    expect(Object.keys(normalizeProfile(GOLDEN_EXTRACTED).profile)).toEqual(STORED_SHAPE);
  });

  it('emits exactly these keys inside each nested shape', () => {
    const { profile: output } = normalizeProfile(GOLDEN_EXTRACTED);

    expect(Object.keys(output.workHistory[0])).toEqual([
      'employer',
      'title',
      'startDate',
      'endDate',
      'summary',
    ]);
    expect(Object.keys(output.education[0])).toEqual([
      'institution',
      'degree',
      'field',
      'level',
      'endDate',
    ]);
    expect(Object.keys(output.location)).toEqual(['city', 'region', 'countryCode']);
  });

  it('fills every field the model left out with null, and an absent list with null', () => {
    // The model omitting a field and the model sending an explicit null are one
    // claim - "the CV does not say" - and this is where the second spelling is
    // restored.
    //
    // Built by hand rather than through `profile()`, deliberately: the wire
    // schema now *requires* the four lists, so a real response can no longer
    // leave one out. The fill stays total anyway, because `profileSchema` still
    // allows a null list and collapsing an absent key to `[]` here would
    // manufacture a claim - "I looked and found nothing" - that nobody made.
    expect(normalizeProfile({}).profile).toEqual({
      fullName: null,
      email: null,
      phone: null,
      linkedinUrl: null,
      location: null,
      statedYearsExperience: null,
      workHistory: null,
      education: null,
      certifications: null,
      skills: null,
    });
  });

  it('turns the golden extraction into the golden profile, value for value', () => {
    // The two fixtures are written out independently, so this is a real
    // assertion rather than a round trip: `GOLDEN_PROFILE` is what phase 2a's
    // scoring tests, the redaction tests and the prompt tests all read, and it
    // is unchanged.
    const { computedYearsExperience, skills, ...stored } = GOLDEN_PROFILE;
    const expected = {
      ...stored,
      // `evidenceVerified` is added later, by `verify-evidence.js`.
      skills: skills.map(({ evidenceVerified, ...skill }) => skill),
    };

    const { profile: output, changes } = normalizeProfile(GOLDEN_EXTRACTED);

    expect(output).toEqual(expected);
    expect(changes).toEqual([]);
    expect(profileSchema.safeParse(output).success).toBe(true);
  });

  it('keeps an empty list empty, because that is a claim the model made', () => {
    // `[]` is "the model looked and found nothing", and since the four lists
    // became required on the wire it is the *only* way a response says that.
    // Nothing here may quietly turn it back into a null.
    const output = normalizeProfile(profile()).profile;

    expect(output.workHistory).toEqual([]);
    expect(output.education).toEqual([]);
    expect(output.certifications).toEqual([]);
    expect(output.skills).toEqual([]);
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
      profile({ email: 'rubbish', fullName: 'A. Candidate', statedYearsExperience: 9 }),
    );

    expect(output.email).toBeNull();
    expect(output.fullName).toBe('A. Candidate');
    expect(output.statedYearsExperience).toBe(9);
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
      profile({ fullName: '  A.   Candidate  ', linkedinUrl: '   ' }),
    );

    expect(output.fullName).toBe('A. Candidate');
    expect(output.linkedinUrl).toBeNull();
    expect(changes).toContainEqual({ field: 'linkedinUrl', action: 'nulled_empty' });
  });

  it('reaches into the list entries too', () => {
    const { profile: output } = normalizeProfile(
      profile({
        workHistory: [
          {
            employer: '  Northwind   Logistics ',
            startDate: ' 2021-03 ',
            summary: '',
          },
        ],
        education: [
          {
            institution: ' University  of Leeds ',
            level: 'bachelors',
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
    // "There is no such section in this profile at all" and "extraction looked
    // and found nothing" are different answers, and `profileSchema` was shaped
    // to keep them apart. Only the second is reachable from the wire now; the
    // first is what the fill produces for anything else that reaches it.
    const nulls = normalizeProfile({}).profile;
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
          { name: ' ' },
          { name: '  RN Licence ', issuer: ' NMC ', expiryDate: '2027-01' },
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
          { name: 'Python', evidenceType: 'listed_only' },
          { name: 'python', evidenceType: 'demonstrated', evidenceQuote: 'built it in Python' },
        ],
      }),
    ).profile.skills;

    const demonstratedFirst = normalizeProfile(
      profile({
        skills: [
          { name: 'Python', evidenceType: 'demonstrated', evidenceQuote: 'built it in Python' },
          { name: 'python', evidenceType: 'listed_only' },
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
          { name: 'Java', evidenceType: 'listed_only' },
          { name: 'JavaScript', evidenceType: 'listed_only' },
        ],
      }),
    ).profile.skills;

    expect(skills.map((skill) => skill.name)).toEqual(['Java', 'JavaScript']);
  });

  it('records the merge without recording the skill twice', () => {
    const { changes } = normalizeProfile(
      profile({
        skills: [
          { name: 'SQL', evidenceType: 'listed_only' },
          { name: 'SQL', evidenceType: 'listed_only' },
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
      profile({ skills: [{ name: '   ', evidenceType: 'listed_only' }] }),
    );

    expect(output.skills).toEqual([]);
    expect(changes).toContainEqual({
      field: 'skills[0]',
      action: 'dropped_entry',
      reason: 'blank_name',
    });
  });
});

describe('location, which the model sends flat and the system stores nested', () => {
  it('re-nests the four flat fields into the object everything downstream reads', () => {
    // The flattening is a wire decision - a nested nullable object cost five of
    // the sixteen union-typed parameters the API allows. `elimination.js` still
    // reads `profile.location.countryCode`, and this is what keeps that true.
    const { profile: output } = normalizeProfile(
      profile({ locationCity: 'Manchester', locationCountryCode: 'GB' }),
    );

    expect(output.location).toEqual({
      city: 'Manchester',
      region: null,
      countryCode: 'GB',
    });
  });

  it('upper-cases a country code and nulls anything that is not ISO alpha-2', () => {
    expect(
      normalizeProfile(profile({ locationCountryCode: 'gb' })).profile.location.countryCode,
    ).toBe('GB');

    const { profile: output, changes } = normalizeProfile(
      profile({ locationCity: ' Manchester ', locationCountryCode: 'United Kingdom' }),
    );

    // "United Kingdom" would silently never match an allowlist of alpha-2 codes.
    // A null makes the rule indeterminate and flags the candidate for a human,
    // which decision 7-C says is the right failure.
    expect(output.location.countryCode).toBeNull();
    expect(output.location.city).toBe('Manchester');
    expect(changes).toContainEqual({
      field: 'location.countryCode',
      action: 'nulled_invalid',
      reason: 'not_iso_alpha_2',
    });
  });

  it('produces a null location when the model gave none of the three fields', () => {
    // The same answer the nested shape used to give as an explicit
    // `location: null`: this CV states no location at all.
    expect(normalizeProfile(profile()).profile.location).toBeNull();
  });

  it('keeps a location whose country the model could not determine', () => {
    // One field present is enough to make the object real. A CV that names a
    // region and no country is the ordinary case, not an error: it produces no
    // change record, and the allowlist rule reads it as indeterminate, which is
    // what decision 7-C asks for.
    const { profile: output, changes } = normalizeProfile(
      profile({ locationRegion: 'North West England' }),
    );

    expect(output.location).toEqual({
      city: null,
      region: 'North West England',
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

  it.each([[-1], [81], [Number.POSITIVE_INFINITY]])(
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

  it('nulls a NaN the schema would never have let through', () => {
    // Deliberately built by hand rather than through `profile()`: `z.number()`
    // rejects NaN, so this value cannot reach normalization from a real
    // response. The `Number.isFinite` check stays and stays tested anyway,
    // because this function is the last thing standing between a stray number
    // and a figure a recruiter reads next to a real one.
    const { profile: output, changes } = normalizeProfile({ statedYearsExperience: Number.NaN });

    expect(output.statedYearsExperience).toBeNull();
    expect(changes).toContainEqual({
      field: 'statedYearsExperience',
      action: 'nulled_invalid',
      reason: 'implausible',
    });
  });
});
