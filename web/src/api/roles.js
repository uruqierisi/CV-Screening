/**
 * Role reads and writes.
 *
 * `PUT` is a full replacement, not a patch (plan section 3): a partial weight
 * edit turns sum-to-100 into a merge problem. The role form therefore sends the
 * whole role every time, and this module gives it no way to do anything else.
 */

import { request, toQueryString } from './client.js';

/**
 * @param {object} [options]
 * @param {number} [options.page]
 * @param {number} [options.pageSize]
 * @param {boolean} [options.includeArchived]
 * @param {AbortSignal} [options.signal]
 */
export function listRoles({ page, pageSize, includeArchived, signal } = {}) {
  const query = toQueryString({
    page,
    pageSize,
    includeArchived: includeArchived === undefined ? undefined : String(includeArchived),
  });
  return request(`/roles${query}`, { signal });
}

/**
 * @param {string} roleId
 * @param {{ signal?: AbortSignal }} [options]
 */
export function getRole(roleId, { signal } = {}) {
  return request(`/roles/${roleId}`, { signal });
}

/**
 * @param {object} body `{ title, description, criteria[], eliminationRules[] }`
 */
export function createRole(body) {
  return request('/roles', { method: 'POST', body });
}

/**
 * @param {string} roleId
 * @param {object} body the same shape as `createRole` - a full replacement
 */
export function replaceRole(roleId, body) {
  return request(`/roles/${roleId}`, { method: 'PUT', body });
}

/**
 * Soft archive. Idempotent, and answers 200 with the archived role rather than
 * 204, so the caller can update its list without a re-fetch.
 *
 * @param {string} roleId
 */
export function archiveRole(roleId) {
  return request(`/roles/${roleId}`, { method: 'DELETE' });
}
