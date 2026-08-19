import { pool } from './pool.js';

/**
 * Runs `fn` inside a single database transaction and hands it the bound client.
 *
 * Transaction boundaries belong to the service layer: repositories take a
 * `Queryable` and never open one themselves, so a service can compose several
 * repository calls into one atomic unit.
 *
 * The callback must use the client it is given. A query issued against the pool
 * from inside the callback runs on a different connection and is therefore
 * outside the transaction.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @param {{ pool?: import('pg').Pool }} [options] injectable pool, for tests
 * @returns {Promise<T>} whatever `fn` resolves to, after COMMIT
 */
export async function withTransaction(fn, options = {}) {
  const client = await (options.pool ?? pool).connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    // COMMIT is inside the try on purpose: deferred constraint triggers - the
    // sum-to-100 check on role_criteria - only fire here, so COMMIT itself can
    // throw and must roll back like any other failure.
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the original error is the useful one
      // and swallowing this keeps it from being masked.
    }
    throw error;
  } finally {
    client.release();
  }
}
