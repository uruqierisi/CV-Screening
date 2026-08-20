/**
 * Uploaded CVs on local disk.
 *
 * The one module that knows `UPLOAD_ROOT` exists. Everything above it deals in
 * relative storage paths, which is what `candidates.storage_path` stores, so the
 * root can move between deployments without a data migration.
 *
 * Plan section 8 records the limit this design accepts: **the API and the worker
 * must share a filesystem.** It does not scale horizontally as written, and S3
 * is the answer the day it needs two nodes. The interface below is the seam that
 * makes that a swap rather than a rewrite - four functions, none of which leaks a
 * `fs` type.
 *
 * ## Two properties worth stating
 *
 * **The path is derived from the candidate id, never from the filename.** A
 * filename is attacker-controlled, arrives with whatever separators and dots the
 * client felt like, and is stored on the row for display only. Deriving the path
 * from a UUID we generated makes path traversal impossible by construction
 * rather than by sanitising - there is nothing of the client's in the path at
 * all.
 *
 * **Files are written before the candidate row exists** (plan section 4). A
 * crash in that window leaves an orphan file, which is harmless and sweepable;
 * the reverse order leaves a candidate row pointing at nothing, which is a
 * failed screening. A failed insert unlinks best-effort.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { env } from '../config/env.js';

/** Absolute root, resolved once. Relative values in `.env` follow the process cwd. */
export const uploadRoot = path.resolve(env.UPLOAD_ROOT);

/**
 * Where one candidate's file lives, relative to the root.
 *
 * Two levels of fan-out from the first four hex characters of the id. A single
 * flat directory with a hundred thousand entries is slow to list and unpleasant
 * on most filesystems; the id is a UUID, so the prefix is uniformly distributed
 * and needs no other balancing.
 *
 * The extension comes from the **sniffed** MIME type, never from the client's
 * filename, so a `.exe` named `cv.pdf` cannot be written as either.
 *
 * @param {{ candidateId: string, extension: string }} input
 * @returns {string} POSIX-separated, relative; never absolute, never with a `..`
 */
export function storagePathFor({ candidateId, extension }) {
  const a = candidateId.slice(0, 2);
  const b = candidateId.slice(2, 4);
  return `${a}/${b}/${candidateId}${extension}`;
}

/**
 * Turns a relative storage path into an absolute one.
 *
 * @param {string} relativePath
 * @returns {string}
 */
export function absolutePathFor(relativePath) {
  return path.join(uploadRoot, relativePath);
}

/**
 * Streams a readable into the store, hashing as it goes.
 *
 * Hash and write in one pass, deliberately: the alternative is buffering the
 * whole file to hash it, which turns a 50-file batch into 50 files' worth of
 * resident memory. The `Transform` here is a tee, not a filter - it passes every
 * chunk through untouched.
 *
 * The caller owns the size limit. `@fastify/multipart` enforces it on the source
 * stream and destroys it, which surfaces here as a rejected pipeline rather than
 * a truncated file.
 *
 * @param {object} input
 * @param {import('node:stream').Readable} input.source
 * @param {string} input.relativePath from {@link storagePathFor}
 * @returns {Promise<{ relativePath: string, contentSha256: string, byteSize: number }>}
 */
export async function writeStream({ source, relativePath }) {
  const destination = absolutePathFor(relativePath);
  await mkdir(path.dirname(destination), { recursive: true });

  const hash = createHash('sha256');
  let byteSize = 0;

  const tee = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      byteSize += chunk.length;
      callback(null, chunk);
    },
  });

  await pipeline(source, tee, createWriteStream(destination));

  return { relativePath, contentSha256: hash.digest('hex'), byteSize };
}

/**
 * Reads a stored file back.
 *
 * @param {string} relativePath
 * @returns {Promise<Buffer>}
 * @throws the underlying `ENOENT` when the file is gone; the caller decides
 *   whether that is a 410 or a candidate failure, which are different answers
 */
export async function readStored(relativePath) {
  return readFile(absolutePathFor(relativePath));
}

/**
 * @param {string} relativePath
 * @returns {Promise<boolean>}
 */
export async function storedFileExists(relativePath) {
  try {
    const stats = await stat(absolutePathFor(relativePath));
    return stats.isFile();
  } catch {
    // Any failure to stat is "not usable". Distinguishing ENOENT from EACCES
    // would give the caller a choice it has no different answer for: either way
    // the source file cannot be screened.
    return false;
  }
}

/**
 * Deletes a stored file, best effort.
 *
 * Used on two paths, both of which have already decided the file is not wanted:
 * a failed insert, and a duplicate upload whose bytes we already have under
 * another candidate. A failure to delete leaves an orphan, and an orphan is
 * harmless - so this never throws and never turns a successful upload into a
 * failed one.
 *
 * @param {string} relativePath
 * @returns {Promise<boolean>} whether it went away
 */
export async function removeStored(relativePath) {
  try {
    await rm(absolutePathFor(relativePath), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves a stored file to a different relative path.
 *
 * Used once, on the upload path: the bytes have to be on disk before they can be
 * sniffed, and the file extension is decided by what the sniff says rather than
 * by what the client named the file. So the write lands on a neutral
 * `.upload` suffix and this puts it where it belongs. Same directory, so it is a
 * rename rather than a copy.
 *
 * @param {string} fromRelativePath
 * @param {string} toRelativePath
 * @returns {Promise<string>} `toRelativePath`
 */
export async function renameStored(fromRelativePath, toRelativePath) {
  const destination = absolutePathFor(toRelativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(absolutePathFor(fromRelativePath), destination);
  return toRelativePath;
}

/**
 * A new candidate id and the path its file will be written to.
 *
 * The id is generated here, before the row exists, because the path depends on
 * it and the file is written first. `insertCandidates` accepts the id for
 * exactly this reason.
 *
 * @param {string} extension including the dot
 * @returns {{ candidateId: string, relativePath: string }}
 */
export function allocate(extension) {
  const candidateId = randomUUID();
  return { candidateId, relativePath: storagePathFor({ candidateId, extension }) };
}
