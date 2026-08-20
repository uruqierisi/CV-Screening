import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/api.js';
import { pool, truncateAll } from '../helpers/database.js';
import { createRole, createScreeningJob, driveCandidateToDone } from '../helpers/fixtures.js';
import { markCandidateFailed, markCandidateParsing } from '../../src/repositories/candidateStatusRepository.js';

/**
 * The dashboard's three reads: the ranked list, the poll, and the detail.
 *
 * Ordering is asserted here rather than only in the repository suite because the
 * ordering rule is the product: not-yet-scored candidates sorting last in BOTH
 * directions is what stops an in-progress batch pushing real results off page 1.
 */

/** @type {import('fastify').FastifyInstance} */
let app;

beforeEach(async () => {
  await truncateAll();
  app = await buildTestApp();
});

afterAll(async () => {
  await pool.end();
});

/**
 * A role with four candidates: three scored, one still pending.
 *
 * @returns {Promise<{ roleId: string, jobId: string, ids: string[] }>}
 */
async function seedScoredCandidates() {
  const { role } = await createRole();
  const { job, candidates } = await createScreeningJob({
    roleId: role.id,
    candidates: [{}, {}, {}, {}],
  });

  await driveCandidateToDone(candidates[0].id, {
    candidateName: 'Alice Strong',
    matchScore: 91.5,
    fitCategory: 'strong_match',
    aiJustification: 'Deep backend experience with demonstrated PostgreSQL work.',
  });
  await driveCandidateToDone(candidates[1].id, {
    candidateName: 'Bob Potential',
    matchScore: 70.0,
    fitCategory: 'potential_match',
  });
  await driveCandidateToDone(candidates[2].id, {
    candidateName: 'Carol Eliminated',
    matchScore: 88.0,
    fitCategory: 'unmatched',
    eliminated: true,
    eliminatedBy: 'Current RN licence',
  });

  return { roleId: role.id, jobId: job.id, ids: candidates.map((c) => c.id) };
}

describe('GET /api/v1/candidates', () => {
  it('ranks by score descending with unscored candidates last', async () => {
    const { roleId } = await seedScoredCandidates();

    const response = await app.inject({ method: 'GET', url: `/api/v1/candidates?roleId=${roleId}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((c) => c.matchScore)).toEqual([91.5, 88, 70, null]);
  });

  it('keeps unscored candidates last in ascending order too', async () => {
    const { roleId } = await seedScoredCandidates();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates?roleId=${roleId}&sort=asc`,
    });

    // NULLS LAST in both directions. Without it, an in-progress batch would push
    // every real result off the first page of a worst-first view.
    expect(response.json().data.map((c) => c.matchScore)).toEqual([70, 88, 91.5, null]);
  });

  it('reports tier counts across the whole filtered set, not the page', async () => {
    const { roleId } = await seedScoredCandidates();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates?roleId=${roleId}&pageSize=1`,
    });

    const { data, meta } = response.json();
    expect(data).toHaveLength(1);
    // A 25-row page cannot tell a recruiter how many Strong Matches exist, and
    // that number is the header of the control they are about to press.
    expect(meta.counts).toEqual({ strong_match: 1, potential_match: 1, unmatched: 1 });
    expect(meta).toMatchObject({ page: 1, pageSize: 1, total: 4, totalPages: 4 });
  });

  it('keeps the tier counts intact when filtering to one tier', async () => {
    const { roleId } = await seedScoredCandidates();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates?roleId=${roleId}&fitCategory=strong_match`,
    });

    expect(response.json().data).toHaveLength(1);
    // Filtering to one tier and then counting tiers would return that tier and
    // two zeroes, which is useless as the header of the filter control itself.
    expect(response.json().meta.counts).toEqual({
      strong_match: 1,
      potential_match: 1,
      unmatched: 1,
    });
  });

  it('filters by status', async () => {
    const { roleId } = await seedScoredCandidates();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates?roleId=${roleId}&status=pending`,
    });

    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].status).toBe('pending');
  });

  it('filters by job', async () => {
    const { roleId, jobId } = await seedScoredCandidates();
    await createScreeningJob({ roleId, candidates: [{}] });

    const response = await app.inject({ method: 'GET', url: `/api/v1/candidates?jobId=${jobId}` });
    expect(response.json().meta.total).toBe(4);
  });

  it('shows an eliminated candidate with its score and the rule that removed it', async () => {
    const { roleId } = await seedScoredCandidates();

    const response = await app.inject({ method: 'GET', url: `/api/v1/candidates?roleId=${roleId}` });
    const carol = response.json().data.find((c) => c.candidateName === 'Carol Eliminated');

    // "88 points, Unmatched, no reason" is what makes a recruiter stop trusting
    // the tool.
    expect(carol).toMatchObject({
      matchScore: 88,
      fitCategory: 'unmatched',
      eliminated: true,
      eliminatedBy: 'Current RN licence',
    });
  });

  it('answers one request for "still working, plus failed" - the panel that used to be four', async () => {
    const { roleId, ids } = await seedScoredCandidates();
    await markCandidateParsing(pool, ids[3]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates?roleId=${roleId}&statusIn=pending,parsing,evaluating,failed`,
    });

    expect(response.statusCode).toBe(200);
    // The dashboard was issuing four parallel filtered requests to build this
    // list. Four requests to express one filter is the API being wrong.
    expect(response.json().data.map((c) => c.id)).toEqual([ids[3]]);
    expect(response.json().meta.total).toBe(1);
  });

  it('keeps the single status param working beside it', async () => {
    const { roleId } = await seedScoredCandidates();

    const single = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates?roleId=${roleId}&status=done`,
    });
    const asSet = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates?roleId=${roleId}&statusIn=done`,
    });

    expect(single.json().data.map((c) => c.id)).toEqual(asSet.json().data.map((c) => c.id));
    expect(single.json().data).toHaveLength(3);
  });

  it('rejects a statusIn value outside the column CHECK', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/candidates?statusIn=done,queued',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a statusIn longer than the vocabulary rather than growing the query', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/candidates?statusIn=done,done,done,done,done,done',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('treats a statusIn injection attempt as a validation failure, not as SQL', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates?statusIn=${encodeURIComponent("done') OR '1'='1")}`,
    });

    expect(response.statusCode).toBe(400);
    // And the table is still there, which the next assertion needs.
    expect((await pool.query('SELECT count(*) FROM candidates')).rows[0].count).toBeDefined();
  });

  it('rejects a sort value that is not one of the two ranking directions', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/candidates?sort=match_score' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /api/v1/candidates/statuses', () => {
  it('returns the poll projection for the ids on screen', async () => {
    const { ids } = await seedScoredCandidates();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates/statuses?ids=${ids[0]},${ids[3]}`,
    });

    expect(response.statusCode).toBe(200);
    const { data, meta } = response.json();
    expect(data).toHaveLength(2);
    expect(Object.keys(data[0]).sort()).toEqual(
      [
        'candidateName',
        'completedAt',
        'eliminated',
        'eliminatedBy',
        'errorCode',
        'fitCategory',
        'id',
        'matchScore',
        'status',
        'updatedAt',
      ].sort(),
    );
    expect(meta).toEqual({ requested: 2, found: 2 });
  });

  it('reports a shortfall so a client stops polling ids that have gone', async () => {
    const { ids } = await seedScoredCandidates();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates/statuses?ids=${ids[0]},11111111-2222-4333-8444-555555555555`,
    });

    expect(response.json().meta).toEqual({ requested: 2, found: 1 });
  });

  it('is routed before /candidates/:candidateId', async () => {
    // Otherwise `statuses` is parsed as a candidate id, fails its uuid check,
    // and the poll returns 400 for no visible reason.
    const { ids } = await seedScoredCandidates();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates/statuses?ids=${ids[0]}`,
    });
    expect(response.statusCode).toBe(200);
  });

  it('400s an id list that is not all uuids', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/candidates/statuses?ids=nope' });
    expect(response.statusCode).toBe(400);
  });

  it('400s a missing id list', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/candidates/statuses' });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/v1/candidates/:candidateId', () => {
  it('carries aiJustification - the contract gap plan section 3 left open', async () => {
    const { ids } = await seedScoredCandidates();

    const response = await app.inject({ method: 'GET', url: `/api/v1/candidates/${ids[0]}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.aiJustification).toBe(
      'Deep backend experience with demonstrated PostgreSQL work.',
    );
  });

  it('carries the profile, the matrix and the elimination details', async () => {
    const { ids } = await seedScoredCandidates();
    const detail = (await app.inject({ method: 'GET', url: `/api/v1/candidates/${ids[0]}` })).json()
      .data;

    expect(detail.parsedProfile).toBeTruthy();
    expect(detail.evaluationMatrix).toBeTruthy();
    expect(detail.eliminationDetails).toBeTruthy();
    expect(detail.scoredRoleVersion).toBe(1);
  });

  it('excludes rawText unless it is asked for', async () => {
    const { ids } = await seedScoredCandidates();

    const without = await app.inject({ method: 'GET', url: `/api/v1/candidates/${ids[0]}` });
    expect(without.json().data).not.toHaveProperty('rawText');

    const withText = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates/${ids[0]}?includeRawText=true`,
    });
    expect(withText.json().data.rawText).toContain('Jane Doe');
  });

  it('returns a failed candidate inside a 200, with its worker-side code', async () => {
    const { ids } = await seedScoredCandidates();
    await markCandidateParsing(pool, ids[3]);
    await markCandidateFailed(pool, {
      candidateId: ids[3],
      errorCode: 'EMPTY_DOCUMENT',
      errorMessage: 'This PDF appears to be a scanned image; no extractable text layer was found.',
    });

    const response = await app.inject({ method: 'GET', url: `/api/v1/candidates/${ids[3]}` });

    // A candidate that failed to screen is a successful read of a failed
    // candidate. The worker-side namespace is never mapped to an HTTP status.
    expect(response.statusCode).toBe(200);
    expect(response.json().data.errorCode).toBe('EMPTY_DOCUMENT');
    expect(response.json().data.errorMessage).toContain('scanned image');
  });

  it('404s an unknown candidate', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/candidates/11111111-2222-4333-8444-555555555555',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('CANDIDATE_NOT_FOUND');
  });

  it('400s an id that is not a uuid', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/candidates/nope' });
    expect(response.statusCode).toBe(400);
  });
});
