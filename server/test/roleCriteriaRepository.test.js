import { beforeEach, describe, expect, it } from 'vitest';
import { pool, truncateAll } from './helpers/database.js';
import { createRole } from './helpers/fixtures.js';
import { withTransaction } from '../src/db/withTransaction.js';
import { insertRole } from '../src/repositories/rolesRepository.js';
import {
  listCriteriaByRoleId,
  listCriteriaByRoleIds,
  replaceCriteriaForRole,
  sumCriteriaWeights,
} from '../src/repositories/roleCriteriaRepository.js';

/** PostgreSQL SQLSTATE for check_violation, which the trigger raises deliberately. */
const CHECK_VIOLATION = '23514';

beforeEach(truncateAll);

describe('replaceCriteriaForRole', () => {
  it('writes criteria in position order', async () => {
    const { criteria } = await createRole({
      criteria: [
        { label: 'B', weight: 40, position: 1 },
        { label: 'A', weight: 60, position: 0 },
      ],
    });

    expect(criteria.map((c) => c.label)).toEqual(['A', 'B']);
    expect(criteria.map((c) => c.weight)).toEqual([60, 40]);
  });

  it('defaults description to an empty string rather than null', async () => {
    const { criteria } = await createRole();

    expect(criteria[0].description).toBe('');
  });

  it('replaces the whole set rather than merging it', async () => {
    const { role } = await createRole({
      criteria: [
        { label: 'Old A', weight: 50, position: 0 },
        { label: 'Old B', weight: 50, position: 1 },
      ],
    });

    await withTransaction((client) =>
      replaceCriteriaForRole(client, role.id, [{ label: 'New', weight: 100, position: 0 }]),
    );

    const criteria = await listCriteriaByRoleId(pool, role.id);
    expect(criteria.map((c) => c.label)).toEqual(['New']);
  });

  it('refuses to run outside a transaction', async () => {
    const { role } = await createRole();

    await expect(
      replaceCriteriaForRole(/** @type {any} */ (pool), role.id, [
        { label: 'X', weight: 100, position: 0 },
      ]),
    ).rejects.toThrow(/must be called with a transaction client/);
  });

  it('rejects a weight outside 1..100', async () => {
    const role = await withTransaction((client) => insertRole(client, { title: 'R' }));

    await expect(
      withTransaction((client) =>
        replaceCriteriaForRole(client, role.id, [{ label: 'X', weight: 0, position: 0 }]),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('rejects two criteria with the same label on one role', async () => {
    const role = await withTransaction((client) => insertRole(client, { title: 'R' }));

    await expect(
      withTransaction((client) =>
        replaceCriteriaForRole(client, role.id, [
          { label: 'Same', weight: 50, position: 0 },
          { label: 'Same', weight: 50, position: 1 },
        ]),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('allows the same label on two different roles', async () => {
    const first = await createRole({ title: 'One' });
    const second = await createRole({ title: 'Two' });

    expect(first.criteria[0].label).toBe(second.criteria[0].label);
  });
});

describe('the sum-to-100 invariant (database layer)', () => {
  it('accepts a delete-then-insert that reaches 100 inside one transaction', async () => {
    const { role } = await createRole({
      criteria: [
        { label: 'A', weight: 70, position: 0 },
        { label: 'B', weight: 30, position: 1 },
      ],
    });

    // The intermediate state here is invalid by design: zero criteria after the
    // delete, then 45 after the first insert. A non-deferred check would reject
    // both. This is the case the DEFERRABLE INITIALLY DEFERRED trigger exists for.
    await expect(
      withTransaction((client) =>
        replaceCriteriaForRole(client, role.id, [
          { label: 'C', weight: 45, position: 0 },
          { label: 'D', weight: 55, position: 1 },
        ]),
      ),
    ).resolves.toHaveLength(2);

    expect(await sumCriteriaWeights(pool, role.id)).toEqual({ total: 100, count: 2 });
  });

  it('accepts criteria written across several statements that only total 100 at the end', async () => {
    const role = await withTransaction((client) => insertRole(client, { title: 'Built up' }));

    // replaceCriteriaForRole inserts every criterion in ONE statement, and a
    // plain AFTER ROW trigger would already tolerate that (row triggers fire at
    // end of statement). This is the case that genuinely requires deferral: two
    // separate INSERTs, the first leaving the role at 30.
    await expect(
      withTransaction(async (client) => {
        await client.query(
          `INSERT INTO role_criteria (role_id, label, weight, position) VALUES ($1, 'First', 30, 0)`,
          [role.id],
        );
        await client.query(
          `INSERT INTO role_criteria (role_id, label, weight, position) VALUES ($1, 'Second', 70, 1)`,
          [role.id],
        );
      }),
    ).resolves.toBeUndefined();

    expect(await sumCriteriaWeights(pool, role.id)).toEqual({ total: 100, count: 2 });
  });

  it('rejects a transaction whose weights total 99, at COMMIT and not before', async () => {
    const { role } = await createRole();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM role_criteria WHERE role_id = $1', [role.id]);

      // This resolves. If the check were not deferred, it would throw here - and
      // that is the whole distinction the test is asserting.
      await expect(
        client.query(
          `INSERT INTO role_criteria (role_id, label, weight, position) VALUES ($1, 'Short', 99, 0)`,
          [role.id],
        ),
      ).resolves.toBeDefined();

      await expect(client.query('COMMIT')).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint: 'role_criteria_weights_sum_100',
      });
    } finally {
      client.release();
    }

    // The failed COMMIT rolled the whole transaction back, so the original
    // criteria are still there.
    expect(await sumCriteriaWeights(pool, role.id)).toEqual({ total: 100, count: 2 });
  });

  it('rejects weights totalling 101 as firmly as 99', async () => {
    const { role } = await createRole();

    await expect(
      withTransaction((client) =>
        replaceCriteriaForRole(client, role.id, [
          { label: 'A', weight: 51, position: 0 },
          { label: 'B', weight: 50, position: 1 },
        ]),
      ),
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
  });

  it('reports the offending total in the error message', async () => {
    const { role } = await createRole();

    await expect(
      withTransaction((client) =>
        replaceCriteriaForRole(client, role.id, [{ label: 'A', weight: 42, position: 0 }]),
      ),
    ).rejects.toThrow(/sum to 42, expected 100/);
  });

  it('does not fire for a role left with zero criteria - the documented gap', async () => {
    const { role } = await createRole();

    // The trigger is per-row on role_criteria, so an empty set has nothing to fire
    // on. This is why zod requires criteria.length >= 1 at the boundary and why an
    // upload to a criteria-less role is rejected ROLE_NOT_SCOREABLE. Asserted here
    // so the gap is visible rather than surprising.
    await expect(
      withTransaction((client) => replaceCriteriaForRole(client, role.id, [])),
    ).resolves.toEqual([]);

    expect(await sumCriteriaWeights(pool, role.id)).toEqual({ total: 0, count: 0 });
  });

  it('is not tripped by cascading deletes when a role is removed', async () => {
    const { role } = await createRole();

    await expect(pool.query('DELETE FROM roles WHERE id = $1', [role.id])).resolves.toBeDefined();
    expect(await listCriteriaByRoleId(pool, role.id)).toEqual([]);
  });
});

describe('listCriteriaByRoleIds', () => {
  it('loads criteria for many roles in one query, keyed by role', async () => {
    const first = await createRole({ title: 'First' });
    const second = await createRole({
      title: 'Second',
      criteria: [{ label: 'Only', weight: 100, position: 0 }],
    });

    const byRole = await listCriteriaByRoleIds(pool, [first.role.id, second.role.id]);

    expect(byRole.get(first.role.id)).toHaveLength(2);
    expect(byRole.get(second.role.id)?.[0].label).toBe('Only');
  });

  it('omits roles that have no criteria, and does not query for an empty list', async () => {
    const role = await withTransaction((client) => insertRole(client, { title: 'Bare' }));

    const byRole = await listCriteriaByRoleIds(pool, [role.id]);
    expect(byRole.has(role.id)).toBe(false);

    expect(await listCriteriaByRoleIds(pool, [])).toEqual(new Map());
  });
});
