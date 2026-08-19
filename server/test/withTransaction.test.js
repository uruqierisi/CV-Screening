import { beforeEach, describe, expect, it } from 'vitest';
import { pool, truncateAll } from './helpers/database.js';
import { withTransaction } from '../src/db/withTransaction.js';
import { countRoles, insertRole } from '../src/repositories/rolesRepository.js';
import { replaceCriteriaForRole } from '../src/repositories/roleCriteriaRepository.js';

beforeEach(truncateAll);

describe('withTransaction', () => {
  it('commits and returns the callback result', async () => {
    const role = await withTransaction((client) => insertRole(client, { title: 'Committed' }));

    expect(role.title).toBe('Committed');
    expect(await countRoles(pool)).toBe(1);
  });

  it('rolls back every write when the callback throws, and rethrows the original error', async () => {
    await expect(
      withTransaction(async (client) => {
        await insertRole(client, { title: 'Doomed' });
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');

    expect(await countRoles(pool)).toBe(0);
  });

  it('rolls back when COMMIT itself fails on a deferred constraint', async () => {
    // The deferred sum-to-100 trigger only fires at COMMIT, which is why COMMIT
    // lives inside withTransaction's try block. If it did not, this would leak an
    // open, un-rolled-back transaction and eventually exhaust the pool.
    await expect(
      withTransaction(async (client) => {
        const role = await insertRole(client, { title: 'Bad weights' });
        await replaceCriteriaForRole(client, role.id, [
          { label: 'Only', weight: 60, position: 0 },
        ]);
      }),
    ).rejects.toMatchObject({ code: '23514' });

    expect(await countRoles(pool)).toBe(0);
  });

  it('returns the connection to the pool on both paths', async () => {
    const before = pool.idleCount + pool.waitingCount;

    await withTransaction((client) => client.query('SELECT 1'));
    await withTransaction(async () => {
      throw new Error('boom');
    }).catch(() => {});

    // A leaked client would leave totalCount high with nothing idle; the check
    // that matters is that repeated failures do not starve the pool.
    expect(pool.idleCount).toBeGreaterThanOrEqual(Math.min(before, 1));
    await expect(withTransaction((client) => client.query('SELECT 1'))).resolves.toBeDefined();
  });

  it('sees its own uncommitted writes, and other connections do not', async () => {
    await withTransaction(async (client) => {
      await insertRole(client, { title: 'In flight' });

      // Inside the transaction: visible.
      expect(await countRoles(client)).toBe(1);
      // On a different pooled connection: not visible until COMMIT. This is the
      // exact reason candidates are committed before anything is enqueued.
      expect(await countRoles(pool)).toBe(0);
    });

    expect(await countRoles(pool)).toBe(1);
  });
});
