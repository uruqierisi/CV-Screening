/**
 * A thrown thing, turned into what goes in `candidates.error_code`,
 * `candidates.error_message`, and whether it is worth another attempt.
 *
 * This is the worker's half of the two-namespace split. The codes here are the
 * ones from plan section 5.4 - stored on the row, returned **inside a 200**,
 * never mapped to an HTTP status. Nothing in this file imports
 * `errors/codes.js`, and nothing here produces a status.
 *
 * ## Where the labels come from
 *
 * The agent layer and the extraction layer already carry everything needed: a
 * `code` from the worker-side namespace, a `userMessage` written for a
 * recruiter, and - on the agent side - a `retryable` label. **The agent layer
 * labels retryability; the worker decides retry policy.** So this file reads
 * those fields rather than re-deriving them from an error class list that would
 * drift the first time a new one is added.
 *
 * ## The one translation
 *
 * `UnsupportedFileTypeError` can only reach the worker if the bytes on disk are
 * not what the upload allowlist accepted - which is a bug in the upload path,
 * not a bad CV. Section 5.4 is explicit that `UNSUPPORTED_FILE_TYPE` is **not**
 * in the worker-side namespace, so storing it would invent a candidate error
 * code that the API's own table also owns. It is stored as `EXTRACTION_FAILED`,
 * which is true - the file could not be read - and the real reason is in the
 * log.
 */

import { AGENT_ERROR_CODES } from '../agents/index.js';
import { EXTRACTION_ERROR_CODES } from '../extraction/index.js';

/**
 * `SOURCE_FILE_MISSING` is in both namespaces, and deliberately: as an API code
 * it is the 410 from the retry endpoint, and as a candidate code it is what a
 * worker stores when the file vanished between upload and screening. Same words,
 * same meaning, two places it can be observed.
 */
export const SOURCE_FILE_MISSING_CODE = 'SOURCE_FILE_MISSING';

/** Fallback message when an error carries none of its own. */
const GENERIC_MESSAGE =
  'Screening this CV failed. Retry the candidate, or re-upload the CV if the problem persists.';

/**
 * Every code this worker may store, so a test can assert that nothing outside
 * plan section 5.4's list can reach the column.
 *
 * @type {readonly string[]}
 */
export const WORKER_CANDIDATE_ERROR_CODES = Object.freeze([
  EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
  EXTRACTION_ERROR_CODES.EMPTY_DOCUMENT,
  AGENT_ERROR_CODES.TIMEOUT,
  AGENT_ERROR_CODES.RATE_LIMIT,
  AGENT_ERROR_CODES.UPSTREAM,
  AGENT_ERROR_CODES.REFUSED,
  AGENT_ERROR_CODES.BAD_OUTPUT,
  AGENT_ERROR_CODES.INCOMPLETE_EVAL,
  AGENT_ERROR_CODES.INPUT_TOO_LARGE,
  AGENT_ERROR_CODES.SCHEMA_REJECTED,
  AGENT_ERROR_CODES.INVALID_ROLE,
  AGENT_ERROR_CODES.UNKNOWN_RULE,
  SOURCE_FILE_MISSING_CODE,
]);

const KNOWN_CODES = new Set(WORKER_CANDIDATE_ERROR_CODES);

/**
 * @typedef {object} CandidateFailure
 * @property {string} errorCode stored in `candidates.error_code`
 * @property {string} errorMessage stored in `candidates.error_message`; recruiter-facing
 * @property {boolean} retryable whether another queue attempt could plausibly help
 */

/**
 * @param {any} error
 * @returns {CandidateFailure}
 */
export function toCandidateFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : null;

  if (code === EXTRACTION_ERROR_CODES.UNSUPPORTED_FILE_TYPE) {
    return {
      errorCode: EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
      errorMessage:
        typeof error.userMessage === 'string' ? error.userMessage : GENERIC_MESSAGE,
      // The bytes will not change on their own.
      retryable: false,
    };
  }

  if (code !== null && KNOWN_CODES.has(code)) {
    return {
      errorCode: code,
      errorMessage: typeof error.userMessage === 'string' ? error.userMessage : GENERIC_MESSAGE,
      retryable: error.retryable === true,
    };
  }

  // Anything else: a bug of ours, a driver error, a `TypeError`. It gets the
  // generic message, because an unknown `error.message` is exactly where a
  // fragment of somebody's CV or a connection string escapes into a column the
  // dashboard renders. The real error is logged in full by the caller.
  return {
    errorCode: EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
    errorMessage: GENERIC_MESSAGE,
    // Unknown means unknown. Retrying once or twice costs a little and can
    // rescue a transient fault; the attempt count bounds it either way.
    retryable: true,
  };
}
