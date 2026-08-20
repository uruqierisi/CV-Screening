/**
 * The one place an error becomes a response.
 *
 * Two rules, and everything here is one of them:
 *
 * 1. **A typed error is described.** An `AppError` carries a code from
 *    `errors/codes.js`, and the code carries the status. Its message and
 *    `details` were written in this repository for a person to read, so they are
 *    safe to serialize.
 * 2. **Anything else is not.** A driver error, a `TypeError`, a throw from a
 *    dependency - logged in full, including the stack, and answered with
 *    `INTERNAL_ERROR` and the `requestId` that finds that log line. No unknown
 *    `error.message` ever reaches a response body, because an unknown message is
 *    exactly where a connection string, a file path or a fragment of somebody's
 *    CV escapes.
 *
 * Between the two sits a short list of errors thrown by the framework and its
 * plugins - a malformed JSON body, a file over the multipart limit - which are
 * translated into the API's own codes rather than passed through with Fastify's
 * wording and Fastify's status. That translation is the only reason this file
 * knows any framework error code at all, and each one is named with the reason
 * it needs a translation.
 */

import { AppError, isAppError } from '../errors/AppError.js';
import { ERROR_CODES, ROUTE_NOT_FOUND_CODE } from '../errors/codes.js';

/**
 * Framework and plugin error codes that have a real equivalent in our namespace.
 *
 * Kept as data for the same reason the status table is: a reader can see the
 * whole translation without reading a branch, and a test can walk it.
 *
 * @type {Readonly<Record<string, { code: string, message: string }>>}
 */
export const FRAMEWORK_ERROR_TRANSLATIONS = Object.freeze({
  // @fastify/multipart, when a part exceeds `limits.fileSize`. Its own message
  // names the byte limit, which is useful, but its status is 413 with a
  // Fastify-shaped body rather than ours.
  FST_REQ_FILE_TOO_LARGE: {
    code: ERROR_CODES.FILE_TOO_LARGE,
    message: 'One of the uploaded files is larger than this server accepts.',
  },
  // @fastify/multipart, when more parts arrive than `limits.files` or
  // `limits.parts`. Both are backstops: the count a recruiter actually runs into
  // is enforced in `uploadsService.js`, because the plugin's limit stops busboy
  // emitting parts and reads as a premature close rather than as a refusal.
  FST_FILES_LIMIT: {
    code: ERROR_CODES.TOO_MANY_FILES,
    message: 'The upload contains more files than this server accepts at once.',
  },
  FST_PARTS_LIMIT: {
    code: ERROR_CODES.TOO_MANY_FILES,
    message: 'The upload contains more parts than this server accepts at once.',
  },
  // The request body ended mid-part: the client hung up, or a proxy cut it. A
  // 400 rather than a 500, because nothing on this side went wrong, and the
  // recruiter's next action is the same as for an empty upload - attach the
  // files and try again.
  ERR_STREAM_PREMATURE_CLOSE: {
    code: ERROR_CODES.EMPTY_UPLOAD,
    message: 'The upload did not finish sending. Attach the files and try again.',
  },
  // A body that is not multipart at all. To a recruiter this means the same
  // thing as attaching nothing.
  FST_INVALID_MULTIPART_CONTENT_TYPE: {
    code: ERROR_CODES.EMPTY_UPLOAD,
    message: 'Attach at least one CV file as multipart/form-data.',
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    code: ERROR_CODES.EMPTY_UPLOAD,
    message: 'Attach at least one CV file as multipart/form-data.',
  },
  // A JSON body that is not JSON. Fastify answers 400 already; this only puts
  // it in our envelope with our code.
  FST_ERR_CTP_INVALID_JSON_BODY: {
    code: ERROR_CODES.VALIDATION_FAILED,
    message: 'The request body is not valid JSON.',
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: {
    code: ERROR_CODES.VALIDATION_FAILED,
    message: 'The request body is empty.',
  },
});

/**
 * Decides what a thrown thing is, without deciding how to log it.
 *
 * Split out from the handler so it can be tested as a pure function over an
 * error, which is the part with all the branches in it.
 *
 * @param {any} error
 * @returns {{ appError: AppError, unexpected: boolean }} `unexpected` drives the
 *   log level and whether the original error is logged in full
 */
export function toAppError(error) {
  if (isAppError(error)) {
    return { appError: /** @type {AppError} */ (error), unexpected: false };
  }

  const translation = FRAMEWORK_ERROR_TRANSLATIONS[error?.code];
  if (translation !== undefined) {
    return {
      appError: new AppError(translation.code, translation.message, { cause: error }),
      unexpected: false,
    };
  }

  // @fastify/rate-limit's own error. Recognised by status rather than by code,
  // because the plugin sets `statusCode` and its `code` is not part of its
  // documented surface. 429 is unambiguous here: nothing else in this API
  // produces one.
  if (error?.statusCode === 429) {
    return {
      appError: new AppError(
        ERROR_CODES.RATE_LIMITED,
        'Too many uploads from this address. Wait a moment and try again.',
        { cause: error },
      ),
      unexpected: false,
    };
  }

  return {
    appError: new AppError(
      ERROR_CODES.INTERNAL_ERROR,
      'Something went wrong on the server. The failure has been logged.',
    ),
    unexpected: true,
  };
}

/**
 * Fastify's error handler. Registered once, in `app.js`.
 *
 * @param {any} error
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @returns {import('fastify').FastifyReply}
 */
export function errorHandler(error, request, reply) {
  const { appError, unexpected } = toAppError(error);

  if (unexpected) {
    // The whole error, stack included. This is the only copy of what actually
    // happened - the client is about to be told nothing but a request id.
    request.log.error({ err: error, requestId: request.id }, 'unhandled error');
  } else if (appError.status >= 500) {
    request.log.error({ err: error, code: appError.code }, appError.message);
  } else {
    // An expected client-side failure is not a fault of ours. Logged at info so
    // a wall of 404s is visible without drowning a real one.
    request.log.info(
      { code: appError.code, status: appError.status, requestId: request.id },
      'request rejected',
    );
  }

  return reply.status(appError.status).send({
    error: { ...appError.toResponse(), requestId: request.id },
  });
}

/**
 * The 404 for a path with no route. Separate from `errorHandler` because
 * Fastify never routes an unmatched request into it.
 *
 * `NOT_FOUND` rather than one of plan section 3's resource-specific codes: an
 * unrouted path has no resource, and answering `ROLE_NOT_FOUND` for
 * `/api/v1/nonsense` would be a lie about which thing was missing.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 * @returns {import('fastify').FastifyReply}
 */
export function notFoundHandler(request, reply) {
  return reply.status(404).send({
    error: {
      code: ROUTE_NOT_FOUND_CODE,
      message: 'No such endpoint.',
      requestId: request.id,
    },
  });
}
