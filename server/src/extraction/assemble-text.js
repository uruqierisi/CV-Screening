/**
 * Turning a page's text items into lines, and pages into a document.
 *
 * Pure, and separated from `parsers/pdf.js` for one reason: this is the part of
 * PDF extraction whose behaviour is arguable, and arguable behaviour should be
 * testable without a PDF. Everything in this file can be exercised with a
 * hand-written array of items.
 *
 * **What this does not do: reconstruct columns.** pdf.js hands back text items
 * in content-stream order and marks the ones that end a line, and this file
 * respects both. It does not cluster items by x-position and re-thread them into
 * reading order. That is a real decision with a visible cost, so it is written
 * down here rather than discovered later:
 *
 * - A producer that emits a two-column layout **column by column** - Word's
 *   column sections, InDesign text frames, most LaTeX classes - extracts
 *   cleanly, because the content stream is already in reading order.
 * - A producer that emits it **row by row** - which is what a CV built on a
 *   two-column *table* does, and that is a very common template shape - extracts
 *   interleaved: the left cell and the right cell of a row land on the same
 *   output line, so a job title is followed by a skill.
 *
 * The measured behaviour on both is asserted in
 * `test/extraction/two-column-pdf.test.js`, with the exact extracted string, so
 * nobody has to take this comment's word for it.
 *
 * Column reconstruction was declined for v1 on the same grounds as OCR in plan
 * section 7-F: a heuristic that guesses at column boundaries would also fire on
 * single-column CVs with a right-aligned date gutter - which is most of them -
 * and reordering a CV that was extracting correctly is a worse failure than
 * interleaving one that was always going to be hard. Plan section 8 already
 * carries non-Western-format CVs as a known limitation and this belongs to the
 * same family. If it is ever revisited, this file is the whole surface area.
 */

/** Separates pages in the assembled document. */
export const PAGE_SEPARATOR = '\n\n';

/**
 * Collapses runs of spaces and tabs *within* a line, and trims the ends.
 *
 * Deliberately not the agent layer's `normalizeWhitespace`, which folds newlines
 * too. Newlines are the only structure a CV has left by the time it is plain
 * text - they are what keeps an employer on its own line and separate from the
 * dates under it - and flattening them here would throw away the signal the
 * extraction prompt relies on.
 *
 * @param {string} line
 * @returns {string}
 */
function collapseIntraLineWhitespace(line) {
  return line.replace(/[^\S\r\n]+/g, ' ').trim();
}

/**
 * A pdf.js text item, narrowed to the three fields this file reads.
 *
 * @typedef {object} TextItem
 * @property {string} [str] the glyphs; absent on marked-content items
 * @property {boolean} [hasEOL] set by pdf.js when the item ends a line
 */

/**
 * Assembles one page's items into text.
 *
 * pdf.js does two things that make this short, and both are worth knowing about
 * because they are why there is no coordinate arithmetic here. It sets `hasEOL`
 * when the next item starts a new line, and it synthesises a whitespace-only
 * item between two items on the same line that are far apart horizontally - so
 * the gap between two table cells arrives as a real space rather than as
 * nothing. Re-deriving either from the transform matrices would be a second,
 * worse implementation of something already done upstream.
 *
 * Items without a `str` are marked-content boundaries, which carry structure
 * rather than glyphs; they are skipped.
 *
 * @param {readonly TextItem[]} items
 * @returns {string} the page, without a trailing newline
 */
export function assemblePageText(items) {
  let buffer = '';
  for (const item of items) {
    if (typeof item.str !== 'string') {
      continue;
    }
    buffer += item.str;
    if (item.hasEOL === true) {
      buffer += '\n';
    }
  }

  return buffer.split('\n').map(collapseIntraLineWhitespace).join('\n').trim();
}

/**
 * Joins pages, dropping the ones that came out empty.
 *
 * Empty pages are dropped rather than preserved as blank separators because a
 * scanned CV yields a run of them, and a document that is nothing but
 * separators reads to the character count in `assessTextLayer` as content.
 *
 * @param {readonly string[]} pages
 * @returns {string}
 */
export function assembleDocumentText(pages) {
  return pages.filter((page) => page.length > 0).join(PAGE_SEPARATOR);
}
