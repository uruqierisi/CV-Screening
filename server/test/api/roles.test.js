import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/api.js';
import { pool, truncateAll } from '../helpers/database.js';

/**
 * Role CRUD, driven through the real Fastify instance with `app.inject()`.
 *
 * `inject` runs a genuine request through the real router, the real plugins and
 * the real error handler without opening a socket - so these tests exercise the
 * code that ships, including the status codes, rather than calling a controller
 * function directly and hoping the wiring matches.
 */

/** @type {import('fastify').FastifyInstance} */
let app;

beforeEach(async () => {
  await truncateAll();
  app = await buildTestApp();
});

afterAll(async () => {
  await pool.end();
});

/** A body that passes; each test breaks exactly one thing. */
function roleBody(overrides = {}) {
  return {
    title: 'Senior Backend Engineer',
    description: 'Owns the API and the pipeline behind it.',
    criteria: [
      { label: 'Backend depth', description: 'Node, SQL, queues.', weight: 60 },
      { label: 'Communication', weight: 40 },
    ],
    eliminationRules: [
      { label: 'Five years', type: 'min_years_experience', value: { years: 5 } },
    ],
    ...overrides,
  };
}

/**
 * @param {object} [body]
 */
async function createRole(body = roleBody()) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/roles', payload: body });
  expect(response.statusCode).toBe(201);
  return response.json().data;
}

describe('POST /api/v1/roles', () => {
  it('creates a role, its criteria and its rules in one call', async () => {
    const role = await createRole();

    expect(role.title).toBe('Senior Backend Engineer');
    expect(role.version).toBe(1);
    expect(role.archived).toBe(false);
    expect(role.criteria.map((c) => [c.label, c.weight, c.position])).toEqual([
      ['Backend depth', 60, 0],
      ['Communication', 40, 1],
    ]);
    // Position comes from the array order, not from the client. A form produces
    // an order; inventing a second way to express it invites the two to disagree.
    expect(role.eliminationRules[0].position).toBe(0);
    expect(role.eliminationRules[0].onMissing).toBe('flag');
  });

  it('rejects weights that do not sum to 100 with 422 WEIGHTS_MUST_SUM_TO_100', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      payload: roleBody({ criteria: [{ label: 'A', weight: 60 }, { label: 'B', weight: 30 }] }),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('WEIGHTS_MUST_SUM_TO_100');
    expect(response.json().error.message).toContain('received 90');
    expect(response.json().error.requestId).toEqual(expect.any(String));
  });

  it('rejects duplicate criterion labels with 422 DUPLICATE_CRITERION_LABEL', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      payload: roleBody({
        criteria: [
          { label: 'Communication', weight: 50 },
          { label: 'communication', weight: 50 },
        ],
      }),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('DUPLICATE_CRITERION_LABEL');
  });

  it('rejects an ordinary bad body with 400 VALIDATION_FAILED and names the fields', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      payload: { title: '', criteria: [{ label: 'A', weight: 'lots' }] },
    });

    expect(response.statusCode).toBe(400);
    const error = response.json().error;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details.fields.map((f) => f.path)).toContain('title');
    expect(error.details.fields.map((f) => f.path)).toContain('criteria.0.weight');
  });

  it('rejects a body that is not JSON with 400 rather than a Fastify-shaped 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
    expect(response.json().error).toHaveProperty('requestId');
  });

  it('writes nothing when the weights are wrong', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/roles',
      payload: roleBody({ criteria: [{ label: 'A', weight: 99 }] }),
    });

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM roles');
    expect(rows[0].n).toBe(0);
  });
});

describe('GET /api/v1/roles', () => {
  it('paginates and attaches each role criteria and rules', async () => {
    await createRole(roleBody({ title: 'One' }));
    await createRole(roleBody({ title: 'Two' }));

    const response = await app.inject({ method: 'GET', url: '/api/v1/roles?page=1&pageSize=1' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].criteria).toHaveLength(2);
    expect(body.meta).toEqual({ page: 1, pageSize: 1, total: 2, totalPages: 2 });
  });

  it('hides archived roles by default and shows them when asked', async () => {
    const role = await createRole();
    await app.inject({ method: 'DELETE', url: `/api/v1/roles/${role.id}` });

    const hidden = await app.inject({ method: 'GET', url: '/api/v1/roles' });
    expect(hidden.json().data).toHaveLength(0);

    const shown = await app.inject({ method: 'GET', url: '/api/v1/roles?includeArchived=true' });
    expect(shown.json().data).toHaveLength(1);
    expect(shown.json().data[0].archived).toBe(true);
  });

  it('rejects a page size above the cap', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/roles?pageSize=5000' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /api/v1/roles/:roleId', () => {
  it('returns the full definition', async () => {
    const created = await createRole();
    const response = await app.inject({ method: 'GET', url: `/api/v1/roles/${created.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(created);
  });

  it('404s for an id that does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/roles/11111111-2222-4333-8444-555555555555',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ROLE_NOT_FOUND');
  });

  it('400s for an id that is not a uuid, rather than 500ing on a driver error', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/roles/not-a-uuid' });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('PUT /api/v1/roles/:roleId', () => {
  it('replaces everything and bumps the version', async () => {
    const created = await createRole();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${created.id}`,
      payload: roleBody({
        title: 'Staff Backend Engineer',
        criteria: [{ label: 'Systems design', weight: 100 }],
        eliminationRules: [],
      }),
    });

    expect(response.statusCode).toBe(200);
    const role = response.json().data;
    expect(role.title).toBe('Staff Backend Engineer');
    // The version stamp is the only thing that tells a recruiter two rows on one
    // dashboard were judged by different rubrics - there is no rescore path.
    expect(role.version).toBe(2);
    expect(role.criteria).toHaveLength(1);
    expect(role.eliminationRules).toHaveLength(0);
  });

  it('rolls the whole replacement back when the new weights are wrong', async () => {
    const created = await createRole();

    const response = await app.inject({
      method: 'PUT',
      url: `/api/v1/roles/${created.id}`,
      payload: roleBody({ criteria: [{ label: 'Only', weight: 70 }] }),
    });

    expect(response.statusCode).toBe(422);

    const after = await app.inject({ method: 'GET', url: `/api/v1/roles/${created.id}` });
    expect(after.json().data.version).toBe(1);
    expect(after.json().data.criteria).toHaveLength(2);
  });

  it('404s for an id that does not exist', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/roles/11111111-2222-4333-8444-555555555555',
      payload: roleBody(),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('ROLE_NOT_FOUND');
  });
});

describe('DELETE /api/v1/roles/:roleId', () => {
  it('soft archives and is idempotent', async () => {
    const created = await createRole();

    const first = await app.inject({ method: 'DELETE', url: `/api/v1/roles/${created.id}` });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.archived).toBe(true);

    const second = await app.inject({ method: 'DELETE', url: `/api/v1/roles/${created.id}` });
    expect(second.statusCode).toBe(200);
    // The original timestamp survives, so a repeated archive is a true no-op.
    expect(second.json().data.archivedAt).toBe(first.json().data.archivedAt);
  });

  it('never hard deletes - the screening history has to survive the role', async () => {
    const created = await createRole();
    await app.inject({ method: 'DELETE', url: `/api/v1/roles/${created.id}` });

    const { rows } = await pool.query('SELECT archived_at FROM roles WHERE id = $1', [created.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].archived_at).not.toBeNull();
  });

  it('404s for an id that does not exist', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/roles/11111111-2222-4333-8444-555555555555',
    });
    expect(response.statusCode).toBe(404);
  });
});
