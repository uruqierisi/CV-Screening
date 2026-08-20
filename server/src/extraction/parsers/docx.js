/**
 * DOCX bytes to text.
 *
 * A DOCX is a ZIP holding `word/document.xml`, which is WordprocessingML: text
 * lives in `<w:t>` elements, grouped into runs, grouped into paragraphs
 * `<w:p>`. This file reads that one entry and pulls the text out of it.
 *
 * **Why a scan rather than an XML parser.** The alternative is a real parser -
 * `@xmldom/xmldom`, or `mammoth` which uses it - and the honest reason not to
 * take one is that this extraction is a *stream of text with paragraph breaks*,
 * not a tree walk. It reads five element names, cares about document order and
 * nothing else, and never asks a question about structure that a tree would
 * answer better. Building a DOM of a 20,000-node document to concatenate its
 * leaves is the more complicated implementation, not the safer one.
 *
 * What that costs, so the trade is visible: this does not understand list
 * numbering (a bullet's number lives in `numbering.xml` and is lost), it does
 * not read headers, footers or footnotes (separate parts - a CV with content in
 * a header is a CV with a problem), and it does not know a table from a
 * paragraph, so a table cell's text arrives as its own line. For a two-column
 * CV *table* that produces the left cell then the right cell, in document order.
 * That is the same interleaving question `assemble-text.js` documents for PDFs,
 * and it lands more kindly here: Word stores a row's cells in order but stores
 * each cell's paragraphs whole, so a column reads as a block rather than a
 * word every other line.
 *
 * `mammoth` (1.12.1, published 2026-08-09, actively maintained) is the upgrade
 * path if DOCX quality ever becomes the limiting factor. It was declined for now
 * on dependency weight - ten transitive packages, including `argparse` for a
 * command-line interface this process will never run - and the note is here so
 * that reversing the decision is a judgement rather than a rediscovery.
 */

import { DOCX_DOCUMENT_ENTRY, MAX_DOCX_ENTRY_BYTES } from '../constants.js';
import { EmptyDocumentError, ExtractionFailedError } from '../errors.js';
import { findZipEntry, readZipDirectory, readZipEntry } from '../zip.js';

/**
 * Recruiter-facing message for a DOCX with nothing in it. Deliberately not the
 * scanned-PDF wording from plan section 7-F: a DOCX has no text layer to be
 * missing, so telling someone to "re-upload a text-based PDF" would be advice
 * about a problem they do not have.
 */
export const EMPTY_DOCX_MESSAGE =
  'This document appears to be empty; no text could be read from it. Check the file and re-upload it.';

/**
 * Every token that contributes to the extracted text, in one alternation so the
 * scan is a single pass in document order. Order inside the pattern matters
 * only for the two that share a prefix - `<w:tab/>` would otherwise be read as
 * a self-closing `<w:t/>` - and that is disambiguated when the branch is
 * identified below rather than by the regex engine.
 *
 * The branches, in the order written:
 *
 * 1. `<w:t>...</w:t>` - a text run. `(?:\s[^>]*)?` covers the
 *    `xml:space="preserve"` attribute Word writes on any run with leading or
 *    trailing spaces; ignoring it glues words together. `[\s\S]*?` rather than
 *    `.*?` so a run split across lines by a pretty-printer stays one run.
 * 2. `<w:tab/>` - becomes a space. It is used for alignment far more often than
 *    for indentation, and a tab inside "Senior Engineer <tab> 2019-2024" reads
 *    worse than a space to everything downstream.
 * 3. `<w:br/>` and `<w:cr/>` - an explicit line break inside a paragraph.
 * 4. `</w:p>` and `<w:p/>` - the end of a paragraph, including the empty
 *    self-closing one Word writes for a bare press of Enter.
 * 5. `<w:t/>` - a self-closing, empty text run. Matched so it is consumed
 *    rather than half-matched by branch 1.
 */
const TOKEN_PATTERN =
  /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab(?:\s[^>]*)?\/?>|<w:(?:br|cr)(?:\s[^>]*)?\/?>|<\/w:p>|<w:p\s*\/>|<w:t\s*\/>/g;

/**
 * The five predefined XML entities. Numeric character references are handled
 * separately.
 */
const NAMED_ENTITIES = Object.freeze({
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
});

/**
 * Named and numeric entities in **one** pattern, matched in **one** pass.
 *
 * This was two chained `.replace()` calls and that was a bug, caught by the
 * test that is now `does not re-decode an escaped entity`: the second call
 * scans the *output* of the first, so the literal text `&amp;#65;` decoded to
 * `&#65;` and then to `A`. A document's data had become its markup.
 *
 * A single pass cannot do that. Each match is replaced from the source string,
 * and a replacement is never looked at again.
 */
const ENTITY_PATTERN = /&(?:(amp|lt|gt|quot|apos)|#(x[0-9a-fA-F]+|[0-9]+));/g;

/** Runs of spaces and tabs, but never a newline - see `assemble-text.js`. */
const INTRA_LINE_WHITESPACE = /[^\S\r\n]+/g;

/**
 * Decodes XML entities in a text run.
 *
 * Named entities are replaced before numeric ones, and the order matters: a
 * document containing the literal text `&amp;#65;` must decode to `&#65;` and
 * stop, not carry on to `A`. Decoding numerics first turns data into markup,
 * which is the shape of most entity-handling bugs.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeXmlEntities(value) {
  return value.replace(ENTITY_PATTERN, (match, named, numeric) => {
    if (named !== undefined) {
      return NAMED_ENTITIES[`&${named};`];
    }

    const point =
      numeric[0] === 'x' || numeric[0] === 'X'
        ? Number.parseInt(numeric.slice(1), 16)
        : Number.parseInt(numeric, 10);

    try {
      return String.fromCodePoint(point);
    } catch {
      // Out of range. The literal text is kept exactly as it was: throwing
      // would fail a whole CV over one bad character reference, and
      // substituting U+FFFD would put a replacement glyph into text the model
      // then has to read as a word.
      return match;
    }
  });
}

/**
 * Which kind of token this is.
 *
 * A function rather than more regex branches with capture groups, because the
 * three non-text branches differ only in what they append and naming them is
 * what makes the scan below readable.
 *
 * @param {string} token the whole match
 * @returns {'tab' | 'break' | 'empty'}
 */
function classifyToken(token) {
  if (token.startsWith('<w:tab')) {
    return 'tab';
  }
  if (token.startsWith('<w:br') || token.startsWith('<w:cr') || token.startsWith('</w:p')) {
    return 'break';
  }
  // `<w:p/>` - an empty paragraph - is also a break. `<w:t/>` is not.
  return token.startsWith('<w:p') ? 'break' : 'empty';
}

/**
 * Pulls the text out of WordprocessingML, in document order, as lines.
 *
 * Exported for its own test: this is the half of DOCX extraction that holds all
 * the decisions, and it should be exercisable with a string rather than a ZIP.
 *
 * Lines are returned rather than a joined string so the caller owns the blank
 * line policy - and so a test can see that an empty paragraph produced an empty
 * line rather than nothing at all.
 *
 * @param {string} xml the contents of `word/document.xml`
 * @returns {string[]} one entry per paragraph or explicit break, untrimmed
 */
export function extractLinesFromWordXml(xml) {
  /** @type {string[]} */
  const lines = [];
  let current = '';

  for (const match of xml.matchAll(TOKEN_PATTERN)) {
    if (match[1] !== undefined) {
      current += decodeXmlEntities(match[1]);
      continue;
    }
    switch (classifyToken(match[0])) {
      case 'tab':
        current += ' ';
        break;
      case 'break':
        lines.push(current);
        current = '';
        break;
      default:
        break;
    }
  }

  // Whatever trails the last paragraph break. Usually empty in a well-formed
  // document, and never dropped, because "the last paragraph has no closing
  // tag" is exactly the kind of malformed file this has to survive.
  lines.push(current);
  return lines;
}

/**
 * Trims lines and collapses runs of blank ones to a single blank line.
 *
 * Word writes an empty `<w:p/>` for every press of Enter, and a CV formatted
 * with spacing rather than styles can carry a dozen in a row. One blank line is
 * kept because it is real structure - it is what separates the education block
 * from the experience block.
 *
 * @param {readonly string[]} lines
 * @returns {string}
 */
function joinLines(lines) {
  /** @type {string[]} */
  const kept = [];
  for (const line of lines) {
    const trimmed = line.replace(INTRA_LINE_WHITESPACE, ' ').trim();
    if (trimmed.length === 0 && (kept.length === 0 || kept.at(-1)?.length === 0)) {
      continue;
    }
    kept.push(trimmed);
  }
  return kept.join('\n').trim();
}

/**
 * Reads `word/document.xml` out of the archive and extracts its text.
 *
 * @param {Buffer} bytes the whole file
 * @returns {{ text: string, entryCount: number }}
 * @throws {ExtractionFailedError} when the archive or its main part cannot be read
 * @throws {EmptyDocumentError} when the document holds no text
 */
export function parseDocx(bytes) {
  const directory = readZipDirectory(bytes);
  if (directory.failure !== null) {
    throw damagedDocx(directory.failure);
  }

  const entry = findZipEntry(directory.entries, DOCX_DOCUMENT_ENTRY);
  if (entry === undefined) {
    // Reachable despite `sniff.js` having already read `[Content_Types].xml`:
    // a package can declare the main document part and not contain it. That is
    // a damaged file rather than a mis-sniffed one.
    throw damagedDocx({
      reason: 'docx_no_main_document',
      message: `the archive has no ${DOCX_DOCUMENT_ENTRY}`,
      details: { entryCount: directory.entries.length },
    });
  }

  const part = readZipEntry(bytes, entry, { maxBytes: MAX_DOCX_ENTRY_BYTES });
  if (part.failure !== null) {
    throw damagedDocx(part.failure);
  }

  const text = joinLines(extractLinesFromWordXml(part.data.toString('utf8')));

  if (text.length === 0) {
    // The same extension point as `parsers/pdf.js`, and the same answer: there
    // is nothing here for OCR to work on, because a DOCX with no text runs is a
    // document with no text rather than a picture of one.
    throw new EmptyDocumentError({
      userMessage: EMPTY_DOCX_MESSAGE,
      details: { characters: 0, entryCount: directory.entries.length },
    });
  }

  return { text, entryCount: directory.entries.length };
}

/**
 * Turns a ZIP-level refusal into the one recruiter-facing message they all
 * share.
 *
 * One message for six reasons, on purpose: "encrypted", "ZIP64" and "inflate
 * failed" are the same instruction to the person holding the file, and the
 * distinction that matters to an engineer is preserved in `reason` and
 * `details`, which go to the log.
 *
 * @param {import('../zip.js').ZipFailure} failure
 * @returns {ExtractionFailedError}
 */
function damagedDocx(failure) {
  return new ExtractionFailedError({
    reason: failure.reason,
    message: failure.message,
    userMessage:
      'This Word document could not be opened; the file may be damaged. Re-upload it, or send a PDF instead.',
    details: failure.details,
  });
}
