import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, truncateAll } from '../helpers/database.js';
import { createRole, createScreeningJob, driveCandidateToDone } from '../helpers/fixtures.js';
import { markCandidateParsing } from '../../src/repositories/candidateStatusRepository.js';
import { DEFAULT_LIMIT, parseArgs, reconcileStuck } from '../../src/scripts/reconcileStuck.js';

/**
 * The stranded-candidate sweep.
 *
 * This script is the whole mitigation for the one cost of enqueueing strictly
 * after COMMIT: a crash in that window leaves candidates `pending` with no queue
 * job to run them. It is also what rebuilds the queue after Redis is flushed,
 * which is what "Redis is rebuildable, Postgres is authoritative" means in
 * practice.
 *
 * The enqueue is injected, so the rules are tested against a real Postgres with
 * no Redis running.
 */

/** Ages a candidate by rewriting `updated_at` directly; nothing else depends on wall-clock time. */
async function age(candidateId, minutes) {
  await pool.query(
    `UPDATE candidates SET updated_at = now() - ($2 || ' minutes')::interval WHERE id = $1`,
    [candidateId, String(minutes)],
  );
}

/** Records what would have been enqueued. */
function recorder() {
  /** @type {string[][]} */
  const calls = [];
  return {
    calls,
    async enqueue({ candidateIds }) {
      calls.push([...candidateIds]);
      return candidateIds;
    },
  };
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await pool.end();
});

describe('reconcileStuck', () => {
  it('re-enqueues a candidate stranded in pending past the cutoff', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id, candidates: [{}] });
    await age(candidates[0].id, 30);

    const queue = recorder();
    const result = await reconcileStuck({ ageMs: 900_000, enqueue: queue.enqueue });

    expect(result).toMatchObject({ found: 1, released: 0, enqueued: 1 });
    expect(queue.calls).toEqual([[candidates[0].id]]);
  });

  it('leaves a candidate that is making progress alone', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id, candidates: [{}] });
    await markCandidateParsing(pool, candidates[0].id);

    const queue = recorder();
    // The cutoff is on `updated_at`, not `created_at`: a candidate that moved to
    // `parsing` two minutes ago is working, however old the upload is.
    const result = await reconcileStuck({ ageMs: 900_000, enqueue: queue.enqueue });

    expect(result.found).toBe(0);
    expect(queue.calls).toEqual([]);
  });

  it('releases a candidate stuck mid-pipeline back to pending before re-enqueueing', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id, candidates: [{}] });
    await markCandidateParsing(pool, candidates[0].id);
    await age(candidates[0].id, 30);

    const queue = recorder();
    const result = await reconcileStuck({ ageMs: 900_000, enqueue: queue.enqueue });

    // The worker's claim only accepts `pending`, so re-enqueueing without the
    // release would produce a job that immediately skips.
    expect(result).toMatchObject({ found: 1, released: 1, enqueued: 1 });
    const { rows } = await pool.query('SELECT status FROM candidates WHERE id = $1', [
      candidates[0].id,
    ]);
    expect(rows[0].status).toBe('pending');
  });

  it('never touches a terminal candidate', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id, candidates: [{}] });
    await driveCandidateToDone(candidates[0].id);
    await age(candidates[0].id, 120);

    const queue = recorder();
    expect(await reconcileStuck({ ageMs: 900_000, enqueue: queue.enqueue })).toMatchObject({
      found: 0,
      enqueued: 0,
    });
  });

  it('lists what it would do without doing it, under --dry-run', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id, candidates: [{}] });
    await markCandidateParsing(pool, candidates[0].id);
    await age(candidates[0].id, 30);

    const queue = recorder();
    const result = await reconcileStuck({ ageMs: 900_000, dryRun: true, enqueue: queue.enqueue });

    // The repair costs real API money, so a person decides - and decides from a
    // list rather than from a guess.
    expect(result).toMatchObject({ found: 1, released: 0, enqueued: 0, dryRun: true });
    expect(result.candidateIds).toEqual([candidates[0].id]);
    expect(queue.calls).toEqual([]);
    const { rows } = await pool.query('SELECT status FROM candidates WHERE id = $1', [
      candidates[0].id,
    ]);
    expect(rows[0].status).toBe('parsing');
  });

  it('sweeps oldest first and honours the limit', async () => {
    const { role } = await createRole();
    const { candidates } = await createScreeningJob({ roleId: role.id, candidates: [{}, {}, {}] });
    await age(candidates[0].id, 60);
    await age(candidates[1].id, 45);
    await age(candidates[2].id, 30);

    const queue = recorder();
    const result = await reconcileStuck({ ageMs: 900_000, limit: 2, enqueue: queue.enqueue });

    expect(result.candidateIds).toEqual([candidates[0].id, candidates[1].id]);
  });

  it('does nothing, quietly, when there is nothing stranded', async () => {
    const queue = recorder();
    expect(await reconcileStuck({ enqueue: queue.enqueue })).toMatchObject({
      found: 0,
      enqueued: 0,
    });
    expect(queue.calls).toEqual([]);
  });
});

describe('parseArgs', () => {
  it('defaults to a live run with the standard limit', () => {
    const args = parseArgs([]);
    expect(args.dryRun).toBe(false);
    expect(args.limit).toBe(DEFAULT_LIMIT);
  });

  it('reads --dry-run, --limit and --age-ms', () => {
    expect(parseArgs(['--dry-run', '--limit=10', '--age-ms=60000'])).toEqual({
      dryRun: true,
      limit: 10,
      ageMs: 60_000,
    });
  });

  it('refuses an unknown argument rather than ignoring it', () => {
    // A typo in a flag on a script that spends money should stop the script, not
    // silently run it with defaults.
    expect(() => parseArgs(['--dryrun'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--limit=0'])).toThrow(/invalid value/);
    expect(() => parseArgs(['--limit=lots'])).toThrow(/invalid value/);
  });
});
