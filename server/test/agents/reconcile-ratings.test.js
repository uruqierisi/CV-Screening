import { describe, expect, it, vi } from 'vitest';
import { reconcileRatings } from '../../src/agents/scoring/reconcile-ratings.js';
import {
  DuplicateRatingError,
  IncompleteEvaluationError,
} from '../../src/agents/errors.js';

/**
 * The three reconciliation behaviours from plan section 5.3, tested as three
 * different things rather than one, because collapsing any two of them is
 * exactly the mistake this module exists to prevent.
 */

const CRITERIA = [
  { id: 'c-a', label: 'A', description: '', weight: 50, position: 0 },
  { id: 'c-b', label: 'B', description: '', weight: 30, position: 1 },
  { id: 'c-c', label: 'C', description: '', weight: 20, position: 2 },
];

/**
 * @param {string} criterionId
 * @param {number} rating
 */
function ratingFor(criterionId, rating) {
  return { criterionId, rating, reason: `because ${criterionId}`, evidence: null };
}

describe('reconcileRatings', () => {
  it('returns one entry per criterion, in the role order', () => {
    const { matched, unknownIds } = reconcileRatings(CRITERIA, [
      ratingFor('c-c', 3),
      ratingFor('c-a', 9),
      ratingFor('c-b', 5),
    ]);

    expect(matched.map((entry) => entry.criterion.id)).toEqual(['c-a', 'c-b', 'c-c']);
    expect(matched.map((entry) => entry.rating.rating)).toEqual([9, 5, 3]);
    expect(unknownIds).toEqual([]);
  });

  describe('a rating for a criterion the role does not define', () => {
    it('is dropped and recorded rather than failing the candidate', () => {
      const { matched, unknownIds } = reconcileRatings(CRITERIA, [
        ratingFor('c-a', 9),
        ratingFor('c-removed', 10),
        ratingFor('c-b', 5),
        ratingFor('c-c', 3),
      ]);

      expect(unknownIds).toEqual(['c-removed']);
      expect(matched).toHaveLength(3);
      expect(matched.map((entry) => entry.criterion.id)).toEqual(['c-a', 'c-b', 'c-c']);
    });

    it('is warned about, with the ids and nothing else', () => {
      const logger = { warn: vi.fn() };

      reconcileRatings(
        CRITERIA,
        [ratingFor('c-a', 9), ratingFor('c-b', 5), ratingFor('c-c', 3), ratingFor('c-gone', 1)],
        { logger },
      );

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('dropped ratings'), {
        unknownIds: ['c-gone'],
      });
    });

    it('does not require a logger to be passed', () => {
      expect(() =>
        reconcileRatings(CRITERIA, [
          ratingFor('c-a', 9),
          ratingFor('c-b', 5),
          ratingFor('c-c', 3),
          ratingFor('c-gone', 1),
        ]),
      ).not.toThrow();
    });

    it('says nothing when there is nothing to say', () => {
      const logger = { warn: vi.fn() };

      reconcileRatings(CRITERIA, [ratingFor('c-a', 9), ratingFor('c-b', 5), ratingFor('c-c', 3)], {
        logger,
      });

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('a criterion missing from the response', () => {
    it('is a hard failure naming the exact ids', () => {
      let thrown;
      try {
        reconcileRatings(CRITERIA, [ratingFor('c-a', 9)]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(IncompleteEvaluationError);
      expect(thrown.missingCriterionIds).toEqual(['c-b', 'c-c']);
      expect(thrown.code).toBe('AGENT_INCOMPLETE_EVAL');
      expect(thrown.retryable).toBe(false);
      expect(thrown.message).toContain('c-b, c-c');
    });

    it('reports missing ids in the role order, not the response order', () => {
      const error = getError(() => reconcileRatings(CRITERIA, [ratingFor('c-b', 4)]));
      expect(error.missingCriterionIds).toEqual(['c-a', 'c-c']);
    });

    it('fails an empty response rather than scoring it as zero', () => {
      const error = getError(() => reconcileRatings(CRITERIA, []));
      expect(error).toBeInstanceOf(IncompleteEvaluationError);
      expect(error.missingCriterionIds).toEqual(['c-a', 'c-b', 'c-c']);
    });
  });

  describe('a duplicate criterionId', () => {
    it('is a hard failure, not a first-wins or last-wins guess', () => {
      const error = getError(() =>
        reconcileRatings(CRITERIA, [
          ratingFor('c-a', 9),
          ratingFor('c-a', 2),
          ratingFor('c-b', 5),
          ratingFor('c-c', 3),
        ]),
      );

      expect(error).toBeInstanceOf(DuplicateRatingError);
      expect(error.duplicateCriterionIds).toEqual(['c-a']);
      expect(error.code).toBe('AGENT_BAD_OUTPUT');
    });

    it('reports each duplicated id once, however many times it repeats', () => {
      const error = getError(() =>
        reconcileRatings(CRITERIA, [
          ratingFor('c-a', 9),
          ratingFor('c-a', 2),
          ratingFor('c-a', 1),
          ratingFor('c-b', 5),
          ratingFor('c-c', 3),
        ]),
      );

      expect(error.duplicateCriterionIds).toEqual(['c-a']);
    });

    it('fires before the completeness check, because the response is malformed either way', () => {
      const error = getError(() =>
        reconcileRatings(CRITERIA, [ratingFor('c-a', 9), ratingFor('c-a', 2)]),
      );
      expect(error).toBeInstanceOf(DuplicateRatingError);
    });

    it('counts a repeated unknown id too', () => {
      const error = getError(() =>
        reconcileRatings(CRITERIA, [
          ratingFor('c-a', 9),
          ratingFor('c-b', 5),
          ratingFor('c-c', 3),
          ratingFor('c-invented', 10),
          ratingFor('c-invented', 10),
        ]),
      );
      expect(error).toBeInstanceOf(DuplicateRatingError);
      expect(error.duplicateCriterionIds).toEqual(['c-invented']);
    });
  });

  describe('programmer errors', () => {
    it('rejects a non-array criteria list', () => {
      expect(() => reconcileRatings(/** @type {any} */ (null), [])).toThrow(TypeError);
    });

    it('rejects a non-array ratings list', () => {
      expect(() => reconcileRatings(CRITERIA, /** @type {any} */ ({}))).toThrow(
        /ratings must be an array/,
      );
    });
  });
});

/**
 * @param {() => unknown} fn
 * @returns {any}
 */
function getError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, and it did not');
}
