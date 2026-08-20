/**
 * The API error namespace, and the one place a code becomes an HTTP status.
 *
 * This is plan section 3's table, transcribed. It is a frozen object rather than
 * a switch in the error handler so that the mapping is data a test can walk: a
 * code added without a status, or a status invented at a throw site, fails a
 * test rather than reaching a client as a 500.
 *
 * ## Two namespaces, kept apart on purpose
 *
 * There is a second, separate set of codes - the worker-side ones in
 * `src/agents/constants.js` (`AGENT_TIMEOUT`, `EXTRACTION_FAILED`, ...). Those
 * are stored in `candidates.error_code` and returned **inside a 200**, because a
 * candidate that failed to screen is a successful read of a failed candidate.
 * They are never mapped to an HTTP status and they never appear here.
 *
 * `UNSUPPORTED_FILE_TYPE` is the one code that looks like it belongs to both and
 * belongs only here (plan section 5.4): a file whose bytes we cannot read never
 * becomes a candidate row, so there is no `candidates.error_code` to store it
 * in. It is a 415 at the upload boundary, decided by sniffing the bytes before
 * anything is written.
 */

/**
 * Code to HTTP status. Every code this API can produce is here, and nothing
 * throws a status directly.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const ERROR_STATUS_BY_CODE = Object.freeze({
  VALIDATION_FAILED: 400,
  EMPTY_UPLOAD: 400,

  ROLE_NOT_FOUND: 404,
  CANDIDATE_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  NOT_FOUND: 404,

  ROLE_ARCHIVED: 409,
  ROLE_NOT_SCOREABLE: 409,
  CANDIDATE_NOT_RETRYABLE: 409,

  SOURCE_FILE_MISSING: 410,

  FILE_TOO_LARGE: 413,
  TOO_MANY_FILES: 413,

  UNSUPPORTED_FILE_TYPE: 415,

  WEIGHTS_MUST_SUM_TO_100: 422,
  DUPLICATE_CRITERION_LABEL: 422,

  RATE_LIMITED: 429,

  STORAGE_WRITE_FAILED: 500,
  INTERNAL_ERROR: 500,

  DEPENDENCY_UNAVAILABLE: 503,
});

/**
 * Named constants for the codes, so a throw site cannot typo a string.
 *
 * Derived from the table above rather than written twice - the two drifting
 * apart is exactly the failure this file exists to prevent.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ERROR_CODES = Object.freeze(
  Object.fromEntries(Object.keys(ERROR_STATUS_BY_CODE).map((code) => [code, code])),
);

/**
 * `NOT_FOUND` is not in plan section 3's table. It exists for one thing only -
 * an unrouted path - because Fastify's own 404 has to become the same envelope
 * as everything else, and inventing `ROLE_NOT_FOUND` for `/api/v1/nonsense`
 * would be a lie about which resource was missing.
 */
export const ROUTE_NOT_FOUND_CODE = 'NOT_FOUND';

/**
 * @param {string} code
 * @returns {number} the HTTP status, or 500 for a code nobody registered
 */
export function statusForCode(code) {
  return ERROR_STATUS_BY_CODE[code] ?? ERROR_STATUS_BY_CODE.INTERNAL_ERROR;
}
