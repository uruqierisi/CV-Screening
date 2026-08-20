import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../src/app.js';
import { removeStored } from '../../src/storage/localDisk.js';
import { pool } from '../../src/db/pool.js';

/**
 * API test scaffolding.
 *
 * Two things: an app built with a **recording queue** instead of a real one, and
 * a hand-rolled multipart body.
 *
 * The recording queue is the point. Plan section 4's ordering - role checks,
 * files to disk, one transaction, COMMIT, then enqueue - is the whole of what
 * the upload endpoint is for, and none of it needs a Redis to be true. So the
 * API suite injects a fake here and asserts *what would have been enqueued*,
 * and the queue gets its own test in `test/queue/` where the thing under test is
 * actually BullMQ.
 *
 * The multipart body is hand-rolled rather than pulled from a package: it is
 * twenty lines, it is only ever built by this file, and adding a dependency to
 * produce a fixed byte string would be a dependency to justify.
 */

const FIXTURE_DIR = fileURLToPath(new URL('../extraction/fixtures/documents/', import.meta.url));

/**
 * Records every enqueue instead of performing one.
 *
 * @returns {{ batches: string[][], singles: { candidateId: string, attempt?: number }[],
 *   ids: () => string[], enqueueCandidate: Function, enqueueCandidates: Function,
 *   failNext: (error: Error) => void }}
 */
export function recordingQueue() {
  /** @type {string[][]} */
  const batches = [];
  /** @type {{ candidateId: string, attempt?: number }[]} */
  const singles = [];
  /** @type {Error | null} */
  let nextError = null;

  return {
    batches,
    singles,
    ids: () => batches.flat(),
    failNext(error) {
      nextError = error;
    },
    async enqueueCandidates({ candidateIds }) {
      if (nextError !== null) {
        const error = nextError;
        nextError = null;
        throw error;
      }
      batches.push([...candidateIds]);
      return [...candidateIds];
    },
    async enqueueCandidate({ candidateId, attempt }) {
      if (nextError !== null) {
        const error = nextError;
        nextError = null;
        throw error;
      }
      singles.push({ candidateId, attempt });
      return attempt === undefined ? candidateId : `${candidateId}-retry-${attempt}`;
    },
  };
}

/**
 * A Fastify instance with logging off and the queue injected.
 *
 * @param {{ queue?: any }} [options]
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export function buildTestApp({ queue } = {}) {
  return buildApp({ logger: false, queue: queue ?? recordingQueue() });
}

/**
 * Reads one of phase 3's committed document fixtures.
 *
 * Real bytes, deliberately: the upload path sniffs, and a hand-made buffer that
 * merely starts with `%PDF-` would prove nothing about the DOCX branch.
 *
 * @param {'clean.pdf' | 'cv.docx' | 'cv.txt' | 'scanned.pdf' | 'two-column.pdf'} name
 * @returns {Promise<Buffer>}
 */
export function fixtureBytes(name) {
  return readFile(path.join(FIXTURE_DIR, name));
}

/**
 * @typedef {object} MultipartFile
 * @property {string} filename
 * @property {Buffer} content
 * @property {string} [contentType] what the client *claims*; the server sniffs
 */

/**
 * Builds a `multipart/form-data` body.
 *
 * @param {MultipartFile[]} files
 * @returns {{ payload: Buffer, headers: Record<string, string> }}
 */
export function multipartBody(files) {
  const boundary = `----vitest${Math.random().toString(16).slice(2)}`;
  /** @type {Buffer[]} */
  const parts = [];

  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        'utf8',
      ),
      file.content,
      Buffer.from('\r\n', 'utf8'),
    );
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/**
 * Deletes every file an upload wrote, so a test run does not accumulate CVs.
 *
 * Reads the paths back from the rows rather than guessing them, which also means
 * a test that never wrote a file cleans nothing.
 *
 * @returns {Promise<void>}
 */
export async function removeUploadedFiles() {
  const { rows } = await pool.query('SELECT storage_path FROM candidates');
  await Promise.all(rows.map((row) => removeStored(row.storage_path)));
}
