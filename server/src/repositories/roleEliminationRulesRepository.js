/**
 * Data access for `role_elimination_rules`.
 *
 * @typedef {import('../db/pool.js').Queryable} Queryable
 *
 * @typedef {'min_years_experience' | 'required_skill' | 'required_education_level'
 *   | 'required_certification' | 'location_allowlist'} EliminationRuleType
 *
 * @typedef {'flag' | 'eliminate'} OnMissing
 *
 * @typedef {object} EliminationRule
 * @property {string} id
 * @property {string} roleId
 * @property {string} label
 * @property {EliminationRuleType} type
 * @property {Record<string, any>} value shape depends on `type` - see plan section 2
 * @property {OnMissing} onMissing what an absent profile fact means for this rule
 * @property {number} position
 *
 * @typedef {object} EliminationRuleInput
 * @property {string} label
 * @property {EliminationRuleType} type
 * @property {Record<string, any>} value
 * @property {OnMissing} [onMissing] defaults to 'flag'
 * @property {number} position
 */

const COLUMNS = 'id, role_id, label, type, value, on_missing, position';

/**
 * The stored type enum, mirrored from the CHECK constraint in migration 0003.
 * The agent layer asserts this set and its evaluator registry are identical - an
 * unknown rule type must be impossible to store and must throw at evaluation
 * time, never silently pass.
 *
 * @type {readonly EliminationRuleType[]}
 */
export const ELIMINATION_RULE_TYPES = Object.freeze([
  'min_years_experience',
  'required_skill',
  'required_education_level',
  'required_certification',
  'location_allowlist',
]);

/**
 * @param {Record<string, any>} row
 * @returns {EliminationRule}
 */
function toRule(row) {
  return {
    id: row.id,
    roleId: row.role_id,
    label: row.label,
    type: row.type,
    value: row.value,
    onMissing: row.on_missing,
    position: row.position,
  };
}

/**
 * @param {Queryable} db
 * @param {string} fnName
 */
function assertTransactionClient(db, fnName) {
  if (typeof (/** @type {any} */ (db).release) !== 'function') {
    throw new Error(`${fnName} must be called with a transaction client (see withTransaction)`);
  }
}

/**
 * Replaces every elimination rule for a role.
 *
 * Same delete-then-insert shape as criteria, and the same transaction
 * requirement - here because a role that briefly has no elimination rules would
 * otherwise be visible to a concurrent upload, which would then screen a
 * candidate against an incomplete rule set.
 *
 * @param {import('pg').PoolClient} client
 * @param {string} roleId
 * @param {EliminationRuleInput[]} rules
 * @returns {Promise<EliminationRule[]>} the inserted rows, in position order
 */
export async function replaceEliminationRulesForRole(client, roleId, rules) {
  assertTransactionClient(client, 'replaceEliminationRulesForRole');

  await client.query('DELETE FROM role_elimination_rules WHERE role_id = $1', [roleId]);

  if (rules.length === 0) {
    // A role with no elimination rules is legitimate: scoring alone is a valid
    // configuration.
    return [];
  }

  const { rows } = await client.query(
    `INSERT INTO role_elimination_rules (role_id, label, type, value, on_missing, position)
     SELECT $1, r.label, r.type, r.value, COALESCE(r.on_missing, 'flag'), r.position
       FROM jsonb_to_recordset($2::jsonb)
         AS r(label text, type text, value jsonb, on_missing text, position integer)
     RETURNING ${COLUMNS}`,
    // COALESCE above mirrors the column default: jsonb_to_recordset yields NULL
    // for an absent key, and NULL would hit the NOT NULL rather than the DEFAULT.
    [
      roleId,
      JSON.stringify(
        rules.map((rule) => ({
          label: rule.label,
          type: rule.type,
          value: rule.value,
          on_missing: rule.onMissing ?? null,
          position: rule.position,
        })),
      ),
    ],
  );

  return rows.map(toRule).sort((a, b) => a.position - b.position);
}

/**
 * @param {Queryable} db
 * @param {string} roleId
 * @returns {Promise<EliminationRule[]>} in position order
 */
export async function listEliminationRulesByRoleId(db, roleId) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM role_elimination_rules WHERE role_id = $1 ORDER BY position, id`,
    [roleId],
  );
  return rows.map(toRule);
}

/**
 * Batch form for the role list endpoint. See the criteria repository for why.
 *
 * @param {Queryable} db
 * @param {string[]} roleIds
 * @returns {Promise<Map<string, EliminationRule[]>>} keyed by role id
 */
export async function listEliminationRulesByRoleIds(db, roleIds) {
  /** @type {Map<string, EliminationRule[]>} */
  const byRole = new Map();
  if (roleIds.length === 0) return byRole;

  const { rows } = await db.query(
    `SELECT ${COLUMNS}
       FROM role_elimination_rules
      WHERE role_id = ANY($1::uuid[])
      ORDER BY role_id, position, id`,
    [roleIds],
  );

  for (const row of rows) {
    const rule = toRule(row);
    const existing = byRole.get(rule.roleId);
    if (existing) {
      existing.push(rule);
    } else {
      byRole.set(rule.roleId, [rule]);
    }
  }

  return byRole;
}
