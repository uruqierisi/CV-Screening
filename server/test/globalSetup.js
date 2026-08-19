import pg from 'pg';
import { env, databaseUrl } from '../src/config/env.js';
import { runMigrations } from '../src/scripts/migrate.js';

/**
 * Prepares the test database once per `vitest run`.
 *
 * Creates it if it does not exist, then migrates all the way down and all the way
 * up again. The down leg is not ceremony: it means every test run exercises every
 * `-- Down Migration` in the repository, so a broken down is a failing test suite
 * rather than something discovered during a production rollback.
 */

/**
 * Splits a connection string into "the server" and "the database name", so a
 * CREATE DATABASE can be issued against the maintenance database.
 *
 * @param {string} connectionString
 * @returns {{ maintenanceUrl: string, databaseName: string }}
 */
function splitConnectionString(connectionString) {
  const url = new URL(connectionString);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));

  if (!databaseName) {
    throw new Error('TEST_DATABASE_URL must include a database name');
  }

  url.pathname = '/postgres';
  return { maintenanceUrl: url.toString(), databaseName };
}

/**
 * @param {string} connectionString
 * @returns {Promise<void>}
 */
async function ensureDatabaseExists(connectionString) {
  const { maintenanceUrl, databaseName } = splitConnectionString(connectionString);
  const client = new pg.Client({ connectionString: maintenanceUrl });

  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      databaseName,
    ]);

    if (rows.length === 0) {
      // A database name cannot be a bind parameter. escapeIdentifier is pg's own
      // quoting, and the value comes from our env schema, not from a request.
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(databaseName)}`);
    }
  } finally {
    await client.end();
  }
}

export async function setup() {
  if (env.NODE_ENV !== 'test') {
    throw new Error(`refusing to run tests with NODE_ENV=${env.NODE_ENV}`);
  }
  if (databaseUrl !== env.TEST_DATABASE_URL) {
    throw new Error('refusing to run tests against a database other than TEST_DATABASE_URL');
  }

  await ensureDatabaseExists(databaseUrl);
  await runMigrations({ direction: 'down' });
  await runMigrations({ direction: 'up' });
}
