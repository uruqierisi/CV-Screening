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

  it('publishes the candidate statuses AND which of them a poll stops on', async () => {
    const config = (await app.inject({ method: 'GET', url: '/api/v1/config' })).json().data;

    expect(config.candidates.statuses).toEqual([
      'pending',
      'parsing',
      'evaluating',
      'done',
      'failed',
    ]);
    // The stop condition, published rather than restated in the client. Without
    // it a dashboard has to carry its own ['done','failed'], and a stop
    // condition kept in two places is the one constant that must not drift: one
    // copy behind means a poll that never stops.
    expect(config.candidates.terminalStatuses).toEqual(['done', 'failed']);
  });

  it('derives terminalStatuses from the status list rather than repeating it', async () => {
    const config = (await app.inject({ method: 'GET', url: '/api/v1/config' })).json().data;
    const { statuses, terminalStatuses } = config.candidates;

    // Asserted as a relationship, not as a literal: every terminal status is one
    // of the published statuses, and the terminal list is a subset in the same
    // order. A second hand-written literal could satisfy the previous test and
    // still fail this one the day a status is added.
    expect(terminalStatuses.every((status) => statuses.includes(status))).toBe(true);
    expect(terminalStatuses).toEqual(statuses.filter((s) => terminalStatuses.includes(s)));
    expect(terminalStatuses.length).toBeLessThan(statuses.length);
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

describe('CORS', () => {
  /**
   * The allowed origin for this run. It comes from the parsed environment rather
   * than from a literal, so the test is asserting the plugin honours the
   * allowlist rather than asserting a port number twice.
   */
  const allowed = env.CORS_ALLOWED_ORIGINS[0];

  it('defaults the allowlist to the Vite dev server origin', () => {
    // `web/vite.config.js` pins the dev server to 5173. Until now the client
    // worked only because that dev server proxied /api and the browser never
    // made a cross-origin request - which is a property of the dev server, not
    // of this API.
    expect(env.CORS_ALLOWED_ORIGINS).toContain('http://localhost:5173');
  });

  it('answers a preflight from an allowed origin', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/candidates',
      headers: {
        origin: allowed,
        'access-control-request-method': 'GET',
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(allowed);
    expect(response.headers['access-control-allow-methods']).toContain('GET');
  });

  it('echoes the allowed origin on an ordinary request, and varies on it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/config',
      headers: { origin: allowed },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(allowed);
    // Without `Vary: Origin` a shared cache can hand one origin's response,
    // headers included, to a different origin.
    expect(String(response.headers.vary)).toContain('Origin');
  });

  it('sends no allow-origin header to an origin that is not on the list', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/config',
      headers: { origin: 'https://evil.example.com' },
    });

    // The request still executes - CORS is enforced by the browser, not by the
    // server refusing to answer - but the browser is told nothing that would let
    // it hand the body to that page. This is what `*` would have thrown away.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not allow credentials, because there is no auth to carry', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/config',
      headers: { origin: allowed },
    });

    // Turning this on would grant a permission nothing uses, and it is mutually
    // exclusive with the `*` this deliberately is not.
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('exposes the headers the 429 contract documents', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/config',
      headers: { origin: allowed },
    });

    // `Retry-After` is not a CORS-safelisted response header. Without this a
    // cross-origin client can see the 429 and not the header telling it when to
    // come back, which makes the rate limit unimplementable on the client side.
    expect(String(response.headers['access-control-expose-headers'])).toContain('retry-after');
  });

  it('leaves a same-origin request untouched', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
