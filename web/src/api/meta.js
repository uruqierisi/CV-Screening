/**
 * `/config` and `/jobs/:jobId`.
 *
 * `/config` is fetched exactly once, at app start, by `ConfigProvider`. It
 * carries the upload limits, the elimination-rule descriptors and the tier
 * thresholds, and it exists so those are defined once server-side rather than
 * duplicated as client constants that drift (plan section 3). Nothing in this
 * client hard-codes 85, 65, a byte limit or a rule type.
 */

import { request } from './client.js';

/** @param {{ signal?: AbortSignal }} [options] */
export function getConfig({ signal } = {}) {
  return request('/config', { signal });
}

/**
 * Derived job status and counts. The upload screen polls this.
 *
 * @param {string} jobId
 * @param {{ signal?: AbortSignal }} [options]
 */
export function getJob(jobId, { signal } = {}) {
  return request(`/jobs/${jobId}`, { signal });
}
