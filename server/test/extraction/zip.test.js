import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { ZIP_METHODS, findZipEntry, readZipDirectory, readZipEntry } from '../../src/extraction/zip.js';
import { buildDocx, buildZip } from './fixtures/build-documents.js';

/**
 * The ZIP reader, and specifically everything it refuses.
 *
 * Uploads are untrusted by definition, so the interesting behaviour of this
 * module is not that it reads a good archive - it is that it declines a bad one
 * with a reason, at a bound, without throwing.
 */

const NO_CAP = 1024 * 1024;

/** Offset of the first central-directory header, found rather than computed. */
function centralDirectoryOffset(/** @type {Buffer} */ archive) {
  return archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
}

describe('readZipDirectory, on a well-formed archive', () => {
  it('lists every entry, in central-directory order', () => {
    const archive = buildDocx(['Priya Ramanathan']);
    const { entries, failure } = readZipDirectory(archive);

    expect(failure).toBeNull();
    expect(entries.map((entry) => entry.name)).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
    ]);
  });

  it('reads the real sizes, so a compressed entry is not confused with its stored size', () => {
    const archive = buildZip([
      { name: 'big.xml', content: 'x'.repeat(5000), method: ZIP_METHODS.DEFLATE },
    ]);
    const entry = readZipDirectory(archive).entries[0];

    expect(entry.uncompressedSize).toBe(5000);
    expect(entry.compressedSize).toBeLessThan(200);
  });
});

describe('readZipDirectory, on archives it will not open', () => {
  it('refuses a file too short to be an archive at all', () => {
    expect(readZipDirectory(Buffer.alloc(4)).failure).toMatchObject({ reason: 'zip_too_small' });
  });

  it('refuses a file with no end-of-central-directory record', () => {
    // Long enough to pass the size check, and containing nothing that looks
    // like the record the reader has to start from.
    expect(readZipDirectory(Buffer.alloc(500)).failure).toMatchObject({
      reason: 'zip_no_end_of_central_directory',
    });
  });

  it('refuses a ZIP64 archive by its locator, rather than misreading it as ZIP32', () => {
    const archive = buildZip([{ name: 'a.txt', content: 'hello' }]);
    // Splice a ZIP64 locator into the 20 bytes immediately before the EOCD,
    // which is where a real ZIP64 archive carries one.
    const eocd = archive.length - 22;
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    const withLocator = Buffer.concat([
      archive.subarray(0, eocd),
      locator,
      archive.subarray(eocd),
    ]);

    expect(readZipDirectory(withLocator).failure).toMatchObject({ reason: 'zip64_unsupported' });
  });

  it('refuses an archive whose entry count is the ZIP64 sentinel', () => {
    const archive = Buffer.from(buildZip([{ name: 'a.txt', content: 'hello' }]));
    const eocd = archive.length - 22;
    archive.writeUInt16LE(0xffff, eocd + 10);

    expect(readZipDirectory(archive).failure).toMatchObject({ reason: 'zip64_unsupported' });
  });

  it('refuses an archive whose directory offset is the ZIP64 sentinel', () => {
    const archive = Buffer.from(buildZip([{ name: 'a.txt', content: 'hello' }]));
    const eocd = archive.length - 22;
    archive.writeUInt32LE(0xffffffff, eocd + 16);

    expect(readZipDirectory(archive).failure).toMatchObject({ reason: 'zip64_unsupported' });
  });

  it('refuses an archive whose central directory points past the end of the file', () => {
    const archive = Buffer.from(buildZip([{ name: 'a.txt', content: 'hello' }]));
    const eocd = archive.length - 22;
    archive.writeUInt32LE(archive.length - 4, eocd + 16);

    expect(readZipDirectory(archive).failure).toMatchObject({ reason: 'zip_truncated' });
  });

  it('refuses an archive whose central directory ends mid-header', () => {
    const archive = Buffer.from(buildZip([{ name: 'a.txt', content: 'hello' }]));
    const eocd = archive.length - 22;
    // Claim two entries where there is only room for one: the second header
    // runs off the end of the directory.
    archive.writeUInt16LE(2, eocd + 10);

    expect(readZipDirectory(archive).failure).toMatchObject({ reason: 'zip_truncated' });
  });

  it('refuses an archive whose central header signature is wrong', () => {
    const archive = Buffer.from(buildZip([{ name: 'a.txt', content: 'hello' }]));
    archive.writeUInt32LE(0x02014b51, centralDirectoryOffset(archive));

    expect(readZipDirectory(archive).failure).toMatchObject({ reason: 'zip_bad_central_header' });
  });

  it('refuses an archive whose entry name runs past the end of the file', () => {
    const archive = Buffer.from(buildZip([{ name: 'a.txt', content: 'hello' }]));
    archive.writeUInt16LE(0xfff0, centralDirectoryOffset(archive) + 28);

    expect(readZipDirectory(archive).failure).toMatchObject({ reason: 'zip_truncated' });
  });
});

describe('readZipEntry', () => {
  it('returns a stored entry byte for byte', () => {
    const archive = buildZip([
      { name: 'a.txt', content: 'Priya Ramanathan', method: ZIP_METHODS.STORED },
    ]);
    const entry = readZipDirectory(archive).entries[0];

    expect(readZipEntry(archive, entry, { maxBytes: NO_CAP }).data.toString('utf8')).toBe(
      'Priya Ramanathan',
    );
  });

  it('inflates a deflated entry', () => {
    const archive = buildZip([
      { name: 'a.txt', content: 'Priya Ramanathan '.repeat(50), method: ZIP_METHODS.DEFLATE },
    ]);
    const entry = readZipDirectory(archive).entries[0];

    expect(readZipEntry(archive, entry, { maxBytes: NO_CAP }).data.toString('utf8')).toBe(
      'Priya Ramanathan '.repeat(50),
    );
  });

  it('refuses an encrypted entry', () => {
    const archive = Buffer.from(buildZip([{ name: 'a.txt', content: 'hello' }]));
    // General-purpose flag bit 0, in the central directory the reader trusts.
    archive.writeUInt16LE(0x0001, centralDirectoryOffset(archive) + 8);
    const entry = readZipDirectory(archive).entries[0];

    expect(readZipEntry(archive, entry, { maxBytes: NO_CAP }).failure).toMatchObject({
      reason: 'zip_encrypted',
    });
  });

  it('refuses an entry that declares a size past the cap, before inflating anything', () => {
    const archive = buildZip([{ name: 'a.txt', content: 'x'.repeat(1000) }]);
    const entry = readZipDirectory(archive).entries[0];

    expect(readZipEntry(archive, entry, { maxBytes: 100 }).failure).toMatchObject({
      reason: 'zip_entry_too_large',
      details: { uncompressedSize: 1000, maxBytes: 100 },
    });
  });

  it('stops a zip bomb at the cap even when the declared size is a lie', () => {
    // The case the declared-size check cannot catch: an entry that claims to be
    // small and inflates to a hundred times the cap. `maxOutputLength` stops
    // the inflate rather than measuring the damage afterwards.
    const bomb = deflateRawSync(Buffer.alloc(2_000_000), { level: 9 });
    const archive = Buffer.from(
      buildZip([{ name: 'a.txt', content: 'x'.repeat(2_000_000), method: ZIP_METHODS.DEFLATE }]),
    );
    expect(bomb.length).toBeLessThan(5000);

    // Rewrite the declared uncompressed size in both headers so the cheap check
    // waves it through and the inflate has to be the thing that stops it.
    const central = centralDirectoryOffset(archive);
    archive.writeUInt32LE(50, central + 24);
    const entry = readZipDirectory(archive).entries[0];

    expect(readZipEntry(archive, entry, { maxBytes: 1000 }).failure).toMatchObject({
      reason: 'zip_inflate_failed',
    });
  });

  it('refuses a compression method it does not implement', () => {
    const archive = Buffer.from(buildZip([{ name: 'a.txt', content: 'hello' }]));
    // 99 is AES encryption in the ZIP specification. Anything but 0 or 8 is a
    // refusal.
    archive.writeUInt16LE(99, centralDirectoryOffset(archive) + 10);
    const entry = readZipDirectory(archive).entries[0];

    expect(readZipEntry(archive, entry, { maxBytes: NO_CAP }).failure).toMatchObject({
      reason: 'zip_unsupported_compression',
      details: { compressionMethod: 99 },
    });
  });

  it('refuses an entry whose local header is past the end of the file', () => {
    const archive = Buffer.from(buildZip([{ name: 'a.txt', content: 'hello' }]));
    archive.writeUInt32LE(archive.length - 4, centralDirectoryOffset(archive) + 42);
    const entry = readZipDirectory(archive).entries[0];

    expect(readZipEntry(archive, entry, { maxBytes: NO_CAP }).failure).toMatchObject({
      reason: 'zip_truncated',
    });
  });

  it('refuses an entry whose local header signature is wrong', () => {
    const archive = Buffer.from(buildZip([{ name: 'a.txt', content: 'hello' }]));
    archive.writeUInt32LE(0x04034b51, 0);
    const entry = readZipDirectory(archive).entries[0];

    expect(readZipEntry(archive, entry, { maxBytes: NO_CAP }).failure).toMatchObject({
      reason: 'zip_bad_local_header',
    });
  });

  it('refuses an entry whose data runs past the end of the file', () => {
    const archive = Buffer.from(buildZip([{ name: 'a.txt', content: 'hello' }]));
    archive.writeUInt32LE(archive.length, centralDirectoryOffset(archive) + 20);
    const entry = readZipDirectory(archive).entries[0];

    expect(readZipEntry(archive, entry, { maxBytes: NO_CAP }).failure).toMatchObject({
      reason: 'zip_truncated',
    });
  });

  it('reports corrupt deflate data rather than throwing out of the module', () => {
    const content = Array.from({ length: 400 }, (_, index) => `line ${index} of a CV`).join('\n');
    const archive = Buffer.from(
      buildZip([{ name: 'a.txt', content, method: ZIP_METHODS.DEFLATE }]),
    );

    // Corrupt inside the compressed stream, located from the headers rather
    // than guessed at - a fixed offset would sooner or later land in the
    // central directory and fail this test for the wrong reason.
    const entry = readZipDirectory(archive).entries[0];
    const dataStart = entry.localHeaderOffset + 30 + Buffer.byteLength(entry.name);
    archive.fill(0xff, dataStart + 2, dataStart + 12);

    const result = readZipEntry(archive, entry, { maxBytes: NO_CAP });

    expect(result.data).toBeNull();
    expect(result.failure.reason).toBe('zip_inflate_failed');
    // The underlying message is kept for the log, and it is zlib's, not a CV's.
    expect(typeof result.failure.details.cause).toBe('string');
  });
});

describe('findZipEntry', () => {
  it('matches an exact name', () => {
    const { entries } = readZipDirectory(buildDocx(['Priya']));

    expect(findZipEntry(entries, 'word/document.xml')?.name).toBe('word/document.xml');
  });

  it('does not match a name that differs only in case or separator', () => {
    // Normalization could only ever be a way to accept an archive that is
    // already wrong: the OOXML part names are fixed by the specification.
    const { entries } = readZipDirectory(buildDocx(['Priya']));

    expect(findZipEntry(entries, 'word\\document.xml')).toBeUndefined();
    expect(findZipEntry(entries, 'Word/Document.xml')).toBeUndefined();
  });
});
