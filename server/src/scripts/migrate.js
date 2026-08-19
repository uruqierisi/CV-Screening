import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runner } from 'node-pg-migrate';
import { databaseUrl as defaultDatabaseUrl } from '../config/env.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/**
 * Runs the migration history against a database.
 *
 * Wrapped rather than shelling out to the CLI so the test global setup can
 * migrate the test database with the same code path a developer runs, and so
 * the connection string comes from the validated env schema instead of being
 * read a second way.
 *
 * @param {object} options
 * @param {'up' | 'down'} options.direction
 * @param {number} [options.count] migrations to run; omit for "all"
 * @param {string} [options.databaseUrl] defaults to the current NODE_ENV's database
 * @param {boolean} [options.verbose] print each statement
 * @returns {Promise<Array<{ path: string, name: string, timestamp: number }>>} migrations run
 */
export async function runMigrations({ direction, count, databaseUrl, verbose = false }) {
  return runner({
    databaseUrl: databaseUrl ?? defaultDatabaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    direction,
    count: count ?? Number.POSITIVE_INFINITY,
    // One transaction for the whole run: a half-applied history is worse than
    // no history, and every migration here is DDL that Postgres can roll back.
    singleTransaction: true,
    // Refuses to run if a migration was inserted before one already applied.
    checkOrder: true,
    verbose,
  });
}

/**
 * @param {string[]} argv
 * @returns {{ direction: 'up' | 'down' | 'redo', count: number | undefined }}
 */
function parseArgs(argv) {
  const [command = 'up', countArg] = argv;

  if (command !== 'up' && command !== 'down' && command !== 'redo') {
    throw new Error(`unknown command "${command}" (expected: up | down [n|all] | redo)`);
  }

  if (countArg === undefined) {
    // `down` with no argument rolls back one migration, matching the CLI. `up`
    // and `redo` default to the whole history.
    return { direction: command, count: command === 'down' ? 1 : undefined };
  }

  if (countArg === 'all') {
    return { direction: command, count: undefined };
  }

  const count = Number(countArg);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`invalid count "${countArg}" (expected a positive integer or "all")`);
  }

  return { direction: command, count };
}

async function main() {
  const { direction, count } = parseArgs(process.argv.slice(2));

  if (direction === 'redo') {
    // Proves every down actually works, from whatever state the database is in.
    process.stdout.write('> migrating down (all)\n');
    await runMigrations({ direction: 'down' });
    process.stdout.write('> migrating up (all)\n');
    await runMigrations({ direction: 'up' });
  } else {
    await runMigrations({ direction, count });
  }

  process.stdout.write('migrations complete\n');
}

// Only run when executed directly, so importing runMigrations has no side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`migration failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
