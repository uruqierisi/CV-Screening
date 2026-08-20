import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  fixtureBytes,
  multipartBody,
  recordingQueue,
  removeUploadedFiles,
} from '../helpers/api.js';
import { pool, truncateAll } from '../helpers/database.js';
import { readdir } from 'node:fs/promises';
import { storedFileExists, uploadRoot } from '../../src/storage/localDisk.js';
import { env } from '../../src/config/env.js';
import { createRole } from '../helpers/fixtures.js';

/**
 * The upload path: plan section 4's ordering, and phase 4's idempotency
 * reversal.
 *
 * The queue is injected (see `test/helpers/api.js`), so what is under test here
 * is everything the API is actually responsible for - the role checks, the
 * sniffing, the files on disk, the one transaction, and *what would have been
 * enqueued after COMMIT*. BullMQ gets its own test where BullMQ is the subject.
 */

/** @type {import('fastify').FastifyInstance} */
let app;
/** @type {ReturnType<typeof recordingQueue>} */
let queue;
/** @type {Buffer} */
let pdf;
/** @type {Buffer} */
let docx;
/** @type {Buffer} */
let txt;

beforeEach(async () => {
  await truncateAll();
  queue = recordingQueue();
  app = await buildTestApp({ queue });
  [pdf, docx, txt] = await Promise.all([
    fixtureBytes('clean.pdf'),
    fixtureBytes('cv.docx'),
    fixtureBytes('cv.txt'),
  ]);
});

afterEach(async () => {
  await removeUploadedFiles();
});

afterAll(async () => {
  await pool.end();
});

/**
 * Every file currently under the upload root.
 *
 * Counted from the filesystem rather than from the rows, because the whole point
 * of the assertions that use it is to catch a file the rows do NOT know about.
 *
 * @returns {Promise<number>}
 */
async function uploadedFileCount() {
  const entries = await readdir(uploadRoot, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).length;
}

/**
 * @param {string} roleId
 * @param {Parameters<typeof multipartBody>[0]} files
 * @param {{ batch?: boolean }} [options]
 */
function upload(roleId, files, { batch = false } = {}) {
  const { payload, headers } = multipartBody(files);
  return app.inject({
    method: 'POST',
    url: `/api/v1/roles/${roleId}/candidates${batch ? '/batch' : ''}`,
    headers,
    payload,
  });
}

describe('POST /roles/:roleId/candidates', () => {
  it('accepts one CV, returns 202 with a job id, and enqueues after commit', async () => {
    const { role } = await createRole();

    const response = await upload(role.id, [{ filename: 'jane.pdf', content: pdf }]);

    expect(response.statusCode).toBe(202);
    const { data, meta } = response.json();
    expect(data.roleId).toBe(role.id);
    expect(data.candidates).toHaveLength(1);
    expect(data.candidates[0]).toMatchObject({
      originalFilename: 'jane.pdf',
      status: 'pending',
      duplicate: false,
    });
    expect(meta).toEqual({ fileCount: 1, created: 1, duplicates: 0 });

    // Enqueue happens strictly after COMMIT, so the row is visible before any
    // worker could pick it up. The row existing here is the observable half.
    const { rows } = await pool.query('SELECT status FROM candidates WHERE id = $1', [
      data.candidates[0].id,
    ]);
    expect(rows[0].status).toBe('pending');
    expect(queue.ids()).toEqual([data.candidates[0].id]);
  });

  it('creates a screening job of size 1, so the dashboard has one polling shape', async () => {
    const { role } = await createRole();
    const response = await upload(role.id, [{ filename: 'jane.pdf', content: pdf }]);

    const { rows } = await pool.query('SELECT file_count FROM screening_jobs WHERE id = $1', [
      response.json().data.jobId,
    ]);
    expect(rows[0].file_count).toBe(1);
  });

  it('writes the file under a path derived from the candidate id, not the filename', async () => {
    const { role } = await createRole();
    const response = await upload(role.id, [
      { filename: '../../etc/passwd', content: pdf, contentType: 'application/pdf' },
    ]);

    const candidateId = response.json().data.candidates[0].id;
    const { rows } = await pool.query('SELECT storage_path FROM candidates WHERE id = $1', [
      candidateId,
    ]);

    expect(rows[0].storage_path).toContain(candidateId);
    expect(rows[0].storage_path).not.toContain('..');
    expect(rows[0].storage_path).not.toContain('passwd');
    expect(await storedFileExists(rows[0].storage_path)).toBe(true);
  });

  it('stores the sniffed type, not the type the client claimed', async () => {
    const { role } = await createRole();
    // A DOCX uploaded as application/pdf. Extracted as a DOCX rather than
    // rejected: the mismatch is a log line, not a rejection.
    const response = await upload(role.id, [
      { filename: 'jane.pdf', content: docx, contentType: 'application/pdf' },
    ]);

    const { rows } = await pool.query('SELECT mime_type FROM candidates WHERE id = $1', [
      response.json().data.candidates[0].id,
    ]);
    expect(rows[0].mime_type).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('refuses a second file with 413 TOO_MANY_FILES', async () => {
    const { role } = await createRole();
    const response = await upload(role.id, [
      { filename: 'a.pdf', content: pdf },
      { filename: 'b.txt', content: txt },
    ]);

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('TOO_MANY_FILES');
  });
});

describe('POST /roles/:roleId/candidates/batch', () => {
  it('accepts a mixed batch and enqueues every new candidate', async () => {
    const { role } = await createRole();

    const response = await upload(
      role.id,
      [
        { filename: 'a.pdf', content: pdf },
        { filename: 'b.docx', content: docx },
        { filename: 'c.txt', content: txt },
      ],
      { batch: true },
    );

    expect(response.statusCode).toBe(202);
    const { data, meta } = response.json();
    expect(data.candidates).toHaveLength(3);
    expect(meta).toEqual({ fileCount: 3, created: 3, duplicates: 0 });
    expect(queue.ids()).toEqual(data.candidates.map((c) => c.id));
  });

  it('returns the candidates in upload order', async () => {
    const { role } = await createRole();
    const response = await upload(
      role.id,
      [
        { filename: 'first.pdf', content: pdf },
        { filename: 'second.docx', content: docx },
        { filename: 'third.txt', content: txt },
      ],
      { batch: true },
    );

    expect(response.json().data.candidates.map((c) => c.originalFilename)).toEqual([
      'first.pdf',
      'second.docx',
      'third.txt',
    ]);
  });
});

describe('upload idempotency on (role_id, content_sha256)', () => {
  it('returns the existing candidate for a duplicate, and enqueues nothing new', async () => {
    const { role } = await createRole();

    const first = await upload(role.id, [{ filename: 'jane.pdf', content: pdf }]);
    const firstId = first.json().data.candidates[0].id;

    const second = await upload(role.id, [{ filename: 'jane-copy.pdf', content: pdf }]);

    // Same bytes, same role, same candidate. No 409: a double-clicked button
    // should not look broken, and re-screening a failed candidate is the retry
    // endpoint's job.
    expect(second.statusCode).toBe(202);
    expect(second.json().data.candidates[0].id).toBe(firstId);
    expect(second.json().data.candidates[0].duplicate).toBe(true);
    expect(second.json().meta).toEqual({ fileCount: 1, created: 0, duplicates: 1 });

    // No second LLM spend.
    expect(queue.batches).toEqual([[firstId], []]);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM candidates');
    expect(rows[0].n).toBe(1);
  });

  it('keeps the original filename, because the candidate is the original one', async () => {
    const { role } = await createRole();
    await upload(role.id, [{ filename: 'jane.pdf', content: pdf }]);
    const second = await upload(role.id, [{ filename: 'jane-copy.pdf', content: pdf }]);

    expect(second.json().data.candidates[0].originalFilename).toBe('jane.pdf');
  });

  it('unlinks the redundant bytes rather than storing the same CV twice', async () => {
    const { role } = await createRole();
    await upload(role.id, [{ filename: 'jane.pdf', content: pdf }]);
    await upload(role.id, [{ filename: 'jane-copy.pdf', content: pdf }]);

    const { rows } = await pool.query('SELECT storage_path FROM candidates');
    expect(rows).toHaveLength(1);
    expect(await storedFileExists(rows[0].storage_path)).toBe(true);
  });

  it('treats the same CV against a DIFFERENT role as a new candidate', async () => {
    const first = await createRole({ title: 'Backend' });
    const second = await createRole({ title: 'Frontend' });

    const a = await upload(first.role.id, [{ filename: 'jane.pdf', content: pdf }]);
    const b = await upload(second.role.id, [{ filename: 'jane.pdf', content: pdf }]);

    // The constraint is per role, on purpose: the same person applying for two
    // jobs is two screenings against two rubrics.
    expect(b.json().data.candidates[0].id).not.toBe(a.json().data.candidates[0].id);
    expect(b.json().meta.created).toBe(1);
  });

  it('collapses two identical files inside one batch and says so', async () => {
    const { role } = await createRole();

    const response = await upload(
      role.id,
      [
        { filename: 'jane.pdf', content: pdf },
        { filename: 'jane-again.pdf', content: pdf },
        { filename: 'other.txt', content: txt },
      ],
      { batch: true },
    );

    const { data, meta } = response.json();
    expect(meta).toEqual({ fileCount: 3, created: 2, duplicates: 1 });
    // One entry per uploaded file, so a caller can line the response up with
    // what it sent - the second one pointing at the same candidate as the first.
    expect(data.candidates).toHaveLength(3);
    expect(data.candidates[1].id).toBe(data.candidates[0].id);
    expect(data.candidates[1].duplicate).toBe(true);
    expect(queue.ids()).toHaveLength(2);
  });

  it('reports a duplicate real status rather than a hard-coded pending', async () => {
    const { role } = await createRole();
    const first = await upload(role.id, [{ filename: 'jane.pdf', content: pdf }]);
    const candidateId = first.json().data.candidates[0].id;

    await pool.query(
      `UPDATE candidates SET status = 'failed', error_code = 'AGENT_TIMEOUT',
              error_message = 'timed out', completed_at = now() WHERE id = $1`,
      [candidateId],
    );

    const second = await upload(role.id, [{ filename: 'jane.pdf', content: pdf }]);
    // Saying "pending" here would send a dashboard into a poll for work that is
    // already over.
    expect(second.json().data.candidates[0].status).toBe('failed');
  });
});

describe('upload rejections', () => {
  it('415s a file that is not a PDF, a DOCX or a TXT, naming it', async () => {
    const { role } = await createRole();

    const response = await upload(role.id, [
      { filename: 'photo.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    ]);

    expect(response.statusCode).toBe(415);
    const error = response.json().error;
    expect(error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(error.details.rejected).toEqual([
      { filename: 'photo.png', reason: expect.any(String) },
    ]);
  });

  it('415s an empty file', async () => {
    const { role } = await createRole();
    const response = await upload(role.id, [{ filename: 'empty.pdf', content: Buffer.alloc(0) }]);

    expect(response.statusCode).toBe(415);
    expect(response.json().error.details.rejected[0].reason).toBe('empty_file');
    expect(await uploadedFileCount()).toBe(0);
  });

  it('rejects a whole batch when one file is unreadable, and writes nothing', async () => {
    const { role } = await createRole();

    const response = await upload(
      role.id,
      [
        { filename: 'good.pdf', content: pdf },
        { filename: 'bad.png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        { filename: 'also-good.txt', content: txt },
      ],
      { batch: true },
    );

    // All-or-nothing at the HTTP layer: nothing is stored, nothing is charged,
    // and the recruiter is told which file to replace. Per-candidate failure
    // starts only once the batch is accepted.
    expect(response.statusCode).toBe(415);
    expect(response.json().error.details.rejected.map((r) => r.filename)).toEqual(['bad.png']);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM candidates');
    expect(rows[0].n).toBe(0);
    expect(queue.ids()).toEqual([]);
    // The two good files were written before the bad one was reached. Nothing
    // is stored and nothing is charged, so nothing may be left on disk either.
    expect(await uploadedFileCount()).toBe(0);
  });

  it('413s FILE_TOO_LARGE for a file over the per-file ceiling', async () => {
    const { role } = await createRole();
    // One byte over. `throwFileSizeLimit` is what makes this a refusal rather
    // than a silently truncated file that screens as a broken CV.
    const oversized = Buffer.alloc(env.MAX_UPLOAD_BYTES + 1, 0x41);

    const response = await upload(role.id, [{ filename: 'huge.txt', content: oversized }]);

    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('FILE_TOO_LARGE');

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM candidates');
    expect(rows[0].n).toBe(0);
    // And nothing partial is left behind. The write is aborted mid-stream, so
    // the path has to be on the cleanup list before the write starts - which is
    // why the allocation happens in the caller rather than inside
    // `storeAndIdentify`.
    expect(await uploadedFileCount()).toBe(0);
  });

  it('400s EMPTY_UPLOAD when no file is attached', async () => {
    const { role } = await createRole();
    const response = await upload(role.id, [], { batch: true });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('EMPTY_UPLOAD');
  });

  it('400s EMPTY_UPLOAD when the body is not multipart at all', async () => {
    const { role } = await createRole();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/roles/${role.id}/candidates`,
      payload: { nope: true },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('EMPTY_UPLOAD');
  });

  it('404s an unknown role before writing a byte', async () => {
    const response = await upload('11111111-2222-4333-8444-555555555555', [
      { filename: 'jane.pdf', content: pdf },
    ]);

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ROLE_NOT_FOUND');
  });

  it('409s an archived role', async () => {
    const { role } = await createRole();
    await app.inject({ method: 'DELETE', url: `/api/v1/roles/${role.id}` });

    const response = await upload(role.id, [{ filename: 'jane.pdf', content: pdf }]);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ROLE_ARCHIVED');
  });

  it('409s ROLE_NOT_SCOREABLE for a role with no criteria', async () => {
    // A criteria-less role is the one shape the sum-to-100 trigger cannot rule
    // out, and screening against it would fail in the worker AFTER the API spend.
    const { role } = await createRole({ criteria: [] });

    const response = await upload(role.id, [{ filename: 'jane.pdf', content: pdf }]);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ROLE_NOT_SCOREABLE');
  });

  it('400s a roleId that is not a uuid', async () => {
    const response = await upload('nope', [{ filename: 'jane.pdf', content: pdf }]);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('when the enqueue fails after COMMIT', () => {
  it('still returns 202, because the CVs are durably recorded', async () => {
    const { role } = await createRole();
    queue.failNext(new Error('redis is down'));

    const response = await upload(role.id, [{ filename: 'jane.pdf', content: pdf }]);

    // Returning a 500 here would tell the recruiter to upload again, which is
    // wrong: the candidate is committed and pending, and reconcileStuck.js
    // re-enqueues anything stranded.
    expect(response.statusCode).toBe(202);
    const { rows } = await pool.query('SELECT status FROM candidates');
    expect(rows[0].status).toBe('pending');
  });
});
