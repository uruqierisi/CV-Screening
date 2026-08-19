import { describe, expect, it } from 'vitest';
import { assignTier } from '../../src/agents/scoring/tiers.js';
import { TIER_THRESHOLDS } from '../../src/agents/constants.js';

/**
 * Every boundary named in plan section 5.3, and every one of them again with the
 * candidate eliminated. The bands are half-open - [85, 100], [65, 85), [0, 65) -
 * so the interesting values are the ones either side of 65 and 85, and they are
 * spelled out individually rather than generated, because a table that computes
 * its own expectations can agree with a broken implementation.
 */

/** @type {[number, string][]} */
const BOUNDARIES = [
  [0, 'unmatched'],
  [64, 'unmatched'],
  [64.9, 'unmatched'],
  [65, 'potential_match'],
  [84, 'potential_match'],
  [84.9, 'potential_match'],
  [85, 'strong_match'],
  [86, 'strong_match'],
  [100, 'strong_match'],
];

describe('assignTier', () => {
  describe('not eliminated', () => {
    for (const [score, expected] of BOUNDARIES) {
      it(`scores ${score} as ${expected}`, () => {
        expect(assignTier(score, false)).toBe(expected);
      });
    }

    it('puts the exact threshold in the higher band, leaving no gap', () => {
      expect(assignTier(TIER_THRESHOLDS.POTENTIAL_MATCH_MIN, false)).toBe('potential_match');
      expect(assignTier(TIER_THRESHOLDS.STRONG_MATCH_MIN, false)).toBe('strong_match');
      expect(assignTier(TIER_THRESHOLDS.POTENTIAL_MATCH_MIN - 0.1, false)).toBe('unmatched');
      expect(assignTier(TIER_THRESHOLDS.STRONG_MATCH_MIN - 0.1, false)).toBe('potential_match');
    });
  });

  describe('eliminated', () => {
    for (const [score] of BOUNDARIES) {
      it(`forces ${score} to unmatched`, () => {
        expect(assignTier(score, true)).toBe('unmatched');
      });
    }

    it('never reads the score at all', () => {
      // The proof that elimination is checked first and unconditionally: these
      // scores would throw on the non-eliminated path. If a threshold comparison
      // were ever moved above the elimination check, this test is what fails.
      expect(assignTier(Number.NaN, true)).toBe('unmatched');
      expect(assignTier(1e9, true)).toBe('unmatched');
      expect(assignTier(/** @type {any} */ ('88'), true)).toBe('unmatched');
      expect(assignTier(/** @type {any} */ (undefined), true)).toBe('unmatched');
    });
  });

  describe('rejects input it cannot honestly tier', () => {
    it('requires isEliminated to be a real boolean', () => {
      // Truthiness here would let assignTier(85, 'no') return unmatched.
      expect(() => assignTier(85, /** @type {any} */ ('no'))).toThrow(TypeError);
      expect(() => assignTier(85, /** @type {any} */ (0))).toThrow(/isEliminated must be a boolean/);
      expect(() => assignTier(85, /** @type {any} */ (undefined))).toThrow(TypeError);
    });

    it('refuses a score that is not a finite number in 0..100', () => {
      expect(() => assignTier(Number.NaN, false)).toThrow(/score must be a finite number/);
      expect(() => assignTier(Number.POSITIVE_INFINITY, false)).toThrow(TypeError);
      expect(() => assignTier(-0.1, false)).toThrow(TypeError);
      expect(() => assignTier(100.1, false)).toThrow(TypeError);
      expect(() => assignTier(/** @type {any} */ ('85'), false)).toThrow(TypeError);
    });
  });
});
