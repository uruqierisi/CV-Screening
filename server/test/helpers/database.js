import { env, databaseUrl } from '../../src/config/env.js';
import { pool } from '../../src/db/pool.js';

/**
 * Test database access.
 *
 * Isolation is by truncation between tests rather than by wrapping each test in a
 * rolled-back transaction. The transaction approach would be faster, but it makes
 * it impossible to test the one thing this schema most needs tested: a DEFERRABLE
 * constraint trigger that only fires at COMMIT. A test that never commits cannot
 * observe it.
 */

// Ordered so a TRUNCATE with CASCADE is not doing the reasoning for us; CASCADE
// is still present because candidates and screening_jobs reference roles.
const TABLES = ['candidates', 'screening_jobs', 'role_elimination_rules', 'role_criteria', 'roles'];

/**
 * Second line of defence behind globalSetup: every helper that deletes data
 * re-checks which database it is pointed at. The cost of being wrong here is
 * someone's development data.
 */
function assertTestDatabase() {
  if (env.NODE_ENV !== 'test' || databaseUrl !== env.TEST_DATABASE_URL) {
    throw new Error('truncateAll refused: not connected to TEST_DATABASE_URL');
  }
}

/**
 * Empties every table. TRUNCATE does not fire row-level triggers, so this does
 * not trip the sum-to-100 constraint trigger on the way out.
 *
 * @returns {Promise<void>}
 */
export async function truncateAll() {
  assertTestDatabase();
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/**
 * The shared pool for tests. Closed once, in a global teardown hook registered by
 * whichever test file needs it; vitest tears the worker down regardless.
 *
 * @type {import('pg').Pool}
 */
export { pool };
