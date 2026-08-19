/**
 * Data access for `screening_jobs`.
 *
 * One upload request is one screening job, which fans out to N queue jobs. Both
 * are called "job" in speech; this module only ever means the former.
 *
 * There is no status column. `countCandidateStatuses` is how job status is
 * obtained - derived, every time, from the candidates themselves. Deriving it
 * costs one indexed aggregate; storing it costs a second copy of the truth that
 * drifts the moment a worker dies mid-update.
 *
 * @typedef {import('../db/pool.js').Queryable} Queryable
 *
 * @typedef {object} ScreeningJob
 * @property {string} id
 * @property {string} roleId
 * @property {number} fileCount
 * @property {Date} createdAt
 *
 * @typedef {object} CandidateStatusCounts
 * @property {number} pending
 * @property {number} parsing
 * @property {number} evaluating
 * @property {number} done
 * @property {number} failed
 * @property {number} total
 */

const COLUMNS = 'id, role_id, file_count, created_at';

/**
 * @param {Record<string, any>} row
 * @returns {ScreeningJob}
 */
function toScreeningJob(row) {
  return {
    id: row.id,
    roleId: row.role_id,
    fileCount: row.file_count,
    createdAt: row.created_at,
  };
}

/**
 * @param {Queryable} db
 * @param {{ id?: string, roleId: string, fileCount: number }} input
 * @returns {Promise<ScreeningJob>}
 */
export async function insertScreeningJob(db, input) {
  const { rows } = await db.query(
    `INSERT INTO screening_jobs (id, role_id, file_count)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3)
     RETURNING ${COLUMNS}`,
    [input.id ?? null, input.roleId, input.fileCount],
  );
  return toScreeningJob(rows[0]);
}

/**
 * @param {Queryable} db
 * @param {string} jobId
 * @returns {Promise<ScreeningJob | null>}
 */
export async function findScreeningJobById(db, jobId) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM screening_jobs WHERE id = $1`, [jobId]);
  return rows.length > 0 ? toScreeningJob(rows[0]) : null;
}

/**
 * The hot polling query: GET /jobs/:id derives its status from these counts.
 * Served by candidates_job_status_idx (job_id, status) as an index-only scan.
 *
 * Returns zeroes for every status when the job has no candidates or does not
 * exist - the caller checks the job's existence separately, because "no such
 * job" and "a job with nothing in it" are different answers at the HTTP layer.
 *
 * @param {Queryable} db
 * @param {string} jobId
 * @returns {Promise<CandidateStatusCounts>}
 */
export async function countCandidateStatuses(db, jobId) {
  const { rows } = await db.query(
    `SELECT status, count(*) AS count
       FROM candidates
      WHERE job_id = $1
      GROUP BY status`,
    [jobId],
  );

  /** @type {CandidateStatusCounts} */
  const counts = { pending: 0, parsing: 0, evaluating: 0, done: 0, failed: 0, total: 0 };

  for (const row of rows) {
    counts[/** @type {keyof CandidateStatusCounts} */ (row.status)] = row.count;
    counts.total += row.count;
  }

  return counts;
}
