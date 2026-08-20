import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { EXTRACTION_ERROR_CODES } from '../../src/extraction/constants.js';
import { SCANNED_PDF_MESSAGE, classifyPdfError, parsePdf } from '../../src/extraction/parsers/pdf.js';
import { buildScannedPdf, buildTextPdf } from './fixtures/build-documents.js';

/** @param {string} name */
function fixture(name) {
  return readFileSync(fileURLToPath(new URL(`./fixtures/documents/${name}`, import.meta.url)));
}

describe('parsePdf', () => {
  it('extracts every page, not just the first', async () => {
    const result = await parsePdf(fixture('clean.pdf'));

    expect(result.stats.pageCount).toBe(2);
    expect(result.text).toContain('Priya Ramanathan');
    expect(result.text).toContain('AWS Certified Solutions Architect');
  });

  it('reports the characters-per-page it measured, for the log', async () => {
    const result = await parsePdf(fixture('clean.pdf'));

    expect(result.stats.characters).toBe(result.text.length);
    expect(result.stats.charactersPerPage).toBeCloseTo(result.text.length / 2, 1);
  });

  it('does not detach the caller\'s buffer', async () => {
    // pdf.js transfers the ArrayBuffer it is given to its worker port, which
    // detaches it. The caller still wants to hash and store those bytes, so the
    // parser works on a copy - and this asserts that rather than trusting the
    // comment that says so.
    const bytes = fixture('clean.pdf');
    const before = bytes.length;

    await parsePdf(bytes);

    expect(bytes.length).toBe(before);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('fails a scanned page with the wording plan section 7-F specifies', async () => {
    const error = await parsePdf(fixture('scanned.pdf')).catch((e) => e);

    expect(error.code).toBe(EXTRACTION_ERROR_CODES.EMPTY_DOCUMENT);
    // Asserted verbatim: it is the one message in this system the plan spells
    // out, and it is the one a recruiter is most likely to act on.
    expect(error.userMessage).toBe(
      'This PDF appears to be a scanned image; no extractable text layer was found. Re-upload a text-based PDF or a DOCX.',
    );
    expect(error.userMessage).toBe(SCANNED_PDF_MESSAGE);
  });

  it('fails a text PDF too thin for its page count, not only a wholly empty one', async () => {
    // The rule is *per page*, so a document with a little text spread over
    // several pages fails too. Four words over three pages is a scan with a
    // running header, whatever the text layer technically contains.
    const thin = buildTextPdf([
      [{ x: 72, y: 720, size: 10, text: 'Page 1' }],
      [{ x: 72, y: 720, size: 10, text: 'Page 2' }],
      [{ x: 72, y: 720, size: 10, text: 'Page 3' }],
    ]);

    const error = await parsePdf(thin).catch((e) => e);

    expect(error.code).toBe(EXTRACTION_ERROR_CODES.EMPTY_DOCUMENT);
    expect(error.details.pageCount).toBe(3);
  });

  it('fails a truncated PDF as damaged rather than as empty', async () => {
    const truncated = buildTextPdf([[{ x: 72, y: 720, size: 12, text: 'Priya' }]]).subarray(0, 100);

    const error = await parsePdf(truncated).catch((e) => e);

    expect(error.code).toBe(EXTRACTION_ERROR_CODES.EXTRACTION_FAILED);
  });

  it('fails a document whose page tree points at an object that is not a page', async () => {
    // Reaches the failure path *after* the document opens, which is a different
    // branch from a file that never opens at all. pdf.js is strikingly tolerant
    // - a wrong `/Count`, a missing `/Contents` object and a wrong `/Length`
    // are all absorbed silently - and a bad kid reference is one of the few
    // structural faults it does reject, at `getPage` rather than at load.
    const complete = buildTextPdf([
      [{ x: 72, y: 720, size: 10, text: 'Priya Ramanathan' }],
      [{ x: 72, y: 720, size: 10, text: 'London, UK' }],
    ]);
    const broken = Buffer.from(
      complete.toString('latin1').replace('/Kids [3 0 R 5 0 R]', '/Kids [3 0 R 99 0 R]'),
      'latin1',
    );

    const error = await parsePdf(broken).catch((e) => e);

    expect(error.code).toBe(EXTRACTION_ERROR_CODES.EXTRACTION_FAILED);
    expect(error.reason).toBe('pdf_read_failed');
  });

  it('produces a genuinely image-only fixture - no text operators at all', () => {
    // Guards the scanned fixture itself. If the generator ever started emitting
    // a font, the scanned-PDF test above would pass for the wrong reason and
    // nobody would notice.
    const source = buildScannedPdf().toString('latin1');

    expect(source).toContain('/Subtype /Image');
    expect(source).not.toContain('/Font');
    expect(source).not.toContain(' Tj');
    expect(source).not.toContain('BT');
  });
});

describe('classifyPdfError', () => {
  /**
   * pdf.js signals through its own exception classes and sets `name` on each.
   * Matching on `name` rather than on message prose is the same discipline the
   * agent layer's client keeps, for the same reason: an upstream wording change
   * would silently downgrade a precise failure to a generic one.
   */

  it('tells a recruiter a password-protected PDF needs an unprotected copy', () => {
    const error = classifyPdfError(
      Object.assign(new Error('No password given'), { name: 'PasswordException' }),
    );

    expect(error.reason).toBe('pdf_password_required');
    expect(error.userMessage).toContain('password protected');
    expect(error.code).toBe(EXTRACTION_ERROR_CODES.EXTRACTION_FAILED);
  });

  it('tells a recruiter a malformed PDF may be damaged', () => {
    const error = classifyPdfError(
      Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' }),
    );

    expect(error.reason).toBe('pdf_invalid');
    expect(error.userMessage).toContain('damaged or incomplete');
  });

  it('falls back rather than guessing, on an exception it does not recognise', () => {
    const error = classifyPdfError(new TypeError('something changed upstream'));

    expect(error.reason).toBe('pdf_read_failed');
    // A missed name is not a regression: this is what the caller would have got
    // anyway, so the failure mode is losing a distinction rather than breaking
    // a behaviour.
    expect(error.code).toBe(EXTRACTION_ERROR_CODES.EXTRACTION_FAILED);
  });

  it('survives being handed something that is not an error at all', () => {
    for (const thrown of [undefined, null, 'a string', 42]) {
      const error = classifyPdfError(thrown);
      expect(error.reason).toBe('pdf_read_failed');
    }
  });

  it('never puts the underlying message in front of a recruiter', () => {
    // The internal message goes to `message` and `cause`, both of which are for
    // the log. `userMessage` is fixed prose that cannot leak a library's
    // internals - or a span of a document.
    const cause = new Error('stream 12 0 R: unexpected token at offset 4821');
    const error = classifyPdfError(cause);

    expect(error.userMessage).not.toContain('4821');
    expect(error.cause).toBe(cause);
    expect(JSON.stringify(error.toJSON())).not.toContain('4821');
  });
});
