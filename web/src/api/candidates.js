/**
 * The three candidate reads and the retry.
 *
 * `listCandidateStatuses` is the poll payload and is deliberately separate from
 * `listCandidates`: the dashboard polls statuses for the ids already on screen
 * and patches them in place, so a poll never re-ranks the table underneath
 * somebody reading it.
 */

import { request, toQueryString } from './client.js';

/**
 * @param {object} params
 * @param {string} [params.roleId]
 * @param {string} [params.jobId]
 * @param {string} [params.fitCategory] one of the server's `fitCategories`
 * @param {string} [params.status]
 * @param {'asc'|'desc'} [params.sort]
 * @param {number} [params.page]
 * @param {number} [params.pageSize]
 * @param {AbortSignal} [params.signal]
 */
export function listCandidates({ signal, ...params } = {}) {
  return request(`/candidates${toQueryString(params)}`, { signal });
}

/**
 * Everything on a role that is not a finished, scored candidate: the three
 * non-terminal statuses plus `failed`.
 *
 * ## Four requests, and why
 *
 * `GET /candidates` takes **one** `status` value, and the ranking sorts
 * unscored candidates last in both directions - deliberately, so an in-progress
 * batch never pushes real results off page 1. Together those mean there is no
 * single request that returns "everything still working plus everything that
 * failed": no `status` value covers four statuses, and no `sort` brings them to
 * the front.
 *
 * So this issues four filtered requests in parallel. They are small, each hits
 * the `(role_id, ...)` index, and they only run on load and on an explicit
 * refresh - the live updates that follow are the far cheaper
 * `GET /candidates/statuses`. The cost is four round trips where one would do.
 *
 * **This is the one place the frontend wants something the API does not offer.**
 * A repeatable `status` parameter, or a `statusIn` list, would collapse these
 * four into one. It is recorded here rather than worked around by fetching
 * everything and filtering in the client, which would move the whole candidate
 * table over the wire to find the three rows that are still parsing.
 *
 * @param {object} params
 * @param {string} params.roleId
 * @param {number} params.pageSize
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{ data: any[], meta: { truncated: boolean } }>}
 */
export async function listAttentionCandidates({ roleId, pageSize, signal }) {
  const statuses = ['pending', 'parsing', 'evaluating', 'failed'];

  const pages = await Promise.all(
    statuses.map((status) => listCandidates({ roleId, status, pageSize, signal })),
  );

  return {
    data: pages.flatMap((page) => page.data),
    meta: {
      // More than one page of a single status means this panel is not showing
      // everything, and it says so rather than quietly truncating.
      truncated: pages.some((page) => page.meta.totalPages > 1),
    },
  };
}

/**
 * The lightweight poll. Capped server-side at `config.candidates.maxStatusIds`.
 *
 * @param {string[]} ids
 * @param {{ signal?: AbortSignal }} [options]
 */
export function listCandidateStatuses(ids, { signal } = {}) {
  return request(`/candidates/statuses${toQueryString({ ids: ids.join(',') })}`, { signal });
}

/**
 * @param {string} candidateId
 * @param {{ includeRawText?: boolean, signal?: AbortSignal }} [options]
 */
export function getCandidate(candidateId, { includeRawText, signal } = {}) {
  const query = toQueryString({
    includeRawText: includeRawText === true ? 'true' : undefined,
  });
  return request(`/candidates/${candidateId}${query}`, { signal });
}

/**
 * Re-enqueues a terminally failed candidate. 202, and the candidate comes back
 * as `pending`.
 *
 * @param {string} candidateId
 */
export function retryCandidate(candidateId) {
  return request(`/candidates/${candidateId}/retry`, { method: 'POST' });
}
