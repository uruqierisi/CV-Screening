import { describe, expect, it } from 'vitest';
import { computeWeightedScore } from '../../src/agents/scoring/compute-score.js';
import { InvalidRatingError, InvalidRoleError } from '../../src/agents/errors.js';
import { SCORE_RAW_MAX, SCORE_RAW_MIN } from '../../src/agents/constants.js';

/**
 * The arithmetic. Expected values are written out, not derived, so a change to
 * the formula cannot quietly change the expectation with it.
 */

const CRITERIA = [
  { id: 'c-a', label: 'A', description: '', weight: 30, position: 0 },
  { id: 'c-b', label: 'B', description: '', weight: 25, position: 1 },
  { id: 'c-c', label: 'C', description: '', weight: 25, position: 2 },
  { id: 'c-d', label: 'D', description: '', weight: 20, position: 3 },
];

/**
 * @param {string} criterionId
 * @param {number} rating
 */
function ratingFor(criterionId, rating) {
  return { criterionId, rating, reason: 'r', evidence: null };
}

/**
 * @param {readonly {id: string}[]} criteria
 * @param {number} rating
 */
function allRated(criteria, rating) {
  return criteria.map((criterion) => ratingFor(criterion.id, rating));
}

describe('computeWeightedScore', () => {
  it('computes Sum(rating * weight) and divides by ten', () => {
    // 8*30 + 6*25 + 10*25 + 4*20 = 240 + 150 + 250 + 80 = 720
    const result = computeWeightedScore(CRITERIA, [
      ratingFor('c-a', 8),
      ratingFor('c-b', 6),
      ratingFor('c-c', 10),
      ratingFor('c-d', 4),
    ]);

    expect(result.scoreRaw).toBe(720);
    expect(result.score).toBe(72);
    expect(result.weightSum).toBe(100);
    expect(result.unknownIds).toEqual([]);
  });

  it('produces one exact decimal, with no floating-point residue', () => {
    // 7*30 + 8*25 + 8*25 + 9*20 = 210 + 200 + 200 + 180 = 790 -> 79.0
    // 7*30 + 8*25 + 9*25 + 9*20 = 210 + 200 + 225 + 180 = 815 -> 81.5
    const evenResult = computeWeightedScore(CRITERIA, [
      ratingFor('c-a', 7),
      ratingFor('c-b', 8),
      ratingFor('c-c', 8),
      ratingFor('c-d', 9),
    ]);
    const oddResult = computeWeightedScore(CRITERIA, [
      ratingFor('c-a', 7),
      ratingFor('c-b', 8),
      ratingFor('c-c', 9),
      ratingFor('c-d', 9),
    ]);

    expect(evenResult.score).toBe(79);
    expect(oddResult.score).toBe(81.5);
    expect(JSON.stringify(oddResult.score)).toBe('81.5');
  });

  it('scores all-zero ratings as 0', () => {
    const result = computeWeightedScore(CRITERIA, allRated(CRITERIA, 0));
    expect(result.scoreRaw).toBe(0);
    expect(result.score).toBe(0);
    expect(result.breakdown.every((entry) => entry.weightedPoints === 0)).toBe(true);
  });

  it('scores all-ten ratings as 100', () => {
    const result = computeWeightedScore(CRITERIA, allRated(CRITERIA, 10));
    expect(result.scoreRaw).toBe(1000);
    expect(result.score).toBe(100);
  });

  it('handles a role with a single criterion carrying the whole weight', () => {
    const single = [{ id: 'only', label: 'Only', description: '', weight: 100, position: 0 }];
    const result = computeWeightedScore(single, [ratingFor('only', 7)]);

    expect(result.scoreRaw).toBe(700);
    expect(result.score).toBe(70);
    expect(result.breakdown).toEqual([
      { criterionId: 'only', rating: 7, weight: 100, weightedPoints: 700 },
    ]);
  });

  describe('the breakdown', () => {
    it('is in the role order, never the response order', () => {
      const result = computeWeightedScore(CRITERIA, [
        ratingFor('c-d', 4),
        ratingFor('c-b', 6),
        ratingFor('c-c', 10),
        ratingFor('c-a', 8),
      ]);

      expect(result.breakdown.map((entry) => entry.criterionId)).toEqual([
        'c-a',
        'c-b',
        'c-c',
        'c-d',
      ]);
    });

    it('sums to scoreRaw exactly, which is what the Contribution column promises', () => {
      const result = computeWeightedScore(CRITERIA, [
        ratingFor('c-a', 3),
        ratingFor('c-b', 7),
        ratingFor('c-c', 5),
        ratingFor('c-d', 9),
      ]);

      const summed = result.breakdown.reduce((total, entry) => total + entry.weightedPoints, 0);
      expect(summed).toBe(result.scoreRaw);
      expect(summed / 10).toBe(result.score);
    });
  });

  it('produces byte-identical output for a shuffled response', () => {
    const ordered = [
      ratingFor('c-a', 8),
      ratingFor('c-b', 6),
      ratingFor('c-c', 10),
      ratingFor('c-d', 4),
    ];
    const baseline = JSON.stringify(computeWeightedScore(CRITERIA, ordered));

    // Every permutation of four ratings, not a single shuffled sample.
    for (const permutation of permutations(ordered)) {
      expect(JSON.stringify(computeWeightedScore(CRITERIA, permutation))).toBe(baseline);
    }
  });

  describe('rejects ratings that are not integers 0..10', () => {
    for (const bad of [11, -1, 7.5, 10.000001, Number.NaN, Number.POSITIVE_INFINITY]) {
      it(`throws on ${String(bad)}`, () => {
        expect(() =>
          computeWeightedScore(CRITERIA, [
            ratingFor('c-a', bad),
            ratingFor('c-b', 5),
            ratingFor('c-c', 5),
            ratingFor('c-d', 5),
          ]),
        ).toThrow(InvalidRatingError);
      });
    }

    it('throws on a rating that is not a number at all', () => {
      let thrown;
      try {
        computeWeightedScore(CRITERIA, [
          ratingFor('c-a', /** @type {any} */ ('8')),
          ratingFor('c-b', 5),
          ratingFor('c-c', 5),
          ratingFor('c-d', 5),
        ]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(InvalidRatingError);
      expect(thrown.criterionId).toBe('c-a');
      expect(thrown.code).toBe('AGENT_BAD_OUTPUT');
      // The offending value is only carried when it is a number: `details` goes
      // to the logs, and a string field is somewhere free text could hide.
      expect(thrown.details.rating).toBeNull();
    });

    it('names the criterion whose rating was bad', () => {
      let thrown;
      try {
        computeWeightedScore(CRITERIA, [
          ratingFor('c-a', 5),
          ratingFor('c-b', 5),
          ratingFor('c-c', 11),
          ratingFor('c-d', 5),
        ]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown.criterionId).toBe('c-c');
      expect(thrown.details.rating).toBe(11);
    });
  });

  describe('refuses a role it cannot score against', () => {
    it('throws when the weights do not sum to 100', () => {
      const broken = [
        { id: 'c-a', label: 'A', description: '', weight: 30, position: 0 },
        { id: 'c-b', label: 'B', description: '', weight: 50, position: 1 },
      ];

      let thrown;
      try {
        computeWeightedScore(broken, [ratingFor('c-a', 10), ratingFor('c-b', 10)]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(InvalidRoleError);
      expect(thrown.code).toBe('AGENT_INVALID_ROLE');
      expect(thrown.details.weightSum).toBe(80);
      expect(thrown.message).toContain('received 80');
    });

    it('throws on zero criteria rather than dividing by nothing', () => {
      expect(() => computeWeightedScore([], [])).toThrow(/zero criteria/);
    });

    it('checks the weights before it looks at the ratings', () => {
      // A role with broken weights and a response missing every rating must
      // report the role, because that is the thing an operator can fix.
      expect(() =>
        computeWeightedScore([{ id: 'x', label: 'X', description: '', weight: 7, position: 0 }], []),
      ).toThrow(InvalidRoleError);
    });
  });

  it('drops a rating for a criterion the role no longer defines', () => {
    const result = computeWeightedScore(CRITERIA, [
      ratingFor('c-a', 10),
      ratingFor('c-b', 10),
      ratingFor('c-c', 10),
      ratingFor('c-d', 10),
      ratingFor('c-deleted', 10),
    ]);

    expect(result.scoreRaw).toBe(1000);
    expect(result.unknownIds).toEqual(['c-deleted']);
    expect(result.breakdown).toHaveLength(4);
  });

  it('keeps scoreRaw inside 0..1000 across the whole input space', () => {
    // The range is a theorem given weights that sum to 100 and ratings in 0..10,
    // so it is asserted here rather than checked at runtime as unreachable code.
    let seed = 1;
    const nextRating = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 11;
    };

    for (const criteria of [CRITERIA, [{ id: 'solo', label: 'S', description: '', weight: 100, position: 0 }]]) {
      for (let run = 0; run < 500; run += 1) {
        const ratings = criteria.map((criterion) => ratingFor(criterion.id, nextRating()));
        const { score, scoreRaw } = computeWeightedScore(criteria, ratings);

        expect(Number.isInteger(scoreRaw)).toBe(true);
        expect(scoreRaw).toBeGreaterThanOrEqual(SCORE_RAW_MIN);
        expect(scoreRaw).toBeLessThanOrEqual(SCORE_RAW_MAX);
        expect(score).toBe(scoreRaw / 10);
        // At most one decimal place, always.
        expect(Math.round(score * 10)).toBe(scoreRaw);
      }
    }
  });
});

/**
 * @template T
 * @param {T[]} items
 * @returns {T[][]}
 */
function permutations(items) {
  if (items.length <= 1) {
    return [items];
  }

  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}
