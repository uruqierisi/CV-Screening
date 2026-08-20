/**
 * What is this file, actually?
 *
 * **The extension and the client-supplied MIME type are not evidence.** Both are
 * strings a browser guessed or a user typed; neither has ever been checked
 * against a byte. A `.pdf` that is really a ZIP, an `application/pdf` that is
 * really a JPEG, and an `application/octet-stream` that is really a perfectly
 * good DOCX all arrive in normal traffic - the first two from renaming, the
 * third from a browser that declined to guess. So this module reads the bytes
 * and decides, and what the client said is recorded next to the answer for the
 * log and then ignored.
 *
 * The consequence, stated because it is a policy and not an implementation
 * detail: **a file is processed as what it is, not as what it claims.** A CV
 * uploaded as `application/pdf` that is genuinely a DOCX is extracted as a DOCX
 * rather than rejected. The alternative - refusing on mismatch - would reject
 * real CVs to punish a wrong Content-Type header the candidate never chose,
 * which trades a recruiter's pipeline for a purity nobody asked for. What the
 * mismatch does buy is a log line: `declaredMimeType !== mimeType` on a large
 * fraction of uploads means a client is broken, and that is worth seeing.
 *
 * Rejection is driven by the sniffed type alone, against the plan section 2
 * allowlist. A ZIP that is not an OOXML word-processing package is
 * `UNSUPPORTED_FILE_TYPE` whatever it was uploaded as.
 */

import {
  DOCX_MAIN_DOCUMENT_CONTENT_TYPE,
  MAX_CONTROL_CHARACTER_RATIO,
  MIME_TYPES,
  OOXML_CONTENT_TYPES_ENTRY,
  SIGNATURE_SCAN_BYTES,
  TEXT_SNIFF_BYTES,
  MAX_DOCX_ENTRY_BYTES,
} from './constants.js';
import { findZipEntry, readZipDirectory, readZipEntry } from './zip.js';

/** `%PDF-`, the header every PDF starts with. */
const PDF_SIGNATURE = Buffer.from('%PDF-', 'latin1');

/**
 * The three things a ZIP can start with. `PK\x03\x04` is a local file header
 * and covers every archive with content in it; the other two are an empty
 * archive and a spanned one, matched so they are reported as ZIPs that cannot
 * be a DOCX rather than as unrecognised bytes.
 */
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY_ARCHIVE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP_SPANNED_ARCHIVE = Buffer.from([0x50, 0x4b, 0x07, 0x08]);

/**
 * A zero byte. Tested against the raw bytes rather than the decoded string, and
 * written as a number rather than a string escape, so that no literal NUL ever
 * appears in this source file - one would make the whole file read as binary to
 * grep, to git diff, and to every review tool downstream of them.
 */
const NUL_BYTE = 0x00;

/** Byte-order marks, which settle the encoding question outright. */
const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16_LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16_BE = Buffer.from([0xfe, 0xff]);

/**
 * The result of looking at the bytes.
 *
 * @typedef {object} SniffResult
 * @property {import('./constants.js').SupportedMimeType | null} mimeType null when
 *   the bytes are not one of the three supported types
 * @property {string} reason machine-readable, always set - it explains a null
 *   and also says *how* a non-null was decided, which is what makes a log line
 *   about a mis-declared upload readable
 * @property {'utf-8' | 'utf-16le' | 'utf-16be' | null} encoding for text only
 * @property {number} [signatureOffset] where `%PDF-` was found, when not 0
 */

/**
 * True when `haystack` starts with `needle`.
 *
 * @param {Buffer} haystack
 * @param {Buffer} needle
 * @returns {boolean}
 */
function startsWith(haystack, needle) {
  return haystack.length >= needle.length && haystack.subarray(0, needle.length).equals(needle);
}

/**
 * Looks for the PDF header in the first {@link SIGNATURE_SCAN_BYTES}.
 *
 * Not just at offset 0: the PDF specification requires a conforming reader to
 * accept a header preceded by junk within the first 1024 bytes, and files pick
 * that junk up from mail gateways. pdf.js accepts them, so refusing here would
 * mean rejecting files the parser would have read.
 *
 * @param {Buffer} bytes
 * @returns {number} offset, or -1
 */
function findPdfSignature(bytes) {
  return bytes.subarray(0, SIGNATURE_SCAN_BYTES + PDF_SIGNATURE.length).indexOf(PDF_SIGNATURE);
}

/**
 * Decides whether a ZIP is a WordprocessingML package.
 *
 * The test is the OOXML content-type declaration, not the presence of
 * `word/document.xml`. Both an XLSX and a DOCX are ZIPs full of XML, and a
 * malformed package can carry a `word/` directory without being a document -
 * `[Content_Types].xml` naming the main-document part is the thing the format
 * actually defines.
 *
 * @param {Buffer} bytes
 * @returns {SniffResult}
 */
function sniffZip(bytes) {
  const directory = readZipDirectory(bytes);
  if (directory.failure !== null) {
    // A ZIP header on something this reader cannot open. Reported as an
    // unreadable ZIP rather than as "not a DOCX", because the two send whoever
    // reads the log to different places - one is a damaged upload, the other is
    // somebody sending the wrong file.
    return { mimeType: null, reason: `zip_unreadable:${directory.failure.reason}`, encoding: null };
  }

  const contentTypes = findZipEntry(directory.entries, OOXML_CONTENT_TYPES_ENTRY);
  if (contentTypes === undefined) {
    return { mimeType: null, reason: 'zip_not_ooxml', encoding: null };
  }

  const part = readZipEntry(bytes, contentTypes, { maxBytes: MAX_DOCX_ENTRY_BYTES });
  if (part.failure !== null) {
    return { mimeType: null, reason: `zip_unreadable:${part.failure.reason}`, encoding: null };
  }

  if (!part.data.toString('utf8').includes(DOCX_MAIN_DOCUMENT_CONTENT_TYPE)) {
    // An XLSX, a PPTX, or an OOXML package of some other kind. Supported one
    // day, perhaps; not by this layer, and not silently.
    return { mimeType: null, reason: 'ooxml_not_wordprocessing', encoding: null };
  }

  return { mimeType: MIME_TYPES.DOCX, reason: 'ooxml_content_types', encoding: null };
}

/**
 * Cuts a byte prefix back to a UTF-8 character boundary.
 *
 * Without this, a file whose 8192nd byte lands in the middle of a three-byte
 * character decodes as invalid and a perfectly good UTF-8 CV is rejected as
 * binary - a bug that would only ever show up on non-English documents, which
 * is the worst possible place for it.
 *
 * Only called when the prefix really is a prefix. If the prefix *is* the whole
 * file then a trailing partial sequence is truncated data rather than a cut, and
 * the decoder should see it and reject it.
 *
 * @param {Buffer} prefix a strict prefix of a longer file
 * @returns {Buffer}
 */
function trimToUtf8Boundary(prefix) {
  // A UTF-8 sequence is at most four bytes, so at most three trailing bytes can
  // belong to an incomplete one. `Math.max` rather than a second loop condition
  // so there is one exit to reason about.
  const earliest = Math.max(0, prefix.length - 3);

  for (let index = prefix.length - 1; index >= earliest; index -= 1) {
    const byte = prefix[index];
    if ((byte & 0b1100_0000) === 0b1000_0000) {
      // A continuation byte: keep walking left to find the lead byte it belongs
      // to.
      continue;
    }

    // A lead byte announces its own length. The sequence is complete only if
    // that many bytes are present from here to the end.
    const available = prefix.length - index;
    return available < sequenceLengthOf(byte) ? prefix.subarray(0, index) : prefix;
  }

  // Three continuation bytes and no lead byte within reach, which means the
  // lead byte is at `prefix.length - 4` and its four-byte sequence is therefore
  // complete. Nothing to trim.
  return prefix;
}

/**
 * How many bytes the UTF-8 sequence beginning with this lead byte occupies.
 *
 * A byte that is not a valid lead byte reports 1, which makes the caller keep
 * it - the decoder that runs next is the thing entitled to reject it, and this
 * function's job is only to avoid cutting a good sequence in half.
 *
 * @param {number} byte
 * @returns {1 | 2 | 3 | 4}
 */
function sequenceLengthOf(byte) {
  if ((byte & 0b1111_1000) === 0b1111_0000) {
    return 4;
  }
  if ((byte & 0b1111_0000) === 0b1110_0000) {
    return 3;
  }
  if ((byte & 0b1110_0000) === 0b1100_0000) {
    return 2;
  }
  return 1;
}

/**
 * Counts control characters that have no business in a text file.
 *
 * Tab, newline and carriage return are excluded: they *are* what a text file is
 * made of. A NUL is decisive on its own and is handled by the caller.
 *
 * @param {string} text
 * @returns {number}
 */
function countControlCharacters(text) {
  let count = 0;
  for (const character of text) {
    // No `?? 0` fallback: `for...of` over a string always yields a non-empty
    // character, so `codePointAt(0)` is always a number here. The fallback the
    // type signature invites would be a branch no test could reach.
    const code = /** @type {number} */ (character.codePointAt(0));
    const isAllowedWhitespace = code === 0x09 || code === 0x0a || code === 0x0d;
    if (!isAllowedWhitespace && (code < 0x20 || code === 0x7f)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Decides whether the bytes are plain text, and in what encoding.
 *
 * This runs last, after PDF and ZIP have been ruled out, because it is the only
 * check here that is a *heuristic* rather than a signature. Order is the design:
 * a signature match is a fact, and a fact should never be overruled by a guess.
 *
 * @param {Buffer} bytes
 * @returns {SniffResult}
 */
function sniffText(bytes) {
  if (startsWith(bytes, BOM_UTF16_LE) || startsWith(bytes, BOM_UTF16_BE)) {
    // A UTF-16 BOM is a signature, not a heuristic - Windows Notepad writes
    // these - so it is accepted without the control-character test, which would
    // reject UTF-16 outright because half of ASCII-range UTF-16 is NUL bytes.
    return {
      mimeType: MIME_TYPES.TXT,
      reason: 'utf16_bom',
      encoding: startsWith(bytes, BOM_UTF16_LE) ? 'utf-16le' : 'utf-16be',
    };
  }

  const hasBom = startsWith(bytes, BOM_UTF8);
  const body = hasBom ? bytes.subarray(BOM_UTF8.length) : bytes;
  const head = body.subarray(0, TEXT_SNIFF_BYTES);
  // Trimmed only when there is more file after the prefix. When the prefix is
  // the whole file, a partial sequence at the end is truncated data and the
  // decoder is entitled to say so.
  const prefix = body.length <= TEXT_SNIFF_BYTES ? head : trimToUtf8Boundary(head);

  if (prefix.includes(NUL_BYTE)) {
    // First, because it is the cheapest and the most decisive: NUL is valid
    // UTF-8 and no text document contains one, so a decoder would happily
    // accept bytes this rules out.
    return { mimeType: null, reason: 'contains_nul', encoding: null };
  }

  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(prefix);
  } catch {
    return { mimeType: null, reason: 'not_utf8', encoding: null };
  }

  const controlRatio = decoded.length === 0 ? 0 : countControlCharacters(decoded) / decoded.length;
  if (controlRatio > MAX_CONTROL_CHARACTER_RATIO) {
    return { mimeType: null, reason: 'too_many_control_characters', encoding: null };
  }

  return { mimeType: MIME_TYPES.TXT, reason: hasBom ? 'utf8_bom' : 'utf8_heuristic', encoding: 'utf-8' };
}

/**
 * Reads the bytes and says what they are.
 *
 * Never throws, and that is deliberate: "I could not identify this" is an answer
 * the caller has to handle anyway, and an exception for it would make the one
 * cheap check in the system look like a failure path.
 *
 * @param {Buffer} bytes the whole file
 * @returns {SniffResult}
 */
export function sniffMimeType(bytes) {
  if (bytes.length === 0) {
    return { mimeType: null, reason: 'empty_file', encoding: null };
  }

  const pdfOffset = findPdfSignature(bytes);
  if (pdfOffset >= 0) {
    return {
      mimeType: MIME_TYPES.PDF,
      reason: pdfOffset === 0 ? 'pdf_signature' : 'pdf_signature_offset',
      encoding: null,
      signatureOffset: pdfOffset,
    };
  }

  if (startsWith(bytes, ZIP_LOCAL_HEADER)) {
    return sniffZip(bytes);
  }
  if (startsWith(bytes, ZIP_EMPTY_ARCHIVE)) {
    return { mimeType: null, reason: 'zip_empty_archive', encoding: null };
  }
  if (startsWith(bytes, ZIP_SPANNED_ARCHIVE)) {
    return { mimeType: null, reason: 'zip_spanned_archive', encoding: null };
  }

  return sniffText(bytes);
}
