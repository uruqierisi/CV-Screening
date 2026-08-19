/**
 * Data access for `roles`.
 *
 * Parameterized SQL only. No HTTP knowledge, no business rules: these functions
 * return rows or null and leave "what does a missing role mean" to the service
 * layer above.
 *
 * Every function takes a `Queryable` first, so the caller owns the transaction
 * boundary. Pass the pool for a standalone read; pass a transaction client when
 * the write is part of a larger unit.
 *
 * @typedef {import('../db/pool.js').Queryable} Queryable
 *
 * @typedef {object} Role
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {number} version
 * @property {string | null} archivedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

const COLUMNS = 'id, title, description, version, archived_at, created_at, updated_at';

/**
 * @param {Record<string, any>} row
 * @returns {Role}
 */
function toRole(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    version: row.version,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Inserts a role. `id` is optional: omit it and the database generates one.
 * Supply it when the caller needs the id before the write (it does not here, but
 * candidates do, and keeping the shape consistent costs nothing).
 *
 * @param {Queryable} db
 * @param {{ id?: string, title: string, description?: string }} input
 * @returns {Promise<Role>}
 */
export async function insertRole(db, input) {
  const { rows } = await db.query(
    `INSERT INTO roles (id, title, description)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, COALESCE($3, ''))
     RETURNING ${COLUMNS}`,
    [input.id ?? null, input.title, input.description ?? null],
  );
  return toRole(rows[0]);
}

/**
 * @param {Queryable} db
 * @param {string} roleId
 * @returns {Promise<Role | null>} null when no such role - including an archived
 *   one, which is still returned; archived is not deleted.
 */
export async function findRoleById(db, roleId) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM roles WHERE id = $1`, [roleId]);
  return rows.length > 0 ? toRole(rows[0]) : null;
}

/**
 * @param {Queryable} db
 * @param {{ limit: number, offset: number, includeArchived?: boolean }} options
 * @returns {Promise<Role[]>} newest first
 */
export async function listRoles(db, { limit, offset, includeArchived = false }) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS}
       FROM roles
      WHERE ($3::boolean OR archived_at IS NULL)
      ORDER BY created_at DESC, id DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset, includeArchived],
  );
  return rows.map(toRole);
}

/**
 * Total matching `listRoles`, for pagination meta. Separate query because a
 * window function count over a paged result costs the same and hides the intent.
 *
 * @param {Queryable} db
 * @param {{ includeArchived?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function countRoles(db, { includeArchived = false } = {}) {
  const { rows } = await db.query(
    'SELECT count(*) AS total FROM roles WHERE ($1::boolean OR archived_at IS NULL)',
    [includeArchived],
  );
  return rows[0].total;
}

/**
 * Rewrites a role's own fields and bumps `version`.
 *
 * The bump lives here rather than in a service because it must be atomic with
 * the update; WHEN to call it (only on a full replacement, per the PUT contract)
 * stays a service decision.
 *
 * @param {Queryable} db
 * @param {string} roleId
 * @param {{ title: string, description?: string }} input
 * @returns {Promise<Role | null>} null when no such role
 */
export async function updateRoleAndBumpVersion(db, roleId, input) {
  const { rows } = await db.query(
    `UPDATE roles
        SET title = $2,
            description = COALESCE($3, ''),
            version = version + 1,
            updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [roleId, input.title, input.description ?? null],
  );
  return rows.length > 0 ? toRole(rows[0]) : null;
}

/**
 * Soft-archives a role. Idempotent: archiving an archived role keeps the
 * original timestamp and still returns the row, so DELETE /roles can be a safe
 * retry. Never a hard delete - candidates reference roles ON DELETE RESTRICT and
 * the screening history has to survive.
 *
 * @param {Queryable} db
 * @param {string} roleId
 * @returns {Promise<Role | null>} null when no such role
 */
export async function archiveRole(db, roleId) {
  const { rows } = await db.query(
    `UPDATE roles
        SET archived_at = COALESCE(archived_at, now()),
            -- Only moves on the transition, so a repeated archive is a true no-op.
            updated_at = CASE WHEN archived_at IS NULL THEN now() ELSE updated_at END
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [roleId],
  );
  return rows.length > 0 ? toRole(rows[0]) : null;
}
