import { describe, expect, it } from 'vitest';
import {
  RANKING_DIRECTIONS,
  candidateRankingOrderBy,
} from '../src/repositories/candidateOrdering.js';

/**
 * Pure tests. The behaviour that matters - that this clause actually orders rows
 * the way the dashboard needs - is asserted against real data in
 * candidatesRepository.test.js. These assert the definition itself has not drifted.
 */

describe('candidateRankingOrderBy', () => {
  it('defaults to the dashboard ranking', () => {
    expect(candidateRankingOrderBy()).toBe('ORDER BY match_score DESC NULLS LAST, id DESC');
  });

  it('puts unscored candidates last in both directions', () => {
    for (const direction of RANKING_DIRECTIONS) {
      expect(candidateRankingOrderBy(direction)).toContain('NULLS LAST');
    }
  });

  it('always tie-breaks on id, so paging cannot skip or repeat a row', () => {
    for (const direction of RANKING_DIRECTIONS) {
      expect(candidateRankingOrderBy(direction)).toContain('id DESC');
    }
  });

  it('throws on an unknown direction rather than silently returning the default', () => {
    expect(() => candidateRankingOrderBy(/** @type {any} */ ('sideways'))).toThrow(
      /unknown ranking direction/,
    );
  });
});
