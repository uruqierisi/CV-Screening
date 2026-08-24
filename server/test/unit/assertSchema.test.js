import { describe, expect, it } from 'vitest';
import {
  MIGRATIONS_TABLE,
  SchemaNotMigratedError,
  assertSchemaMigrated,
  expectedMigrationCount,
} from '../../src/db/assertSchema.js';

/**
 * The startup guard's policy, against a stub client.
 *
 * No database here on purpose: the decision is "how many are applied versus how
 * many does this build carry", and that is arithmetic. The one case that needs a
 * real Postgres - that a properly migrated database passes - is asserted in
 * `test/schemaGuard.test.js`, where there is one.
 */

/**
 * A client that answers the guard's two queries and nothing else.
 *
 * @param {{ tableExists: boolean, applied?: number }} state
 * @returns {{ query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }}
 */
function stubClient({ tableExists, applied = 0 }) {
  return {
    async query(text) {
      if (text.startsWith('SELECT to_regclass')) {
        return { rows: [{ relation: tableExists ? MIGRATIONS_TABLE : null }] };
      }
      return { rows: [{ count: applied }] };
    },
  };
}

describe('assertSchemaMigrated', () => {
  it('refuses an empty database, naming the command that fixes it', async () => {
    const error = await assertSchemaMigrated(stubClient({ tableExists: false })).catch((e) => e);

    expect(error).toBeInstanceOf(SchemaNotMigratedError);
    expect(error.message).toContain('npm run migrate');
    expect(error.applied).toBe(0);
    expect(error.expected).toBe(expectedMigrationCount());
  });

  it('refuses a migrations table that exists but is empty', async () => {
    // Distinct from the case above: a `down` to zero leaves the table behind.
    const error = await assertSchemaMigrated(
      stubClient({ tableExists: true, applied: 0 }),
    ).catch((e) => e);

    expect(error).toBeInstanceOf(SchemaNotMigratedError);
    expect(error.message).toContain('npm run migrate');
  });

  it('refuses a database behind this build, and says by how much', async () => {
    // What deploying code with a new migration looks like when the schema was
    // not updated first - the same runtime failure, one step less obvious.
    const expected = expectedMigrationCount();
    const error = await assertSchemaMigrated(
      stubClient({ tableExists: true, applied: expected - 1 }),
    ).catch((e) => e);

    expect(error).toBeInstanceOf(SchemaNotMigratedError);
    expect(error.message).toContain(`${expected - 1} of ${expected}`);
  });

  it('accepts a database carrying exactly this build', async () => {
    const expected = expectedMigrationCount();

    await expect(
      assertSchemaMigrated(stubClient({ tableExists: true, applied: expected })),
    ).resolves.toEqual({ applied: expected, expected });
  });

  it('accepts a database ahead of this build, because that is a rollback', async () => {
    // The older code being rolled back to was working against that schema a
    // moment ago. Refusing here would turn a rollback into an outage.
    const expected = expectedMigrationCount();

    await expect(
      assertSchemaMigrated(stubClient({ tableExists: true, applied: expected + 3 })),
    ).resolves.toEqual({ applied: expected + 3, expected });
  });
});

describe('expectedMigrationCount', () => {
  it('counts the .sql files this build ships', () => {
    // A floor rather than a fixed number: this asserts the directory is being
    // read at all, without breaking every time a migration is added.
    expect(expectedMigrationCount()).toBeGreaterThanOrEqual(8);
  });
});
