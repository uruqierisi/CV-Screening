/**
 * Score plus elimination to a tier.
 *
 * Two properties matter here, and both are load-bearing:
 *
 * 1. **isEliminated is checked first and unconditionally**, before any threshold
 *    is read. Elimination is categorical: it is not a very low score and must not
 *    be expressible as one. The candidate keeps the score they earned - the
 *    dashboard shows "eliminated, but would have scored 88" - and only the tier
 *    is forced.
 *
 * 2. **The bands are half-open**: [85, 100] strong, [65, 85) potential,
 *    [0, 65) unmatched. No gap and no overlap: 84.9 is Potential, 85.0 is Strong.
 *
 * The thresholds themselves are asserted, not validated - nobody has checked that
 * 85 means "strong" to a real recruiter (plan section 8). What this function
 * guarantees is that whatever the numbers are, they are applied identically every
 * time, in exactly one place, and that the frontend never recomputes them.
 */

import { SCORE_MAX, SCORE_MIN, TIERS, TIER_THRESHOLDS } from '../constants.js';

/**
 * @param {number} score 0..100
 * @param {boolean} isEliminated
 * @returns {import('../constants.js').FitCategory}
 * @throws {TypeError} if isEliminated is not a boolean, or if a non-eliminated
 *   candidate has a score that is not a finite number in 0..100
 */
export function assignTier(score, isEliminated) {
  if (typeof isEliminated !== 'boolean') {
    // Truthiness would make assignTier(85, "no") return unmatched, which is the
    // sort of bug that survives review. One comparison, and it reads no
    // threshold, so the guarantee below is untouched.
    throw new TypeError('isEliminated must be a boolean');
  }

  if (isEliminated) {
    // Before the score is so much as looked at. An eliminated candidate whose
    // score is unusable is still unmatched: never a crash, never a promotion.
    return TIERS.UNMATCHED;
  }

  if (
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    score < SCORE_MIN ||
    score > SCORE_MAX
  ) {
    throw new TypeError(`score must be a finite number in ${SCORE_MIN}..${SCORE_MAX}`);
  }

  if (score >= TIER_THRESHOLDS.STRONG_MATCH_MIN) {
    return TIERS.STRONG_MATCH;
  }

  if (score >= TIER_THRESHOLDS.POTENTIAL_MATCH_MIN) {
    return TIERS.POTENTIAL_MATCH;
  }

  return TIERS.UNMATCHED;
}
