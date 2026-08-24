/**
 * A shared secret on the three endpoints that spend real API money.
 *
 * ## This is not authentication, and the README says so in those words
 *
 * The frontend has to send this header, which means the value is compiled into
 * the client bundle and is visible to anyone who opens devtools. It is a **speed
 * bump against a crawler or a passer-by who finds the deployed URL**, sitting
 * alongside the per-IP rate limit in `routes/index.js`. It is not an access
 * control, it establishes no principal, and nothing in this system is safe to
 * expose on a public network on the strength of it (plan section 0: no auth).
 *
 * What it actually buys is the thing worth buying: the deployment runs on an
 * API key with a real balance, and this stops that balance being spent by
 * anything that merely found the URL.
 *
 * ## Which endpoints, and why three rather than two
 *
 * The two upload endpoints are obvious. `POST /candidates/:id/retry` is the one
 * that gets missed: it re-runs **both** model calls from scratch, so it spends
 * exactly as much as an upload does. It is also not inside the rate-limited
 * plugin scope, which makes it the cheapest endpoint to abuse and the most
 * important one to cover.
 *
 * ## Off unless configured
 *
 * With `UPLOAD_ACCESS_TOKEN` absent `checkUploadToken` returns `null` for
 * everything, so the hook - which `routes/index.js` registers unconditionally -
 * runs and allows every request. That is what keeps local development and the
 * entire test suite untouched: no fixture has to learn a header, and no existing
 * test changes.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors/AppError.js';
import { env } from '../config/env.js';

/** The header carrying the secret. Lower-case: Node normalises incoming names. */
export const UPLOAD_TOKEN_HEADER = 'x-upload-token';

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on buffers of different lengths, which would leak the
 * secret's length through an exception and defeat the point. Hashing both sides
 * first gives two 32-byte buffers whatever the inputs were, so the comparison is
 * always defined and always constant-time.
 *
 * Worth being honest about the value of this: the token is public in the client
 * bundle, so a timing attack against it is not the threat. It costs one hash and
 * it means the comparison is not the thing a reviewer has to think about.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function secretEquals(a, b) {
  return timingSafeEqual(
    createHash('sha256').update(a, 'utf8').digest(),
    createHash('sha256').update(b, 'utf8').digest(),
  );
}

/**
 * The whole decision, as a pure function of the request's method and headers.
 *
 * Pure so the policy is testable without a server, a socket or a route table -
 * the same reason `pollSchedule.js` exists on the client side. The Fastify hook
 * below is four lines and contains no branches of its own.
 *
 * @param {object} input
 * @param {string} input.method the HTTP method
 * @param {Record<string, unknown>} input.headers
 * @param {string | undefined} input.expectedToken `env.UPLOAD_ACCESS_TOKEN`
 * @returns {AppError | null} the error to answer with, or null to allow
 */
export function checkUploadToken({ method, headers, expectedToken }) {
  // The guard is opt-in. No token configured is not a misconfiguration - it is
  // development, and it is the test suite.
  if (expectedToken === undefined) return null;

  // A CORS preflight carries no custom headers by definition: the browser sends
  // OPTIONS precisely to ask whether it may send `x-upload-token`. Rejecting it
  // would make every guarded cross-origin request fail before the real request
  // was ever attempted, and the browser would report it as a CORS error with no
  // mention of a token - which is an afternoon of debugging the wrong thing.
  if (method === 'OPTIONS') return null;

  const provided = headers[UPLOAD_TOKEN_HEADER];

  // A repeated header arrives as an array. Rejecting rather than picking one is
  // the only defensible reading: two different values is a client that does not
  // know what it is sending, and choosing between them would be guessing.
  if (typeof provided !== 'string' || !secretEquals(provided, expectedToken)) {
    return new AppError(
      'UPLOAD_TOKEN_INVALID',
      'This endpoint requires an upload token. Set it in the client configuration and try again.',
      // No `details`. There is nothing to say that does not help somebody guess:
      // not the expected length, not whether the header was absent or merely
      // wrong. The recruiter using the real client never sees this.
      {},
    );
  }

  return null;
}

/**
 * The Fastify hook. Registered by `routes/index.js` inside the scope that holds
 * the money-spending routes, so it can never accidentally cover the dashboard's
 * three-second poll.
 *
 * `onRequest` rather than `preHandler`: it runs before the body is parsed, so a
 * request with no token never gets a 5 MB multipart body streamed to disk first.
 * Refusing early is the whole point of a cost guard.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} _reply
 * @returns {Promise<void>}
 */
export async function uploadTokenHook(request, _reply) {
  const failure = checkUploadToken({
    method: request.method,
    headers: /** @type {Record<string, unknown>} */ (request.headers),
    expectedToken: env.UPLOAD_ACCESS_TOKEN,
  });

  // Thrown, not replied: the central `errorHandler` owns the envelope, the
  // status lookup and the `requestId`, and a handler that sent its own response
  // would be the one place in the API answering in a different shape.
  if (failure !== null) throw failure;
}
