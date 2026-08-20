/**
 * The one interface. Bytes in, text and structural facts out.
 *
 * Everything above this - the upload controller, the worker - calls exactly this
 * function and knows nothing about PDFs, ZIPs or encodings. Plan section 7-F
 * requires that shape for a specific reason: it is what lets an OCR fallback be
 * added later "at the point where `EMPTY_DOCUMENT` is currently raised, with no
 * change above it". A caller that branched on file type would have to be edited
 * too, and then so would its tests, and then the extension point would not be
 * one.
 *
 * The seam is three parts, and each is load-bearing:
 *
 * 1. **Dispatch on the sniffed type**, never on the declared one - `PARSERS`
 *    below is the whole dispatch table, and adding a format is adding a row.
 * 2. **One result shape**, whatever the format. `structure.pageCount` is `null`
 *    for a DOCX or a TXT because those have no pages, not because the field is
 *    optional.
 * 3. **One error hierarchy**, so a caller handles `EXTRACTION_FAILED`,
 *    `EMPTY_DOCUMENT` and `UNSUPPORTED_FILE_TYPE` and nothing else - never a
 *    `ZipReadError`, never a pdf.js exception.
 *
 * This layer is framework-agnostic in the same way `src/agents/` is: no Fastify,
 * no `pg`, no BullMQ, no filesystem. It is handed a Buffer. Reading the file is
 * the caller's job, which is what keeps the whole thing testable from an array
 * of bytes and is asserted by `test/extraction/boundaries.test.js`.
 */

import { MIME_TYPES } from './constants.js';
import { UnsupportedFileTypeError } from './errors.js';
import { parseDocx } from './parsers/docx.js';
import { parsePdf } from './parsers/pdf.js';
import { parseTxt } from './parsers/txt.js';
import { sniffMimeType } from './sniff.js';

/**
 * Recruiter-facing message for a file that is not one of the three types.
 *
 * One message for every rejection reason, on purpose. A recruiter cannot act on
 * "this ZIP is not an OOXML package"; the machine-readable reason is in
 * `details` for the log, where somebody can.
 */
export const UNSUPPORTED_TYPE_MESSAGE =
  'This file is not a PDF, a Word document or a plain text file. Re-upload the CV as a PDF or a DOCX.';

/** Said instead when the file has no bytes at all, because that is actionable. */
export const EMPTY_FILE_MESSAGE = 'This file is empty. Check the file and re-upload it.';

/**
 * The dispatch table. Adding a format is adding a row here and a parser;
 * nothing above this file learns about it.
 *
 * Each parser is `(bytes, context) => { text, ... } | Promise<...>`. Only the
 * PDF parser is async and only the PDF parser reports a page count - the
 * signature is uniform so the dispatch does not have to know which is which.
 */
const PARSERS = Object.freeze({
  [MIME_TYPES.PDF]: parsePdf,
  [MIME_TYPES.DOCX]: parseDocx,
  [MIME_TYPES.TXT]: parseTxt,
});

/**
 * What this layer hands upward.
 *
 * `structure` is the honest half of the division of labour with
 * `agents/util/text.js`: this layer knows how many pages there were and how many
 * characters came out of them, and `assessCvText` knows what usable CV text
 * looks like. Neither can do the other's job, so both facts travel.
 *
 * @typedef {object} ExtractedDocument
 * @property {string} text the extracted text, ready for `assessCvText`
 * @property {import('./constants.js').SupportedMimeType} mimeType what the bytes
 *   actually are - store this on the candidate, not what the client claimed
 * @property {object} structure
 * @property {number | null} structure.pageCount null for formats without pages
 * @property {number} structure.characters length of `text`
 * @property {number | null} structure.charactersPerPage null when there are no pages
 * @property {number} structure.byteSize the input size
 * @property {object} source what was claimed, for the log
 * @property {string | null} source.declaredMimeType
 * @property {boolean} source.mimeTypeMismatch true when the client was wrong
 * @property {string} source.sniffReason how the type was decided
 */

/**
 * Extracts text from an uploaded document.
 *
 * @param {object} params
 * @param {Buffer} params.bytes the whole file
 * @param {string | null} [params.declaredMimeType] what the client said it was.
 *   Recorded and then ignored - see `sniff.js` for why that is a policy rather
 *   than an oversight.
 * @returns {Promise<ExtractedDocument>}
 * @throws {import('./errors.js').UnsupportedFileTypeError} the bytes are not a
 *   PDF, DOCX or TXT
 * @throws {import('./errors.js').EmptyDocumentError} nothing usable came out -
 *   for a PDF this is plan section 7-F's scanned-image case
 * @throws {import('./errors.js').ExtractionFailedError} the file is the type it
 *   claims and could not be read anyway
 */
export async function extractDocumentText({ bytes, declaredMimeType = null }) {
  const sniffed = sniffMimeType(bytes);

  if (sniffed.mimeType === null) {
    throw new UnsupportedFileTypeError({
      reason: sniffed.reason,
      userMessage: sniffed.reason === 'empty_file' ? EMPTY_FILE_MESSAGE : UNSUPPORTED_TYPE_MESSAGE,
      details: { declaredMimeType, byteSize: bytes.length },
    });
  }

  const parse = PARSERS[sniffed.mimeType];
  const result = await parse(bytes, { encoding: sniffed.encoding });

  const pageCount = result.stats?.pageCount ?? null;

  return {
    text: result.text,
    mimeType: sniffed.mimeType,
    structure: {
      pageCount,
      characters: result.text.length,
      charactersPerPage: result.stats?.charactersPerPage ?? null,
      byteSize: bytes.length,
    },
    source: {
      declaredMimeType,
      // A mismatch is a log line, not a rejection. It is worth seeing because a
      // *rate* of mismatches means a broken client, while a single one usually
      // means a renamed file.
      mimeTypeMismatch: declaredMimeType !== null && declaredMimeType !== sniffed.mimeType,
      sniffReason: sniffed.reason,
    },
  };
}
