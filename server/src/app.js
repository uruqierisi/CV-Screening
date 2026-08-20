/**
 * Builds the Fastify instance. **Does not listen.**
 *
 * That split is what makes the API testable: the whole suite calls
 * `app.inject()`, which runs a real request through the real router, the real
 * plugins and the real error handler without opening a socket. `server.js` is
 * the only file that binds a port.
 */

import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './http/errorHandler.js';
import { API_PREFIX, registerRoutes } from './routes/index.js';
import { enqueueCandidate, enqueueCandidates } from './queue/screeningQueue.js';
import { REDACTED_LOG_PATHS } from './util/logging.js';

/**
 * The queue functions the HTTP layer calls, gathered into one object.
 *
 * This is the composition root's single injection seam, and it exists for a
 * reason worth stating: **the API's job is to record intent durably and hand it
 * over**, and everything about that - the role checks, the sniffing, the
 * transaction, the ordering of COMMIT before enqueue - is testable without a
 * Redis. Passing these in means the whole upload and retry surface can be
 * exercised against a real Postgres with a recording fake here, and the queue
 * gets its own test where the thing under test is actually the queue.
 *
 * @returns {{ enqueueCandidate: typeof enqueueCandidate, enqueueCandidates: typeof enqueueCandidates }}
 */
export function defaultQueue() {
  return { enqueueCandidate, enqueueCandidates };
}

/**
 * @param {object} [options]
 * @param {boolean|object} [options.logger] override for tests
 * @param {ReturnType<typeof defaultQueue>} [options.queue]
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp({ logger, queue } = {}) {
  const app = Fastify({
    logger:
      logger ?? {
        level: env.LOG_LEVEL,
        // Redaction is configured here, at the logging boundary, once - not by
        // remembering to omit a header at each call site.
        redact: { paths: [...REDACTED_LOG_PATHS], censor: '[redacted]' },
      },
    // Fastify's own request id, returned in every error body as `requestId`. It
    // is the only thing a client is given for an INTERNAL_ERROR, so it has to be
    // the same string that appears in the log line.
    genReqId: () => globalThis.crypto.randomUUID(),
    // A client-supplied request id would let a caller poison the logs with a
    // value of their choosing, or collide two unrelated requests deliberately.
    requestIdHeader: false,
    // JSON bodies only reach the role endpoints; uploads are multipart and are
    // bounded separately by the multipart limits.
    bodyLimit: 1024 * 1024,
  });

  await app.register(multipart, {
    limits: {
      fileSize: env.MAX_UPLOAD_BYTES,
      // Deliberately ONE MORE than the batch endpoint accepts.
      //
      // The plugin's own file-count limit does not produce a usable error: when
      // it fires, busboy stops emitting parts and the request ends up as
      // `ERR_STREAM_PREMATURE_CLOSE`, which reads as a 500 for what is plainly a
      // client mistake. So the count is enforced one layer up, in
      // `uploadsService.js`, where refusing the (max + 1)-th part yields a clean
      // `413 TOO_MANY_FILES` - and this limit sits just above that as a backstop
      // that in practice never fires.
      files: env.MAX_BATCH_FILES + 1,
      // No non-file field is read by any endpoint, so accepting one would be
      // accepting input nothing validates.
      fields: 0,
    },
    // The default. Named explicitly because the whole 413 path depends on it:
    // with `false`, an oversized file arrives truncated and silently screens as
    // a broken CV instead of being refused.
    throwFileSizeLimit: true,
  });

  // Read by the upload and retry controllers as `request.server.queue`.
  app.decorate('queue', queue ?? defaultQueue());

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  await app.register(registerRoutes, { prefix: API_PREFIX });

  return app;
}
