/**
 * Role business rules.
 *
 * Knows nothing about HTTP: it takes parsed data, returns plain objects, and
 * throws `AppError`s carrying codes the HTTP layer maps. The transaction
 * boundaries are here, which is the whole reason this layer exists between the
 * controller and the repositories - a role, its criteria and its rules are one
 * atomic thing, and the sum-to-100 constraint trigger is DEFERRABLE, so the
 * check happens at COMMIT and COMMIT has to be inside the same try.
 */

import { AppError } from '../errors/AppError.js';
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/withTransaction.js';
import {
  archiveRole,
  countRoles,
  findRoleById,
  insertRole,
  listRoles,
  updateRoleAndBumpVersion,
} from '../repositories/rolesRepository.js';
import {
  listCriteriaByRoleId,
  listCriteriaByRoleIds,
  replaceCriteriaForRole,
} from '../repositories/roleCriteriaRepository.js';
import {
  listEliminationRulesByRoleId,
  listEliminationRulesByRoleIds,
  replaceEliminationRulesForRole,
} from '../repositories/roleEliminationRulesRepository.js';

/**
 * @typedef {import('../schemas/role.schemas.js').RoleBody} RoleBody
 * @typedef {import('../repositories/rolesRepository.js').Role} Role
 * @typedef {object} FullRole
 * @property {Role} role
 * @property {import('../repositories/roleCriteriaRepository.js').RoleCriterion[]} criteria
 * @property {import('../repositories/roleEliminationRulesRepository.js').EliminationRule[]} eliminationRules
 */

/**
 * Position is the array index, assigned here rather than accepted from a client.
 *
 * @param {RoleBody} body
 * @returns {{ criteria: any[], eliminationRules: any[] }}
 */
function withPositions(body) {
  return {
    criteria: body.criteria.map((criterion, position) => ({ ...criterion, position })),
    eliminationRules: body.eliminationRules.map((rule, position) => ({ ...rule, position })),
  };
}

/**
 * Creates a role, its criteria and its rules in one transaction.
 *
 * @param {RoleBody} body already parsed by `roleBodySchema`
 * @returns {Promise<FullRole>}
 */
export async function createRole(body) {
  const { criteria, eliminationRules } = withPositions(body);

  return withTransaction(async (client) => {
    const role = await insertRole(client, { title: body.title, description: body.description });
    const insertedCriteria = await replaceCriteriaForRole(client, role.id, criteria);
    const insertedRules = await replaceEliminationRulesForRole(client, role.id, eliminationRules);
    return { role, criteria: insertedCriteria, eliminationRules: insertedRules };
  });
}

/**
 * Full replacement, per the PUT contract.
 *
 * Bumps `version`, unconditionally, because every field that could change is
 * being replaced and candidates already screened carry the old number in
 * `scored_role_version`. There is no rescore path (plan section 8), so the
 * version stamp is the only thing that tells a recruiter two rows on one
 * dashboard were judged by different rubrics.
 *
 * Editing an archived role is allowed. Archiving means "stop offering this for
 * new uploads", not "freeze it": fixing a typo in an archived role's title is
 * harmless, and refusing would force an un-archive endpoint nothing else needs.
 *
 * @param {string} roleId
 * @param {RoleBody} body
 * @returns {Promise<FullRole>}
 * @throws {AppError} ROLE_NOT_FOUND
 */
export async function replaceRole(roleId, body) {
  const { criteria, eliminationRules } = withPositions(body);

  return withTransaction(async (client) => {
    const role = await updateRoleAndBumpVersion(client, roleId, {
      title: body.title,
      description: body.description,
    });

    if (role === null) {
      throw new AppError('ROLE_NOT_FOUND', 'No role with that id.', { details: { roleId } });
    }

    const nextCriteria = await replaceCriteriaForRole(client, roleId, criteria);
    const nextRules = await replaceEliminationRulesForRole(client, roleId, eliminationRules);
    return { role, criteria: nextCriteria, eliminationRules: nextRules };
  });
}

/**
 * @param {string} roleId
 * @returns {Promise<FullRole>}
 * @throws {AppError} ROLE_NOT_FOUND
 */
export async function getRole(roleId) {
  const role = await findRoleById(pool, roleId);
  if (role === null) {
    throw new AppError('ROLE_NOT_FOUND', 'No role with that id.', { details: { roleId } });
  }

  const [criteria, eliminationRules] = await Promise.all([
    listCriteriaByRoleId(pool, roleId),
    listEliminationRulesByRoleId(pool, roleId),
  ]);

  return { role, criteria, eliminationRules };
}

/**
 * The paginated list, with each role's criteria and rules attached.
 *
 * Three queries for N roles rather than 2N + 1: the two batch repository
 * functions exist for exactly this, and a role list that fired a query per role
 * would be the N+1 this schema most invites.
 *
 * @param {{ limit: number, offset: number, includeArchived: boolean }} options
 * @returns {Promise<{ roles: FullRole[], total: number }>}
 */
export async function listRolesPage({ limit, offset, includeArchived }) {
  const [roles, total] = await Promise.all([
    listRoles(pool, { limit, offset, includeArchived }),
    countRoles(pool, { includeArchived }),
  ]);

  const roleIds = roles.map((role) => role.id);
  const [criteriaByRole, rulesByRole] = await Promise.all([
    listCriteriaByRoleIds(pool, roleIds),
    listEliminationRulesByRoleIds(pool, roleIds),
  ]);

  return {
    roles: roles.map((role) => ({
      role,
      criteria: criteriaByRole.get(role.id) ?? [],
      eliminationRules: rulesByRole.get(role.id) ?? [],
    })),
    total,
  };
}

/**
 * Soft archive. Idempotent, and never a hard delete: candidates reference roles
 * `ON DELETE RESTRICT` and the screening history has to survive the role.
 *
 * @param {string} roleId
 * @returns {Promise<FullRole>} the archived role, so a client can render it
 * @throws {AppError} ROLE_NOT_FOUND
 */
export async function archiveRoleById(roleId) {
  const role = await archiveRole(pool, roleId);
  if (role === null) {
    throw new AppError('ROLE_NOT_FOUND', 'No role with that id.', { details: { roleId } });
  }

  const [criteria, eliminationRules] = await Promise.all([
    listCriteriaByRoleId(pool, roleId),
    listEliminationRulesByRoleId(pool, roleId),
  ]);

  return { role, criteria, eliminationRules };
}

/**
 * The three checks an upload has to pass before a byte is written.
 *
 * Here rather than in the upload service because they are facts about a role,
 * and because the upload path is long enough that a reader should be able to see
 * this list in one place.
 *
 * @param {string} roleId
 * @returns {Promise<FullRole>}
 * @throws {AppError} ROLE_NOT_FOUND, ROLE_ARCHIVED, ROLE_NOT_SCOREABLE
 */
export async function assertRoleAcceptsUploads(roleId) {
  const full = await getRole(roleId);

  if (full.role.archivedAt !== null) {
    throw new AppError(
      'ROLE_ARCHIVED',
      'This role has been archived and is no longer accepting CVs.',
      { details: { roleId } },
    );
  }

  // A role with no criteria has nothing to score against, and - because the
  // sum-to-100 constraint trigger never fires for an empty set - it is the one
  // shape the database cannot rule out. Screening a candidate against it would
  // fail in the worker after the API spend, which is the expensive place to find
  // out.
  if (full.criteria.length === 0) {
    throw new AppError(
      'ROLE_NOT_SCOREABLE',
      'This role has no scoring criteria, so uploaded CVs could not be scored.',
      { details: { roleId } },
    );
  }

  return full;
}

/**
 * The role, in the shape the agent layer's `parseRole` expects.
 *
 * The translation is one function, here, so the worker does not have to know
 * that the repositories return three lists and the scoring layer wants one
 * object.
 *
 * @param {FullRole} full
 * @returns {{ id: string, title: string, version: number, criteria: any[], eliminationRules: any[] }}
 */
export function toScoringRole({ role, criteria, eliminationRules }) {
  return {
    id: role.id,
    title: role.title,
    version: role.version,
    criteria,
    eliminationRules,
  };
}
