import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, fixtureBytes, multipartBody, removeUploadedFiles } from '../helpers/api.js';
import { pool, truncateAll } from '../helpers/database.js';
import { createRole } from '../helpers/fixtures.js';
import { env } from '../../src/config/env.js';
import { ELIMINATION_RULE_TYPES, TIER_THRESHOLDS } from '../../src/agents/index.js';

/**
 * `/config`, `/health`, the central error handler and the upload rate limit.
 *
 * The error-handler assertions here are the ones that cannot be made from a unit
 * test: that a throw from deep inside a route really does reach the client as
 * `INTERNAL_ERROR` and a request id, with nothing of the original in the body.
 */

/** @type {import('fastify').FastifyInstance} */
let app;

beforeEach(async () => {
  await truncateAll();
  app = await buildTestApp();
});

afterEach(async () => {
  await removeUploadedFiles();
});

afterAll(async () => {
  await pool.end();
});

describe('GET /api/v1/config', () => {
  it('publishes the limits and thresholds so no client has to duplicate them', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });

    expect(response.statusCode).toBe(200);
    const config = response.json().data;

    expect(config.upload).toEqual({
      maxFileBytes: env.MAX_UPLOAD_BYTES,
      maxBatchFiles: env.MAX_BATCH_FILES,
      acceptedMimeTypes: [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
      ],
    });
    // The thresholds are here to render a legend, not to decide one: the client
    // never recomputes a tier, because elimination overrides score.
    expect(config.scoring.tierThresholds).toEqual(TIER_THRESHOLDS);
    expect(config.scoring.requiredWeightSum).toBe(100);
  });

  it('describes every elimination rule type the API will accept', async () => {
    const config = (await app.inject({ method: 'GET', url: '/api/v1/config' })).json().data;

    expect(config.eliminationRules.types).toEqual([...ELIMINATION_RULE_TYPES]);
    // A form that renders a type with no descriptor renders a blank control.
    for (const type of ELIMINATION_RULE_TYPES) {
      expect(config.eliminationRules.descriptors[type]).toBeTruthy();
      expect(config.eliminationRules.descriptors[type].fields.length).toBeGreaterThan(0);
    }
  });

  it('publishes the job statuses a client polls against', async () => {
    const config = (await app.inject({ method: 'GET', url: '/api/v1/config' })).json().data;
    expect(config.jobs.statuses).toEqual([
      'queued',
      'in_progress',
      'completed',
      'completed_with_failures',
    ]);
  });
});

describe('GET /api/v1/health', () => {
  it('reports the database as reachable', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    const body = response.json().data;

    // Redis may or may not be up in a given run; the database must be, because
    // this suite is talking to it.
    expect(body.dependencies.database).toBe(true);
    expect([200, 503]).toContain(response.statusCode);
    expect(response.statusCode).toBe(body.dependencies.redis ? 200 : 503);
  });
});

describe('the central error handler', () => {
  it('answers 404 NOT_FOUND for an unrouted path, in the same envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/nonsense' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'No such endpoint.',
        requestId: expect.any(String),
      },
    });
  });

  it('turns an unexpected throw into INTERNAL_ERROR with a request id and nothing else', async () => {
    app.get('/api/v1/boom', async () => {
      throw new Error('connection to postgres://cv:hunter2@db:5432/prod failed');
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/boom' });

    expect(response.statusCode).toBe(500);
    const error = response.json().error;
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.requestId).toEqual(expect.any(String));
    // The stack, the driver message and the credential all stay in the log.
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('postgres://');
    expect(error).not.toHaveProperty('stack');
  });

  it('gives every response its own request id', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/v1/nonsense' });
    const second = await app.inject({ method: 'GET', url: '/api/v1/nonsense' });

    expect(first.json().error.requestId).not.toBe(second.json().error.requestId);
  });

  it('ignores a client-supplied request id', async () => {
    // Otherwise a caller can poison the logs with a value of their choosing, or
    // deliberately collide two unrelated requests.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/nonsense',
      headers: { 'request-id': 'attacker-chosen' },
    });

    expect(response.json().error.requestId).not.toBe('attacker-chosen');
  });
});

describe('upload rate limiting', () => {
  it('applies to the upload endpoints only', async () => {
    // A dashboard polls every three seconds; rate-limiting it would break the
    // product to protect nothing. The uploads are the endpoints that spend
    // money.
    const limited = await buildTestApp();

    const many = await Promise.all(
      Array.from({ length: env.UPLOAD_RATE_LIMIT_MAX + 5 }, () =>
        limited.inject({ method: 'GET', url: '/api/v1/candidates' }),
      ),
    );

    expect(many.every((response) => response.statusCode === 200)).toBe(true);
  });

  it('answers 429 RATE_LIMITED with a Retry-After header once the window is spent', async () => {
    const { role } = await createRole();
    const pdf = await fixtureBytes('clean.pdf');

    /** One upload attempt; the payload is irrelevant past the limit. */
    const attempt = () => {
      const { payload, headers } = multipartBody([{ filename: 'jane.pdf', content: pdf }]);
      return app.inject({
        method: 'POST',
        url: `/api/v1/roles/${role.id}/candidates`,
        headers,
        payload,
      });
    };

    /** @type {any[]} */
    const responses = [];
    for (let i = 0; i < env.UPLOAD_RATE_LIMIT_MAX + 1; i += 1) {
      responses.push(await attempt());
    }

    const last = responses.at(-1);
    expect(last.statusCode).toBe(429);
    expect(last.json().error.code).toBe('RATE_LIMITED');
    expect(last.headers['retry-after']).toBeDefined();
  });
});
