/**
 * The route table: path to controller, and nothing else.
 *
 * No validation, no business logic, no database. A reader should be able to see
 * the whole API surface from plan section 3 in one screen and know exactly which
 * function answers each line of it.
 *
 * Two ordering facts are load-bearing and are commented where they apply:
 * `/candidates/statuses` before `/candidates/:candidateId`, and the rate limit
 * scoped to the upload routes alone.
 */

import { env } from '../config/env.js';
import {
  getCandidateById,
  getCandidateStatusesHandler,
  getCandidates,
  postCandidateRetry,
} from '../controllers/candidatesController.js';
import { getConfig, getHealth } from '../controllers/metaController.js';
import { getJob } from '../controllers/jobsController.js';
import {
  deleteRole,
  getRoleById,
  getRoles,
  postRole,
  putRole,
} from '../controllers/rolesController.js';
import { postCandidate, postCandidateBatch } from '../controllers/uploadsController.js';

/** The one version prefix. */
export const API_PREFIX = '/api/v1';

/**
 * @param {import('fastify').FastifyInstance} app
 * @returns {Promise<void>}
 */
export async function registerRoutes(app) {
  app.get('/config', getConfig);
  app.get('/health', getHealth);

  app.post('/roles', postRole);
  app.get('/roles', getRoles);
  app.get('/roles/:roleId', getRoleById);
  app.put('/roles/:roleId', putRole);
  app.delete('/roles/:roleId', deleteRole);

  // The two endpoints that spend real API money, and therefore the only two
  // that are rate limited (plan section 3). With no auth the only principal is
  // the client IP, which bounds how much this buys - it is a cost guard, not a
  // security control, and the README says so.
  //
  // Scoped inside a plugin rather than applied globally: rate-limiting a
  // dashboard that polls every 3 seconds would break the product to protect
  // nothing.
  await app.register(async (uploads) => {
    await uploads.register(import('@fastify/rate-limit'), {
      max: env.UPLOAD_RATE_LIMIT_MAX,
      timeWindow: env.UPLOAD_RATE_LIMIT_WINDOW_MS,
      // In-process counters. A second API instance would count separately; that
      // is honest for a cost guard and would need Redis to be otherwise.
      // `RATE_LIMITED` and the `Retry-After` header come from the plugin, mapped
      // to our envelope in `errorHandler.js`.
      addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true },
    });

    uploads.post('/roles/:roleId/candidates', postCandidate);
    uploads.post('/roles/:roleId/candidates/batch', postCandidateBatch);
  });

  app.get('/jobs/:jobId', getJob);

  app.get('/candidates', getCandidates);
  // MUST come before `/candidates/:candidateId`. Fastify's router prefers a
  // static segment over a parametric one, so this is belt and braces - but the
  // day somebody reorders these by accident, `statuses` becomes a candidate id
  // that fails a uuid check, and the poll returns 400 for no visible reason.
  app.get('/candidates/statuses', getCandidateStatusesHandler);
  app.get('/candidates/:candidateId', getCandidateById);
  app.post('/candidates/:candidateId/retry', postCandidateRetry);
}
