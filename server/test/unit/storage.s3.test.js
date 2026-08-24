import { describe, it } from 'vitest';
import { describeStorageContract } from './storageContract.js';
import { allocate } from '../../src/storage/localDisk.js';

/**
 * The S3 adapter, held to exactly the same contract as local disk.
 *
 * ## This suite skips unless a bucket is configured, and that is a real gap
 *
 * Stated plainly rather than buried: **on a machine with no S3 credentials this
 * file asserts nothing.** `npm test` on a fresh clone runs the contract against
 * local disk only, and a regression in `src/storage/s3.js` would not be caught.
 *
 * The alternative was considered and rejected. Standing up an in-memory fake S3
 * would let this run everywhere, but it would test the adapter against a mock of
 * S3's semantics written by the same person who wrote the adapter - and the
 * failures worth catching here are precisely the ones where a real provider
 * disagrees with that mental model: how B2 reports a missing key on HEAD versus
 * GET, whether a delete of an absent key is an error, whether a single-part PUT
 * needs a declared `ContentLength`. A mock that got those right would be a mock
 * written by someone who did not need the test.
 *
 * So the honest arrangement is: the contract runs against the real thing, and it
 * runs when a real thing is configured. Deployment step for B2 is one command:
 *
 * ```sh
 * STORAGE_DRIVER=s3 \
 * S3_BUCKET=... S3_ENDPOINT=https://s3.<region>.backblazeb2.com \
 * S3_REGION=<region> S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
 *   npx vitest run --project unit test/unit/storage.s3.test.js
 * ```
 *
 * It costs a handful of Class A/B/C transactions - comfortably inside B2's free
 * daily allowance - and it is the check that the bucket, the endpoint, the
 * region and the key permissions are all actually right, which is worth far more
 * than a green tick from a fake.
 *
 * The suite writes under freshly generated UUIDs and deletes everything it wrote
 * in `afterAll`, so it is safe to point at the deployment's own bucket.
 */

const CONFIGURED = Boolean(
  process.env.S3_BUCKET &&
    process.env.S3_ENDPOINT &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY,
);

if (CONFIGURED) {
  // Imported lazily and only when configured: `src/storage/s3.js` reads
  // `env.S3_*` at module scope, and importing it unconfigured would be a
  // startup failure in a suite that is supposed to skip.
  const s3 = await import('../../src/storage/s3.js');

  describeStorageContract('s3', s3, { allocate });
} else {
  describe('s3: the storage contract', () => {
    it.skip('needs S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY', () => {});
  });
}
