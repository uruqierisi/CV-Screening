import { beforeEach, describe, expect, it } from 'vitest';
import { pool, truncateAll } from './helpers/database.js';
import { createRole, createScreeningJob } from './helpers/fixtures.js';
import { withTransaction } from '../src/db/withTransaction.js';
import { archiveRole } from '../src/repositories/rolesRepository.js';
import { markCandidateParsing } from '../src/repositories/candidateStatusRepository.js';

/**
 * The BEFORE UPDATE trigger from migration 0006.
 *
 * The repositories all write `updated_at = now()` themselves, so none of this is
 * observable through them - which is exactly the point. Every test here issues
 * raw SQL of the kind a later phase, a backfill script or a psql session would
 * write, because the guarantee being tested is that such a statement cannot skip
 * the column. `findStuckCandidates` sweeps on `updated_at < cutoff`; a missed bump
 * there means a genuinely stuck candidate is never re-enqueued.
 */

beforeEach(truncateAll);

/**
 * @param {'roles' | 'candidates'} table literal from this file, never input
 * @param {string} id
 * @returns {Promise<Date>}
 */
async function updatedAtOf(table, id) {
  const { rows } = await pool.query(`SELECT updated_at FROM ${table} WHERE id = $1`, [id]);
  return rows[0].updated_at;
}

/**
 * A candidate in its initial state, with no repository call having touched it yet.
 *
 * @returns {Promise<{ roleId: string, candidateIds: string[] }>}
 */
async function seedCandidates(count = 1) {
  const { role } = await createRole();
  const { candidates } = await createScreeningJob({
    roleId: role.id,
    candidates: Array.from({ length: count }, () => ({})),
  });
  return { roleId: role.id, candidateIds: candidates.map((candidate) => candidate.id) };
}

describe('updated_at trigger', () => {
  it('bumps candidates.updated_at on an UPDATE that never mentions the column', async () => {
    const { candidateIds } = await seedCandidates();
    const before = await updatedAtOf('candidates', candidateIds[0]);

    // Deliberately raw, and deliberately not a status transition: this is the
    // shape of a statement written by someone who does not know the convention.
    await pool.query('UPDATE candidates SET candidate_name = $2 WHERE id = $1', [
      candidateIds[0],
      'Written by raw SQL',
    ]);

    const after = await updatedAtOf('candidates', candidateIds[0]);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('bumps roles.updated_at on an UPDATE that never mentions the column', async () => {
    const { role } = await createRole();
    const before = await updatedAtOf('roles', role.id);

    await pool.query('UPDATE roles SET description = $2 WHERE id = $1', [role.id, 'Rewritten']);

    const after = await updatedAtOf('roles', role.id);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('still agrees with the repositories, which set the column themselves', async () => {
    const { candidateIds } = await seedCandidates();
    const before = await updatedAtOf('candidates', candidateIds[0]);

    await markCandidateParsing(pool, candidateIds[0]);

    // The repository's explicit `updated_at = now()` and the trigger's now() are
    // the same value in the same transaction, so the redundancy is invisible -
    // which is why it was left in place rather than removed.
    const after = await updatedAtOf('candidates', candidateIds[0]);
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('does not overrule a statement that sets updated_at itself', async () => {
    const { candidateIds } = await seedCandidates();

    // Backdating is a legitimate operation - it is how the stuck-candidate sweep
    // is tested, and how any backfill would work. A trigger that overwrote this
    // would make `findStuckCandidates` untestable.
    await pool.query(`UPDATE candidates SET updated_at = now() - interval '1 hour' WHERE id = $1`, [
      candidateIds[0],
    ]);

    const after = await updatedAtOf('candidates', candidateIds[0]);
    expect(Date.now() - after.getTime()).toBeGreaterThan(59 * 60 * 1000);
  });

  it('leaves updated_at alone when an UPDATE changes nothing at all', async () => {
    const { role } = await createRole();

    const first = await archiveRole(pool, role.id);
    const second = await archiveRole(pool, role.id);

    // archiveRole is idempotent by contract, and PostgreSQL still writes a new row
    // version for an UPDATE whose values are all unchanged. Without the no-op guard
    // in the trigger, the second call would move a timestamp on a call that changed
    // nothing, and a retried DELETE /roles would stop being a true no-op.
    expect(second?.updatedAt.getTime()).toBe(first?.updatedAt.getTime());
  });

  it('gives every row changed by one transaction the same timestamp', async () => {
    const { candidateIds } = await seedCandidates(2);

    await withTransaction(async (client) => {
      for (const id of candidateIds) {
        await client.query('UPDATE candidates SET candidate_name = $2 WHERE id = $1', [
          id,
          `Name ${id}`,
        ]);
      }
    });

    // This is the now() vs clock_timestamp() decision, asserted rather than
    // described: rows that became visible atomically share one timestamp, instead
    // of being ordered among themselves by an accident of execution order.
    const [first, second] = await Promise.all(candidateIds.map((id) => updatedAtOf('candidates', id)));
    expect(second.getTime()).toBe(first.getTime());
  });
});
