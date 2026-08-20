import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool, truncateAll } from './helpers/database.js';
import { candidateInput, createRole, createScreeningJob, driveCandidateToDone } from './helpers/fixtures.js';
import { withTransaction } from '../src/db/withTransaction.js';
import {
  markCandidateEvaluating,
  markCandidateFailed,
  markCandidateParsing,
} from '../src/repositories/candidateStatusRepository.js';
import { insertCandidates } from '../src/repositories/candidatesRepository.js';
import {
  countCandidates,
  countCandidatesByFitCategory,
  findCandidateById,
  findCandidateStatusesByIds,
  findDuplicateCandidates,
  findStuckCandidates,
  listRankedCandidates,
} from '../src/repositories/candidatesRepository.js';

beforeEach(truncateAll);

describe('insertCandidates', () => {
  it('inserts a batch in one statement and returns them in the order supplied', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({
      roleId: role.id,
      candidates: [
        { originalFilename: 'first.pdf' },
        { originalFilename: 'second.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        { originalFilename: 'third.txt', mimeType: 'text/plain' },
      ],
    });

    expect(candidates.map((c) => c.originalFilename)).toEqual([
      'first.pdf',
      'second.docx',
      'third.txt',
    ]);
  });

  it('starts every candidate pending, unscored and not eliminated', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id });

    expect(candidates[0]).toMatchObject({
      status: 'pending',
      matchScore: null,
      fitCategory: null,
      candidateName: null,
      eliminated: false,
      attempts: 0,
      completedAt: null,
    });
  });

  it('honours a caller-supplied id, because the file was already written under it', async () => {
    const { role } = await createRole();
    const id = randomUUID();
    const { candidates } = await createScreeningJob({ roleId: role.id, candidates: [{ id }] });

    expect(candidates[0].id).toBe(id);
    expect(candidates[0].storagePath).toBe(`${id}.pdf`);
  });

  it('rejects a mime type outside the extraction allowlist', async () => {
    const { role } = await createRole();

    await expect(
      createScreeningJob({
        roleId: role.id,
        candidates: [{ mimeType: 'application/zip' }],
      }),
    ).rejects.toMatchObject({ constraint: 'candidates_mime_type_check' });
  });

  it('returns an empty array without touching the database for an empty batch', async () => {
    const { role } = await createRole();
    const inserted = await withTransaction((client) =>
      insertCandidates(client, { roleId: role.id, jobId: randomUUID(), candidates: [] }),
    );

    expect(inserted).toEqual([]);
  });
});

describe('findCandidateById', () => {
  it('excludes raw_text unless it is asked for', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id });
    await driveCandidateToDone(candidates[0].id);

    const withoutText = await findCandidateById(pool, candidates[0].id);
    const withText = await findCandidateById(pool, candidates[0].id, { includeRawText: true });

    expect(withoutText).not.toHaveProperty('rawText');
    expect(withText?.rawText).toContain('Jane Doe');
  });

  it('returns null for an unknown id', async () => {
    expect(await findCandidateById(pool, randomUUID())).toBeNull();
  });

  it('round-trips jsonb columns as objects', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id });
    await driveCandidateToDone(candidates[0].id);

    const candidate = await findCandidateById(pool, candidates[0].id);
    expect(candidate?.evaluationMatrix).toEqual({ scoreRaw: 880, criteria: [] });
  });

  it('returns match_score as a number, not a string', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id });
    await driveCandidateToDone(candidates[0].id, { matchScore: 84.7 });

    const candidate = await findCandidateById(pool, candidates[0].id);
    expect(candidate?.matchScore).toBe(84.7);
  });
});

describe('listRankedCandidates', () => {
  /**
   * @returns {Promise<{ roleId: string, ids: Record<string, string> }>}
   */
  async function seedRanking() {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({
      roleId: role.id,
      candidates: [{}, {}, {}, {}],
    });

    await driveCandidateToDone(candidates[0].id, { matchScore: 91.5, fitCategory: 'strong_match' });
    await driveCandidateToDone(candidates[1].id, {
      matchScore: 64.9,
      fitCategory: 'unmatched',
      eliminated: true,
      eliminatedBy: 'Right to work',
    });
    await driveCandidateToDone(candidates[2].id, {
      matchScore: 91.5,
      fitCategory: 'strong_match',
    });
    // candidates[3] stays pending: not yet scored.

    return {
      roleId: role.id,
      ids: {
        high: candidates[0].id,
        low: candidates[1].id,
        tied: candidates[2].id,
        pending: candidates[3].id,
      },
    };
  }

  it('sorts by score descending with unscored candidates last', async () => {
    const { roleId, ids } = await seedRanking();

    const rows = await listRankedCandidates(pool, { roleId, limit: 10, offset: 0 });

    expect(rows.map((row) => row.matchScore)).toEqual([91.5, 91.5, 64.9, null]);
    expect(rows.at(-1)?.id).toBe(ids.pending);
  });

  it('keeps unscored candidates last in ascending order too', async () => {
    const { roleId, ids } = await seedRanking();

    const rows = await listRankedCandidates(pool, {
      roleId,
      limit: 10,
      offset: 0,
      direction: 'asc',
    });

    expect(rows.map((row) => row.matchScore)).toEqual([64.9, 91.5, 91.5, null]);
    expect(rows.at(-1)?.id).toBe(ids.pending);
  });

  it('breaks a score tie by id descending, so paging is stable', async () => {
    const { roleId, ids } = await seedRanking();

    const rows = await listRankedCandidates(pool, { roleId, limit: 10, offset: 0 });
    const tiedIds = rows.filter((row) => row.matchScore === 91.5).map((row) => row.id);

    expect(tiedIds).toEqual([...tiedIds].sort().reverse());
    expect(new Set(tiedIds)).toEqual(new Set([ids.high, ids.tied]));
  });

  it('pages without dropping or repeating a tied row', async () => {
    const { roleId } = await seedRanking();

    const first = await listRankedCandidates(pool, { roleId, limit: 2, offset: 0 });
    const second = await listRankedCandidates(pool, { roleId, limit: 2, offset: 2 });
    const ids = [...first, ...second].map((row) => row.id);

    expect(new Set(ids).size).toBe(4);
  });

  it('filters by tier and by status', async () => {
    const { roleId } = await seedRanking();

    const strong = await listRankedCandidates(pool, {
      roleId,
      fitCategory: 'strong_match',
      limit: 10,
      offset: 0,
    });
    const pending = await listRankedCandidates(pool, {
      roleId,
      status: 'pending',
      limit: 10,
      offset: 0,
    });

    expect(strong).toHaveLength(2);
    expect(pending).toHaveLength(1);
  });

  it('scopes to one role, so parallel screenings never bleed into each other', async () => {
    const { roleId } = await seedRanking();
    const other = await createRole({ title: 'Other role' });
    await createScreeningJob({ roleId: other.role.id });

    expect(await countCandidates(pool, { roleId })).toBe(4);
    expect(await countCandidates(pool, { roleId: other.role.id })).toBe(1);
    expect(await countCandidates(pool, {})).toBe(5);
  });

  it('keeps an eliminated candidate score visible while forcing its tier to unmatched', async () => {
    const { roleId, ids } = await seedRanking();

    const rows = await listRankedCandidates(pool, { roleId, limit: 10, offset: 0 });
    const eliminated = rows.find((row) => row.id === ids.low);

    // "Eliminated, but would have scored 64.9" - without the score and the rule
    // label the row looks broken and the recruiter stops trusting the tool.
    expect(eliminated).toMatchObject({
      eliminated: true,
      eliminatedBy: 'Right to work',
      fitCategory: 'unmatched',
      matchScore: 64.9,
    });
  });
});

describe('countCandidatesByFitCategory', () => {
  it('counts every tier across the whole filtered set', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({
      roleId: role.id,
      candidates: [{}, {}, {}],
    });
    await driveCandidateToDone(candidates[0].id, { fitCategory: 'strong_match' });
    await driveCandidateToDone(candidates[1].id, { fitCategory: 'potential_match' });

    const counts = await countCandidatesByFitCategory(pool, { roleId: role.id });

    // The unscored third candidate belongs to no tier and is counted in none.
    expect(counts).toEqual({ strong_match: 1, potential_match: 1, unmatched: 0 });
  });

  it('ignores a fitCategory filter, so the tier chips are not self-filtering', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id, candidates: [{}, {}] });
    await driveCandidateToDone(candidates[0].id, { fitCategory: 'strong_match' });
    await driveCandidateToDone(candidates[1].id, { fitCategory: 'unmatched' });

    const counts = await countCandidatesByFitCategory(pool, {
      roleId: role.id,
      fitCategory: 'strong_match',
    });

    expect(counts).toEqual({ strong_match: 1, potential_match: 0, unmatched: 1 });
  });
});

describe('findCandidateStatusesByIds', () => {
  it('returns the lightweight poll payload for the ids on screen', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id, candidates: [{}, {}] });
    await driveCandidateToDone(candidates[0].id);

    const rows = await findCandidateStatusesByIds(
      pool,
      candidates.map((c) => c.id),
    );

    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]).sort()).toEqual([
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
    ]);
  });

  it('silently omits ids that no longer exist', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id });

    const rows = await findCandidateStatusesByIds(pool, [candidates[0].id, randomUUID()]);

    expect(rows).toHaveLength(1);
  });

  it('does not query at all for an empty id list', async () => {
    expect(await findCandidateStatusesByIds(pool, [])).toEqual([]);
  });
});

describe('findDuplicateCandidates', () => {
  it('finds the candidate already holding this content for the role', async () => {
    const { role } = await createRole();
    const sha = 'b'.repeat(64);
    const { candidates } = await createScreeningJob({
      roleId: role.id,
      candidates: [{ contentSha256: sha }, { contentSha256: 'c'.repeat(64) }],
    });

    const duplicates = await findDuplicateCandidates(pool, {
      roleId: role.id,
      contentSha256: sha,
    });

    expect(duplicates.map((row) => row.id)).toEqual([candidates[0].id]);
  });

  it('cannot find a second copy for one role, because the schema forbids one', async () => {
    const { role } = await createRole();
    const sha = 'e'.repeat(64);
    await createScreeningJob({ roleId: role.id, candidates: [{ contentSha256: sha }] });

    // Migration 0008. This is the guarantee the upload path's ON CONFLICT relies
    // on, asserted from the outside rather than assumed.
    await expect(
      createScreeningJob({ roleId: role.id, candidates: [{ contentSha256: sha }] }),
    ).rejects.toThrow(/candidates_role_content_sha256_key/);
  });

  it('excludes a candidate the caller already knows about', async () => {
    const { role } = await createRole();
    const sha = 'f'.repeat(64);
    const { candidates } = await createScreeningJob({
      roleId: role.id,
      candidates: [{ contentSha256: sha }],
    });

    expect(
      await findDuplicateCandidates(pool, {
        roleId: role.id,
        contentSha256: sha,
        excludeCandidateId: candidates[0].id,
      }),
    ).toEqual([]);
  });

  it('does not match the same content uploaded against a different role', async () => {
    const first = await createRole({ title: 'One' });
    const second = await createRole({ title: 'Two' });
    const sha = 'd'.repeat(64);

    await createScreeningJob({ roleId: first.role.id, candidates: [{ contentSha256: sha }] });
    await createScreeningJob({ roleId: second.role.id, candidates: [{ contentSha256: sha }] });

    const duplicates = await findDuplicateCandidates(pool, {
      roleId: first.role.id,
      contentSha256: sha,
    });

    expect(duplicates).toHaveLength(1);
  });
});

describe('findStuckCandidates', () => {
  it('returns only non-terminal candidates older than the cutoff, oldest first', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({
      roleId: role.id,
      candidates: [{}, {}, {}],
    });
    await driveCandidateToDone(candidates[2].id);

    // Age two of them by hand; nothing else in the suite depends on wall-clock time.
    await pool.query(
      `UPDATE candidates SET updated_at = now() - interval '1 hour' WHERE id = ANY($1::uuid[])`,
      [[candidates[0].id, candidates[2].id]],
    );

    const stuck = await findStuckCandidates(pool, {
      updatedBefore: new Date(Date.now() - 60_000),
      limit: 10,
    });

    // candidates[1] is recent, candidates[2] is done: neither is stuck.
    expect(stuck.map((row) => row.id)).toEqual([candidates[0].id]);
  });

  it('respects its limit, so a sweep cannot pull an unbounded result set', async () => {
    const { role } = await createRole();
    await createScreeningJob({ roleId: role.id, candidates: [{}, {}, {}] });
    await pool.query(`UPDATE candidates SET updated_at = now() - interval '1 hour'`);

    const stuck = await findStuckCandidates(pool, { updatedBefore: new Date(), limit: 2 });

    expect(stuck).toHaveLength(2);
  });
});

describe('candidateInput fixture', () => {
  it('produces a payload the schema accepts', async () => {
    const input = candidateInput();
    expect(input.contentSha256).toHaveLength(64);
  });
});

describe('listRankedCandidates with statusIn', () => {
  /**
   * One candidate in each of the five statuses, so a set filter has something to
   * be wrong about.
   *
   * Statuses are reached through the real guarded transitions rather than by a
   * hand-written UPDATE, for the reason the rest of this suite gives: a row no
   * repository could have produced is a fixture that proves nothing.
   *
   * @returns {Promise<{ roleId: string, byStatus: Record<string, string> }>}
   */
  async function seedEveryStatus() {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({
      roleId: role.id,
      candidates: [{}, {}, {}, {}, {}],
    });

    const [pending, parsing, evaluating, done, failed] = candidates;

    await markCandidateParsing(pool, parsing.id);

    await markCandidateParsing(pool, evaluating.id);
    await markCandidateEvaluating(pool, { candidateId: evaluating.id, rawText: 'cv text' });

    await driveCandidateToDone(done.id, { matchScore: 77.0, fitCategory: 'potential_match' });

    await markCandidateParsing(pool, failed.id);
    await markCandidateFailed(pool, {
      candidateId: failed.id,
      errorCode: 'EXTRACTION_FAILED',
      errorMessage: 'no text layer',
    });

    return {
      roleId: role.id,
      byStatus: {
        pending: pending.id,
        parsing: parsing.id,
        evaluating: evaluating.id,
        done: done.id,
        failed: failed.id,
      },
    };
  }

  /**
   * @param {string} roleId
   * @param {string[]} statusIn
   * @param {object} [extra]
   */
  function list(roleId, statusIn, extra = {}) {
    return listRankedCandidates(pool, { roleId, statusIn, limit: 25, offset: 0, ...extra });
  }

  it('returns the union of the statuses asked for, in one query', async () => {
    const { roleId, byStatus } = await seedEveryStatus();

    // The whole reason this parameter exists: "everything still working, plus
    // everything that failed" is one filter, and the dashboard was issuing four
    // parallel requests to express it.
    const rows = await list(roleId, ['pending', 'parsing', 'evaluating', 'failed']);

    expect(new Set(rows.map((row) => row.id))).toEqual(
      new Set([byStatus.pending, byStatus.parsing, byStatus.evaluating, byStatus.failed]),
    );
  });

  it('agrees with the single-status filter on a one-element set', async () => {
    const { roleId, byStatus } = await seedEveryStatus();

    const viaSet = await list(roleId, ['evaluating']);
    const viaScalar = await listRankedCandidates(pool, {
      roleId,
      status: 'evaluating',
      limit: 25,
      offset: 0,
    });

    expect(viaSet.map((row) => row.id)).toEqual([byStatus.evaluating]);
    expect(viaSet.map((row) => row.id)).toEqual(viaScalar.map((row) => row.id));
  });

  it('accepts the whole vocabulary and returns everything', async () => {
    const { roleId } = await seedEveryStatus();

    const rows = await list(roleId, ['pending', 'parsing', 'evaluating', 'done', 'failed']);

    expect(rows).toHaveLength(5);
  });

  it('intersects with the single status param rather than overriding it', async () => {
    const { roleId, byStatus } = await seedEveryStatus();

    // Both filter one column and both are applied - `status` still means what it
    // meant, and two filters compose with AND exactly as roleId and jobId do.
    const overlapping = await list(roleId, ['done', 'failed'], { status: 'failed' });
    const disjoint = await list(roleId, ['done'], { status: 'failed' });

    expect(overlapping.map((row) => row.id)).toEqual([byStatus.failed]);
    expect(disjoint).toEqual([]);
  });

  it('numbers LIMIT and OFFSET after the array parameter, whatever its length', async () => {
    // The off-by-one this design exists to avoid. The set crosses as ONE bound
    // array, so the next placeholder number is the same for a one-element filter
    // and a five-element one. A hand-built `IN ($4,$5,$6)` is exactly where the
    // placeholder count starts depending on the query string, and where a page
    // silently becomes a LIMIT of the wrong value.
    const { roleId } = await seedEveryStatus();

    const sets = [
      ['pending'],
      ['pending', 'parsing'],
      ['pending', 'parsing', 'evaluating'],
      ['pending', 'parsing', 'evaluating', 'done'],
      ['pending', 'parsing', 'evaluating', 'done', 'failed'],
    ];

    for (const statuses of sets) {
      const label = statuses.join('+');
      const all = await list(roleId, statuses);
      const firstPage = await list(roleId, statuses, { limit: 1, offset: 0 });
      const secondPage = await list(roleId, statuses, { limit: 1, offset: 1 });

      expect(all, label).toHaveLength(statuses.length);
      expect(firstPage.map((row) => row.id), label).toEqual([all[0].id]);
      expect(secondPage.map((row) => row.id), label).toEqual(
        all.length > 1 ? [all[1].id] : [],
      );
    }
  });

  it('keeps the count and the page filtered identically', async () => {
    const { roleId } = await seedEveryStatus();
    const statusIn = ['parsing', 'evaluating', 'failed'];

    const rows = await list(roleId, statusIn);
    const total = await countCandidates(pool, { roleId, statusIn });

    expect(total).toBe(rows.length);
    expect(total).toBe(3);
  });

  it('narrows the tier counts too, so the chips match the rows', async () => {
    const { roleId } = await seedEveryStatus();

    const scored = await countCandidatesByFitCategory(pool, { roleId, statusIn: ['done'] });
    const working = await countCandidatesByFitCategory(pool, {
      roleId,
      statusIn: ['pending', 'parsing'],
    });

    expect(scored).toEqual({ strong_match: 0, potential_match: 1, unmatched: 0 });
    // Nothing unscored belongs to a tier, so a working-set filter counts nobody.
    expect(working).toEqual({ strong_match: 0, potential_match: 0, unmatched: 0 });
  });

  it('binds the set as a parameter, so a hostile value is data and not SQL', async () => {
    // The boundary enum means this array can only ever hold one of five strings.
    // This asserts the layer below it does not depend on that: the value reaches
    // Postgres as an element of a bound text[], matches no row, and changes
    // nothing. Interpolated, this test would drop the table instead of returning
    // nothing.
    const { roleId } = await seedEveryStatus();

    const rows = await list(roleId, ["done') OR '1'='1", 'x; DROP TABLE candidates; --']);

    expect(rows).toEqual([]);
    expect(await countCandidates(pool, { roleId })).toBe(5);
  });

  it('ignores an absent statusIn entirely', async () => {
    const { roleId } = await seedEveryStatus();

    // `undefined` must not become `status = ANY(NULL)`, which matches nothing.
    const rows = await listRankedCandidates(pool, {
      roleId,
      statusIn: undefined,
      limit: 25,
      offset: 0,
    });

    expect(rows).toHaveLength(5);
  });
});
