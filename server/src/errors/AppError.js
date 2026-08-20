/**
 * The one error type services throw.
 *
 * Shaped so the HTTP layer has nothing left to decide: a code from
 * `errors/codes.js`, a message written for a person, and optional structured
 * `details`. The status is looked up from the code, never carried, so two throw
 * sites cannot disagree about what `ROLE_ARCHIVED` means.
 *
 * ## What reaches a client
 *
 * `message` and `details` on an `AppError` are, by construction, safe to
 * serialize: they are written here in this repository, by us, for a recruiter to
 * read. Anything else that reaches the error handler - a driver error, a
 * `TypeError`, a third-party throw - is logged in full and becomes
 * `INTERNAL_ERROR` with a `requestId` and nothing else. That asymmetry is the
 * whole point of having a type: "is this message safe to show" is answered by
 * `instanceof`, not by inspection at each catch site.
 *
 * So no `details` field may ever carry CV text, a profile, a stack, a SQL
 * fragment or a credential. The rule is the same one `src/agents/errors.js`
 * follows: ids, labels, counts and field paths only.
 */

import { statusForCode } from './codes.js';

export class AppError extends Error {
  /**
   * @param {string} code a key of `ERROR_STATUS_BY_CODE`
   * @param {string} message recruiter-facing; safe to render
   * @param {object} [options]
   * @param {Record<string, unknown>} [options.details] structured, log-safe context
   * @param {unknown} [options.cause] the original throw, for the log only
   */
  constructor(code, message, { details, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    /** @type {string} */
    this.code = code;
    /** @type {number} */
    this.status = statusForCode(code);
    /** @type {Record<string, unknown> | undefined} */
    this.details = details;
  }

  /**
   * The response body's `error` object, minus the `requestId` the handler adds.
   *
   * @returns {{ code: string, message: string, details?: Record<string, unknown> }}
   */
  toResponse() {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * True for an error this API is willing to describe to a client.
 *
 * A plain `instanceof` would be enough in one process, but the worker, the API
 * and the test suite can end up with the same module loaded twice under
 * different specifiers, and a duplicated class identity silently turns a 409
 * into a 500. The structural check costs nothing and cannot do that.
 *
 * @param {unknown} error
 * @returns {error is AppError}
 */
export function isAppError(error) {
  return (
    error instanceof AppError ||
    (typeof error === 'object' &&
      error !== null &&
      /** @type {any} */ (error).name === 'AppError' &&
      typeof (/** @type {any} */ (error).code) === 'string' &&
      typeof (/** @type {any} */ (error).status) === 'number')
  );
}

/**
 * Turns a zod failure into a `VALIDATION_FAILED` with one entry per bad field.
 *
 * `details.fields` is the contract the frontend renders: `path` is dotted so a
 * nested criterion reads `criteria.2.weight`, and `message` is zod's, which is
 * about the shape of the input rather than about anything internal.
 *
 * @param {import('zod').ZodError} error
 * @param {string} [message]
 * @returns {AppError}
 */
export function validationError(error, message = 'The request did not match the expected shape.') {
  return new AppError('VALIDATION_FAILED', message, {
    details: {
      fields: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
  });
}
