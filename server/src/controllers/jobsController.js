/**
 * `GET /api/v1/jobs/:jobId` - the poll target for an in-flight upload.
 */

import { ok, parseOrThrow } from '../http/boundary.js';
import { uuidParam } from '../schemas/common.schemas.js';
import { getJobStatus } from '../services/jobsService.js';

/**
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function getJob(request, reply) {
  const jobId = parseOrThrow(uuidParam, /** @type {any} */ (request.params).jobId);
  return reply.send(ok(await getJobStatus(jobId)));
}
