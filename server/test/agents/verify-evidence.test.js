import { describe, expect, it } from 'vitest';
import { verifyEvidence } from '../../src/agents/extraction/verify-evidence.js';
import { verifiedProfileSchema } from '../../src/agents/schemas/profile.schema.js';

/**
 * The falsification test. Every other field in the profile is the model's word
 * against nothing; this one is checkable, and the tests below are about the two
 * ways of getting it wrong: being so strict that a faithful quote is rejected
 * because a PDF rewrote a dash, and being so loose that a paraphrase passes.
 */

const CV_TEXT = [
  'Rebuilt the shipment tracking service in Node.js, cutting p99 latency from 1.8s to 240ms.',
  'Designed the PostgreSQL schema behind it — including the partitioning migration.',
  'Mentored two junior engineers through their first on-call rotation.',
].join('\n');

/**
 * @param {any[]} skills
 */
function profileWithSkills(skills) {
  return {
    fullName: 'A Candidate',
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
    skills,
  };
}

/**
 * @param {string} name
 * @param {'demonstrated' | 'listed_only'} evidenceType
 * @param {string | null} evidenceQuote
 */
function skill(name, evidenceType, evidenceQuote) {
  return { name, evidenceType, evidenceQuote };
}

describe('verifyEvidence', () => {
  it('keeps a skill demonstrated when the quote is in the source', () => {
    const { profile, downgraded, verifiedCount } = verifyEvidence(
      profileWithSkills([
        skill('Node.js', 'demonstrated', 'Rebuilt the shipment tracking service in Node.js'),
      ]),
      CV_TEXT,
    );

    expect(profile.skills[0].evidenceType).toBe('demonstrated');
    expect(profile.skills[0].evidenceVerified).toBe(true);
    expect(downgraded).toEqual([]);
    expect(verifiedCount).toBe(1);
  });

  describe('folds differences that are not differences', () => {
    /** @type {[string, string][]} */
    const tolerated = [
      ['case', 'REBUILT THE SHIPMENT TRACKING SERVICE IN NODE.JS'],
      ['collapsed whitespace', 'Rebuilt   the  shipment\n  tracking service in Node.js'],
      ['a unicode em dash', 'Designed the PostgreSQL schema behind it - including'],
      ['a zero-width character', 'Mentored two ju​nior engineers'],
      ['a non-breaking space', 'Mentored two junior engineers'],
    ];

    for (const [description, quote] of tolerated) {
      it(`verifies a quote differing only by ${description}`, () => {
        const { profile, downgraded } = verifyEvidence(
          profileWithSkills([skill('Something', 'demonstrated', quote)]),
          CV_TEXT,
        );

        expect(downgraded).toEqual([]);
        expect(profile.skills[0].evidenceVerified).toBe(true);
      });
    }
  });

  describe('downgrades a claim it cannot substantiate', () => {
    it('when the quote is nowhere in the source', () => {
      const { profile, downgraded, verifiedCount } = verifyEvidence(
        profileWithSkills([
          skill('Kubernetes', 'demonstrated', 'Ran a 200-node Kubernetes cluster'),
        ]),
        CV_TEXT,
      );

      expect(profile.skills[0].evidenceType).toBe('listed_only');
      expect(profile.skills[0].evidenceVerified).toBe(false);
      expect(downgraded).toEqual([{ skill: 'Kubernetes', reason: 'quote_not_found' }]);
      expect(verifiedCount).toBe(0);
    });

    it('when the quote is a paraphrase rather than a copy', () => {
      const { downgraded } = verifyEvidence(
        profileWithSkills([
          skill('Node.js', 'demonstrated', 'Rebuilt the tracking service using Node.js'),
        ]),
        CV_TEXT,
      );

      expect(downgraded).toHaveLength(1);
    });

    it('when the model claimed demonstration and supplied no quote at all', () => {
      const { profile, downgraded } = verifyEvidence(
        profileWithSkills([skill('Go', 'demonstrated', null)]),
        CV_TEXT,
      );

      expect(profile.skills[0].evidenceType).toBe('listed_only');
      expect(downgraded).toEqual([{ skill: 'Go', reason: 'missing_quote' }]);
    });

    it('when the quote is empty', () => {
      const { downgraded } = verifyEvidence(
        profileWithSkills([skill('Go', 'demonstrated', '   ')]),
        CV_TEXT,
      );

      expect(downgraded).toEqual([{ skill: 'Go', reason: 'quote_not_found' }]);
    });

    it('and keeps the quote, because it is the evidence of the fabrication', () => {
      const { profile } = verifyEvidence(
        profileWithSkills([skill('Rust', 'demonstrated', 'Wrote a kernel in Rust')]),
        CV_TEXT,
      );

      expect(profile.skills[0].evidenceQuote).toBe('Wrote a kernel in Rust');
    });
  });

  it('leaves a listed_only skill alone and marks it unchecked', () => {
    const { profile, downgraded, verifiedCount } = verifyEvidence(
      profileWithSkills([skill('Terraform', 'listed_only', null)]),
      CV_TEXT,
    );

    // null, not false: "nothing was claimed" and "a claim failed" have to stay
    // distinguishable in the stored profile.
    expect(profile.skills[0].evidenceVerified).toBeNull();
    expect(profile.skills[0].evidenceType).toBe('listed_only');
    expect(downgraded).toEqual([]);
    expect(verifiedCount).toBe(0);
  });

  it('handles a mixed skill list', () => {
    const { profile, downgraded, verifiedCount } = verifyEvidence(
      profileWithSkills([
        skill('Node.js', 'demonstrated', 'Rebuilt the shipment tracking service in Node.js'),
        skill('Kubernetes', 'demonstrated', 'Operated a Kubernetes cluster'),
        skill('Terraform', 'listed_only', null),
      ]),
      CV_TEXT,
    );

    expect(profile.skills.map((entry) => entry.evidenceType)).toEqual([
      'demonstrated',
      'listed_only',
      'listed_only',
    ]);
    expect(verifiedCount).toBe(1);
    expect(downgraded).toHaveLength(1);
  });

  it('passes a null skills list straight through', () => {
    const { profile, downgraded, verifiedCount } = verifyEvidence(profileWithSkills(null), CV_TEXT);

    expect(profile.skills).toBeNull();
    expect(downgraded).toEqual([]);
    expect(verifiedCount).toBe(0);
  });

  it('does not mutate the profile it was given', () => {
    const original = profileWithSkills([skill('Rust', 'demonstrated', 'Wrote a kernel in Rust')]);
    Object.freeze(original);
    Object.freeze(original.skills);
    Object.freeze(original.skills[0]);

    const { profile } = verifyEvidence(original, CV_TEXT);

    expect(profile).not.toBe(original);
    expect(original.skills[0].evidenceType).toBe('demonstrated');
    expect(profile.skills[0].evidenceType).toBe('listed_only');
  });

  it('refuses to verify against nothing', () => {
    // Verifying against an empty source would downgrade every skill on the CV and
    // look like a model failure rather than the plumbing failure it is.
    const profile = profileWithSkills([skill('Go', 'demonstrated', 'wrote Go')]);

    expect(() => verifyEvidence(profile, '')).toThrow(/requires the source text/);
    expect(() => verifyEvidence(profile, '   \n ')).toThrow(TypeError);
    expect(() => verifyEvidence(profile, /** @type {any} */ (null))).toThrow(TypeError);
  });

  it('produces something the verified profile schema accepts', () => {
    const { profile } = verifyEvidence(
      profileWithSkills([
        skill('Node.js', 'demonstrated', 'Rebuilt the shipment tracking service in Node.js'),
        skill('Terraform', 'listed_only', null),
      ]),
      CV_TEXT,
    );

    const parsed = verifiedProfileSchema.safeParse({ ...profile, computedYearsExperience: 4.5 });
    expect(parsed.success).toBe(true);
  });
});
