import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { truncateAll } from '../helpers/database.js';
import { createRole, createScreeningJob } from '../helpers/fixtures.js';
import { backfillRatingText, cleanMatrix } from '../../src/scripts/backfillRatingText.js';

/**
 * The one-off cleanup, against a real row.
 *
 * `test/agents/normalize-ratings.test.js` proves the rule. This proves the
 * plumbing around it: that a stored matrix is read, cleaned, written back as
 * jsonb, and that everything else in the row survives the round trip. The last
 * part is the one worth a database - the matrix carries weights, points and a
 * scoreRaw the dashboard reconciles against, and a backfill that quietly dropped
 * one of them would be a much worse bug than the artifact it removes.
 */

/** A matrix in the shape `scoring/score-candidate.js` writes, with the artifact. */
function matrixWithArtifact() {
  return {
    scoreRaw: 74,
    computedAt: '2026-08-20T10:00:00.000Z',
    criteria: [
      {
        criterionId: 'c1',
        label: 'Backend depth',
        weight: 5,
        rating: 8,
        weightedPoints: 40,
        reason: 'Ran the payments platform"},',
        evidence: 'Led the payments platform team of six engineers"},',
      },
      {
        criterionId: 'c2',
        label: 'Data modelling',
        weight: 4,
        rating: 6,
        weightedPoints: 24,
        reason: 'Designed the ledger schema.',
        evidence: null,
      },
    ],
  };
}

/**
 * @param {Record<string, any>} matrix
 * @returns {Promise<string>} the candidate id
 */
async function storeCandidateWithMatrix(matrix) {
  const { role } = await createRole();
  const { candidates } = await createScreeningJob({ roleId: role.id });
  const candidateId = candidates[0].id;

  await pool.query('UPDATE candidates SET evaluation_matrix = $2::jsonb WHERE id = $1', [
    candidateId,
    JSON.stringify(matrix),
  ]);

  return candidateId;
}

/** @param {string} id */
async function readMatrix(id) {
  const { rows } = await pool.query('SELECT evaluation_matrix FROM candidates WHERE id = $1', [id]);
  return rows[0].evaluation_matrix;
}

const silent = () => {};

beforeEach(async () => {
  await truncateAll();
});

afterEach(async () => {
  await truncateAll();
});

describe('cleanMatrix', () => {
  it('returns the same object when there is nothing to clean', () => {
    const matrix = { scoreRaw: 10, criteria: [{ reason: 'Fine.', evidence: 'Also fine.' }] };

    expect(cleanMatrix(matrix).matrix).toBe(matrix);
    expect(cleanMatrix(matrix).changed).toBe(0);
  });

  it('leaves a matrix with no criteria array alone', () => {
    const matrix = { scoreRaw: 0 };

    expect(cleanMatrix(matrix).changed).toBe(0);
    expect(cleanMatrix(null).changed).toBe(0);
  });
});

describe('backfillRatingText, against stored rows', () => {
  it('cleans both columns and leaves the rest of the matrix intact', async () => {
    const id = await storeCandidateWithMatrix(matrixWithArtifact());

    const result = await backfillRatingText({ log: silent });

    expect(result).toEqual({ scanned: 1, candidates: 1, rows: 1 });

    const matrix = await readMatrix(id);
    expect(matrix.criteria[0].reason).toBe('Ran the payments platform');
    expect(matrix.criteria[0].evidence).toBe('Led the payments platform team of six engineers');

    // The arithmetic the dashboard reconciles against must survive untouched.
    expect(matrix.scoreRaw).toBe(74);
    expect(matrix.computedAt).toBe('2026-08-20T10:00:00.000Z');
    expect(matrix.criteria[0].weight).toBe(5);
    expect(matrix.criteria[0].rating).toBe(8);
    expect(matrix.criteria[0].weightedPoints).toBe(40);
    expect(matrix.criteria[1]).toEqual({
      criterionId: 'c2',
      label: 'Data modelling',
      weight: 4,
      rating: 6,
      weightedPoints: 24,
      reason: 'Designed the ledger schema.',
      evidence: null,
    });
  });

  it('writes nothing on a dry run', async () => {
    const id = await storeCandidateWithMatrix(matrixWithArtifact());

    const result = await backfillRatingText({ dryRun: true, log: silent });

    expect(result).toEqual({ scanned: 1, candidates: 1, rows: 1 });
    expect((await readMatrix(id)).criteria[0].evidence).toBe(
      'Led the payments platform team of six engineers"},',
    );
  });

  it('is safe to run twice', async () => {
    await storeCandidateWithMatrix(matrixWithArtifact());

    await backfillRatingText({ log: silent });
    const second = await backfillRatingText({ log: silent });

    expect(second).toEqual({ scanned: 1, candidates: 0, rows: 0 });
  });

  it('leaves an already-clean candidate alone', async () => {
    const clean = matrixWithArtifact();
    clean.criteria[0].reason = 'Ran the payments platform.';
    clean.criteria[0].evidence = 'Led the payments platform team of six engineers.';
    await storeCandidateWithMatrix(clean);

    expect(await backfillRatingText({ log: silent })).toEqual({
      scanned: 1,
      candidates: 0,
      rows: 0,
    });
  });
});
