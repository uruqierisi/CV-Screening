/**
 * Candidate reads, the poll, and the retry.
 */

import { ok, parseOrThrow } from '../http/boundary.js';
import {
  toCandidateDetailDto,
  toCandidateListDto,
  toCandidateStatusDto,
} from '../http/dto/candidateDto.js';
import {
  candidateDetailQuerySchema,
  candidateStatusesQuerySchema,
  listCandidatesQuerySchema,
} from '../schemas/candidate.schemas.js';
import { paginationMeta, toLimitOffset, uuidParam } from '../schemas/common.schemas.js';
import {
  getCandidate,
  getCandidateStatuses,
  listCandidatesPage,
  retryCandidate,
} from '../services/candidatesService.js';

/**
 * `GET /api/v1/candidates` -> 200
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function getCandidates(request, reply) {
  const query = parseOrThrow(listCandidatesQuerySchema, request.query);

  const { candidates, total, counts } = await listCandidatesPage({
    ...toLimitOffset(query),
    sort: /** @type {'desc'|'asc'} */ (query.sort),
    roleId: query.roleId,
    jobId: query.jobId,
    fitCategory: query.fitCategory,
    status: query.status,
  });

  return reply.send(
    ok(candidates.map(toCandidateListDto), {
      ...paginationMeta({ page: query.page, pageSize: query.pageSize, total }),
      // Across the whole filtered set, not the page. A 25-row page cannot tell a
      // recruiter how many Strong Matches exist, and that number is the header
      // of the control they are about to press.
      counts,
    }),
  );
}

/**
 * `GET /api/v1/candidates/statuses?ids=a,b,c` -> 200
 *
 * Declared before `/candidates/:candidateId` in the route file, or `statuses`
 * would be parsed as a candidate id and fail its uuid check.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function getCandidateStatusesHandler(request, reply) {
  const { ids } = parseOrThrow(candidateStatusesQuerySchema, request.query);
  const statuses = await getCandidateStatuses(ids);

  return reply.send(
    ok(statuses.map(toCandidateStatusDto), {
      requested: ids.length,
      // A client polling ids that have gone away needs to know, or it polls
      // them forever.
      found: statuses.length,
    }),
  );
}

/**
 * `GET /api/v1/candidates/:candidateId` -> 200
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function getCandidateById(request, reply) {
  const candidateId = parseOrThrow(uuidParam, /** @type {any} */ (request.params).candidateId);
  const { includeRawText } = parseOrThrow(candidateDetailQuerySchema, request.query);

  const candidate = await getCandidate(candidateId, { includeRawText });
  return reply.send(ok(toCandidateDetailDto(candidate)));
}

/**
 * `POST /api/v1/candidates/:candidateId/retry` -> 202
 *
 * 202 rather than 200, and it is the same 202 the upload endpoints return for
 * the same reason: the work has been accepted and recorded, and it has not
 * happened yet.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function postCandidateRetry(request, reply) {
  const candidateId = parseOrThrow(uuidParam, /** @type {any} */ (request.params).candidateId);
  const { candidate, queueJobId } = await retryCandidate(candidateId, {
    enqueue: /** @type {any} */ (request.server).queue.enqueueCandidate,
  });

  return reply.status(202).send(
    ok(toCandidateListDto(candidate), {
      // The fresh queue-job id, because the original was consumed by the
      // attempt that failed. Returned so a caller can correlate a retry with the
      // queue entry it produced.
      queueJobId,
      attempts: candidate.attempts,
    }),
  );
}
