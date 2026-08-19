import { describe, expect, it, vi } from 'vitest';
import { scoreCandidate } from '../../src/agents/scoring/score-candidate.js';
import { InvalidRoleError } from '../../src/agents/errors.js';
import {
  GOLDEN_EVALUATION,
  GOLDEN_EXPECTED,
  GOLDEN_NOW_ISO,
  GOLDEN_PROFILE,
  GOLDEN_ROLE,
  deepFreeze,
} from './fixtures/golden.js';

/**
 * The composition root of the deterministic core, tested through the one
 * property the whole product rests on: the same inputs produce the same bytes,
 * and every number on the screen reconciles to the ones next to it.
 *
 * The fixture inputs are deep-frozen, so a stray mutation anywhere in the layer
 * throws rather than passing quietly.
 */

/**
 * @param {Partial<Record<string, any>>} [overrides]
 */
function scoreGolden(overrides = {}) {
  return scoreCandidate({
    role: GOLDEN_ROLE,
    profile: GOLDEN_PROFILE,
    evaluation: GOLDEN_EVALUATION,
    now: new Date(GOLDEN_NOW_ISO),
    ...overrides,
  });
}

describe('scoreCandidate', () => {
  it('produces the score worked out by hand from the weights', () => {
    const result = scoreGolden();

    expect(result.scoreRaw).toBe(GOLDEN_EXPECTED.scoreRaw);
    expect(result.score).toBe(GOLDEN_EXPECTED.score);
    expect(result.fitCategory).toBe(GOLDEN_EXPECTED.fitCategory);
    expect(result.eliminated).toBe(GOLDEN_EXPECTED.eliminated);
    expect(result.eliminatedBy).toBeNull();
    expect(result.scoredRoleVersion).toBe(4);
    expect(result.aiJustification).toBe(GOLDEN_EVALUATION.summary);
  });

  it('is byte-identical over a hundred runs', () => {
    const baseline = JSON.stringify(scoreGolden());

    for (let run = 0; run < 100; run += 1) {
      // A fresh Date each time, so the result cannot depend on object identity.
      expect(JSON.stringify(scoreGolden({ now: new Date(GOLDEN_NOW_ISO) }))).toBe(baseline);
    }
  });

  it('is byte-identical when the model returns its ratings in a different order', () => {
    const baseline = JSON.stringify(scoreGolden());
    const shuffles = [
      [5, 4, 3, 2, 1, 0],
      [2, 0, 4, 1, 5, 3],
      [1, 3, 5, 0, 2, 4],
    ];

    for (const order of shuffles) {
      const shuffled = { ...GOLDEN_EVALUATION, ratings: order.map((index) => GOLDEN_EVALUATION.ratings[index]) };
      expect(JSON.stringify(scoreGolden({ evaluation: shuffled }))).toBe(baseline);
    }
  });

  it('is byte-identical when the role arrives with its lists out of order', () => {
    const baseline = JSON.stringify(scoreGolden());
    const jumbledRole = deepFreeze({
      ...GOLDEN_ROLE,
      criteria: [...GOLDEN_ROLE.criteria].reverse(),
      eliminationRules: [...GOLDEN_ROLE.eliminationRules].reverse(),
    });

    expect(JSON.stringify(scoreGolden({ role: jumbledRole }))).toBe(baseline);
  });

  describe('the evaluation matrix', () => {
    it('is in the role order and carries the reason with the number', () => {
      const { evaluationMatrix } = scoreGolden();

      expect(evaluationMatrix.criteria.map((row) => row.criterionId)).toEqual([
        'c-node',
        'c-api',
        'c-data',
        'c-test',
        'c-cloud',
        'c-comms',
      ]);
      expect(evaluationMatrix.criteria[0]).toEqual({
        criterionId: 'c-node',
        label: 'Backend engineering depth (Node.js)',
        weight: 30,
        rating: 8,
        weightedPoints: 240,
        reason: 'Rebuilt a production Node.js service and quotes the latency result.',
        evidence: 'cutting p99 latency from 1.8s to 240ms',
      });
    });

    it('has a contribution column that sums to the score exactly', () => {
      const { evaluationMatrix, score, scoreRaw } = scoreGolden();
      const summed = evaluationMatrix.criteria.reduce((total, row) => total + row.weightedPoints, 0);

      expect(summed).toBe(scoreRaw);
      expect(summed).toBe(evaluationMatrix.scoreRaw);
      expect(summed / 10).toBe(score);
    });

    it('is stamped with the injected clock, not the real one', () => {
      const { evaluationMatrix, eliminationDetails } = scoreGolden({
        now: new Date('2001-09-09T01:46:40.000Z'),
      });

      expect(evaluationMatrix.computedAt).toBe('2001-09-09T01:46:40.000Z');
      expect(eliminationDetails.evaluatedAt).toBe('2001-09-09T01:46:40.000Z');
    });
  });

  describe('an eliminated candidate', () => {
    const abroad = deepFreeze({
      ...GOLDEN_PROFILE,
      location: { raw: 'Austin, Texas', city: 'Austin', region: 'TX', countryCode: 'US' },
    });

    it('keeps the score it earned and only loses the tier', () => {
      const result = scoreGolden({ profile: abroad });

      // The sentence the dashboard has to be able to say: "eliminated, but would
      // have scored 72.5".
      expect(result.score).toBe(GOLDEN_EXPECTED.score);
      expect(result.scoreRaw).toBe(GOLDEN_EXPECTED.scoreRaw);
      expect(result.eliminated).toBe(true);
      expect(result.fitCategory).toBe('unmatched');
      expect(result.eliminatedBy).toBe('Authorised to work in the UK, Ireland or Germany');
    });

    it('would have been a strong match on the same ratings', () => {
      const topRatings = deepFreeze({
        ...GOLDEN_EVALUATION,
        ratings: GOLDEN_EVALUATION.ratings.map((rating) => ({ ...rating, rating: 10 })),
      });

      expect(scoreGolden({ evaluation: topRatings }).fitCategory).toBe('strong_match');
      expect(scoreGolden({ evaluation: topRatings, profile: abroad })).toMatchObject({
        score: 100,
        fitCategory: 'unmatched',
        eliminated: true,
      });
    });

    it('reports the failing rule in full, so the row is not inexplicable', () => {
      const { eliminationDetails } = scoreGolden({ profile: abroad });

      expect(eliminationDetails.failures).toHaveLength(1);
      expect(eliminationDetails.failures[0].detail).toContain('US is not in GB, IE, DE');
      expect(eliminationDetails.results).toHaveLength(3);
      expect(eliminationDetails.results.map((result) => result.outcome)).toEqual([
        'pass',
        'pass',
        'fail',
      ]);
    });
  });

  it('badges an unchecked requirement without rejecting the candidate', () => {
    const noSkills = deepFreeze({ ...GOLDEN_PROFILE, skills: null });
    const result = scoreGolden({ profile: noSkills });

    expect(result.eliminated).toBe(false);
    expect(result.eliminationDetails.indeterminate).toHaveLength(1);
    expect(result.eliminationDetails.indeterminate[0].label).toBe(
      'Demonstrated production PostgreSQL experience',
    );
  });

  it('eliminates on an unchecked requirement the recruiter marked as hard', () => {
    // The location rule in the fixture carries on_missing: 'eliminate', which is
    // the opt-in decision 7-C describes for a legal requirement.
    const noLocation = deepFreeze({ ...GOLDEN_PROFILE, location: null });
    const result = scoreGolden({ profile: noLocation });

    expect(result.eliminated).toBe(true);
    expect(result.fitCategory).toBe('unmatched');
    expect(result.eliminationDetails.failures).toHaveLength(0);
    expect(result.eliminationDetails.indeterminate).toHaveLength(1);
  });

  it('drops a rating for a criterion the role no longer defines, and says so', () => {
    const logger = { warn: vi.fn() };
    const withStale = deepFreeze({
      ...GOLDEN_EVALUATION,
      ratings: [
        ...GOLDEN_EVALUATION.ratings,
        { criterionId: 'c-deleted', rating: 10, reason: 'from an older role version', evidence: null },
      ],
    });

    const result = scoreGolden({ evaluation: withStale, logger });

    expect(result.score).toBe(GOLDEN_EXPECTED.score);
    expect(result.unknownCriterionIds).toEqual(['c-deleted']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('treats a missing summary as no justification rather than inventing one', () => {
    const noSummary = deepFreeze({ ratings: GOLDEN_EVALUATION.ratings });
    expect(scoreGolden({ evaluation: noSummary }).aiJustification).toBeNull();
  });

  it('validates the role before it does anything else', () => {
    const brokenRole = deepFreeze({
      ...GOLDEN_ROLE,
      criteria: GOLDEN_ROLE.criteria.map((criterion) => ({ ...criterion, weight: 10 })),
    });

    expect(() => scoreGolden({ role: brokenRole })).toThrow(InvalidRoleError);
  });

  it('fails the candidate rather than scoring an incomplete evaluation', () => {
    const partial = deepFreeze({
      ...GOLDEN_EVALUATION,
      ratings: GOLDEN_EVALUATION.ratings.slice(0, 3),
    });

    expect(() => scoreGolden({ evaluation: partial })).toThrow(/missing a rating/);
  });

  it('never mutates its inputs', () => {
    const roleBefore = JSON.stringify(GOLDEN_ROLE);
    const profileBefore = JSON.stringify(GOLDEN_PROFILE);
    const evaluationBefore = JSON.stringify(GOLDEN_EVALUATION);

    scoreGolden();

    expect(JSON.stringify(GOLDEN_ROLE)).toBe(roleBefore);
    expect(JSON.stringify(GOLDEN_PROFILE)).toBe(profileBefore);
    expect(JSON.stringify(GOLDEN_EVALUATION)).toBe(evaluationBefore);
  });

  it('produces a result whose every number agrees with every other', () => {
    const result = scoreGolden();

    expect(result.evaluationMatrix.scoreRaw).toBe(result.scoreRaw);
    expect(result.score).toBe(result.scoreRaw / 10);
    expect(result.eliminationDetails.eliminated).toBe(result.eliminated);
    expect(result.eliminationDetails.eliminatedBy).toBe(result.eliminatedBy);
    expect(result.evaluationMatrix.criteria).toHaveLength(GOLDEN_ROLE.criteria.length);
  });
});
