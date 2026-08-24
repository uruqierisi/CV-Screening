/**
 * Uploaded CVs in S3-compatible object storage.
 *
 * The second implementation of the contract `localDisk.js` defines, added
 * because a deployment that runs the API and the worker as separate processes
 * gives them separate filesystems - and `candidates.storage_path` written by one
 * is then unreadable by the other. `localDisk.js` predicted this in its own
 * header ("S3 is the answer the day it needs two nodes"); this is that day.
 *
 * ## It composes the local adapter rather than replacing it
 *
 * Every byte still lands on local disk first, at exactly the path
 * `localDisk.js` would have used, and is hashed by exactly the same single-pass
 * stream. That is deliberate and it is the whole design:
 *
 * ```
 *   writeStream   -> local disk (staging), hashed in one pass
 *   readStored    -> staging if it is still there, otherwise GET
 *   renameStored  -> ONE PutObject, then unlink the staged file
 * ```
 *
 * The alternative - PUT on write, GET to sniff, CopyObject to rename, Delete the
 * original - is four network round trips per file and downloads every CV back
 * out of the bucket in order to look at its first eight bytes. This is one round
 * trip, and the file the sniffer reads is the one already on the local disk.
 *
 * Local disk is used as **scratch only**. Nothing here depends on it surviving a
 * restart: a staged file is written, read, and either uploaded or discarded
 * inside a single HTTP request. A process that dies mid-request leaves a staged
 * orphan on an ephemeral disk, which is the same harmless outcome
 * `uploadsService.js` already reasons about.
 *
 * ## What the two adapters do NOT differ on
 *
 * `storagePathFor` and `allocate` are pure and stay in `localDisk.js`. The
 * relative path is the same string in both worlds - a POSIX-separated key - so
 * switching drivers needs no data migration and `candidates.storage_path` did
 * not have to change.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { env } from '../config/env.js';
import {
  absolutePathFor,
  readStored as readStaged,
  removeStored as removeStaged,
  storedFileExists as stagedFileExists,
  writeStream as writeStaged,
} from './localDisk.js';

/** @type {S3Client | null} */
let client = null;

/**
 * The shared client, built lazily.
 *
 * Lazy for the same reason the Redis connection is: `src/config/env.js` is
 * imported by `npm run migrate` and by the whole unit suite, and none of those
 * should need object-storage credentials to exist. A driver of `local` never
 * reaches this function at all.
 *
 * @returns {S3Client}
 */
export function s3Client() {
  if (client === null) {
    client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      // Path style addresses the bucket as `<endpoint>/<bucket>/<key>` rather
      // than folding it into the hostname. Backblaze B2 and Cloudflare R2 both
      // accept it; virtual-hosted style needs per-provider hostname rules and
      // breaks outright on bucket names that are not DNS-safe. Overridable
      // because AWS proper has deprecated it.
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: /** @type {string} */ (env.S3_ACCESS_KEY_ID),
        secretAccessKey: /** @type {string} */ (env.S3_SECRET_ACCESS_KEY),
      },
    });
  }
  return client;
}

/**
 * Closes the shared client, if one was ever built.
 *
 * @returns {Promise<void>}
 */
export async function closeStorage() {
  if (client === null) return;
  const current = client;
  client = null;
  current.destroy();
}

/**
 * True when an S3 error means "that key is not there".
 *
 * The SDK reports a missing key in more than one way depending on whether the
 * verb was HEAD or GET and on which S3 implementation answered, so the check is
 * a union rather than a single equality. Anything else is rethrown: a
 * permissions failure must never be reported as an absent file, because the
 * caller's answer to "absent" is to fail the candidate permanently.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isNotFound(error) {
  const status = /** @type {any} */ (error)?.$metadata?.httpStatusCode;
  const name = /** @type {any} */ (error)?.name;
  return status === 404 || name === 'NoSuchKey' || name === 'NotFound';
}

/**
 * An error shaped like the one `node:fs` throws for a missing file.
 *
 * `screenCandidate.processor.js` branches on `error.code === 'ENOENT'` to raise
 * `MissingSourceFileError`, and that branch is the difference between "this
 * candidate's file is gone, fail it permanently and tell the recruiter to
 * upload again" and an unrecognised 500. Rather than teach the processor a
 * second vocabulary, this adapter speaks the one it already knows.
 *
 * @param {string} relativePath
 * @returns {Error & { code: string }}
 */
function enoent(relativePath) {
  const error = /** @type {Error & { code: string }} */ (
    new Error(`no such object: ${relativePath}`)
  );
  error.code = 'ENOENT';
  return error;
}

/**
 * Streams a readable into staging, hashing as it goes.
 *
 * Identical to the local adapter, because it *is* the local adapter. Nothing is
 * uploaded here: the bytes have to be complete and sniffable before we know what
 * extension the object should carry, and paying for a PUT under a name we are
 * about to change is a wasted round trip.
 *
 * @param {object} input
 * @param {import('node:stream').Readable} input.source
 * @param {string} input.relativePath
 * @returns {Promise<{ relativePath: string, contentSha256: string, byteSize: number }>}
 */
export async function writeStream({ source, relativePath }) {
  return writeStaged({ source, relativePath });
}

/**
 * Reads a stored file back.
 *
 * Staging first. During an upload the file is still on local disk and has not
 * been published yet, so the sniffer's read costs nothing and no network call is
 * made; after {@link renameStored} the staged copy is gone and this falls
 * through to the bucket, which is the path the worker takes.
 *
 * @param {string} relativePath
 * @returns {Promise<Buffer>}
 * @throws an `ENOENT`-coded error when the object is not there
 */
export async function readStored(relativePath) {
  if (await stagedFileExists(relativePath)) {
    return readStaged(relativePath);
  }

  try {
    const response = await s3Client().send(
      new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: relativePath }),
    );
    const body = /** @type {any} */ (response).Body;
    return Buffer.from(await body.transformToByteArray());
  } catch (error) {
    if (isNotFound(error)) throw enoent(relativePath);
    throw error;
  }
}

/**
 * @param {string} relativePath
 * @returns {Promise<boolean>}
 */
export async function storedFileExists(relativePath) {
  if (await stagedFileExists(relativePath)) return true;

  try {
    await s3Client().send(
      new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: relativePath }),
    );
    return true;
  } catch {
    // Any failure to HEAD is "not usable", matching the local adapter's
    // reasoning exactly: distinguishing a missing key from a denied one would
    // give the caller a choice it has no different answer for.
    return false;
  }
}

/**
 * Deletes a stored file, best effort, from both staging and the bucket.
 *
 * Both, unconditionally, because the callers - a failed insert, a duplicate
 * upload, a rejected batch - do not know and should not have to know which side
 * of {@link renameStored} the file is on. Never throws: an orphan is harmless,
 * and a failed cleanup must not turn a successful upload into a failed one.
 *
 * @param {string} relativePath
 * @returns {Promise<boolean>} whether it went away
 */
export async function removeStored(relativePath) {
  await removeStaged(relativePath);

  try {
    await s3Client().send(
      new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: relativePath }),
    );
    return true;
  } catch (error) {
    // S3 delete is idempotent and answers success for a key that was never
    // there, so a not-found is still "it went away" by the contract's own
    // definition. Anything else failed, and the caller is told so.
    return isNotFound(error);
  }
}

/**
 * Publishes a staged file to the bucket under its final key.
 *
 * This is the upload. `uploadsService.js` calls it once per file, immediately
 * after the sniffer has decided the extension, which is why the single PUT lands
 * under the right name the first time and no CopyObject is ever needed.
 *
 * The body is a `createReadStream` with an explicit `ContentLength` from `stat`.
 * Both parts matter: a stream keeps peak memory at a buffer rather than at the
 * whole file, and a single-part PUT requires a known length - without it the SDK
 * buffers the stream in order to measure it, which is the memory cost the
 * streaming was for.
 *
 * @param {string} fromRelativePath the staged path
 * @param {string} toRelativePath the final key
 * @returns {Promise<string>} `toRelativePath`
 */
export async function renameStored(fromRelativePath, toRelativePath) {
  const staged = absolutePathFor(fromRelativePath);
  const { size } = await stat(staged);

  await s3Client().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: toRelativePath,
      Body: createReadStream(staged),
      ContentLength: size,
    }),
  );

  // Only after the PUT resolves. Unlinking first would mean a failed upload
  // leaves neither a staged file nor an object, and the candidate row that is
  // about to be inserted would point at nothing.
  await removeStaged(fromRelativePath);

  return toRelativePath;
}
