/**
 * Every constant this layer reads. Defined once, here, for the same reason
 * `agents/constants.js` exists: a threshold that appears in two files is a
 * threshold that will eventually disagree with itself.
 *
 * Nothing in this file imports anything. It is the bottom of the extraction
 * layer.
 */

/**
 * The allowlist from plan section 2, which is also the CHECK constraint on
 * `candidates.mime_type`. Anything not in here is `UNSUPPORTED_FILE_TYPE`.
 *
 * These are the *sniffed* types. What the client claimed the file was is
 * recorded and then ignored - see `sniff.js`.
 *
 * @typedef {'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' | 'text/plain'} SupportedMimeType
 */

/** @type {{ PDF: 'application/pdf', DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', TXT: 'text/plain' }} */
export const MIME_TYPES = Object.freeze({
  PDF: 'application/pdf',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  TXT: 'text/plain',
});

/** @type {readonly SupportedMimeType[]} */
export const SUPPORTED_MIME_TYPES = Object.freeze([
  MIME_TYPES.PDF,
  MIME_TYPES.DOCX,
  MIME_TYPES.TXT,
]);

/**
 * Error codes this layer raises.
 *
 * `EXTRACTION_FAILED` and `EMPTY_DOCUMENT` are worker-side candidate codes from
 * plan section 5.4 - stored in `candidates.error_code`, returned inside a 200,
 * never mapped to an HTTP status.
 *
 * `UNSUPPORTED_FILE_TYPE` is different and the difference is deliberate: it is
 * an *API* code from section 3 that maps to 415, because the place it is
 * supposed to fire is the upload request, where sniffing runs before anything
 * is written to disk. Reaching it from the worker means the bytes on disk are
 * not what the upload allowlist accepted, which is a bug in phase 4 rather than
 * a bad CV - see the note in `errors.js`.
 */
export const EXTRACTION_ERROR_CODES = Object.freeze({
  EXTRACTION_FAILED: 'EXTRACTION_FAILED',
  EMPTY_DOCUMENT: 'EMPTY_DOCUMENT',
  UNSUPPORTED_FILE_TYPE: 'UNSUPPORTED_FILE_TYPE',
});

/**
 * How far into the file to look for a signature.
 *
 * The PDF specification allows the `%PDF-` header to be preceded by junk, and
 * requires a conforming reader to find it within the first 1024 bytes. Real
 * files acquire that junk from mail gateways and download managers, so the
 * lenient read is the correct one rather than the generous one.
 */
export const SIGNATURE_SCAN_BYTES = 1024;

/**
 * How much of a file to decode before deciding it is plain text.
 *
 * A prefix rather than the whole file, because the decision is "does this look
 * like text" and a megabyte of it says nothing the first 8 KB did not. The
 * prefix is cut at a UTF-8 character boundary before decoding so a multi-byte
 * character split across the cut is not read as an encoding error.
 */
export const TEXT_SNIFF_BYTES = 8192;

/**
 * Control characters as a fraction of the sniffed prefix, above which the bytes
 * are not plain text. Tab, newline and carriage return are not counted - they
 * are the three control characters text files are made of.
 *
 * Set loose on purpose. This check exists to reject a binary that happens to
 * decode as UTF-8, not to police the contents of a text file, and a CV pasted
 * out of a word processor can carry form feeds and vertical tabs.
 */
export const MAX_CONTROL_CHARACTER_RATIO = 0.02;

/**
 * The scanned-PDF bar from plan section 7-F: "a PDF whose text layer yields too
 * little extractable text for its page count".
 *
 * 100 characters per page is deliberately far below any real CV page (1,500 to
 * 4,000 characters is typical, and even a sparse design-led one clears 300).
 * The asymmetry is the argument: a false positive here tells a recruiter to
 * re-upload a file that was fine, which is the worst outcome this layer can
 * produce, while a false negative costs nothing at all - `assessCvText` runs
 * next, applies a 200-character floor of its own, and fails the candidate
 * before a token is spent. Two cheap overlapping checks, and the one that is
 * cheap to be wrong about is the one set generously.
 */
export const MIN_CHARACTERS_PER_PAGE = 100;

/**
 * Ceiling on the inflated size of a single DOCX entry, in bytes.
 *
 * A DOCX is a ZIP and a ZIP can lie about what it costs to open: a few hundred
 * bytes of compressed zeroes inflate to gigabytes. Uploads are untrusted by
 * definition, so the reader stops at a bound rather than trusting the size the
 * archive declares. 64 MB of `word/document.xml` is roughly a 20,000-page
 * document - far past any CV and far short of a memory problem.
 */
export const MAX_DOCX_ENTRY_BYTES = 64 * 1024 * 1024;

/** The one entry inside a DOCX this layer reads. */
export const DOCX_DOCUMENT_ENTRY = 'word/document.xml';

/** Present in every OOXML package; used to tell a DOCX from any other ZIP. */
export const OOXML_CONTENT_TYPES_ENTRY = '[Content_Types].xml';

/**
 * The WordprocessingML main-document content type. Its presence in
 * `[Content_Types].xml` is what makes a ZIP a DOCX rather than an XLSX, a PPTX,
 * an ODT or a JAR.
 */
export const DOCX_MAIN_DOCUMENT_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
