/**
 * The upload path, which is the most consequential ordering decision in the
 * system.
 *
 * Plan section 4, made literal:
 *
 * ```
 *   check the role -> write files to disk -> sniff every one of them
 *      -> INSERT screening_job + candidates in ONE transaction -> COMMIT
 *      -> enqueue one BullMQ job per NEW candidate -> 202
 * ```
 *
 * Three properties of that order, each of which is the answer to a real failure:
 *
 * 1. **Files before rows.** A crash between the write and the insert leaves an
 *    orphan file, which is harmless. The reverse order leaves a candidate row
 *    pointing at nothing, which is a screening that can never succeed. A failed
 *    insert unlinks best-effort.
 * 2. **Enqueue strictly after COMMIT.** A worker can then never pick up a row
 *    that is not yet visible. The cost, recorded in the plan and again here: a
 *    crash between COMMIT and enqueue leaves candidates in `pending` until
 *    `scripts/reconcileStuck.js` runs, and that script is manual.
 * 3. **All-or-nothing at the HTTP layer, per-candidate afterwards.** A batch with
 *    one unreadable file is rejected whole, with `details.rejected` naming the
 *    bad files - because the recruiter can fix that before spending anything.
 *    Once accepted, one malformed PDF fails one candidate and nothing else.
 *
 * ## `UNSUPPORTED_FILE_TYPE` is a 415 here, and only here
 *
 * Plan section 5.4 is explicit and phase 4 implements it rather than
 * rediscovering it: the worker-side error namespace has no
 * `UNSUPPORTED_FILE_TYPE`, because a file whose bytes we cannot read never
 * becomes a candidate row and so has no `candidates.error_code` to store it in.
 * Phase 3 exports `sniffMimeType` for exactly this. The bytes are sniffed at the
 * upload boundary and a type outside the section 2 allowlist is refused before
 * any row exists.
 *
 * ## Framework-agnostic on purpose
 *
 * This service takes an async iterable of `{ filename, mimeType, file }`, which
 * is a shape a test can build out of `Readable.from(bytes)`. It has never heard
 * of Fastify or of multipart; the controller adapts.
 */

import { AppError } from '../errors/AppError.js';
import { env } from '../config/env.js';
import { withTransaction } from '../db/withTransaction.js';
import { MIME_TYPES, sniffMimeType } from '../extraction/index.js';
import { insertCandidatesIdempotent } from '../repositories/candidatesRepository.js';
import { insertScreeningJob } from '../repositories/screeningJobsRepository.js';
import {
  allocate,
  readStored,
  removeStored,
  renameStored,
  writeStream,
} from '../storage/index.js';
import { enqueueCandidates } from '../queue/screeningQueue.js';
import { assertRoleAcceptsUploads } from './rolesService.js';

/**
 * File extension per sniffed type. Cosmetic - nothing reads it back, the worker
 * sniffs again - but a human browsing `uploads/` should not have to guess.
 *
 * @type {Readonly<Record<string, string>>}
 */
const EXTENSION_BY_MIME = Object.freeze({
  [MIME_TYPES.PDF]: '.pdf',
  [MIME_TYPES.DOCX]: '.docx',
  [MIME_TYPES.TXT]: '.txt',
});

/** The suffix a file wears between being written and being identified. */
const PENDING_SUFFIX = '.upload';

/**
 * Node `fs` errnos that mean the failure was the disk's, not the request's.
 *
 * Listed rather than inferred, because the distinction decides between a 500
 * that says "our problem" and a 4xx that says "yours", and getting it backwards
 * either blames a recruiter for a full disk or hides one behind a 413.
 */
const STORAGE_ERRNOS = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EMFILE', 'ENFILE', 'EIO']);

/**
 * @typedef {object} IncomingFile
 * @property {string} filename as the client named it; stored for display, never
 *   used to build a path
 * @property {string | null} mimeType what the client claimed; recorded, ignored
 * @property {import('node:stream').Readable} file
 *
 * @typedef {object} StoredUpload
 * @property {string} candidateId
 * @property {string} originalFilename
 * @property {string} storagePath
 * @property {string} contentSha256
 * @property {string} mimeType the SNIFFED type
 * @property {number} byteSize
 */

/**
 * Streams one file to disk and identifies it.
 *
 * The two-step - write to `<id>.upload`, read back, sniff, rename - is what
 * keeps peak memory at one file rather than at the whole batch. A DOCX cannot be
 * sniffed from a prefix (the ZIP central directory is at the end), so the bytes
 * have to be complete before the question can be answered, and having them
 * complete on disk is cheaper than having fifty of them complete in memory.
 *
 * The allocation is made by the CALLER and passed in, so that the path is on the
 * caller's cleanup list *before* the first byte is written. Allocating in here
 * would mean a write that fails part-way - a full disk, an oversized part cut
 * off by the multipart limit - leaves a partial file whose path nothing else
 * knows, and an orphan nobody can sweep is worse than an orphan somebody can.
 *
 * @param {IncomingFile} incoming
 * @param {{ candidateId: string, relativePath: string }} allocation
 * @returns {Promise<{ ok: true, stored: StoredUpload } | { ok: false, filename: string, reason: string }>}
 */
async function storeAndIdentify(incoming, { candidateId, relativePath }) {
  const written = await writeStream({ source: incoming.file, relativePath });

  const bytes = await readStored(relativePath);
  const sniffed = sniffMimeType(bytes);

  if (sniffed.mimeType === null) {
    return {
      ok: false,
      filename: incoming.filename,
      // Machine-readable, from the sniffer: `empty_file`, `zip_not_ooxml`,
      // `ooxml_not_wordprocessing`, `unrecognised`, and so on. Safe to return -
      // it is a fact about the file's structure, never about its contents.
      reason: sniffed.reason,
    };
  }

  const finalPath = await renameStored(
    relativePath,
    relativePath.replace(new RegExp(`${PENDING_SUFFIX}$`), EXTENSION_BY_MIME[sniffed.mimeType]),
  );

  return {
    ok: true,
    stored: {
      candidateId,
      originalFilename: incoming.filename,
      storagePath: finalPath,
      contentSha256: written.contentSha256,
      mimeType: sniffed.mimeType,
      byteSize: written.byteSize,
    },
  };
}

/**
 * Collapses files that are byte-identical to each other *within one batch*.
 *
 * The unique constraint handles a duplicate of something already uploaded; it
 * cannot help with two copies of the same CV in one request, because
 * `ON CONFLICT DO NOTHING` would skip the second silently and the response would
 * have nothing to say about it. Collapsing here means the second file gets an
 * honest `duplicate: true`, and its redundant bytes get unlinked.
 *
 * @param {StoredUpload[]} stored
 * @returns {{ unique: StoredUpload[], redundant: StoredUpload[], shaOrder: string[] }}
 */
function collapseWithinBatch(stored) {
  /** @type {Map<string, StoredUpload>} */
  const firstBySha = new Map();
  /** @type {StoredUpload[]} */
  const redundant = [];
  /** @type {string[]} */
  const shaOrder = [];

  for (const upload of stored) {
    shaOrder.push(upload.contentSha256);
    if (firstBySha.has(upload.contentSha256)) {
      redundant.push(upload);
    } else {
      firstBySha.set(upload.contentSha256, upload);
    }
  }

  return { unique: [...firstBySha.values()], redundant, shaOrder };
}

/**
 * Accepts an upload.
 *
 * @param {object} input
 * @param {string} input.roleId
 * @param {AsyncIterable<IncomingFile>} input.files
 * @param {number} [input.maxFiles] defaults to `MAX_BATCH_FILES`; the single-file
 *   endpoint passes 1
 * @param {(input: { candidateIds: string[] }) => Promise<string[]>} [input.enqueue]
 *   injectable, so the whole upload path can be tested against a real Postgres
 *   with no Redis running
 * @param {{ error: Function }} [input.logger]
 * @returns {Promise<{ job: import('../repositories/screeningJobsRepository.js').ScreeningJob,
 *   entries: { candidate: any, created: boolean }[] }>}
 * @throws {AppError} ROLE_NOT_FOUND, ROLE_ARCHIVED, ROLE_NOT_SCOREABLE,
 *   EMPTY_UPLOAD, TOO_MANY_FILES, UNSUPPORTED_FILE_TYPE, STORAGE_WRITE_FAILED
 */
export async function uploadCandidates({
  roleId,
  files,
  maxFiles = env.MAX_BATCH_FILES,
  enqueue = enqueueCandidates,
  logger,
}) {
  // Before a single byte is written. A role that cannot be scored against must
  // not cost the recruiter an upload they will have to repeat.
  await assertRoleAcceptsUploads(roleId);

  /** @type {StoredUpload[]} */
  const stored = [];
  /** @type {{ filename: string, reason: string }[]} */
  const rejected = [];
  /** @type {string[]} */
  const writtenPaths = [];

  try {
    for await (const incoming of files) {
      if (stored.length + rejected.length >= maxFiles) {
        // Drain the part before refusing it. The producer is a multipart parser
        // reading one body: abandoning a part stream mid-flight leaves it
        // waiting for a reader that will never arrive, and the request hangs
        // rather than answering 413. Discarding the bytes costs one pass over a
        // file we are not going to keep.
        incoming.file.resume();
        throw new AppError(
          'TOO_MANY_FILES',
          `Upload at most ${maxFiles} file${maxFiles === 1 ? '' : 's'} at a time.`,
          { details: { maxFiles } },
        );
      }

      // On the cleanup list before a byte is written, so a write that throws
      // part-way still has its partial file swept by the catch below.
      const allocation = allocate(PENDING_SUFFIX);
      writtenPaths.push(allocation.relativePath);

      const result = await storeAndIdentify(incoming, allocation);
      if (result.ok) {
        stored.push(result.stored);
        // The rename moved it, so the final path needs sweeping too. The
        // pre-rename path is left on the list deliberately: unlinking something
        // that is already gone is a no-op, and removing it would mean trusting
        // that the rename happened.
        writtenPaths.push(result.stored.storagePath);
      } else {
        rejected.push({ filename: result.filename, reason: result.reason });
      }
    }
  } catch (error) {
    await discard(writtenPaths);
    if (error instanceof AppError) throw error;

    if (STORAGE_ERRNOS.has(/** @type {any} */ (error)?.code)) {
      // A write that failed for a reason that is ours: a full disk, a read-only
      // mount, a permission problem. The client is told the code and nothing
      // else; the errno is in the log, where it belongs.
      throw new AppError('STORAGE_WRITE_FAILED', 'The upload could not be saved. Try again.', {
        cause: error,
      });
    }

    // Anything else came from the source stream rather than from the disk - an
    // oversized part, a truncated body - and the central error handler owns the
    // translation of those. Swallowing them into STORAGE_WRITE_FAILED would
    // answer 500 for a client mistake and blame the server for it.
    throw error;
  }

  if (stored.length === 0 && rejected.length === 0) {
    throw new AppError('EMPTY_UPLOAD', 'Attach at least one CV file.');
  }

  if (rejected.length > 0) {
    // All-or-nothing: nothing is written, nothing is charged, and the recruiter
    // is told which files to replace.
    await discard(writtenPaths);
    throw new AppError(
      'UNSUPPORTED_FILE_TYPE',
      'Every CV must be a PDF, a Word document or a plain text file.',
      { details: { rejected } },
    );
  }

  const { unique, redundant, shaOrder } = collapseWithinBatch(stored);
  await discard(redundant.map((upload) => upload.storagePath));

  let job;
  /** @type {{ candidate: any, created: boolean }[]} */
  let inserted;
  try {
    ({ job, inserted } = await withTransaction(async (client) => {
      // `file_count` is what the client uploaded, not what became a new
      // candidate. The difference is the duplicate count, and `GET /jobs/:id`
      // reports it rather than leaving the gap to be inferred.
      const screeningJob = await insertScreeningJob(client, {
        roleId,
        fileCount: stored.length,
      });

      const rows = await insertCandidatesIdempotent(client, {
        roleId,
        jobId: screeningJob.id,
        candidates: unique.map((upload) => ({
          id: upload.candidateId,
          originalFilename: upload.originalFilename,
          storagePath: upload.storagePath,
          contentSha256: upload.contentSha256,
          mimeType: upload.mimeType,
          byteSize: upload.byteSize,
        })),
      });

      return { job: screeningJob, inserted: rows };
    }));
  } catch (error) {
    await discard(writtenPaths);
    throw error;
  }

  // Everything below this line runs after COMMIT.

  const byCandidateSha = new Map(
    inserted.map((entry) => [entry.candidate.contentSha256, entry]),
  );

  // A duplicate kept the storage path of the candidate that already existed, so
  // the bytes this request wrote are an orphan. Unlink them: the same CV twice
  // should not cost twice the disk.
  await discard(
    unique
      .filter((upload) => byCandidateSha.get(upload.contentSha256)?.created === false)
      .map((upload) => upload.storagePath),
  );

  const newCandidateIds = inserted
    .filter((entry) => entry.created)
    .map((entry) => entry.candidate.id);

  try {
    await enqueue({ candidateIds: newCandidateIds });
  } catch (error) {
    // The candidates are committed and `pending`. The upload succeeded; what
    // failed is the notification. Returning a 500 here would tell the recruiter
    // to upload again, which would be wrong - the CVs are recorded, and
    // `reconcileStuck.js` re-enqueues anything stranded.
    logger?.error({ err: error, jobId: job.id, count: newCandidateIds.length }, 'enqueue failed after commit');
  }

  return {
    job,
    // One entry per uploaded file, in upload order, including files collapsed
    // within the batch - so a caller can line the response up with what it sent.
    entries: shaOrder.map((sha, index) => {
      const entry = /** @type {{ candidate: any, created: boolean }} */ (byCandidateSha.get(sha));
      const isFirstOccurrence = shaOrder.indexOf(sha) === index;
      return { candidate: entry.candidate, created: entry.created && isFirstOccurrence };
    }),
  };
}

/**
 * Unlinks a set of files, best effort, never throwing.
 *
 * @param {string[]} relativePaths
 * @returns {Promise<void>}
 */
async function discard(relativePaths) {
  await Promise.all(relativePaths.map((relativePath) => removeStored(relativePath)));
}
