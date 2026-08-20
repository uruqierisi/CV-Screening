import { rm } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { env, databaseUrl } from '../src/config/env.js';
import { runMigrations } from '../src/scripts/migrate.js';
import { TEST_UPLOAD_ROOT } from './uploadRoot.js';

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

/**
 * The upload root this run owns.
 *
 * Taken from the shared constant rather than from `env.UPLOAD_ROOT`, because
 * this file runs in vitest's MAIN process, where the `db` project's `env` has
 * not been applied - `env.UPLOAD_ROOT` here is the development default. That
 * mistake is what the guard below caught the first time this was written.
 */
const uploadRoot = path.resolve(TEST_UPLOAD_ROOT);

/**
 * Refuses to delete a root the suite does not own.
 *
 * The guard is the point. This function removes a directory tree, and the value
 * it removes comes from an environment variable - so if `UPLOAD_ROOT` is ever
 * unset, or points at the development root, or is edited to something careless,
 * the failure mode without this check is deleting a reviewer's uploaded CVs and
 * orphaning every candidate row that referenced them.
 *
 * @returns {Promise<void>}
 */
async function removeTestUploadRoot() {
  const name = path.basename(uploadRoot);

  if (!name.startsWith('uploads-')) {
    throw new Error(
      `refusing to remove ${uploadRoot}: the test upload root must be named uploads-*, ` +
        'so this can never delete the development root',
    );
  }

  await rm(uploadRoot, { recursive: true, force: true });
}

export async function setup() {
  if (env.NODE_ENV !== 'test') {
    throw new Error(`refusing to run tests with NODE_ENV=${env.NODE_ENV}`);
  }
  if (databaseUrl !== env.TEST_DATABASE_URL) {
    throw new Error('refusing to run tests against a database other than TEST_DATABASE_URL');
  }

  // Empty before, so a run that was killed mid-way cannot make the next one fail
  // a file count it has nothing to do with.
  await removeTestUploadRoot();

  await ensureDatabaseExists(databaseUrl);
  await runMigrations({ direction: 'down' });
  await runMigrations({ direction: 'up' });
}

/**
 * Removes the upload root after the run, so the repository is left clean and
 * `git status` after `npm test` shows nothing.
 *
 * @returns {Promise<void>}
 */
export async function teardown() {
  await removeTestUploadRoot();
}
