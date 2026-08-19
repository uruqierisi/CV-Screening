/**
 * Data access for `role_criteria`.
 *
 * @typedef {import('../db/pool.js').Queryable} Queryable
 *
 * @typedef {object} RoleCriterion
 * @property {string} id
 * @property {string} roleId
 * @property {string} label
 * @property {string} description
 * @property {number} weight integer 1..100; weights for a role sum to 100
 * @property {number} position
 *
 * @typedef {object} RoleCriterionInput
 * @property {string} label
 * @property {string} [description]
 * @property {number} weight
 * @property {number} position
 */

const COLUMNS = 'id, role_id, label, description, weight, position';

/**
 * @param {Record<string, any>} row
 * @returns {RoleCriterion}
 */
function toCriterion(row) {
  return {
    id: row.id,
    roleId: row.role_id,
    label: row.label,
    description: row.description,
    weight: row.weight,
    position: row.position,
  };
}

/**
 * Guards the one mistake this module cannot survive: being handed the pool
 * instead of a transaction client. `replaceCriteriaForRole` is two statements
 * whose intermediate state is invalid by design, so running them on separate
 * pooled connections would leave a role with no criteria at all.
 *
 * @param {Queryable} db
 * @param {string} fnName
 */
function assertTransactionClient(db, fnName) {
  if (typeof (/** @type {any} */ (db).release) !== 'function') {
    throw new Error(`${fnName} must be called with a transaction client (see withTransaction)`);
  }
}

/**
 * Replaces every criterion for a role: delete, then insert the new set.
 *
 * MUST run inside a transaction. The intermediate state - zero criteria, then a
 * partial set - violates the sum-to-100 invariant on purpose; the CONSTRAINT
 * TRIGGER is DEFERRABLE INITIALLY DEFERRED and only judges the final state at
 * COMMIT. That means a bad weight total surfaces from `COMMIT`, not from this
 * call, which is why withTransaction keeps COMMIT inside its try block.
 *
 * Full replacement rather than a diff: partial weight edits turn sum-to-100 into
 * a merge problem, and the PUT contract is a full replacement anyway.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} roleId
 * @param {RoleCriterionInput[]} criteria
 * @returns {Promise<RoleCriterion[]>} the inserted rows, in position order
 */
export async function replaceCriteriaForRole(client, roleId, criteria) {
  assertTransactionClient(client, 'replaceCriteriaForRole');

  await client.query('DELETE FROM role_criteria WHERE role_id = $1', [roleId]);

  if (criteria.length === 0) {
    // Legal at this layer, and deliberately not rejected here: the "at least one
    // criterion" rule is a boundary rule (zod), and a criteria-less role is
    // caught again at upload time as ROLE_NOT_SCOREABLE.
    return [];
  }

  // One statement for N rows via jsonb_to_recordset: no N+1, no hand-built
  // placeholder list, and the column types are declared right here in the AS list.
  const { rows } = await client.query(
    `INSERT INTO role_criteria (role_id, label, description, weight, position)
     SELECT $1, c.label, COALESCE(c.description, ''), c.weight, c.position
       FROM jsonb_to_recordset($2::jsonb)
         AS c(label text, description text, weight integer, position integer)
     RETURNING ${COLUMNS}`,
    [roleId, JSON.stringify(criteria)],
  );

  return rows.map(toCriterion).sort((a, b) => a.position - b.position);
}

/**
 * @param {Queryable} db
 * @param {string} roleId
 * @returns {Promise<RoleCriterion[]>} in position order; empty when the role has
 *   none or does not exist - the caller checks the role separately
 */
export async function listCriteriaByRoleId(db, roleId) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM role_criteria WHERE role_id = $1 ORDER BY position, id`,
    [roleId],
  );
  return rows.map(toCriterion);
}

/**
 * Batch form for the role list endpoint. One query for N roles instead of N
 * queries - the N+1 this schema would otherwise invite.
 *
 * @param {Queryable} db
 * @param {string[]} roleIds
 * @returns {Promise<Map<string, RoleCriterion[]>>} keyed by role id; roles with
 *   no criteria are absent from the map
 */
export async function listCriteriaByRoleIds(db, roleIds) {
  /** @type {Map<string, RoleCriterion[]>} */
  const byRole = new Map();
  if (roleIds.length === 0) return byRole;

  const { rows } = await db.query(
    `SELECT ${COLUMNS}
       FROM role_criteria
      WHERE role_id = ANY($1::uuid[])
      ORDER BY role_id, position, id`,
    [roleIds],
  );

  for (const row of rows) {
    const criterion = toCriterion(row);
    const existing = byRole.get(criterion.roleId);
    if (existing) {
      existing.push(criterion);
    } else {
      byRole.set(criterion.roleId, [criterion]);
    }
  }

  return byRole;
}

/**
 * Sum of a role's criterion weights. Exists for diagnostics and for the health
 * of the invariant, not as a substitute for it: the database enforces the sum at
 * COMMIT, and reading it back is not a check, it is a report.
 *
 * @param {Queryable} db
 * @param {string} roleId
 * @returns {Promise<{ total: number, count: number }>}
 */
export async function sumCriteriaWeights(db, roleId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(weight), 0)::int AS total, count(*) AS count
       FROM role_criteria
      WHERE role_id = $1`,
    [roleId],
  );
  return { total: rows[0].total, count: rows[0].count };
}
