import { describe, expect, test } from 'vitest';
import { reconcileMatrix, scoreDivisor } from './matrix.js';

/** The `scoring` block as `GET /api/v1/config` actually returns it. */
const SCORING = {
  requiredWeightSum: 100,
  weightMin: 1,
  weightMax: 100,
  ratingMin: 0,
  ratingMax: 10,
  scoreMin: 0,
  scoreMax: 100,
};

/**
 * The matrix from the one candidate screened end to end against the live
 * pipeline, transcribed from the API response. Ratings 3/7/7/6/3/2 over weights
 * 30/20/20/15/10/5, scoreRaw 500, stored match score 50.
 */
const REAL_MATRIX = {
  scoreRaw: 500,
  computedAt: '2026-08-20T11:51:46.733Z',
  criteria: [
    {
      criterionId: '570db4b4',
      label: 'Backend engineering depth (Node.js)',
      weight: 30,
      rating: 3,
      weightedPoints: 90,
      reason: 'Node.js appears only as a listed skill.',
      evidence: "Skills: 'Node.js' evidenceType: listed_only",
    },
    {
      criterionId: '924dd912',
      label: 'API and distributed systems design',
      weight: 20,
      rating: 7,
      weightedPoints: 140,
      reason: 'Designed an idempotency layer.',
      evidence: "'Designed the idempotency layer behind the public payments API.'",
    },
    {
      criterionId: '52a50da7',
      label: 'Relational data modelling',
      weight: 20,
      rating: 7,
      weightedPoints: 140,
      reason: 'Led a PostgreSQL 14 migration.',
      evidence: "'Led the migration of the ledger service to PostgreSQL 14'",
    },
    {
      criterionId: '217ed0b8',
      label: 'Testing and code quality',
      weight: 15,
      rating: 6,
      weightedPoints: 90,
      reason: 'Contract testing across six services.',
      evidence: "'Introduced contract testing across six internal services.'",
    },
    {
      criterionId: 'fdf57e02',
      label: 'Cloud infrastructure and CI/CD',
      weight: 10,
      rating: 3,
      weightedPoints: 30,
      reason: 'Cloud skills are listed only.',
      evidence: "skills 'Docker', 'Terraform' both listed_only",
    },
    {
      criterionId: '0eba2827',
      label: 'Collaboration and written communication',
      weight: 5,
      rating: 2,
      weightedPoints: 10,
      reason: 'No written artefacts described.',
      evidence: null,
    },
  ],
};

describe('scoreDivisor', () => {
  test('falls out of the config numbers rather than being typed in', () => {
    // ratingMax 10 x requiredWeightSum 100 = a raw range of 0..1000 against a
    // score range of 0..100.
    expect(scoreDivisor(SCORING)).toBe(10);
  });

  test('tracks a server that changes its rating scale', () => {
    expect(scoreDivisor({ ...SCORING, ratingMax: 5 })).toBe(5);
    expect(scoreDivisor({ ...SCORING, scoreMax: 1000 })).toBe(1);
  });
});

describe('reconcileMatrix', () => {
  test('the contributions add up to scoreRaw, and scoreRaw divides to the score', () => {
    const result = reconcileMatrix(REAL_MATRIX, 10);

    expect(result.pointsSum).toBe(500);
    expect(result.pointsSum).toBe(result.scoreRaw);
    expect(result.score).toBe(50);
    expect(result.reconciles).toBe(true);
  });

  test('the weights total the required sum', () => {
    expect(reconcileMatrix(REAL_MATRIX, 10).weightSum).toBe(100);
  });

  test('every row states rating x weight', () => {
    for (const row of reconcileMatrix(REAL_MATRIX, 10).rows) {
      expect(row.weightedPoints).toBe(row.rating * row.weight);
      expect(row.arithmeticHolds).toBe(true);
    }
  });

  test('rows keep the order the server sent, which is the role criterion order', () => {
    expect(reconcileMatrix(REAL_MATRIX, 10).rows.map((row) => row.label)).toEqual(
      REAL_MATRIX.criteria.map((row) => row.label),
    );
  });

  test('a row whose arithmetic is wrong fails the reconciliation', () => {
    const tampered = {
      ...REAL_MATRIX,
      criteria: REAL_MATRIX.criteria.map((row, index) =>
        index === 0 ? { ...row, weightedPoints: 300 } : row,
      ),
    };
    const result = reconcileMatrix(tampered, 10);

    expect(result.rows[0].arithmeticHolds).toBe(false);
    expect(result.reconciles).toBe(false);
  });

  test('a total that does not match scoreRaw fails the reconciliation', () => {
    const result = reconcileMatrix({ ...REAL_MATRIX, scoreRaw: 501 }, 10);

    expect(result.pointsSum).toBe(500);
    expect(result.reconciles).toBe(false);
  });

  test('missing evidence is carried as null rather than dropped', () => {
    const rows = reconcileMatrix(REAL_MATRIX, 10).rows;
    expect(rows[rows.length - 1].evidence).toBeNull();
    expect(rows[0].evidence).toContain('listed_only');
  });

  test('an unscored candidate has no matrix to reconcile', () => {
    expect(reconcileMatrix(null, 10)).toBeNull();
    expect(reconcileMatrix(undefined, 10)).toBeNull();
  });

  test('an all-zero evaluation reconciles at zero rather than dividing by nothing', () => {
    const zeroed = {
      scoreRaw: 0,
      computedAt: REAL_MATRIX.computedAt,
      criteria: REAL_MATRIX.criteria.map((row) => ({ ...row, rating: 0, weightedPoints: 0 })),
    };
    const result = reconcileMatrix(zeroed, 10);

    expect(result.score).toBe(0);
    expect(result.reconciles).toBe(true);
  });
});
