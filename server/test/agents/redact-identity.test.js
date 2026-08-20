import { describe, expect, it } from 'vitest';
import {
  REDACTED_IDENTITY_FIELDS,
  redactIdentity,
} from '../../src/agents/evaluation/redact-identity.js';
import { profileSchema, verifiedProfileSchema } from '../../src/agents/schemas/profile.schema.js';
import { GOLDEN_PROFILE } from './fixtures/golden.js';

/**
 * Decision 7-D, from both sides: the four fields go, and nothing else does.
 *
 * The second half matters as much as the first. Redacting an institution or an
 * employer would remove signal a recruiter legitimately weights, and would do it
 * unilaterally - that belongs behind a role-level toggle, not in a default.
 */

describe('redactIdentity', () => {
  it('removes exactly name, email, phone and linkedin', () => {
    expect([...REDACTED_IDENTITY_FIELDS]).toEqual(['fullName', 'email', 'phone', 'linkedinUrl']);

    const redacted = redactIdentity({
      ...GOLDEN_PROFILE,
      phone: '+44 161 496 0000',
      linkedinUrl: 'https://linkedin.com/in/priya',
    });

    for (const field of REDACTED_IDENTITY_FIELDS) {
      expect(redacted[field], field).toBeNull();
    }
    expect(JSON.stringify(redacted)).not.toContain('Priya');
    expect(JSON.stringify(redacted)).not.toContain('priya.ramanathan@example.com');
  });

  it('keeps every field a criterion could legitimately be about', () => {
    const redacted = redactIdentity(GOLDEN_PROFILE);

    // Institutions and employers stay. Taking them away would remove signal
    // recruiters weight, and should be a role-level choice rather than a
    // unilateral default.
    expect(redacted.education[0].institution).toBe('University of Leeds');
    expect(redacted.workHistory[0].employer).toBe('Northwind Logistics');
    expect(redacted.skills).toEqual(GOLDEN_PROFILE.skills);
    expect(redacted.location).toEqual(GOLDEN_PROFILE.location);
    expect(redacted.computedYearsExperience).toBe(GOLDEN_PROFILE.computedYearsExperience);
    // The free text that carries the evidence a criterion is rated on. The
    // profile-level `headline` and `summary` used to be checked here too; both
    // were deleted from the schema, which narrowed this module's honest limit
    // without anybody aiming at it - see its header.
    expect(redacted.workHistory[0].summary).toBe(GOLDEN_PROFILE.workHistory[0].summary);
  });

  it('returns a copy and leaves the original whole', () => {
    // The caller is holding the profile that gets stored. A function that edited
    // it in place would redact the recruiter's view from inside the evaluation
    // step - the exact bug this module is arranged to make impossible.
    const original = { ...GOLDEN_PROFILE };
    const redacted = redactIdentity(original);

    expect(redacted).not.toBe(original);
    expect(original.fullName).toBe('Priya Ramanathan');
    expect(original.email).toBe('priya.ramanathan@example.com');
  });

  it('nulls rather than deletes, so the result still fits the schema', () => {
    const redacted = redactIdentity(GOLDEN_PROFILE);

    for (const field of REDACTED_IDENTITY_FIELDS) {
      expect(Object.hasOwn(redacted, field), field).toBe(true);
    }
    // Round-tripped through the schema the input satisfied: redaction must not
    // be able to produce a profile that no longer validates.
    const { computedYearsExperience, ...withoutDerived } = redacted;
    expect(profileSchema.safeParse(withoutDerived).success).toBe(true);

    const verifiable = {
      ...redacted,
      skills: redacted.skills.map((skill) => ({ ...skill, evidenceVerified: true })),
    };
    expect(verifiedProfileSchema.safeParse(verifiable).success).toBe(true);
  });

  it('is idempotent, and harmless on a profile that had none of them', () => {
    const alreadyEmpty = {
      ...GOLDEN_PROFILE,
      fullName: null,
      email: null,
      phone: null,
      linkedinUrl: null,
    };

    expect(redactIdentity(alreadyEmpty)).toEqual(alreadyEmpty);
    expect(redactIdentity(redactIdentity(GOLDEN_PROFILE))).toEqual(redactIdentity(GOLDEN_PROFILE));
  });

  it('does not scrub free text, and the limit is documented rather than implied', () => {
    // The honest edge: a summary written in the third person carries the name
    // into evaluation. Scrubbing prose needs a name list or another model call,
    // and both would sometimes delete a real word from a real CV - "Baker" is a
    // surname and a job. The test records the gap so nobody mistakes this for
    // anonymisation.
    const redacted = redactIdentity({
      ...GOLDEN_PROFILE,
      summary: 'Priya is a senior engineer with a decade in logistics.',
    });

    expect(redacted.fullName).toBeNull();
    expect(redacted.summary).toContain('Priya');
  });
});
