import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_FILE_MESSAGE,
  EXTRACTION_ERROR_CODES,
  MIME_TYPES,
  SCANNED_PDF_MESSAGE,
  UNSUPPORTED_TYPE_MESSAGE,
  extractDocumentText,
} from '../../src/extraction/index.js';
import { buildDocx, buildTextPdf, buildZip } from './fixtures/build-documents.js';

/**
 * The interface, exercised against the five committed fixtures - real bytes on
 * a real disk, not strings pretending to be files.
 */

/** @param {string} name */
function fixture(name) {
  return readFileSync(fileURLToPath(new URL(`./fixtures/documents/${name}`, import.meta.url)));
}

describe('extractDocumentText, on the committed fixtures', () => {
  it('reads a conventional single-column PDF, and reports its page count', async () => {
    const result = await extractDocumentText({ bytes: fixture('clean.pdf') });

    expect(result.mimeType).toBe(MIME_TYPES.PDF);
    expect(result.structure.pageCount).toBe(2);
    expect(result.text).toContain('Priya Ramanathan');
    expect(result.text).toContain('priya.ramanathan@example.com | +44 20 7946 0102 | London, UK');
    // Page two's content is present, which is the thing a single-page reader
    // would silently get wrong.
    expect(result.text).toContain('AWS Certified Solutions Architect - Associate, 2021');
    // Line structure survives: employer, dates and bullets are separate lines,
    // and that is the only structure the extraction prompt has left to work
    // with.
    expect(result.text).toContain(
      'Senior Backend Engineer, Northwind Payments\nJanuary 2019 - present, London',
    );
  });

  it('reads a DOCX, resolving the XML entity in an employer name', async () => {
    const result = await extractDocumentText({ bytes: fixture('cv.docx') });

    expect(result.mimeType).toBe(MIME_TYPES.DOCX);
    // `Halcyon Data &amp; Analytics` in the XML. A reader that skipped entity
    // decoding would put the raw `&amp;` into the profile and then into the
    // dashboard.
    expect(result.text).toContain('Lead Engineer, Halcyon Data & Analytics');
    // Blank lines between sections survive as one blank line, not a dozen.
    expect(result.text).toContain('\n\nEXPERIENCE\n');
    expect(result.text).not.toContain('\n\n\n');
    // No pages in a DOCX, and the field says so rather than guessing.
    expect(result.structure.pageCount).toBeNull();
    expect(result.structure.charactersPerPage).toBeNull();
  });

  it('reads a CRLF text file, normalizing the line endings', async () => {
    const result = await extractDocumentText({ bytes: fixture('cv.txt') });

    expect(result.mimeType).toBe(MIME_TYPES.TXT);
    expect(result.text).toContain('AISHA KHAN');
    expect(result.text).not.toContain('\r');
    expect(result.structure.characters).toBe(result.text.length);
  });

  it('fails a scanned PDF with plan section 7-F wording, rather than returning three words', async () => {
    // The whole point of the phase. A scanned CV must produce a failure a
    // recruiter can act on, never a thin string that becomes a confidently
    // wrong profile and then a score.
    const error = await extractDocumentText({ bytes: fixture('scanned.pdf') }).catch((e) => e);

    expect(error.code).toBe(EXTRACTION_ERROR_CODES.EMPTY_DOCUMENT);
    expect(error.userMessage).toBe(SCANNED_PDF_MESSAGE);
    expect(error.retryable).toBe(false);
    // Counts and page totals, and nothing that could be a span of a document.
    expect(error.details).toEqual({
      characters: 0,
      pageCount: 1,
      charactersPerPage: 0,
      threshold: 100,
    });
  });

  it('reports the sniffed type for every fixture, not the declared one', async () => {
    const cases = [
      ['clean.pdf', MIME_TYPES.PDF],
      ['two-column.pdf', MIME_TYPES.PDF],
      ['cv.docx', MIME_TYPES.DOCX],
      ['cv.txt', MIME_TYPES.TXT],
    ];

    for (const [name, expected] of cases) {
      // Every one declared as something it is not.
      const result = await extractDocumentText({
        bytes: fixture(name),
        declaredMimeType: 'application/octet-stream',
      });
      expect(result.mimeType).toBe(expected);
      expect(result.source.mimeTypeMismatch).toBe(true);
      expect(result.source.declaredMimeType).toBe('application/octet-stream');
    }
  });
});

describe('extractDocumentText, when the file is not what it says it is', () => {
  it('extracts a DOCX that was uploaded as application/pdf', async () => {
    // The policy, asserted: the bytes win. A candidate whose browser guessed
    // wrong, or who renamed a file, is not rejected for it.
    const result = await extractDocumentText({
      bytes: fixture('cv.docx'),
      declaredMimeType: MIME_TYPES.PDF,
    });

    expect(result.mimeType).toBe(MIME_TYPES.DOCX);
    expect(result.text).toContain('Marcus Adeyemi');
    expect(result.source.mimeTypeMismatch).toBe(true);
  });

  it('rejects a ZIP that claims to be a DOCX, because it is not an OOXML package', async () => {
    const notADocx = buildZip([{ name: 'notes.txt', content: 'nothing to see' }]);

    const error = await extractDocumentText({
      bytes: notADocx,
      declaredMimeType: MIME_TYPES.DOCX,
    }).catch((e) => e);

    expect(error.code).toBe(EXTRACTION_ERROR_CODES.UNSUPPORTED_FILE_TYPE);
    expect(error.reason).toBe('zip_not_ooxml');
    expect(error.userMessage).toBe(UNSUPPORTED_TYPE_MESSAGE);
    // The claim is recorded for the log, and had no effect on the outcome.
    expect(error.details.declaredMimeType).toBe(MIME_TYPES.DOCX);
  });

  it('records no mismatch when the client happened to be right', async () => {
    const result = await extractDocumentText({
      bytes: fixture('cv.txt'),
      declaredMimeType: MIME_TYPES.TXT,
    });

    expect(result.source.mimeTypeMismatch).toBe(false);
  });

  it('records no mismatch when the client said nothing at all', async () => {
    const result = await extractDocumentText({ bytes: fixture('cv.txt') });

    expect(result.source.declaredMimeType).toBeNull();
    expect(result.source.mimeTypeMismatch).toBe(false);
  });
});

describe('extractDocumentText, on files it will not take', () => {
  it('rejects an image', async () => {
    // A JPEG header, which is what arrives when somebody photographs their CV.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

    const error = await extractDocumentText({ bytes: jpeg }).catch((e) => e);

    expect(error.code).toBe(EXTRACTION_ERROR_CODES.UNSUPPORTED_FILE_TYPE);
    expect(error.userMessage).toBe(UNSUPPORTED_TYPE_MESSAGE);
  });

  it('tells the recruiter an empty file is empty, rather than unrecognised', async () => {
    const error = await extractDocumentText({ bytes: Buffer.alloc(0) }).catch((e) => e);

    expect(error.code).toBe(EXTRACTION_ERROR_CODES.UNSUPPORTED_FILE_TYPE);
    expect(error.reason).toBe('empty_file');
    // Different advice, because "this file is empty" is something they can check
    // and "we do not recognise this format" is not.
    expect(error.userMessage).toBe(EMPTY_FILE_MESSAGE);
  });

  it('fails a PDF whose bytes stop halfway through', async () => {
    const truncated = buildTextPdf([[{ x: 72, y: 720, size: 12, text: 'Priya Ramanathan' }]]).subarray(
      0,
      120,
    );

    const error = await extractDocumentText({ bytes: truncated }).catch((e) => e);

    // Still a PDF by signature, so it is not an unsupported type - it is a
    // damaged one, and those are different conversations with the candidate.
    expect(error.code).toBe(EXTRACTION_ERROR_CODES.EXTRACTION_FAILED);
    expect(error.userMessage).toMatch(/could not be (opened|read)/);
  });

  it('fails a DOCX whose package declares a main document it does not contain', async () => {
    const complete = buildDocx(['Priya Ramanathan']);
    // Rebuild the same package without the part it advertises. This gets past
    // the sniffer - `[Content_Types].xml` still names the main document - which
    // is exactly why the parser cannot assume the sniffer's word for it.
    const hollow = buildZip([
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
      },
    ]);

    expect(complete.length).toBeGreaterThan(hollow.length);

    const error = await extractDocumentText({ bytes: hollow }).catch((e) => e);

    expect(error.code).toBe(EXTRACTION_ERROR_CODES.EXTRACTION_FAILED);
    expect(error.reason).toBe('docx_no_main_document');
    expect(error.details.entryCount).toBe(1);
  });

  it('fails a DOCX with no text in it, without borrowing the scanned-PDF advice', async () => {
    const blank = buildDocx(['', '   ', '']);

    const error = await extractDocumentText({ bytes: blank }).catch((e) => e);

    expect(error.code).toBe(EXTRACTION_ERROR_CODES.EMPTY_DOCUMENT);
    // A DOCX has no text layer to be missing. Telling somebody to "re-upload a
    // text-based PDF" would be advice about a problem they do not have.
    expect(error.userMessage).not.toBe(SCANNED_PDF_MESSAGE);
    expect(error.userMessage).toContain('empty');
  });
});
