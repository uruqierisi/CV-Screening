/**
 * Re-enqueues candidates that are stranded.
 *
 * ## Why this exists
 *
 * Plan section 4 puts the enqueue strictly **after** COMMIT, so a worker can
 * never pick up a row that is not yet visible. That ordering has one cost, and
 * this script is the whole of the mitigation: **a crash between COMMIT and
 * enqueue leaves candidates in `pending` with no queue job to run them.** Redis
 * being flushed does the same thing to a larger set - which is exactly what
 * "Redis is rebuildable, Postgres is authoritative" means in practice, and this
 * is the rebuild.
 *
 * A second, smaller case: a worker killed mid-candidate leaves a row in
 * `parsing` or `evaluating`. BullMQ's stalled-job handling covers that when the
 * queue entry still exists; this covers it when it does not.
 *
 * ## Why it is manual
 *
 * Recorded rather than apologised for. Running it on a timer would mean a
 * background process that re-enqueues work - and therefore spends API budget -
 * without anybody asking. The failure it repairs is rare and visible (candidates
 * that never leave `pending`), and the repair costs real money, so a person
 * decides. `--dry-run` exists so that decision can be made from a list.
 *
 * ## Safety
 *
 * Two properties keep a sweep from making things worse:
 *
 * 1. **The age cutoff is on `updated_at`, not `created_at`.** A candidate that
 *    moved to `evaluating` two minutes ago is making progress, however old the
 *    upload is.
 * 2. **The queue-job id is the candidate UUID**, so re-enqueueing something that
 *    is already queued is a no-op rather than a second screening. This is the
 *    same deduplication property the upload path relies on, used here as a
 *    safety net.
 *
 * A candidate in `parsing` or `evaluating` is released back to `pending` first,
 * because the worker's claim only accepts `pending` - re-enqueueing without that
 * would produce a job that immediately skips.
 */

import { pathToFileURL } from 'node:url';
import { env } from '../config/env.js';
import { closePool, pool } from '../db/pool.js';
import { findStuckCandidates } from '../repositories/candidatesRepository.js';
import { releaseCandidateToPending } from '../repositories/candidateStatusRepository.js';
import { closeRedis } from '../queue/connection.js';
import { closeScreeningQueue, enqueueCandidates } from '../queue/screeningQueue.js';

/** Never sweep more than this in one run; a bigger backlog wants a second look. */
export const DEFAULT_LIMIT = 500;

/**
 * @typedef {object} ReconcileResult
 * @property {number} found
 * @property {number} released candidates moved back to `pending` from a
 *   non-terminal working status
 * @property {number} enqueued
 * @property {string[]} candidateIds
 * @property {boolean} dryRun
 */

/**
 * The sweep itself, as a function, so it can be tested against a real database
 * with the enqueue injected and no Redis running.
 *
 * @param {object} [options]
 * @param {import('../db/pool.js').Queryable} [options.db]
 * @param {Date} [options.now] injected clock
 * @param {number} [options.ageMs] defaults to `STUCK_CANDIDATE_AGE_MS`
 * @param {number} [options.limit]
 * @param {boolean} [options.dryRun]
 * @param {(input: { candidateIds: string[] }) => Promise<string[]>} [options.enqueue]
 * @param {{ info?: Function }} [options.logger]
 * @returns {Promise<ReconcileResult>}
 */
export async function reconcileStuck({
  db = pool,
  now = new Date(),
  ageMs = env.STUCK_CANDIDATE_AGE_MS,
  limit = DEFAULT_LIMIT,
  dryRun = false,
  enqueue = enqueueCandidates,
  logger,
} = {}) {
  const updatedBefore = new Date(now.getTime() - ageMs);
  const stuck = await findStuckCandidates(db, { updatedBefore, limit });

  const candidateIds = stuck.map((candidate) => candidate.id);

  if (dryRun || candidateIds.length === 0) {
    return {
      found: stuck.length,
      released: 0,
      enqueued: 0,
      candidateIds,
      dryRun,
    };
  }

  // Anything already `pending` needs no release; the guard rejects it and that
  // is the correct outcome, not a failure.
  let released = 0;
  for (const candidate of stuck) {
    if (candidate.status === 'pending') continue;
    const result = await releaseCandidateToPending(db, candidate.id);
    if (result.ok) released += 1;
  }

  await enqueue({ candidateIds });
  logger?.info?.({ found: stuck.length, released, enqueued: candidateIds.length }, 'reconcile complete');

  return {
    found: stuck.length,
    released,
    enqueued: candidateIds.length,
    candidateIds,
    dryRun: false,
  };
}

/**
 * @param {string[]} argv
 * @returns {{ dryRun: boolean, limit: number, ageMs: number }}
 */
export function parseArgs(argv) {
  let dryRun = false;
  let limit = DEFAULT_LIMIT;
  let ageMs = env.STUCK_CANDIDATE_AGE_MS;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    const [flag, rawValue] = arg.split('=');
    if (flag === '--limit' || flag === '--age-ms') {
      const value = Number(rawValue);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`invalid value for ${flag}: "${rawValue}"`);
      }
      if (flag === '--limit') limit = value;
      else ageMs = value;
      continue;
    }

    throw new Error(`unknown argument "${arg}" (expected: --dry-run | --limit=N | --age-ms=N)`);
  }

  return { dryRun, limit, ageMs };
}

async function main() {
  const { dryRun, limit, ageMs } = parseArgs(process.argv.slice(2));

  const result = await reconcileStuck({ dryRun, limit, ageMs });

  process.stdout.write(
    `${dryRun ? '[dry run] ' : ''}stuck candidates found: ${result.found}` +
      `, released: ${result.released}, enqueued: ${result.enqueued}\n`,
  );
  for (const candidateId of result.candidateIds) {
    process.stdout.write(`  ${candidateId}\n`);
  }

  await closeScreeningQueue();
  await closeRedis();
  await closePool();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`reconcile failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
