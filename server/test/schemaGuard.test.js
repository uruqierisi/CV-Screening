import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import {
  appliedMigrationCount,
  assertSchemaMigrated,
  expectedMigrationCount,
} from '../src/db/assertSchema.js';

/**
 * The startup guard against a real, migrated database.
 *
 * The policy is tested with a stub in `test/unit/assertSchema.test.js`. What
 * cannot be stubbed is the half that talks to Postgres: that `to_regclass` finds
 * the migrations table under this connection's search path, and that the row
 * count matches what `scripts/migrate.js` actually applied. A guard that refused
 * a correctly migrated database would stop every deploy, so this is the case
 * worth holding against the real thing.
 */

describe('the startup schema guard, against the migrated test database', () => {
  it('counts the migrations globalSetup applied', async () => {
    expect(await appliedMigrationCount(pool)).toBe(expectedMigrationCount());
  });

  it('lets a properly migrated database start', async () => {
    const expected = expectedMigrationCount();

    await expect(assertSchemaMigrated(pool)).resolves.toEqual({
      applied: expected,
      expected,
    });
  });
});
