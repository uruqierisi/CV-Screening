import { beforeEach, describe, expect, it } from 'vitest';
import { pool, truncateAll } from './helpers/database.js';
import { createRole, createScreeningJob } from './helpers/fixtures.js';
import { withTransaction } from '../src/db/withTransaction.js';
import {
  archiveRole,
  countRoles,
  findRoleById,
  insertRole,
  listRoles,
  updateRoleAndBumpVersion,
} from '../src/repositories/rolesRepository.js';

beforeEach(truncateAll);

describe('insertRole', () => {
  it('creates a role with the documented defaults', async () => {
    const role = await withTransaction((client) =>
      insertRole(client, { title: 'Platform Engineer' }),
    );

    expect(role).toMatchObject({
      title: 'Platform Engineer',
      description: '',
      version: 1,
      archivedAt: null,
    });
    expect(role.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('accepts a caller-supplied id, so the seed can be re-runnable', async () => {
    const id = '3f8c2b1e-9d4a-4c6f-8a71-2e5b7c9d0a11';
    const role = await withTransaction((client) => insertRole(client, { id, title: 'Fixed' }));

    expect(role.id).toBe(id);
  });

  it('rejects an empty title', async () => {
    await expect(
      withTransaction((client) => insertRole(client, { title: '' })),
    ).rejects.toMatchObject({ constraint: 'roles_title_length_check' });
  });

  it('rejects a title longer than 200 characters', async () => {
    await expect(
      withTransaction((client) => insertRole(client, { title: 'x'.repeat(201) })),
    ).rejects.toMatchObject({ constraint: 'roles_title_length_check' });
  });
});

describe('findRoleById', () => {
  it('returns null for an id that does not exist', async () => {
    expect(await findRoleById(pool, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('still returns an archived role - archived is not deleted', async () => {
    const { role } = await createRole();
    await archiveRole(pool, role.id);

    const found = await findRoleById(pool, role.id);
    expect(found?.archivedAt).toBeInstanceOf(Date);
  });
});

describe('listRoles', () => {
  it('hides archived roles by default and counts them the same way', async () => {
    const visible = await createRole({ title: 'Open' });
    const hidden = await createRole({ title: 'Closed' });
    await archiveRole(pool, hidden.role.id);

    const roles = await listRoles(pool, { limit: 10, offset: 0 });

    expect(roles.map((r) => r.title)).toEqual(['Open']);
    expect(await countRoles(pool)).toBe(1);
    expect(await countRoles(pool, { includeArchived: true })).toBe(2);
    expect(visible.role.archivedAt).toBeNull();
  });

  it('includes archived roles on request', async () => {
    const { role } = await createRole();
    await archiveRole(pool, role.id);

    const roles = await listRoles(pool, { limit: 10, offset: 0, includeArchived: true });
    expect(roles).toHaveLength(1);
  });

  it('pages without repeating or skipping a row', async () => {
    await createRole({ title: 'A' });
    await createRole({ title: 'B' });
    await createRole({ title: 'C' });

    const first = await listRoles(pool, { limit: 2, offset: 0 });
    const second = await listRoles(pool, { limit: 2, offset: 2 });
    const ids = [...first, ...second].map((r) => r.id);

    expect(new Set(ids).size).toBe(3);
  });
});

describe('updateRoleAndBumpVersion', () => {
  it('bumps the version so candidates can be stamped with the rubric they were scored against', async () => {
    const { role } = await createRole();

    const updated = await updateRoleAndBumpVersion(pool, role.id, { title: 'Renamed' });

    expect(updated).toMatchObject({ title: 'Renamed', version: 2 });
    const again = await updateRoleAndBumpVersion(pool, role.id, { title: 'Renamed twice' });
    expect(again?.version).toBe(3);
  });

  it('returns null when the role does not exist, rather than throwing', async () => {
    const missing = await updateRoleAndBumpVersion(pool, '00000000-0000-0000-0000-000000000000', {
      title: 'Nobody',
    });

    expect(missing).toBeNull();
  });
});

describe('archiveRole', () => {
  it('soft-archives and is idempotent on a repeat call', async () => {
    const { role } = await createRole();

    const first = await archiveRole(pool, role.id);
    const second = await archiveRole(pool, role.id);

    expect(first?.archivedAt).toBeInstanceOf(Date);
    // Same timestamp, and updated_at did not move either: a repeated DELETE is a
    // true no-op, which is what makes the endpoint safe to retry.
    expect(second?.archivedAt?.getTime()).toBe(first?.archivedAt?.getTime());
    expect(second?.updatedAt.getTime()).toBe(first?.updatedAt.getTime());
  });

  it('returns null for an unknown role', async () => {
    expect(await archiveRole(pool, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('role deletion rules', () => {
  it('cascades criteria and rules when a role is hard-deleted', async () => {
    const { role } = await createRole({
      eliminationRules: [
        { label: 'Five years', type: 'min_years_experience', value: { years: 5 }, position: 0 },
      ],
    });

    await pool.query('DELETE FROM roles WHERE id = $1', [role.id]);

    const criteria = await pool.query('SELECT 1 FROM role_criteria WHERE role_id = $1', [role.id]);
    const rules = await pool.query('SELECT 1 FROM role_elimination_rules WHERE role_id = $1', [
      role.id,
    ]);
    expect(criteria.rowCount).toBe(0);
    expect(rules.rowCount).toBe(0);
  });

  it('refuses to hard-delete a role that has screening history', async () => {
    const { role } = await createRole();
    await createScreeningJob({ roleId: role.id });

    // ON DELETE RESTRICT. This is why DELETE /roles archives instead: the history
    // has to survive, and a foreign key is a better guarantee than a convention.
    await expect(pool.query('DELETE FROM roles WHERE id = $1', [role.id])).rejects.toMatchObject({
      code: '23503',
    });
  });
});
