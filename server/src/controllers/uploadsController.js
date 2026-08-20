/**
 * The two upload endpoints.
 *
 * The whole of the framework-specific part of an upload is the adapter below:
 * `@fastify/multipart`'s async iterator has a shape of its own, and the service
 * takes a shape a test can build from `Readable.from(bytes)`. Everything else -
 * the ordering, the sniffing, the transaction, the enqueue - is in the service,
 * where it can be exercised without an HTTP request.
 */

import { AppError } from '../errors/AppError.js';
import { env } from '../config/env.js';
import { ok, parseOrThrow } from '../http/boundary.js';
import { toUploadedCandidateDto } from '../http/dto/candidateDto.js';
import { uuidParam } from '../schemas/common.schemas.js';
import { uploadCandidates } from '../services/uploadsService.js';

/**
 * Adapts `request.files()` into the service's `IncomingFile` shape.
 *
 * A generator rather than an array: the parts must be consumed in order and each
 * one's stream must be drained before the next arrives, which is a property of
 * multipart and not something to buffer away.
 *
 * @param {import('fastify').FastifyRequest} request
 * @returns {AsyncGenerator<import('../services/uploadsService.js').IncomingFile>}
 */
async function* incomingFiles(request) {
  const parts = /** @type {any} */ (request).files({
    limits: {
      fileSize: env.MAX_UPLOAD_BYTES,
      fields: 0,
    },
    // No `files` limit here on purpose. The plugin's count limit stops busboy
    // emitting parts and surfaces as `ERR_STREAM_PREMATURE_CLOSE`, so the count
    // is enforced by the service - which refuses the extra part with a clean
    // `413 TOO_MANY_FILES` after draining it. See `app.js` for the backstop.
  });

  for await (const part of parts) {
    yield {
      // A filename is display-only and is never used to build a path. It is
      // still bounded, because it goes in a column and onto a screen.
      filename: typeof part.filename === 'string' && part.filename.length > 0
        ? part.filename.slice(0, 255)
        : 'unnamed',
      mimeType: typeof part.mimetype === 'string' ? part.mimetype : null,
      file: part.file,
    };
  }
}

/**
 * Shared by both endpoints, because they differ in exactly one number.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @param {number} maxFiles
 */
async function handleUpload(request, reply, maxFiles) {
  const roleId = parseOrThrow(uuidParam, /** @type {any} */ (request.params).roleId);

  if (!(/** @type {any} */ (request).isMultipart())) {
    throw new AppError('EMPTY_UPLOAD', 'Attach at least one CV file as multipart/form-data.');
  }

  const { job, entries } = await uploadCandidates({
    roleId,
    files: incomingFiles(request),
    maxFiles,
    enqueue: /** @type {any} */ (request.server).queue.enqueueCandidates,
    logger: request.log,
  });

  const duplicates = entries.filter((entry) => !entry.created).length;

  return reply.status(202).send(
    ok(
      {
        jobId: job.id,
        roleId: job.roleId,
        candidates: entries.map(toUploadedCandidateDto),
      },
      {
        // The observable half of upload idempotency. A caller can tell at a
        // glance whether this upload created work or found it already done,
        // without diffing the candidate list against anything.
        fileCount: job.fileCount,
        created: entries.length - duplicates,
        duplicates,
      },
    ),
  );
}

/**
 * `POST /api/v1/roles/:roleId/candidates` -> 202
 *
 * A single upload still creates a screening job of size 1, so the dashboard has
 * exactly one polling shape for both endpoints.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function postCandidate(request, reply) {
  return handleUpload(request, reply, 1);
}

/**
 * `POST /api/v1/roles/:roleId/candidates/batch` -> 202
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function postCandidateBatch(request, reply) {
  return handleUpload(request, reply, env.MAX_BATCH_FILES);
}
