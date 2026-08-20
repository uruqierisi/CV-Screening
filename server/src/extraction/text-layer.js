/**
 * "Is this PDF a scan?" - plan section 7-F, and the one judgement in the whole
 * system that needs a fact only this layer holds.
 *
 * **Why this is here and not in `agents/util/text.js`.** Section 7-F states the
 * rule as *"a PDF whose text layer yields too little extractable text for its
 * page count"*, and the page count is not recoverable from the text. By the time
 * `assessCvText` sees a string, the difference between a thin one-page CV and a
 * six-page scan whose text layer produced nothing but running headers has been
 * erased - both are a few hundred characters. `assessCvText` therefore cannot
 * make this call, and giving it the ability to would mean handing it a PDF fact
 * in a module that deliberately knows nothing about files.
 *
 * So the division of labour is:
 *
 * - **This layer** owns the structural question - characters *per page* - and
 *   raises `EMPTY_DOCUMENT` with section 7-F's wording. It is the only place
 *   that can.
 * - **`assessCvText`** owns the content question - enough characters, enough
 *   letters, at least one CV-shaped signal - and runs later, immediately before
 *   the first API call, on text that has already survived this.
 *
 * The two overlap on the simplest case, a PDF with a completely empty text
 * layer, and that overlap is the point: section 5.5 calls the redundancy
 * intentional, because two cheap checks that agree cost less than one check in a
 * file somebody later reorganises. **No change to `agents/util/text.js` is
 * needed**, and the phase 3 report says so explicitly rather than leaving it
 * implied - the guard is not missing a signal, it is being handed text that a
 * structural check has already vetted.
 */

import { MIN_CHARACTERS_PER_PAGE } from './constants.js';

/**
 * What the PDF parser learned about the file, beyond the text itself.
 *
 * These are the facts the worker should log next to `assessCvText`'s stats:
 * together they say whether a failed candidate failed because the file was a
 * picture or because the CV was thin, and those need different advice.
 *
 * @typedef {object} TextLayerStats
 * @property {number} characters after assembly and whitespace collapsing
 * @property {number} pageCount
 * @property {number} charactersPerPage rounded to one decimal - a log line, not
 *   a measurement
 */

/**
 * The judgement, kept separate from the throw.
 *
 * A returned verdict rather than a raised error, for the same reason
 * `assessCvText` is a judgement rather than a throw: it makes this testable with
 * two numbers, and it leaves the decision about what a verdict *means* with the
 * parser that has the context to phrase it.
 *
 * @typedef {object} TextLayerVerdict
 * @property {boolean} imageOnly
 * @property {TextLayerStats} stats
 * @property {number} threshold the bar that was applied, so a log line explains
 *   itself without the reader having to find this file
 */

/**
 * Decides whether a PDF's text layer carries enough text for its page count.
 *
 * A zero page count is treated as image-only rather than as a division by zero.
 * pdf.js does not report zero pages for a file it opened, so this is a guard
 * against a future parser rather than an observed case - but "0 characters over
 * 0 pages is fine" is exactly the kind of arithmetic that would quietly pass a
 * broken file through to the model.
 *
 * @param {object} params
 * @param {number} params.characters
 * @param {number} params.pageCount
 * @returns {TextLayerVerdict}
 */
export function assessTextLayer({ characters, pageCount }) {
  const charactersPerPage = pageCount <= 0 ? 0 : characters / pageCount;

  return {
    imageOnly: charactersPerPage < MIN_CHARACTERS_PER_PAGE,
    threshold: MIN_CHARACTERS_PER_PAGE,
    stats: {
      characters,
      pageCount,
      charactersPerPage: Math.round(charactersPerPage * 10) / 10,
    },
  };
}
