/**
 * A ZIP reader that does one thing: find a named entry and return its bytes.
 *
 * **Why this is hand-written rather than a dependency.** The job is "open one
 * archive, read one entry whose name we already know, and refuse everything
 * unusual" - and the general-purpose libraries are general in exactly the
 * directions that are liabilities on an upload path: they extract whatever the
 * archive names, and they believe the archive's own claims about size. The
 * best-maintained DOCX option, `mammoth` (1.12.1, published 2026-08-09), brings
 * ten transitive packages including `bluebird`, `underscore` and `argparse` -
 * the last of which is there for a command-line interface. This file has no
 * dependencies beyond `node:zlib`, never writes to disk, never resolves a path
 * out of the archive, and stops at a byte ceiling instead of trusting a declared
 * size.
 *
 * The trade-off, stated so it can be reversed knowingly: `mammoth` understands
 * WordprocessingML far better than `parsers/docx.js` does, and if DOCX quality
 * ever becomes the bottleneck the right move is to take the dependency rather
 * than to grow these two files toward it.
 *
 * **It reads the central directory, not the local headers.** A local header may
 * carry zeroes for the sizes and CRC and defer them to a data descriptor after
 * the entry (general-purpose flag bit 3), which is what streaming writers do.
 * The central directory always holds the real values, so reading it is both
 * simpler and correct on archives a local-header reader gets wrong. The local
 * header is consulted for one thing: the variable-length name and extra fields
 * that sit between it and the data.
 *
 * **Nothing here throws.** Every refusal is a returned {@link ZipFailure}, and
 * that is a deliberate shape rather than a style preference. A malformed archive
 * is an expected outcome on an upload path - it is data, not an exception - and
 * both callers want to *translate* the reason rather than catch it: the sniffer
 * turns it into "not a DOCX" and the parser turns it into a recruiter-facing
 * message. Returning the failure means neither needs a `catch` that has to
 * re-throw anything it did not recognise, which is the branch that can never be
 * tested and therefore never be trusted. A `TypeError` from a bug in this file
 * still propagates as a `TypeError`, which is what should happen to it.
 *
 * Refused, every time: encrypted entries, ZIP64, compression methods other than
 * stored and deflate, and anything whose inflated size exceeds the caller's
 * ceiling. Refusing is the whole point - a CV that needs any of those is not a
 * CV.
 */

import { inflateRawSync } from 'node:zlib';

/** End of central directory record. */
const EOCD_SIGNATURE = 0x06054b50;
/** Central directory file header. */
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
/** Local file header. */
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
/** ZIP64 end of central directory locator - present only on ZIP64 archives. */
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

const EOCD_MIN_SIZE = 22;
const CENTRAL_HEADER_MIN_SIZE = 46;
const LOCAL_HEADER_MIN_SIZE = 30;
const ZIP64_LOCATOR_SIZE = 20;

/**
 * The ZIP comment is a 16-bit length, so the EOCD can be at most 65,535 bytes
 * plus its own 22 from the end of the file. Anything further back is not an
 * EOCD however much it looks like one.
 */
const MAX_EOCD_SEARCH = 0xffff + EOCD_MIN_SIZE;

/** Values that mean "the real one is in a ZIP64 record". */
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

/** General-purpose bit flag: the entry is encrypted. */
const FLAG_ENCRYPTED = 0x0001;

/** The two compression methods a real DOCX uses. */
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/**
 * Why an archive was refused. Plain data, log-safe, and never containing
 * anything out of the archive except an entry name.
 *
 * @typedef {object} ZipFailure
 * @property {string} reason machine-readable, e.g. `zip64_unsupported`
 * @property {string} message internal detail for logs
 * @property {Record<string, unknown>} details counts and offsets only
 */

/**
 * One entry as described by the central directory.
 *
 * @typedef {object} ZipEntry
 * @property {string} name the archive-relative path, exactly as stored
 * @property {number} compressionMethod
 * @property {number} compressedSize
 * @property {number} uncompressedSize
 * @property {number} localHeaderOffset
 * @property {number} flags general-purpose bit flags
 */

/**
 * @typedef {{ entries: ZipEntry[], failure: null } | { entries: null, failure: ZipFailure }} ZipDirectoryResult
 */

/**
 * @typedef {{ data: Buffer, failure: null } | { data: null, failure: ZipFailure }} ZipEntryResult
 */

/**
 * @param {string} reason
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {ZipFailure}
 */
function failure(reason, message, details = {}) {
  return { reason, message, details };
}

/**
 * Finds the end-of-central-directory record by scanning backwards.
 *
 * Backwards because the record sits at the end and its position depends on a
 * trailing comment of arbitrary length; scanning forwards would mean parsing
 * every entry to find out where to stop.
 *
 * @param {Buffer} bytes
 * @returns {number} offset of the EOCD signature, or -1
 */
function findEndOfCentralDirectory(bytes) {
  const earliest = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
  for (let offset = bytes.length - EOCD_MIN_SIZE; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

/**
 * Reads the central directory.
 *
 * @param {Buffer} bytes the whole archive
 * @returns {ZipDirectoryResult} entries in central-directory order
 */
export function readZipDirectory(bytes) {
  if (bytes.length < EOCD_MIN_SIZE) {
    return {
      entries: null,
      failure: failure('zip_too_small', 'file is shorter than an empty ZIP archive', {
        byteLength: bytes.length,
      }),
    };
  }

  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) {
    return {
      entries: null,
      failure: failure(
        'zip_no_end_of_central_directory',
        'no end-of-central-directory record in the last 64 KiB',
        { byteLength: bytes.length },
      ),
    };
  }

  // Checked before the sentinel fields, so a ZIP64 archive is refused on its own
  // terms rather than as a corrupt ZIP32 one.
  const locator = eocd - ZIP64_LOCATOR_SIZE;
  const hasZip64Locator = locator >= 0 && bytes.readUInt32LE(locator) === ZIP64_LOCATOR_SIGNATURE;

  const entryCount = bytes.readUInt16LE(eocd + 10);
  const directorySize = bytes.readUInt32LE(eocd + 12);
  const directoryOffset = bytes.readUInt32LE(eocd + 16);

  if (
    hasZip64Locator ||
    entryCount === ZIP64_SENTINEL_16 ||
    directoryOffset === ZIP64_SENTINEL_32
  ) {
    return {
      entries: null,
      failure: failure('zip64_unsupported', 'ZIP64 archives are not supported', { entryCount }),
    };
  }

  if (directoryOffset + directorySize > bytes.length) {
    return {
      entries: null,
      failure: failure('zip_truncated', 'the central directory extends past the end of file', {
        directoryOffset,
        directorySize,
        byteLength: bytes.length,
      }),
    };
  }

  /** @type {ZipEntry[]} */
  const entries = [];
  let cursor = directoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + CENTRAL_HEADER_MIN_SIZE > bytes.length) {
      return {
        entries: null,
        failure: failure('zip_truncated', 'central directory ends mid-header', { index }),
      };
    }
    if (bytes.readUInt32LE(cursor) !== CENTRAL_HEADER_SIGNATURE) {
      return {
        entries: null,
        failure: failure('zip_bad_central_header', 'wrong central directory header signature', {
          index,
        }),
      };
    }

    const nameLength = bytes.readUInt16LE(cursor + 28);
    const nameStart = cursor + CENTRAL_HEADER_MIN_SIZE;
    const nameEnd = nameStart + nameLength;

    if (nameEnd > bytes.length) {
      return {
        entries: null,
        failure: failure('zip_truncated', 'an entry name extends past the end of file', { index }),
      };
    }

    entries.push({
      // Names are decoded as UTF-8 whether or not the archive sets the flag
      // that says so. The alternative for an unset flag is CP437, and every
      // name this layer looks for is ASCII, where the two agree - so a code
      // page table would buy nothing, and a mis-decoded name simply fails to
      // match the one being looked for.
      name: bytes.toString('utf8', nameStart, nameEnd),
      flags: bytes.readUInt16LE(cursor + 8),
      compressionMethod: bytes.readUInt16LE(cursor + 10),
      compressedSize: bytes.readUInt32LE(cursor + 20),
      uncompressedSize: bytes.readUInt32LE(cursor + 24),
      localHeaderOffset: bytes.readUInt32LE(cursor + 42),
    });

    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    cursor = nameEnd + extraLength + commentLength;
  }

  return { entries, failure: null };
}

/**
 * Reads and, if necessary, inflates one entry.
 *
 * @param {Buffer} bytes the whole archive
 * @param {ZipEntry} entry from {@link readZipDirectory}
 * @param {object} options
 * @param {number} options.maxBytes ceiling on the inflated size
 * @returns {ZipEntryResult}
 */
export function readZipEntry(bytes, entry, { maxBytes }) {
  if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
    return {
      data: null,
      failure: failure('zip_encrypted', 'the archive entry is encrypted', {
        entryName: entry.name,
      }),
    };
  }

  if (entry.uncompressedSize > maxBytes) {
    // Refused on the declared size before a byte is inflated. The ceiling is
    // enforced again during the inflate, because a declared size is a claim.
    return {
      data: null,
      failure: failure('zip_entry_too_large', 'the entry declares a size past the cap', {
        entryName: entry.name,
        uncompressedSize: entry.uncompressedSize,
        maxBytes,
      }),
    };
  }

  const header = entry.localHeaderOffset;
  if (header + LOCAL_HEADER_MIN_SIZE > bytes.length) {
    return {
      data: null,
      failure: failure('zip_truncated', 'a local header extends past the end of file', {
        entryName: entry.name,
      }),
    };
  }
  if (bytes.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE) {
    return {
      data: null,
      failure: failure('zip_bad_local_header', 'wrong local file header signature', {
        entryName: entry.name,
      }),
    };
  }

  // Only the two variable-length fields are read from the local header. Every
  // other value comes from the central directory, which is the copy that is
  // always populated.
  const nameLength = bytes.readUInt16LE(header + 26);
  const extraLength = bytes.readUInt16LE(header + 28);
  const dataStart = header + LOCAL_HEADER_MIN_SIZE + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;

  if (dataEnd > bytes.length) {
    return {
      data: null,
      failure: failure('zip_truncated', 'entry data extends past the end of file', {
        entryName: entry.name,
        dataEnd,
        byteLength: bytes.length,
      }),
    };
  }

  const stored = bytes.subarray(dataStart, dataEnd);

  if (entry.compressionMethod === METHOD_STORED) {
    return { data: Buffer.from(stored), failure: null };
  }
  if (entry.compressionMethod !== METHOD_DEFLATE) {
    return {
      data: null,
      failure: failure('zip_unsupported_compression', 'unsupported compression method', {
        entryName: entry.name,
        compressionMethod: entry.compressionMethod,
      }),
    };
  }

  try {
    // `maxOutputLength` is the real defence: it stops the inflate rather than
    // measuring the damage afterwards, so a zip bomb costs the ceiling and not
    // the machine.
    return { data: inflateRawSync(stored, { maxOutputLength: maxBytes }), failure: null };
  } catch (cause) {
    // The one `catch` in the file, and it is around a call that signals through
    // exceptions because `node:zlib` does. Corrupt deflate data and a bomb that
    // hit the ceiling both arrive here; both mean the same thing to a caller.
    return {
      data: null,
      failure: failure('zip_inflate_failed', 'inflate failed', {
        entryName: entry.name,
        // `node:zlib` documents throwing an `Error`, so the message is read
        // without an `instanceof` guard. A guard here would be a branch no test
        // could ever reach, and an untestable branch is one nobody can trust.
        cause: /** @type {Error} */ (cause).message,
      }),
    };
  }
}

/**
 * Finds an entry by exact name.
 *
 * Exact rather than normalized. ZIP names are stored with forward slashes and
 * the OOXML names this layer looks for are fixed by the specification, so
 * normalization could only ever be a way to accept an archive that is already
 * wrong.
 *
 * @param {readonly ZipEntry[]} entries
 * @param {string} name
 * @returns {ZipEntry | undefined}
 */
export function findZipEntry(entries, name) {
  return entries.find((entry) => entry.name === name);
}

/** Exported for the fixture generator, which writes both kinds of entry. */
export const ZIP_METHODS = Object.freeze({
  STORED: METHOD_STORED,
  DEFLATE: METHOD_DEFLATE,
});
