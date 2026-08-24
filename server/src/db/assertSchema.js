/**
 * Refuses to start a process whose database has not been migrated.
 *
 * ## The failure this exists to prevent
 *
 * Nothing in the deployment runs migrations - the blueprint installs and starts,
 * and the schema is applied by hand from a developer's machine against Neon's
 * direct host, because `node-pg-migrate` takes a session-level advisory lock
 * that a transaction-mode pooler will not hold. That arrangement is fine right
 * up until somebody forgets.
 *
 * What made forgetting expensive is that **`/health` cannot see it**. The
 * database probe is `SELECT 1`, which succeeds perfectly well against a database
 * with no tables in it, so the platform marks the deploy healthy, the service
 * goes live, and every real request fails with `relation "roles" does not
 * exist`. A green deploy that 500s on every request is a much worse hour than a
 * process that refuses to boot and says why.
 *
 * So this is checked once, at startup, before the port is opened. A process that
 * will not start is a failure an operator can see immediately, and the message
 * names the command that fixes it.
 *
 * ## Why the count and not just the table
 *
 * An absent `pgmigrations` table is the obvious case: nothing has ever been
 * migrated. The second case is subtler and just as broken - the table exists and
 * is behind, which is what a deploy of code that ships a new migration looks
 * like when the schema was not updated first. Both produce the same class of
 * runtime failure, so both refuse here, and the comparison is against the
 * migration files this build actually carries rather than a number written down
 * somewhere that would drift.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Set by `scripts/migrate.js`; node-pg-migrate's default name. */
export const MIGRATIONS_TABLE = 'pgmigrations';

/** The same directory `scripts/migrate.js` runs. */
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

/** What to run. Named in the error, so the message is actionable on its own. */
const REMEDY = 'npm run migrate';

/**
 * A database that cannot serve this build.
 *
 * A distinct class so `server.js` can report it as a configuration failure
 * rather than as an unexpected crash, and so a test can assert on the type
 * instead of on the wording.
 */
export class SchemaNotMigratedError extends Error {
  /**
   * @param {string} message
   * @param {{ applied: number, expected: number }} state
   */
  constructor(message, state) {
    super(message);
    this.name = 'SchemaNotMigratedError';
    /** @type {number} */
    this.applied = state.applied;
    /** @type {number} */
    this.expected = state.expected;
  }
}

/**
 * How many migration files this build carries.
 *
 * Read synchronously and once: this runs before the port opens, the directory
 * is part of the deployed tree, and an unreadable migrations directory is a
 * broken build rather than something to recover from.
 *
 * @returns {number}
 */
export function expectedMigrationCount() {
  return readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).length;
}

/**
 * How many migrations the database has recorded.
 *
 * `to_regclass` rather than a `SELECT` in a `try`: an absent table is an
 * expected answer here, not an error to catch, and catching would also swallow a
 * genuine connection failure - which must stay loud and distinguishable.
 *
 * @param {{ query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }} client
 * @returns {Promise<number>} 0 when the table does not exist
 */
export async function appliedMigrationCount(client) {
  const { rows } = await client.query('SELECT to_regclass($1) AS relation', [MIGRATIONS_TABLE]);

  if (rows[0]?.relation === null || rows[0]?.relation === undefined) return 0;

  const counted = await client.query(`SELECT count(*)::int AS count FROM ${MIGRATIONS_TABLE}`);
  return counted.rows[0]?.count ?? 0;
}

/**
 * Throws unless the database carries at least this build's migrations.
 *
 * "At least" rather than "exactly": a database ahead of this build is a rollback
 * in progress, and the older code it is running was working against that schema
 * a moment ago. Refusing there would turn a rollback into an outage.
 *
 * @param {{ query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> }} client
 * @returns {Promise<{ applied: number, expected: number }>}
 * @throws {SchemaNotMigratedError}
 */
export async function assertSchemaMigrated(client) {
  const expected = expectedMigrationCount();
  const applied = await appliedMigrationCount(client);

  if (applied === 0) {
    throw new SchemaNotMigratedError(
      `the database has no schema: \`${MIGRATIONS_TABLE}\` is absent or empty, and this build ` +
        `carries ${expected} migrations. Run \`${REMEDY}\` against it before starting the API.`,
      { applied, expected },
    );
  }

  if (applied < expected) {
    throw new SchemaNotMigratedError(
      `the database is behind this build: ${applied} of ${expected} migrations applied. ` +
        `Run \`${REMEDY}\` against it before starting the API.`,
      { applied, expected },
    );
  }

  return { applied, expected };
}
