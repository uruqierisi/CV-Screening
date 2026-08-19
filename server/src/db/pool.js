import pg from 'pg';
import { databaseUrl, env } from '../config/env.js';

const { Pool, types } = pg;

/**
 * `numeric` arrives as a string by default because it can exceed IEEE-754 range.
 * `match_score` is `numeric(4,1)` - always 0.0..100.0 - so a Number is exact and
 * saves every caller from parseFloat-ing it. This is the only numeric column in
 * the schema; revisit the day that stops being true.
 */
const PG_NUMERIC_OID = 1700;
types.setTypeParser(PG_NUMERIC_OID, (value) => (value === null ? null : Number(value)));

/**
 * `int8` (count(*)) also arrives as a string. Every count in this schema is a row
 * count that fits in a JS integer comfortably.
 */
const PG_INT8_OID = 20;
types.setTypeParser(PG_INT8_OID, (value) => (value === null ? null : Number(value)));

/** @type {import('pg').Pool} */
export const pool = new Pool({
  connectionString: databaseUrl,
  max: env.DB_POOL_MAX,
  // Fail fast on an unreachable database instead of hanging a request forever.
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30_000,
});

// An idle client can be terminated by the server (restart, admin disconnect).
// Without this listener that surfaces as an unhandled 'error' event and takes
// the process down.
pool.on('error', (error) => {
  process.stderr.write(`postgres pool error: ${error.message}\n`);
});

/**
 * Anything that can run a query: the pool itself, or a client bound to an open
 * transaction. Repositories accept this so a caller decides the transaction
 * boundary, not the repository.
 *
 * @typedef {import('pg').Pool | import('pg').PoolClient} Queryable
 */

/**
 * Closes every pooled connection. Call once, on shutdown or at the end of a
 * script; the pool is unusable afterwards.
 *
 * @returns {Promise<void>}
 */
export async function closePool() {
  await pool.end();
}
