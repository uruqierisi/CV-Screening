/**
 * Typed errors thrown by the extraction layer.
 *
 * Shaped like `agents/errors.js` on purpose - `code`, `details`, `retryable`, a
 * log-safe `toJSON` - because the worker that catches these also catches those,
 * and it should be able to store one code, show one message and make one retry
 * decision with a single `instanceof` however the failure arose.
 *
 * It is deliberately **not** a subclass of `AgentError`. This layer imports
 * nothing from `src/agents/`: extraction runs before the agent layer enters a
 * candidate's life, it has no idea an SDK exists, and a shared base class would
 * be the one import that makes the two layers hard to reason about separately.
 * Two small hierarchies that agree on shape cost less than one that couples
 * them. `boundaries.test.js` asserts the no-import rule rather than leaving it
 * to this comment.
 *
 * Every error carries a `userMessage`. These are the only strings in this layer
 * a recruiter ever sees, and they say what to *do* rather than what went wrong
 * internally - "re-upload a text-based PDF or a DOCX" is actionable, "the text
 * layer yielded 12 characters over 3 pages" is not, and the second belongs in
 * `details`, which goes to logs.
 *
 * No message, `userMessage` or `details` field in this file ever interpolates
 * document content. Counts, byte offsets, entry names and MIME types only - the
 * rule section 5.4 states for the agent layer, for the same reason: logs must
 * not become a second copy of somebody's CV.
 */

import { EXTRACTION_ERROR_CODES } from './constants.js';

/**
 * Base class for every extraction failure.
 */
export class ExtractionError extends Error {
  /**
   * @param {string} message internal, for logs
   * @param {object} params
   * @param {string} params.code the stored `candidates.error_code`
   * @param {string} params.userMessage recruiter-facing, safe to render
   * @param {Record<string, unknown>} params.details structured, log-safe context
   */
  constructor(message, { code, userMessage, details }) {
    super(message);
    this.name = new.target.name;
    /** @type {string} */
    this.code = code;
    /** @type {string} */
    this.userMessage = userMessage;
    /** @type {Record<string, unknown>} */
    this.details = details;
    /**
     * The agent layer *labels* retryability and the worker *decides* policy, so
     * the label travels even though this layer only ever sets one value.
     *
     * Always false, and there is no constructor knob to make it true. Every
     * failure here is a property of the bytes, and the bytes do not change
     * between attempts: a re-read of the same file produces the same scanned
     * PDF, the same broken ZIP and the same unsupported type. The one case that
     * looks like an exception - a truncated upload - is a *different* file on
     * re-upload, which is a new candidate rather than a retry of this one.
     *
     * @type {boolean}
     */
    this.retryable = false;
  }

  /**
   * Log-safe serialization. No stack: the logger attaches that.
   *
   * @returns {{ name: string, code: string, message: string, userMessage: string, retryable: boolean, details: Record<string, unknown> }}
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

/**
 * The bytes are not a PDF, a DOCX or a TXT.
 *
 * **Where this is meant to fire is the upload request, not the worker.**
 * Sniffing is cheap and runs on bytes already in memory, so phase 4 should call
 * `sniffMimeType` at upload and answer 415 before anything is written to disk
 * or a candidate row exists. Reaching this from the worker means the bytes on
 * disk are not what the allowlist accepted, which is a phase 4 bug rather than
 * a bad CV.
 *
 * That leaves phase 4 one decision this layer cannot make for it: plan section
 * 5.4's worker-side code namespace has no `UNSUPPORTED_FILE_TYPE`, so a worker
 * catching this has to map it to something before storing it. Raised in the
 * phase 3 report rather than settled here - inventing a namespace entry is
 * exactly the kind of quiet decision that later reads as a plan change.
 */
export class UnsupportedFileTypeError extends ExtractionError {
  /**
   * @param {object} params
   * @param {string} params.reason machine-readable sniff outcome, e.g. `zip_not_ooxml`
   * @param {string} params.userMessage what the recruiter is told to do
   * @param {Record<string, unknown>} params.details
   */
  constructor({ reason, userMessage, details }) {
    super(`file type not supported: ${reason}`, {
      code: EXTRACTION_ERROR_CODES.UNSUPPORTED_FILE_TYPE,
      userMessage,
      details: { reason, ...details },
    });
    /** @type {string} */
    this.reason = reason;
  }
}

/**
 * The file parsed, and there was nothing in it worth screening.
 *
 * **This is the OCR extension point.** Plan section 7-F declined OCR and
 * documented where it would go if that is ever revisited: here, at the single
 * place `EMPTY_DOCUMENT` is raised for a PDF, behind an interface that already
 * dispatches on the sniffed type. A future `parsers/ocr.js` would run in
 * `parsers/pdf.js` where this is thrown, and nothing above it would change.
 */
export class EmptyDocumentError extends ExtractionError {
  /**
   * @param {object} params
   * @param {string} params.userMessage recruiter-facing
   * @param {Record<string, unknown>} params.details counts and page totals only
   */
  constructor({ userMessage, details }) {
    super('the document yielded no usable text', {
      code: EXTRACTION_ERROR_CODES.EMPTY_DOCUMENT,
      userMessage,
      details,
    });
  }
}

/**
 * The file is the type it claims to be and could not be read anyway: a
 * truncated PDF, an encrypted one, a DOCX with no main document part, a ZIP
 * this reader will not open.
 *
 * Distinct from {@link EmptyDocumentError} because the two send a recruiter to
 * different actions - "this file is damaged" against "this file is a picture" -
 * and collapsing them would tell half of them to do the wrong thing.
 */
export class ExtractionFailedError extends ExtractionError {
  /**
   * @param {object} params
   * @param {string} params.reason machine-readable, e.g. `pdf_password_required`
   * @param {string} params.message internal detail for logs
   * @param {string} params.userMessage recruiter-facing
   * @param {Record<string, unknown>} params.details
   * @param {unknown} [params.cause] the underlying library error, for the log
   */
  constructor({ reason, message, userMessage, details, cause }) {
    super(message, {
      code: EXTRACTION_ERROR_CODES.EXTRACTION_FAILED,
      userMessage,
      details: { reason, ...details },
    });
    /** @type {string} */
    this.reason = reason;
    // Assigned unconditionally. `undefined` is what `Error.cause` is when
    // nothing caused it, and a guard here would be a branch with no test.
    this.cause = cause;
  }
}
