/**
 * The extraction layer's public surface - phase 3.
 *
 * Everything phase 4 needs and nothing else. The parsers, the ZIP reader and
 * the text assembler are internal: they are exported from their own files for
 * their own tests, and importing them from outside this directory would be
 * reaching past the interface plan section 7-F asks for.
 *
 * Mirrors `src/agents/index.js`, deliberately - one entry point per layer, so a
 * reader can see a layer's whole contract in one file.
 */

export {
  EMPTY_FILE_MESSAGE,
  UNSUPPORTED_TYPE_MESSAGE,
  extractDocumentText,
} from './extract-document-text.js';

export {
  EXTRACTION_ERROR_CODES,
  MIME_TYPES,
  MIN_CHARACTERS_PER_PAGE,
  SUPPORTED_MIME_TYPES,
} from './constants.js';

export {
  EmptyDocumentError,
  ExtractionError,
  ExtractionFailedError,
  UnsupportedFileTypeError,
} from './errors.js';

/**
 * Exported for the upload path specifically.
 *
 * Plan section 3 answers 415 `UNSUPPORTED_FILE_TYPE` on upload, and that
 * decision should be made on the bytes in the request rather than on the
 * `Content-Type` the client attached to them. Sniffing is cheap and needs no
 * parser, so the controller can reject before anything is written to disk or a
 * candidate row exists.
 */
export { sniffMimeType } from './sniff.js';

/**
 * Exported so the worker can log the structural facts next to `assessCvText`'s
 * stats when a candidate fails. Together they distinguish "the file was a
 * picture" from "the CV was thin", and those are different conversations with a
 * recruiter.
 */
export { assessTextLayer } from './text-layer.js';

/** Plan section 7-F's exact wording, exported so phase 4 can assert on it. */
export { SCANNED_PDF_MESSAGE } from './parsers/pdf.js';
