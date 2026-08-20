/**
 * PDF bytes to text, via pdf.js.
 *
 * **Library choice: `unpdf`, checked on 2026-08-20 rather than recalled.**
 * `npm view` on every realistic candidate, and what it said:
 *
 * | package | latest | last publish | what it actually is |
 * |---|---|---|---|
 * | `unpdf` | 1.8.1 | 2026-08-13 | pdf.js 6.1.200, bundled, zero runtime deps |
 * | `pdfjs-dist` | 6.2.108 | 2026-07-28 | Mozilla's own build |
 * | `pdf-parse` | 2.4.5 | 2025-10-29 | rewrite; pins pdfjs-dist 5.4.296 + native canvas |
 * | `pdf2json` | 4.0.3 | 2026-04-16 | a different, older fork of pdf.js |
 * | `pdf-text-extract` | 1.5.0 | 2022-06-23 | shells out to poppler; needs a binary on the host |
 *
 * `pdf-parse` is the trap the maintenance check exists to catch. It is the name
 * everyone reaches for, the version everyone remembers is 1.1.1 from 2018
 * wrapping pdf.js 1.10, and the 2.x on npm today is a rewrite under a new sole
 * maintainer that shipped twenty releases in five days and then published a
 * *1.1.4* four days after 2.4.5. It also depends on `@napi-rs/canvas`, a native
 * binary we would never execute.
 *
 * That left the real choice: Mozilla's `pdfjs-dist` or `unpdf`, which bundles
 * it. Measured, not assumed - `npm install pdfjs-dist` in this repository
 * produced **35 MB, plus 37 MB of `@napi-rs/canvas`** pulled in as an optional
 * dependency and installed by default. `unpdf` is **2.5 MB and one package**,
 * with the same canvas as an *optional peer* that stays uninstalled. Nothing in
 * this system rasterises a page, so 72 MB and a native binary in the image would
 * be paid entirely for code we have specifically decided not to run.
 *
 * The cost of `unpdf`, stated plainly: it is a single-maintainer wrapper, and it
 * runs a pdf.js one minor behind upstream. The mitigation is real rather than
 * hopeful - this file uses **pdf.js's own API** through unpdf's re-export and
 * nothing of unpdf's own, so if it ever goes stale the swap is the import on the
 * next line plus a `getDocument().promise`, in one file, with the tests
 * unchanged.
 */

import { getDocumentProxy } from 'unpdf';

import { assembleDocumentText, assemblePageText } from '../assemble-text.js';
import { EmptyDocumentError, ExtractionFailedError } from '../errors.js';
import { assessTextLayer } from '../text-layer.js';

/**
 * Fixed by plan section 7-F. Asserted by a test, because it is the string a
 * recruiter is most likely to act on and the only one whose wording the plan
 * spells out.
 */
export const SCANNED_PDF_MESSAGE =
  'This PDF appears to be a scanned image; no extractable text layer was found. Re-upload a text-based PDF or a DOCX.';

/**
 * Options handed to pdf.js for every document.
 *
 * Every one of these is a decision about running an untrusted file, not a
 * performance tweak:
 *
 * - `isEvalSupported: false` - pdf.js will otherwise compile parts of a font or
 *   a pattern through `Function`. Uploaded CVs are attacker-controlled input,
 *   and there is no reason to hand any of it to a code path that compiles.
 * - `disableFontFace: true` - there is no DOM here to install a font into, and
 *   text extraction does not need glyph rendering.
 * - `useSystemFonts: false` - keeps an uploaded file from reaching the host's
 *   font configuration. Costs nothing: extraction reads character codes, not
 *   shapes.
 * - `verbosity: 0` - pdf.js writes warnings straight to the console for any
 *   slightly malformed file, which is most real-world PDFs. This layer reports
 *   through its return value and its errors; a library writing to stdout would
 *   put CV-adjacent strings into logs nobody redacted.
 */
const PDFJS_OPTIONS = Object.freeze({
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  verbosity: 0,
});

/**
 * Maps a pdf.js failure onto one of ours.
 *
 * Matched on the error's `name`, which pdf.js sets on its own exception classes
 * (`PasswordException`, `InvalidPDFException`), rather than on message prose.
 * Prose matching is what the agent layer's client refuses to do, and the reason
 * is the same here: an upstream wording change would silently turn a precise
 * failure into a generic one, and losing a distinction is much harder to notice
 * than breaking one.
 *
 * A missed name is not a regression - it falls through to `pdf_read_failed`,
 * which is what the caller would have got anyway.
 *
 * Exported because this mapping is the arguable part of PDF error handling and
 * it should be assertable without having to manufacture a PDF that provokes
 * each exception. `pdf-errors.test.js` covers it directly; the fixtures cover
 * that it is wired in.
 *
 * @param {unknown} cause anything thrown by pdf.js, including a non-`Error`
 * @returns {ExtractionFailedError}
 */
export function classifyPdfError(cause) {
  // Read off the value rather than guarded by `instanceof Error`: pdf.js throws
  // its own classes, a plain object from a future version would still carry a
  // name, and anything else reads as `undefined` and lands on the fallback -
  // which is exactly where an unrecognised throw belongs.
  const name = /** @type {{ name?: unknown }} */ (cause)?.name;

  if (name === 'PasswordException') {
    return new ExtractionFailedError({
      reason: 'pdf_password_required',
      message: 'the PDF is password protected',
      userMessage:
        'This PDF is password protected, so its text could not be read. Re-upload an unprotected copy.',
      details: {},
      cause,
    });
  }

  if (name === 'InvalidPDFException') {
    return new ExtractionFailedError({
      reason: 'pdf_invalid',
      message: 'the PDF structure could not be parsed',
      userMessage:
        'This PDF could not be opened; the file may be damaged or incomplete. Re-upload it, or send a DOCX instead.',
      details: {},
      cause,
    });
  }

  return new ExtractionFailedError({
    reason: 'pdf_read_failed',
    message: 'the PDF could not be read',
    userMessage:
      'This PDF could not be read. Re-upload it, or send a DOCX instead.',
    details: {},
    cause,
  });
}

/**
 * @typedef {object} PdfParseResult
 * @property {string} text
 * @property {import('../text-layer.js').TextLayerStats} stats
 */

/**
 * Extracts every page's text.
 *
 * @param {Buffer} bytes
 * @returns {Promise<PdfParseResult>}
 * @throws {EmptyDocumentError} when the text layer is too thin for the page count
 * @throws {ExtractionFailedError} when the file cannot be opened or read
 */
export async function parsePdf(bytes) {
  // A copy, not a view. pdf.js transfers the underlying ArrayBuffer to its
  // worker port, which detaches it - and the caller handed us bytes it may well
  // want to hash or store afterwards. Detaching somebody else's buffer is the
  // kind of action at a distance that takes a day to find.
  const data = new Uint8Array(bytes);

  /** @type {Awaited<ReturnType<typeof getDocumentProxy>>} */
  let document;
  try {
    document = await getDocumentProxy(data, PDFJS_OPTIONS);
  } catch (cause) {
    throw classifyPdfError(cause);
  }

  try {
    const { numPages } = document;
    /** @type {string[]} */
    const pages = [];

    for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
      // Sequential rather than Promise.all: pages are extracted for their text
      // and nothing else, the documents are CVs rather than books, and a
      // parallel version would hold every page's items in memory at once for a
      // saving measured against a file that is already on disk.
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(assemblePageText(content.items));
      // Frees the page's operator list and font data. pdf.js caches these on the
      // page object, and a worker looping over a batch of CVs without this grows
      // for the life of the process.
      page.cleanup();
    }

    const text = assembleDocumentText(pages);
    const verdict = assessTextLayer({ characters: text.length, pageCount: numPages });

    if (verdict.imageOnly) {
      // *** The OCR extension point (plan section 7-F). ***
      //
      // A future `parsers/ocr.js` runs here, on the same `bytes`, and returns
      // text instead of this throw. Nothing above this line changes: the
      // dispatcher, the interface and the result shape are all unaware that this
      // branch exists.
      throw new EmptyDocumentError({
        userMessage: SCANNED_PDF_MESSAGE,
        details: { ...verdict.stats, threshold: verdict.threshold },
      });
    }

    return { text, stats: verdict.stats };
  } catch (cause) {
    if (cause instanceof EmptyDocumentError) {
      throw cause;
    }
    throw classifyPdfError(cause);
  } finally {
    // Always, and via the loading task rather than the document.
    // `PDFDocumentProxy.destroy()` existed in older pdf.js and does not in 6.x;
    // the surviving teardown is `loadingTask.destroy()`, which tears down the
    // transport and the port with it. Worth doing rather than leaving to the
    // garbage collector: unpdf runs pdf.js against an in-process loopback port,
    // so nothing here is reclaimed just because the promise settled, and the
    // worker screens CVs in a loop.
    await document.loadingTask.destroy();
  }
}
