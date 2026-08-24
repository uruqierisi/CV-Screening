import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The behaviour every storage adapter must have, written once.
 *
 * There are two implementations - local disk and S3-compatible object storage -
 * and the whole point of the seam is that `uploadsService.js`,
 * `candidatesService.js` and the worker's processor cannot tell them apart. That
 * claim is only worth anything if it is asserted against both, so the assertions
 * live here and each adapter's test file runs them.
 *
 * What is deliberately NOT here: `storagePathFor`, `allocate`, `absolutePathFor`
 * and `uploadRoot`. Those are pure, they live in `localDisk.js`, and both
 * drivers share the identical implementation - there is nothing to vary and
 * therefore nothing to parameterise. They keep their own tests in
 * `storage.test.js`.
 *
 * Four of these assertions encode a decision rather than a mechanism, and those
 * are the ones that would break a caller if an adapter disagreed:
 *
 * - a missing file throws with `code === 'ENOENT'`, because the worker branches
 *   on exactly that to raise `MissingSourceFileError`;
 * - `storedFileExists` never throws, because the retry endpoint calls it to
 *   decide between a 410 and a screening;
 * - `removeStored` never throws, because both callers have already decided the
 *   file is unwanted and an orphan is harmless;
 * - the hash is of the bytes as written, computed in the same pass.
 *
 * @param {string} name shown in the test output
 * @param {any} adapter the module under test
 * @param {{ allocate: (extension: string) => { candidateId: string, relativePath: string } }} helpers
 */
export function describeStorageContract(name, adapter, helpers) {
  describe(`${name}: the storage contract`, () => {
    /** Every path this suite wrote, so cleanup is exact rather than a wipe. */
    const written = [];

    /** @param {string} extension */
    function allocateTracked(extension) {
      const allocation = helpers.allocate(extension);
      written.push(allocation.relativePath);
      return allocation;
    }

    afterAll(async () => {
      await Promise.all(written.map((relativePath) => adapter.removeStored(relativePath)));
    });

    /**
     * A path that no adapter has ever written. Randomised per call so a bucket
     * left dirty by an interrupted run cannot make this pass by accident.
     */
    const missingPath = () => `zz/zz/${randomUUID()}-never-written.pdf`;

    describe('writeStream', () => {
      it('writes the bytes and hashes them in the same pass', async () => {
        const bytes = Buffer.from('Jane Doe\nSenior Backend Engineer\n', 'utf8');
        const { relativePath } = allocateTracked('.txt');

        const result = await adapter.writeStream({ source: Readable.from(bytes), relativePath });

        expect(result.byteSize).toBe(bytes.length);
        expect(result.contentSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
        expect(await adapter.readStored(relativePath)).toEqual(bytes);
      });

      it('makes the written file readable back immediately', async () => {
        const { relativePath } = allocateTracked('.txt');
        await adapter.writeStream({ source: Readable.from(Buffer.from('x')), relativePath });
        expect(await adapter.storedFileExists(relativePath)).toBe(true);
      });

      it('hashes an empty file rather than failing on it', async () => {
        // An empty upload is refused as UNSUPPORTED_FILE_TYPE by the sniffer,
        // which runs after this. Storage should not have its own opinion.
        const { relativePath } = allocateTracked('.txt');
        const result = await adapter.writeStream({ source: Readable.from([]), relativePath });

        expect(result.byteSize).toBe(0);
        expect(result.contentSha256).toBe(
          createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
        );
      });

      it('round-trips bytes that are not text', async () => {
        // The real payloads are PDFs and DOCXs. An adapter that quietly applied
        // an encoding somewhere would pass every string-based assertion above
        // and corrupt every actual CV.
        const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80, 0x0a]);
        const { relativePath } = allocateTracked('.pdf');

        await adapter.writeStream({ source: Readable.from(bytes), relativePath });

        expect(await adapter.readStored(relativePath)).toEqual(bytes);
      });
    });

    describe('renameStored', () => {
      it('moves a file to the extension the sniffer chose', async () => {
        const { relativePath } = allocateTracked('.upload');
        await adapter.writeStream({
          source: Readable.from(Buffer.from('%PDF-1.4')),
          relativePath,
        });

        const finalPath = relativePath.replace(/\.upload$/, '.pdf');
        written.push(finalPath);

        expect(await adapter.renameStored(relativePath, finalPath)).toBe(finalPath);
        expect(await adapter.storedFileExists(relativePath)).toBe(false);
        expect(await adapter.storedFileExists(finalPath)).toBe(true);
      });

      it('preserves the bytes across the move', async () => {
        // The S3 adapter publishes on rename rather than on write, so this is
        // the assertion that the upload actually carried the file rather than
        // creating an empty key.
        const bytes = Buffer.from('%PDF-1.4\nstream contents\n', 'utf8');
        const { relativePath } = allocateTracked('.upload');
        await adapter.writeStream({ source: Readable.from(bytes), relativePath });

        const finalPath = relativePath.replace(/\.upload$/, '.pdf');
        written.push(finalPath);
        await adapter.renameStored(relativePath, finalPath);

        expect(await adapter.readStored(finalPath)).toEqual(bytes);
      });
    });

    describe('storedFileExists', () => {
      it('is false for a path that was never written, and does not throw', async () => {
        // The retry endpoint calls this to choose between a 410 and spending
        // money. A throw here would become a 500 on a question with a perfectly
        // good answer.
        expect(await adapter.storedFileExists(missingPath())).toBe(false);
      });
    });

    describe('removeStored', () => {
      it('deletes a file and reports success', async () => {
        const { relativePath } = allocateTracked('.txt');
        await adapter.writeStream({ source: Readable.from(Buffer.from('x')), relativePath });

        expect(await adapter.removeStored(relativePath)).toBe(true);
        expect(await adapter.storedFileExists(relativePath)).toBe(false);
      });

      it('is a no-op on a file that is already gone', async () => {
        // Both callers have already decided the file is not wanted; an orphan is
        // harmless, and a throw here would turn a successful upload into a
        // failed one.
        expect(await adapter.removeStored(missingPath())).toBe(true);
      });
    });

    describe('readStored', () => {
      it('throws ENOENT for a missing file, so the caller can decide what that means', async () => {
        // A 410 at the retry endpoint and a candidate failure in the worker are
        // different answers to the same fact, so this layer does not choose.
        // The worker branches on this exact `code`, which is why the S3 adapter
        // translates a 404 into it rather than inventing its own vocabulary.
        await expect(adapter.readStored(missingPath())).rejects.toMatchObject({
          code: 'ENOENT',
        });
      });
    });
  });
}
