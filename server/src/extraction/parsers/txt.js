/**
 * Text bytes to text. The short one, and it is still not `toString('utf8')`.
 *
 * Three things have to happen that the naive call gets wrong: the byte-order
 * mark has to come off (a leading U+FEFF is invisible, survives every downstream
 * trim, and lands in the first field of the extracted profile - it would show up
 * as a candidate whose name does not match anything); UTF-16 has to be decoded
 * as UTF-16 rather than as mojibake; and CRLF has to become LF so that line
 * handling is the same for a file written on Windows and one written anywhere
 * else.
 *
 * The encoding is not guessed here - `sniff.js` already decided, from the BOM or
 * from a UTF-8 validity check, and this function is handed the answer. Guessing
 * twice is how two parts of a system come to disagree about what a file says.
 */

import { EmptyDocumentError } from '../errors.js';

/**
 * Recruiter-facing message for a text file with nothing in it.
 */
export const EMPTY_TEXT_MESSAGE =
  'This file is empty; no text could be read from it. Check the file and re-upload it.';

/**
 * U+FEFF, left in the decoded string whatever the encoding was.
 *
 * Built from its code point rather than written as a literal: a raw U+FEFF in
 * source is invisible in every editor and diff, so the one place it appears
 * should be the one place it is named.
 */
const BOM_CHARACTER = String.fromCharCode(0xfeff);

/** Windows and classic-Mac line endings. */
const CRLF_PATTERN = /\r\n?/g;

/** Runs of spaces and tabs, but never a newline. */
const INTRA_LINE_WHITESPACE = /[^\S\r\n]+/g;

/** Three or more newlines, i.e. two or more consecutive blank lines. */
const BLANK_LINE_RUN = /\n{3,}/g;

/**
 * Decodes and tidies a plain-text file.
 *
 * @param {Buffer} bytes
 * @param {object} params
 * @param {'utf-8' | 'utf-16le' | 'utf-16be'} params.encoding as decided by `sniff.js`
 * @returns {{ text: string }}
 * @throws {EmptyDocumentError} when the file holds no text
 */
export function parseTxt(bytes, { encoding }) {
  // Non-fatal on purpose, and only reachable for UTF-8 through the sniffer's
  // 8 KB prefix check - a file whose first 8 KB are clean UTF-8 and whose
  // hundredth kilobyte is not should lose that one character, not the whole
  // candidate. `sniff.js` has already rejected anything that is not text at all.
  const decoded = new TextDecoder(encoding).decode(bytes);

  const text = decoded
    .replaceAll(BOM_CHARACTER, '')
    .replace(CRLF_PATTERN, '\n')
    .split('\n')
    .map((line) => line.replace(INTRA_LINE_WHITESPACE, ' ').trimEnd())
    .join('\n')
    .replace(BLANK_LINE_RUN, '\n\n')
    .trim();

  if (text.length === 0) {
    throw new EmptyDocumentError({
      userMessage: EMPTY_TEXT_MESSAGE,
      details: { characters: 0, byteSize: bytes.length },
    });
  }

  return { text };
}
