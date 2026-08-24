// Set BEFORE any `src/` module is imported. `config/env.js` parses the
// environment once, at import time, and freezes the result - which is the right
// design for a server and an awkward one for a test that needs a different
// value. Assigning here and using dynamic `import()` below is the whole trick,
// and it is why this file is separate from the rest of the API suite: every
// other test must keep running with the guard OFF.
process.env.UPLOAD_ACCESS_TOKEN = 'a-deployment-secret';

const { afterAll, afterEach, beforeEach, describe, expect, it } = await import('vitest');
const { pool, truncateAll } = await import('../helpers/database.js');
const { createRole, createScreeningJob } = await import('../helpers/fixtures.js');
const { buildTestApp, multipartBody, removeUploadedFiles } = await import('../helpers/api.js');
const { UPLOAD_TOKEN_HEADER } = await import('../../src/http/uploadGuard.js');

/**
 * **Which routes the spend guard actually covers.**
 *
 * `test/unit/uploadGuard.test.js` proves the policy is right. This proves it is
 * *wired to the right routes*, which is a different claim and the one that fails
 * silently: a guard attached to two routes instead of three looks identical in
 * every unit test and leaves the most expensive endpoint open.
 *
 * The endpoint that makes this worth a file of its own is
 * `POST /candidates/:id/retry`. It re-runs both model calls from scratch, so it
 * costs exactly what an upload costs, and it is not an upload - which is
 * precisely why it was outside the rate-limited scope until phase 6 and why it
 * is the one somebody would forget again.
 *
 * The negative case matters just as much: the dashboard polls
 * `/candidates/statuses` every three seconds, and a guard that crept onto it
 * would break the product to protect nothing.
 */

const TOKEN = 'a-deployment-secret';

/** @type {import('fastify').FastifyInstance} */
let app;

beforeEach(async () => {
  await truncateAll();
  app = await buildTestApp();
});

afterEach(async () => {
  await app.close();
  await removeUploadedFiles();
});

afterAll(async () => {
  await pool.end();
});

/** A role and one committed candidate, so the guarded routes have real targets. */
async function seed() {
  const { role } = await createRole({
    title: 'Senior Backend Engineer',
    criteria: [{ label: 'Depth', weight: 100, position: 0 }],
    eliminationRules: [],
  });
  const { candidates } = await createScreeningJob({ roleId: role.id, candidates: [{}] });
  return { roleId: role.id, candidateId: candidates[0].id };
}

/** A one-file multipart body. The bytes only need to survive routing. */
function oneFile() {
  return multipartBody([
    { filename: 'cv.txt', content: Buffer.from('Jane Doe\nEngineer\n', 'utf8'), contentType: 'text/plain' },
  ]);
}

describe('the routes that spend API money', () => {
  it('refuses a single upload with no token', async () => {
    const { roleId } = await seed();
    const body = oneFile();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/roles/${roleId}/candidates`,
      headers: body.headers,
      payload: body.payload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('UPLOAD_TOKEN_INVALID');
  });

  it('refuses a batch upload with no token', async () => {
    const { roleId } = await seed();
    const body = oneFile();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/roles/${roleId}/candidates/batch`,
      headers: body.headers,
      payload: body.payload,
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a retry with no token - the endpoint that is easiest to forget', async () => {
    const { candidateId } = await seed();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/candidates/${candidateId}/retry`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('UPLOAD_TOKEN_INVALID');
  });

  it('lets a correctly-tokened upload through to the real handler', async () => {
    const { roleId } = await seed();
    const body = oneFile();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/roles/${roleId}/candidates`,
      headers: { ...body.headers, [UPLOAD_TOKEN_HEADER]: TOKEN },
      payload: body.payload,
    });

    // 202: past the guard and through the whole upload path. The assertion is
    // "not refused" rather than a specific success shape, which the upload
    // suite already owns.
    expect(response.statusCode).toBe(202);
  });

  it('refuses before the body is read, so an untokened upload costs no disk', async () => {
    // The hook is `onRequest`, which runs before multipart parsing. A guard at
    // `preHandler` would stream 5 MB to disk and then refuse it, which defeats
    // the point of a cost guard.
    const { roleId } = await seed();
    const body = oneFile();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/roles/${roleId}/candidates`,
      headers: body.headers,
      payload: body.payload,
    });

    expect(response.statusCode).toBe(403);

    // Nothing was written and no candidate row was created by the refused
    // request - the one candidate is the seeded one.
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM candidates');
    expect(rows[0].count).toBe(1);
  });
});

describe('the routes that do not spend anything', () => {
  it('leaves the dashboard poll open', async () => {
    // Every three seconds, from every open tab. Gating this would break the
    // product to protect nothing.
    const { candidateId } = await seed();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/candidates/statuses?ids=${candidateId}`,
    });

    expect(response.statusCode).toBe(200);
  });

  it('leaves the ranked list, the detail view and /config open', async () => {
    const { candidateId } = await seed();

    for (const url of ['/api/v1/candidates', `/api/v1/candidates/${candidateId}`, '/api/v1/config']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
    }
  });

  it('leaves role creation open - it costs nothing to score against', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      payload: {
        title: 'Another Role',
        description: 'x'.repeat(40),
        criteria: [{ label: 'Depth', weight: 100 }],
        eliminationRules: [],
      },
    });

    expect(response.statusCode).toBe(201);
  });
});
