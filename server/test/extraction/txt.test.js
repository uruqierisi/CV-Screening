import { describe, expect, it } from 'vitest';

import { EXTRACTION_ERROR_CODES } from '../../src/extraction/constants.js';
import { parseTxt } from '../../src/extraction/parsers/txt.js';

/**
 * The short parser, and it is still not `toString('utf8')`.
 */

/** U+FEFF, built from its code point so no invisible character sits in this file. */
const BOM = String.fromCharCode(0xfeff);

describe('parseTxt', () => {
  it('normalizes CRLF, which is what a file written on Windows carries', () => {
    const bytes = Buffer.from('Priya Ramanathan\r\nLondon, UK\r\n', 'utf8');

    expect(parseTxt(bytes, { encoding: 'utf-8' }).text).toBe('Priya Ramanathan\nLondon, UK');
  });

  it('normalizes a bare carriage return, which classic Mac exports still use', () => {
    const bytes = Buffer.from('Priya Ramanathan\rLondon, UK', 'utf8');

    expect(parseTxt(bytes, { encoding: 'utf-8' }).text).toBe('Priya Ramanathan\nLondon, UK');
  });

  it('strips the byte-order mark, which would otherwise land in the candidate name', () => {
    // A leading U+FEFF is invisible, survives every downstream trim, and ends
    // up as the first character of the extracted name - where it matches
    // nothing and looks like a data-entry error.
    const bytes = Buffer.from(`${BOM}Priya Ramanathan`, 'utf8');
    const { text } = parseTxt(bytes, { encoding: 'utf-8' });

    expect(text).toBe('Priya Ramanathan');
    expect(text.charCodeAt(0)).toBe('P'.charCodeAt(0));
  });

  it('decodes UTF-16 little-endian', () => {
    const bytes = Buffer.from(`${BOM}Priya Ramanathan`, 'utf16le');

    expect(parseTxt(bytes, { encoding: 'utf-16le' }).text).toBe('Priya Ramanathan');
  });

  it('decodes UTF-16 big-endian', () => {
    const bytes = Buffer.from(`${BOM}Priya Ramanathan`, 'utf16le').swap16();

    expect(parseTxt(bytes, { encoding: 'utf-16be' }).text).toBe('Priya Ramanathan');
  });

  it('collapses a run of blank lines to one, and keeps the one', () => {
    // The blank line is real structure - it is what separates the education
    // block from the experience block - so it is collapsed rather than removed.
    const bytes = Buffer.from('EXPERIENCE\n\n\n\n\nEDUCATION', 'utf8');

    expect(parseTxt(bytes, { encoding: 'utf-8' }).text).toBe('EXPERIENCE\n\nEDUCATION');
  });

  it('collapses spaces within a line without touching the line breaks', () => {
    const bytes = Buffer.from('Skills:    Node.js,   Redis   \nDocker', 'utf8');

    expect(parseTxt(bytes, { encoding: 'utf-8' }).text).toBe('Skills: Node.js, Redis\nDocker');
  });

  it('keeps a non-Latin CV intact', () => {
    const bytes = Buffer.from('職務経歴書\n山田太郎\n2019年 - 現在', 'utf8');

    expect(parseTxt(bytes, { encoding: 'utf-8' }).text).toBe('職務経歴書\n山田太郎\n2019年 - 現在');
  });

  it('fails an empty file rather than returning an empty string', () => {
    // An empty string that reached the agent layer would fail there anyway, but
    // one page later and with a message about CV quality rather than about the
    // file.
    const error = (() => {
      try {
        parseTxt(Buffer.alloc(0), { encoding: 'utf-8' });
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error.code).toBe(EXTRACTION_ERROR_CODES.EMPTY_DOCUMENT);
    expect(error.details).toEqual({ characters: 0, byteSize: 0 });
  });

  it('fails a file that is nothing but whitespace', () => {
    expect(() => parseTxt(Buffer.from('   \r\n\t\n  ', 'utf8'), { encoding: 'utf-8' })).toThrow(
      /no usable text/,
    );
  });
});
