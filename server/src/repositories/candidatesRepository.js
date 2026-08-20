import { candidateRankingOrderBy } from './candidateOrdering.js';
import {
  CANDIDATE_FULL_COLUMNS,
  CANDIDATE_LIST_COLUMNS,
  CANDIDATE_STATUS_COLUMNS,
  toCandidate,
  toCandidateListRow,
  toCandidateStatusRow,
} from './candidateRow.js';

/**
 * Reads and inserts for `candidates`. Status transitions live in
 * candidateStatusRepository.js, because they are guarded writes with a different
 * return contract.
 *
 * @typedef {import('../db/pool.js').Queryable} Queryable
 * @typedef {import('./candidateRow.js').Candidate} Candidate
 * @typedef {import('./candidateRow.js').CandidateListRow} CandidateListRow
 * @typedef {import('./candidateRow.js').CandidateStatusRow} CandidateStatusRow
 *
 * @typedef {object} CandidateInsertInput
 * @property {string} [id] supply it when the file was written under a path
 *   derived from this id, which is what the upload path actually does
 * @property {string} originalFilename
 * @property {string} storagePath
 * @property {string} contentSha256
 * @property {string} mimeType
 * @property {number} byteSize
 *
 * @typedef {'pending'|'parsing'|'evaluating'|'done'|'failed'} CandidateStatus
 *
 * @typedef {object} CandidateFilters
 * @property {string} [roleId]
 * @property {string} [jobId]
 * @property {'strong_match'|'potential_match'|'unmatched'} [fitCategory]
 * @property {CandidateStatus} [status]
 * @property {CandidateStatus[]} [statusIn] a set over the same column; composes
 *   with `status` by AND, exactly as every other filter here composes
 */

/**
 * Builds the shared WHERE clause for the ranked list and its counts, so a page
 * and the totals beside it can never be filtered differently.
 *
 * Every filter value is a placeholder; only fixed column names are interpolated.
 *
 * @param {CandidateFilters} filters
 * @param {number} [startIndex] first placeholder number to use
 * @returns {{ clause: string, params: any[], nextIndex: number }}
 */
function buildFilterClause(filters, startIndex = 1) {
  const conditions = [];
  const params = [];
  let index = startIndex;

  if (filters.roleId !== undefined) {
    conditions.push(`role_id = $${index++}`);
    params.push(filters.roleId);
  }
  if (filters.jobId !== undefined) {
    conditions.push(`job_id = $${index++}`);
    params.push(filters.jobId);
  }
  if (filters.fitCategory !== undefined) {
    conditions.push(`fit_category = $${index++}`);
    params.push(filters.fitCategory);
  }
  if (filters.status !== undefined) {
    conditions.push(`status = $${index++}`);
    params.push(filters.status);
  }
  if (filters.statusIn !== undefined) {
    // `= ANY($n::text[])` over ONE bound array, never a comma-joined `IN (...)`
    // built from the query string. Two properties follow from that and both are
    // load-bearing:
    //
    //   - there is no string interpolation of a value anywhere on this path, so
    //     the boundary enum is a defence in depth rather than the only one;
    //   - the placeholder count does not depend on how many statuses were asked
    //     for, so `nextIndex` - which LIMIT and OFFSET are numbered from - stays
    //     correct for a one-element set and a five-element one alike. A
    //     hand-built `IN ($4,$5,$6)` is exactly where that off-by-one lives.
    //
    // The cast is explicit because the driver sends a JS array as a Postgres
    // array literal, and an untyped literal beside a `text` column is left for
    // the planner to guess at.
    conditions.push(`status = ANY($${index++}::text[])`);
    params.push(filters.statusIn);
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    nextIndex: index,
  };
}

/**
 * Inserts a batch of candidates for one screening job in a single statement.
 *
 * Called inside the same transaction as the screening_jobs insert: the whole
 * upload is one atomic record of intent, committed before anything is enqueued,
 * so a worker can never pick up a row that is not yet visible.
 *
 * @param {Queryable} db
 * @param {{ roleId: string, jobId: string, candidates: CandidateInsertInput[] }} input
 * @returns {Promise<Candidate[]>} in the order supplied
 */
export async function insertCandidates(db, { roleId, jobId, candidates }) {
  if (candidates.length === 0) return [];

  const payload = candidates.map((candidate, index) => ({
    id: candidate.id ?? null,
    original_filename: candidate.originalFilename,
    storage_path: candidate.storagePath,
    content_sha256: candidate.contentSha256,
    mime_type: candidate.mimeType,
    byte_size: candidate.byteSize,
    ordinal: index,
  }));

  const { rows } = await db.query(
    `INSERT INTO candidates (
       id, role_id, job_id, original_filename, storage_path, content_sha256, mime_type, byte_size
     )
     SELECT COALESCE(c.id, gen_random_uuid()), $1, $2, c.original_filename, c.storage_path,
            c.content_sha256, c.mime_type, c.byte_size
       FROM jsonb_to_recordset($3::jsonb)
         AS c(id uuid, original_filename text, storage_path text, content_sha256 char(64),
              mime_type text, byte_size integer, ordinal integer)
      ORDER BY c.ordinal
     RETURNING ${CANDIDATE_FULL_COLUMNS}`,
    [roleId, jobId, JSON.stringify(payload)],
  );

  // RETURNING order is not guaranteed to follow the source ORDER BY, so the
  // caller's order is restored explicitly rather than assumed. storage_path is
  // the key because it is unique per upload by construction (it is derived from
  // the candidate id), whereas two files in one batch can share a filename.
  const byStoragePath = new Map(rows.map((row) => [row.storage_path, row]));
  return candidates.map((candidate) => toCandidate(byStoragePath.get(candidate.storagePath)));
}

/**
 * @param {Queryable} db
 * @param {string} candidateId
 * @param {{ includeRawText?: boolean }} [options] raw text is an entire CV; it is
 *   excluded unless the caller asks (?includeRawText=true on the detail endpoint)
 * @returns {Promise<Candidate | null>}
 */
export async function findCandidateById(db, candidateId, { includeRawText = false } = {}) {
  const columns = includeRawText ? `${CANDIDATE_FULL_COLUMNS}, raw_text` : CANDIDATE_FULL_COLUMNS;
  const { rows } = await db.query(`SELECT ${columns} FROM candidates WHERE id = $1`, [candidateId]);
  return rows.length > 0 ? toCandidate(rows[0]) : null;
}

/**
 * The ranked list. Ordering comes from candidateOrdering.js and is defined
 * nowhere else in the system.
 *
 * @param {Queryable} db
 * @param {CandidateFilters & { limit: number, offset: number,
 *   direction?: import('./candidateOrdering.js').RankingDirection }} options
 * @returns {Promise<CandidateListRow[]>}
 */
export async function listRankedCandidates(db, { limit, offset, direction = 'desc', ...filters }) {
  const { clause, params, nextIndex } = buildFilterClause(filters);

  const { rows } = await db.query(
    `SELECT ${CANDIDATE_LIST_COLUMNS}
       FROM candidates
       ${clause}
       ${candidateRankingOrderBy(direction)}
      LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
    [...params, limit, offset],
  );

  return rows.map(toCandidateListRow);
}

/**
 * @param {Queryable} db
 * @param {CandidateFilters} filters
 * @returns {Promise<number>} total matching rows, for pagination meta
 */
export async function countCandidates(db, filters) {
  const { clause, params } = buildFilterClause(filters);
  const { rows } = await db.query(`SELECT count(*) AS total FROM candidates ${clause}`, params);
  return rows[0].total;
}

/**
 * Tier counts across the whole filtered set, not the current page - a 25-row page
 * cannot tell a recruiter how many Strong Matches exist.
 *
 * A fitCategory filter is deliberately not accepted: filtering to one tier and
 * then counting tiers returns that tier and two zeroes, which is useless as the
 * header of a filter control.
 *
 * @param {Queryable} db
 * @param {Omit<CandidateFilters, 'fitCategory'>} filters
 * @returns {Promise<{ strong_match: number, potential_match: number, unmatched: number }>}
 */
export async function countCandidatesByFitCategory(db, filters) {
  const { clause, params } = buildFilterClause({ ...filters, fitCategory: undefined });
  const { rows } = await db.query(
    `SELECT fit_category, count(*) AS count
       FROM candidates
       ${clause}
      GROUP BY fit_category`,
    params,
  );

  const counts = { strong_match: 0, potential_match: 0, unmatched: 0 };
  for (const row of rows) {
    // fit_category is NULL for everything not yet scored; those belong to no tier.
    if (row.fit_category !== null) {
      counts[/** @type {keyof typeof counts} */ (row.fit_category)] = row.count;
    }
  }
  return counts;
}

/**
 * The lightweight poll payload: one query for every id on screen, rather than one
 * request per row.
 *
 * @param {Queryable} db
 * @param {string[]} candidateIds
 * @returns {Promise<CandidateStatusRow[]>} only the ids that exist; a caller that
 *   needs to detect a deleted candidate compares lengths
 */
export async function findCandidateStatusesByIds(db, candidateIds) {
  if (candidateIds.length === 0) return [];

  const { rows } = await db.query(
    `SELECT ${CANDIDATE_STATUS_COLUMNS}
       FROM candidates
      WHERE id = ANY($1::uuid[])`,
    [candidateIds],
  );

  return rows.map(toCandidateStatusRow);
}

/**
 * The candidate holding byte-identical content for the same role, if there is
 * one.
 *
 * Since migration 0008 there can be at most one per role: uploads are idempotent
 * on `(role_id, content_sha256)` and a duplicate upload returns the existing
 * candidate rather than creating a second. So this is now a lookup rather than
 * the after-the-fact duplicate detector it was written as - the return type
 * stays a list because the same content across DIFFERENT roles is legitimate and
 * `excludeCandidateId` still has a job to do.
 *
 * @param {Queryable} db
 * @param {{ roleId: string, contentSha256: string, excludeCandidateId?: string }} input
 * @returns {Promise<CandidateListRow[]>} newest first
 */
export async function findDuplicateCandidates(db, { roleId, contentSha256, excludeCandidateId }) {
  const { rows } = await db.query(
    `SELECT ${CANDIDATE_LIST_COLUMNS}
       FROM candidates
      WHERE role_id = $1
        AND content_sha256 = $2
        AND ($3::uuid IS NULL OR id <> $3::uuid)
      ORDER BY created_at DESC, id DESC`,
    [roleId, contentSha256, excludeCandidateId ?? null],
  );
  return rows.map(toCandidateListRow);
}

/**
 * Candidates stuck in a non-terminal status past a cutoff - the input to
 * scripts/reconcileStuck.js, which re-enqueues anything stranded by a crash
 * between COMMIT and enqueue.
 *
 * Filters on `updated_at` rather than `created_at`: a candidate that moved to
 * `evaluating` two minutes ago is making progress, however old the upload is.
 *
 * @param {Queryable} db
 * @param {{ updatedBefore: Date, limit: number }} options
 * @returns {Promise<CandidateListRow[]>} oldest first - the ones stuck longest
 */
export async function findStuckCandidates(db, { updatedBefore, limit }) {
  const { rows } = await db.query(
    `SELECT ${CANDIDATE_LIST_COLUMNS}
       FROM candidates
      WHERE status IN ('pending', 'parsing', 'evaluating')
        AND updated_at < $1
      ORDER BY updated_at ASC, id ASC
      LIMIT $2`,
    [updatedBefore, limit],
  );
  return rows.map(toCandidateListRow);
}

/**
 * Inserts a batch of candidates, treating a byte-identical prior upload for the
 * same role as already done.
 *
 * ## Why this exists beside `insertCandidates`
 *
 * Uploads became idempotent on `(role_id, content_sha256)` in phase 4, enforced
 * by a UNIQUE constraint (migration 0008). This reverses the earlier decision
 * recorded in plan sections 2, 3 and 8, and those sections were rewritten rather
 * than left contradictory.
 *
 * The semantics the owner chose: a duplicate upload **returns the existing
 * candidate** rather than erroring. Same bytes, same role, same result - no new
 * work, no second LLM spend, and no 409 to make a double-clicked button look
 * broken. Re-screening a candidate that failed stays the retry endpoint's job.
 *
 * `insertCandidates` is kept unchanged as the plain insert: it is what the test
 * fixtures build rows with, and a fixture that silently returned somebody else's
 * row would make a confusing test failure. This is the function the upload path
 * uses.
 *
 * ## The one statement
 *
 * `ON CONFLICT DO NOTHING` returns nothing for the rows it skipped, and a plain
 * `SELECT` in the same statement cannot see the rows it just inserted - one
 * snapshot. So the result is the union of the two: what was inserted, and what
 * already existed for the shas that were not.
 *
 * **Precondition:** `candidates` must be unique by `contentSha256` within the
 * call. Two files with identical bytes in one batch are collapsed by the caller,
 * which is also where the redundant file gets unlinked.
 *
 * @param {Queryable} db
 * @param {{ roleId: string, jobId: string, candidates: CandidateInsertInput[] }} input
 * @returns {Promise<{ candidate: Candidate, created: boolean }[]>} in the order
 *   supplied; `created: false` means the row was already there
 */
export async function insertCandidatesIdempotent(db, { roleId, jobId, candidates }) {
  if (candidates.length === 0) return [];

  const payload = candidates.map((candidate, index) => ({
    src_id: candidate.id ?? null,
    src_original_filename: candidate.originalFilename,
    src_storage_path: candidate.storagePath,
    src_content_sha256: candidate.contentSha256,
    src_mime_type: candidate.mimeType,
    src_byte_size: candidate.byteSize,
    ordinal: index,
  }));

  // Every input column is prefixed so that CANDIDATE_FULL_COLUMNS can be used
  // unqualified in both branches of the union without any name colliding.
  const { rows } = await db.query(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($3::jsonb)
         AS c(src_id uuid, src_original_filename text, src_storage_path text,
              src_content_sha256 char(64), src_mime_type text, src_byte_size integer,
              ordinal integer)
     ),
     inserted AS (
       INSERT INTO candidates (
         id, role_id, job_id, original_filename, storage_path, content_sha256,
         mime_type, byte_size
       )
       SELECT COALESCE(i.src_id, gen_random_uuid()), $1, $2, i.src_original_filename,
              i.src_storage_path, i.src_content_sha256, i.src_mime_type, i.src_byte_size
         FROM input i
        ORDER BY i.ordinal
       ON CONFLICT (role_id, content_sha256) DO NOTHING
       RETURNING ${CANDIDATE_FULL_COLUMNS}
     )
     SELECT i.ordinal, true AS created, ${CANDIDATE_FULL_COLUMNS}
       FROM input i
       JOIN inserted ON inserted.content_sha256 = i.src_content_sha256
     UNION ALL
     SELECT i.ordinal, false AS created, ${CANDIDATE_FULL_COLUMNS}
       FROM input i
       JOIN candidates ON candidates.role_id = $1
                      AND candidates.content_sha256 = i.src_content_sha256
      WHERE NOT EXISTS (
        SELECT 1 FROM inserted WHERE inserted.content_sha256 = i.src_content_sha256
      )
      ORDER BY ordinal`,
    [roleId, jobId, JSON.stringify(payload)],
  );

  return rows.map((row) => ({ candidate: toCandidate(row), created: row.created }));
}
