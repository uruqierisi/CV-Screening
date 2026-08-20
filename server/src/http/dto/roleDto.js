/**
 * Role rows to response payloads.
 *
 * One shape, used by the list and by the detail read alike. A role is small -
 * a title, a handful of criteria, a handful of rules - so there is no argument
 * for a slimmer list projection here, and having one shape means the role form
 * can round-trip a GET into a PUT without a translation step.
 */

/**
 * @typedef {import('../../repositories/rolesRepository.js').Role} Role
 * @typedef {import('../../repositories/roleCriteriaRepository.js').RoleCriterion} RoleCriterion
 * @typedef {import('../../repositories/roleEliminationRulesRepository.js').EliminationRule} EliminationRule
 */

/**
 * @param {Date | string | null} value
 * @returns {string | null}
 */
function isoOrNull(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * @param {{ role: Role, criteria: RoleCriterion[], eliminationRules: EliminationRule[] }} input
 * @returns {Record<string, unknown>}
 */
export function toRoleDto({ role, criteria, eliminationRules }) {
  return {
    id: role.id,
    title: role.title,
    description: role.description,
    // The number stamped onto every candidate scored against this role. A client
    // showing "scored under v2, role is now v4" needs both ends of that.
    version: role.version,
    archived: role.archivedAt !== null,
    archivedAt: isoOrNull(role.archivedAt),
    criteria: criteria.map((criterion) => ({
      id: criterion.id,
      label: criterion.label,
      description: criterion.description,
      weight: criterion.weight,
      position: criterion.position,
    })),
    eliminationRules: eliminationRules.map((rule) => ({
      id: rule.id,
      label: rule.label,
      type: rule.type,
      value: rule.value,
      onMissing: rule.onMissing,
      position: rule.position,
    })),
    createdAt: isoOrNull(role.createdAt),
    updatedAt: isoOrNull(role.updatedAt),
  };
}
