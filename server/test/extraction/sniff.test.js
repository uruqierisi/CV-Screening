import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MIME_TYPES } from '../../src/extraction/constants.js';
import { sniffMimeType } from '../../src/extraction/sniff.js';
import { buildDocx, buildTextPdf, buildZip } from './fixtures/build-documents.js';

/**
 * Reading the bytes, and never the name on the file.
 *
 * The cases that matter here are the ones where the two disagree, because that
 * is normal traffic rather than an attack: a `.pdf` somebody renamed, a browser
 * that sent `application/octet-stream` because it declined to guess, and a
 * `.docx` that is really an XLSX because it was saved from the wrong tab.
 */

/** @param {string} name */
function fixture(name) {
  return readFileSync(fileURLToPath(new URL(`./fixtures/documents/${name}`, import.meta.url)));
}

/** @param {string} text */
function utf8(text) {
  return Buffer.from(text, 'utf8');
}

describe('sniffMimeType, on files whose name is telling the truth', () => {
  it('identifies a PDF by its header', () => {
    expect(sniffMimeType(fixture('clean.pdf'))).toEqual({
      mimeType: MIME_TYPES.PDF,
      reason: 'pdf_signature',
      encoding: null,
      signatureOffset: 0,
    });
  });

  it('identifies a DOCX by the content type it declares, not by a word/ directory', () => {
    expect(sniffMimeType(fixture('cv.docx'))).toEqual({
      mimeType: MIME_TYPES.DOCX,
      reason: 'ooxml_content_types',
      encoding: null,
    });
  });

  it('identifies plain text', () => {
    expect(sniffMimeType(fixture('cv.txt'))).toEqual({
      mimeType: MIME_TYPES.TXT,
      reason: 'utf8_heuristic',
      encoding: 'utf-8',
    });
  });
});

describe('sniffMimeType, when the extension lies', () => {
  it('reads a renamed DOCX as a DOCX however it was uploaded', () => {
    // `resume.pdf` that is really a Word file. The sniffer never sees a
    // filename, which is the point - there is nothing here for a lie to attach
    // to.
    expect(sniffMimeType(fixture('cv.docx')).mimeType).toBe(MIME_TYPES.DOCX);
  });

  it('reads a renamed PDF as a PDF', () => {
    expect(sniffMimeType(fixture('clean.pdf')).mimeType).toBe(MIME_TYPES.PDF);
  });

  it('refuses a plain ZIP renamed to .docx', () => {
    const zip = buildZip([{ name: 'cv.pdf', content: 'not really a pdf' }]);
    expect(sniffMimeType(zip)).toEqual({
      mimeType: null,
      reason: 'zip_not_ooxml',
      encoding: null,
    });
  });

  it('refuses an OOXML package that is not a word-processing document', () => {
    // What an XLSX looks like to this check: a valid OOXML package whose
    // content types name a spreadsheet. A reader that only looked for `PK`
    // would hand a workbook to the DOCX parser.
    const xlsx = buildZip([
      {
        name: '[Content_Types].xml',
        content:
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '</Types>',
      },
      { name: 'xl/workbook.xml', content: '<workbook/>' },
    ]);

    expect(sniffMimeType(xlsx)).toEqual({
      mimeType: null,
      reason: 'ooxml_not_wordprocessing',
      encoding: null,
    });
  });

  it('refuses a JPEG that was uploaded with a .pdf extension', () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      utf8('JFIF'),
      Buffer.from([0x00, 0x01, 0x02, 0x03]),
    ]);

    expect(sniffMimeType(jpeg).mimeType).toBeNull();
  });
});

describe('sniffMimeType, on PDFs that are not quite well formed', () => {
  it('accepts a header preceded by junk, because the specification does', () => {
    // Mail gateways and download managers prepend bytes. pdf.js reads these
    // files, so refusing them here would reject CVs the parser would have
    // handled.
    const withJunk = Buffer.concat([utf8('X'.repeat(300)), fixture('clean.pdf')]);

    expect(sniffMimeType(withJunk)).toEqual({
      mimeType: MIME_TYPES.PDF,
      reason: 'pdf_signature_offset',
      encoding: null,
      signatureOffset: 300,
    });
  });

  it('stops looking for the header after 1024 bytes', () => {
    // The specification's own bound. Past it, a `%PDF-` is a coincidence or a
    // payload, not a header - and this one is inside what would otherwise sniff
    // as text.
    const tooLate = Buffer.concat([utf8('X'.repeat(2000)), fixture('clean.pdf')]);

    expect(sniffMimeType(tooLate).mimeType).not.toBe(MIME_TYPES.PDF);
  });
});

describe('sniffMimeType, on text encodings', () => {
  it('accepts UTF-8 with a byte-order mark', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('Priya Ramanathan')]);

    expect(sniffMimeType(withBom)).toEqual({
      mimeType: MIME_TYPES.TXT,
      reason: 'utf8_bom',
      encoding: 'utf-8',
    });
  });

  it('accepts UTF-16, which Windows Notepad writes and a NUL check would reject', () => {
    const littleEndian = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('Priya Ramanathan', 'utf16le'),
    ]);
    const bigEndian = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      Buffer.from('Priya Ramanathan', 'utf16le').swap16(),
    ]);

    expect(sniffMimeType(littleEndian)).toEqual({
      mimeType: MIME_TYPES.TXT,
      reason: 'utf16_bom',
      encoding: 'utf-16le',
    });
    expect(sniffMimeType(bigEndian)).toEqual({
      mimeType: MIME_TYPES.TXT,
      reason: 'utf16_bom',
      encoding: 'utf-16be',
    });
  });

  it('accepts a CV in a non-Latin script', () => {
    // The check must not be an "is this English" check. Rejecting valid UTF-8
    // because it is not ASCII would be a bug visible only to non-English
    // candidates, which is the worst place for one.
    const japanese = utf8('職務経歴書\n山田太郎\n2019年 - 現在');

    expect(sniffMimeType(japanese).mimeType).toBe(MIME_TYPES.TXT);
  });

  it('rejects bytes that are not valid UTF-8', () => {
    // A lone continuation byte: legal in Latin-1, impossible in UTF-8.
    const latin1 = Buffer.from([0x50, 0x72, 0x69, 0x79, 0x61, 0xe9, 0x20, 0x52]);

    expect(sniffMimeType(latin1)).toEqual({
      mimeType: null,
      reason: 'not_utf8',
      encoding: null,
    });
  });

  it('rejects a NUL, which is valid UTF-8 and never appears in a document', () => {
    const withNul = Buffer.concat([utf8('Priya'), Buffer.from([0x00]), utf8('Ramanathan')]);

    expect(sniffMimeType(withNul).reason).toBe('contains_nul');
  });

  it('rejects a run of control characters', () => {
    // Valid UTF-8, no NUL, and still plainly not a document.
    const controls = Buffer.from(new Array(200).fill(0x01));

    expect(sniffMimeType(controls).reason).toBe('too_many_control_characters');
  });

  it('tolerates the occasional control character a word processor leaves behind', () => {
    // A form feed in 500 characters of prose is a page break somebody pasted,
    // not a binary. The bar is set to reject binaries, not to police documents.
    const prose = utf8(`${'Backend engineer with nine years of experience. '.repeat(11)}\f`);

    expect(sniffMimeType(prose).mimeType).toBe(MIME_TYPES.TXT);
  });

  it('accepts a file that is nothing but a byte-order mark, and leaves it to the parser', () => {
    // Type detection and emptiness are different questions, and answering the
    // second one here would produce "unsupported file type" for a file whose
    // real problem is that it has no content.
    expect(sniffMimeType(Buffer.from([0xef, 0xbb, 0xbf]))).toEqual({
      mimeType: MIME_TYPES.TXT,
      reason: 'utf8_bom',
      encoding: 'utf-8',
    });
  });
});

describe('sniffMimeType, on the 8 KB prefix boundary', () => {
  it('does not reject a large UTF-8 file because a character straddles the cut', () => {
    // The bug this prevents: an 8192-byte cut landing inside a multi-byte
    // character makes the prefix invalid UTF-8, and a real CV is rejected as
    // binary - but only ever a non-English one.
    for (const padding of [8189, 8190, 8191]) {
      const straddling = Buffer.concat([
        utf8('a'.repeat(padding)),
        utf8('日本語'), // three three-byte characters
        utf8('b'.repeat(100)),
      ]);

      expect(sniffMimeType(straddling).mimeType).toBe(MIME_TYPES.TXT);
    }
  });

  it('leaves an ASCII file alone at the cut, which is the common case', () => {
    // The plain path through the boundary walk: the last byte of the prefix is
    // an ordinary one-byte character, so there is nothing to trim.
    const ascii = utf8('Backend engineer with nine years of experience. '.repeat(400));
    expect(ascii.length).toBeGreaterThan(8192);

    expect(sniffMimeType(ascii).mimeType).toBe(MIME_TYPES.TXT);
  });

  it('handles a two-byte character whose lead byte is the last byte of the prefix', () => {
    // The tightest case: one byte of a two-byte character inside the prefix and
    // the other outside it.
    const straddling = Buffer.concat([
      utf8('a'.repeat(8191)),
      utf8('é'),
      utf8('b'.repeat(100)),
    ]);

    expect(sniffMimeType(straddling).mimeType).toBe(MIME_TYPES.TXT);
  });

  it('handles a four-byte character whose lead byte is the last byte of the prefix', () => {
    const straddling = Buffer.concat([
      utf8('a'.repeat(8191)),
      utf8('\u{1f600}'),
      utf8('b'.repeat(100)),
    ]);

    expect(sniffMimeType(straddling).mimeType).toBe(MIME_TYPES.TXT);
  });

  it('handles a four-byte character straddling the cut', () => {
    // The case the trailing-byte walk has to reach its last step for: three
    // continuation bytes at the end of the prefix and the lead byte just before
    // them.
    const emoji = utf8('\u{1f600}');
    expect(emoji.length).toBe(4);

    const straddling = Buffer.concat([
      utf8('a'.repeat(8188)),
      emoji, // bytes 8188..8191 - entirely inside the prefix
      utf8('b'.repeat(100)),
    ]);

    expect(sniffMimeType(straddling).mimeType).toBe(MIME_TYPES.TXT);
  });

  it('still rejects a file whose own last character is truncated', () => {
    // When the prefix *is* the whole file, a partial sequence is damage rather
    // than a cut, and the decoder is entitled to say so.
    const truncated = Buffer.concat([utf8('Priya '), Buffer.from([0xe6, 0x97])]);

    expect(sniffMimeType(truncated).reason).toBe('not_utf8');
  });
});

describe('sniffMimeType, on the edges', () => {
  it('reports an empty file as empty rather than unrecognised', () => {
    expect(sniffMimeType(Buffer.alloc(0))).toEqual({
      mimeType: null,
      reason: 'empty_file',
      encoding: null,
    });
  });

  it('handles a file shorter than the signatures it is compared against', () => {
    expect(sniffMimeType(Buffer.from([0x50]))).toEqual({
      mimeType: MIME_TYPES.TXT,
      reason: 'utf8_heuristic',
      encoding: 'utf-8',
    });
  });

  it('names an empty ZIP archive as one, instead of calling it unrecognised', () => {
    const emptyArchive = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      Buffer.alloc(18),
    ]);

    expect(sniffMimeType(emptyArchive).reason).toBe('zip_empty_archive');
  });

  it('names a spanned ZIP archive as one', () => {
    const spanned = Buffer.concat([Buffer.from([0x50, 0x4b, 0x07, 0x08]), Buffer.alloc(30)]);

    expect(sniffMimeType(spanned).reason).toBe('zip_spanned_archive');
  });

  it('reports a ZIP header on an unreadable archive as unreadable, not as "not a DOCX"', () => {
    // The two send whoever reads the log to different places: one is a damaged
    // upload, the other is somebody sending the wrong kind of file.
    const damaged = buildDocx(['Priya Ramanathan']).subarray(0, 40);

    expect(sniffMimeType(damaged).reason).toMatch(/^zip_unreadable:/);
  });

  it('reports an OOXML package whose content-type part cannot be read', () => {
    // A package whose central directory is intact - so the archive opens and
    // the entry is found - but whose `[Content_Types].xml` data cannot be
    // reached. The decoy entry goes first so that breaking the second local
    // header leaves the ZIP signature at offset 0 alone, and the file is still
    // sniffed as an archive rather than falling out as unrecognised bytes.
    const archive = buildZip([
      { name: 'docProps/app.xml', content: '<Properties/>' },
      { name: '[Content_Types].xml', content: '<Types/>' },
    ]);

    const corrupted = Buffer.from(archive);
    const secondLocalHeader = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), 4);
    expect(secondLocalHeader).toBeGreaterThan(0);
    corrupted.writeUInt32LE(0x04034b51, secondLocalHeader);

    expect(sniffMimeType(corrupted).reason).toBe('zip_unreadable:zip_bad_local_header');
  });

  it('never throws, whatever it is handed', () => {
    // Type detection is the one cheap check in the system, and an exception
    // from it would make the caller treat "I do not know" as a failure.
    const inputs = [
      Buffer.alloc(0),
      Buffer.alloc(1),
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from(new Array(64).fill(0xff)),
      buildTextPdf([[]]),
    ];

    for (const input of inputs) {
      expect(() => sniffMimeType(input)).not.toThrow();
    }
  });
});
