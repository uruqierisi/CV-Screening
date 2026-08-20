import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.js';
import { CANDIDATE_DEADLINE_MS } from '../../src/agents/index.js';
import {
  DRAIN_GRACE_MS,
  LOCK_DURATION_MS,
  STALLED_INTERVAL_MS,
} from '../../src/worker.js';
import {
  SCREEN_CANDIDATE_JOB,
  SCREENING_QUEUE_NAME,
  defaultJobOptions,
  enqueueCandidate,
  enqueueCandidates,
  retryJobId,
  screeningJobPayloadSchema,
} from '../../src/queue/screeningQueue.js';

/**
 * The knobs, and the one inequality that has to hold between two of them.
 *
 * Everything here is configuration, and configuration is exactly the kind of
 * thing that is asserted in a comment and then quietly wrong. The concurrency
 * dial and the lock duration both get pinned, because the first is what an
 * operator reaches for during an incident and the second is what stops two
 * workers screening one candidate.
 */

/** A minimal valid environment; every phase 4 variable is defaulted. */
const BASE = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
};

/**
 * @param {Record<string, string>} [overrides]
 */
function parse(overrides = {}) {
  const result = parseEnv({ ...BASE, ...overrides });
  if (!result.success) throw new Error(result.issues.join('; '));
  return result.env;
}

describe('SCREENING_CONCURRENCY - the concurrency dial', () => {
  it('defaults to 4', () => {
    // The bound on in-flight Anthropic calls for the whole system. One candidate
    // is two SEQUENTIAL model calls at roughly 8.2k input tokens (plan section
    // 9), so four in flight is around 8-10 requests a minute - inside a standard
    // tier, and four times faster than serial.
    expect(parse().SCREENING_CONCURRENCY).toBe(4);
  });

  it('accepts 1, which is what an operator turns it to during an incident', () => {
    expect(parse({ SCREENING_CONCURRENCY: '1' }).SCREENING_CONCURRENCY).toBe(1);
  });

  it('coerces the string every environment variable actually is', () => {
    expect(parse({ SCREENING_CONCURRENCY: '12' }).SCREENING_CONCURRENCY).toBe(12);
  });

  it.each(['0', '-1', '65', '2.5', 'four', ''])('rejects %o at startup', (value) => {
    // Fail fast and loudly. A concurrency of 0 would silently process nothing;
    // a concurrency of 500 would produce the wall of 429s the dial exists to
    // prevent.
    expect(parseEnv({ ...BASE, SCREENING_CONCURRENCY: value }).success).toBe(false);
  });
});

describe('the other phase 4 defaults', () => {
  it('defaults every one of them, so a copied .env.example starts', () => {
    const env = parse();
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.UPLOAD_ROOT).toBe('./uploads');
    expect(env.MAX_UPLOAD_BYTES).toBe(5 * 1024 * 1024);
    expect(env.MAX_BATCH_FILES).toBe(50);
    expect(env.REDIS_URL).toBe('redis://localhost:6389');
    expect(env.SCREENING_JOB_ATTEMPTS).toBe(3);
    expect(env.SCREENING_JOB_BACKOFF_MS).toBe(10_000);
    expect(env.UPLOAD_RATE_LIMIT_MAX).toBe(30);
    expect(env.UPLOAD_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(env.STUCK_CANDIDATE_AGE_MS).toBe(900_000);
  });

  it('refuses a REDIS_URL that is not a redis connection string', () => {
    expect(parseEnv({ ...BASE, REDIS_URL: 'http://localhost:6379' }).success).toBe(false);
    expect(parseEnv({ ...BASE, REDIS_URL: 'rediss://localhost:6379' }).success).toBe(true);
  });

  it('refuses a stuck-candidate age at or below the per-candidate deadline', () => {
    // A sweep that fires sooner than the agent layer's 240s deadline would
    // re-enqueue work that is still running - the one way this script could
    // double the API bill it exists to protect. The schema's floor is checked
    // against the deadline here rather than trusted from a comment.
    expect(parseEnv({ ...BASE, STUCK_CANDIDATE_AGE_MS: '1000' }).success).toBe(false);
    expect(parseEnv({ ...BASE, STUCK_CANDIDATE_AGE_MS: String(CANDIDATE_DEADLINE_MS) }).success).toBe(
      false,
    );
    expect(parse().STUCK_CANDIDATE_AGE_MS).toBeGreaterThan(CANDIDATE_DEADLINE_MS);
  });

  it('rejects a port outside the legal range', () => {
    expect(parseEnv({ ...BASE, PORT: '0' }).success).toBe(false);
    expect(parseEnv({ ...BASE, PORT: '70000' }).success).toBe(false);
  });
});

describe('the queue-lock inequality', () => {
  it('holds a job lock for longer than the agent layer will ever run', () => {
    // Plan section 4: "The BullMQ job timeout must exceed 240s". BullMQ expresses
    // that as lockDuration - a job whose lock expires is treated as stalled and
    // handed to another worker, so a lock shorter than the deadline would produce
    // two workers on one candidate, double spend, and contradictory writes.
    expect(LOCK_DURATION_MS).toBeGreaterThan(CANDIDATE_DEADLINE_MS);
    expect(CANDIDATE_DEADLINE_MS).toBe(240_000);
  });

  it('does not check for stalled jobs more often than the lock it is checking', () => {
    expect(STALLED_INTERVAL_MS).toBeGreaterThanOrEqual(LOCK_DURATION_MS);
  });

  it('gives a draining worker less than a full candidate deadline to finish', () => {
    // A deploy should not wait four minutes on one slow CV; the abort signal is
    // what bounds it, and the processor's retryable path releases the candidate.
    expect(DRAIN_GRACE_MS).toBeLessThan(CANDIDATE_DEADLINE_MS);
  });
});

describe('the queue job contract', () => {
  it('has one job name on one queue', () => {
    expect(SCREENING_QUEUE_NAME).toBe('candidate-screening');
    expect(SCREEN_CANDIDATE_JOB).toBe('screen-candidate');
  });

  it('accepts only a candidate id, and rejects anything extra', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(screeningJobPayloadSchema.parse({ candidateId: id })).toEqual({ candidateId: id });
    // The payload comes out of Redis, which is rebuildable and therefore not
    // trusted to have the shape we last wrote. A role embedded in the payload
    // would also be a stale copy of a role the worker should re-read.
    expect(screeningJobPayloadSchema.safeParse({ candidateId: id, roleId: id }).success).toBe(false);
    expect(screeningJobPayloadSchema.safeParse({ candidateId: 'not-a-uuid' }).success).toBe(false);
    expect(screeningJobPayloadSchema.safeParse({}).success).toBe(false);
  });

  it('keeps failures forever and successes for a bounded window', () => {
    const options = defaultJobOptions();
    // The dead-letter path: a candidate that exhausted its attempts stays in the
    // failed set with its stack, which is the thing an operator goes looking for.
    expect(options.removeOnFail).toBe(false);
    expect(options.removeOnComplete).toEqual({ age: 24 * 60 * 60, count: 1000 });
    expect(options.backoff).toEqual({ type: 'exponential', delay: 10_000 });
    expect(options.attempts).toBe(3);
  });
});

describe('enqueue job ids', () => {
  /** Records what BullMQ would have been asked to do. */
  function fakeQueue() {
    /** @type {any[]} */
    const added = [];
    return {
      added,
      async add(name, data, opts) {
        added.push({ name, data, opts });
      },
      async addBulk(jobs) {
        added.push(...jobs);
      },
    };
  }

  const candidateId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('uses the candidate UUID as the queue-job id on a first enqueue', async () => {
    const queue = fakeQueue();
    const jobId = await enqueueCandidate({ candidateId, queue: /** @type {any} */ (queue) });

    // This is what makes a duplicate enqueue a no-op rather than a second set of
    // LLM calls - the deduplication plan section 4 relies on.
    expect(jobId).toBe(candidateId);
    expect(queue.added[0].opts.jobId).toBe(candidateId);
    expect(queue.added[0].name).toBe(SCREEN_CANDIDATE_JOB);
    expect(queue.added[0].data).toEqual({ candidateId });
  });

  it('uses candidateId-retry-N on a retry, because the original id is consumed', async () => {
    const queue = fakeQueue();
    const jobId = await enqueueCandidate({
      candidateId,
      attempt: 2,
      queue: /** @type {any} */ (queue),
    });

    // BullMQ refuses an id that already exists, even a completed one, so a retry
    // under the candidate UUID would silently do nothing at all.
    // Not a colon: BullMQ builds its own Redis keys with `:` and rejects a
    // custom id containing one. Plan section 3 said `candidateId:attempts`; it
    // was corrected rather than left describing an id the queue refuses.
    expect(jobId).toBe(`${candidateId}-retry-2`);
    expect(queue.added[0].opts.jobId).toBe(`${candidateId}-retry-2`);
    expect(retryJobId(candidateId, 2)).toBe(jobId);
  });

  it('adds a batch in one round trip, one job per candidate', async () => {
    const queue = fakeQueue();
    const ids = [candidateId, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'];

    expect(await enqueueCandidates({ candidateIds: ids, queue: /** @type {any} */ (queue) })).toEqual(
      ids,
    );
    expect(queue.added).toHaveLength(2);
    expect(queue.added.map((job) => job.opts.jobId)).toEqual(ids);
  });

  it('does not talk to the queue at all for an empty batch', async () => {
    const queue = fakeQueue();
    expect(await enqueueCandidates({ candidateIds: [], queue: /** @type {any} */ (queue) })).toEqual(
      [],
    );
    expect(queue.added).toHaveLength(0);
  });
});

describe('CORS_ALLOWED_ORIGINS - the allowlist', () => {
  it('defaults to the Vite dev server origin, and not to a wildcard', () => {
    // `web/vite.config.js` pins the dev server to 5173. The default matters more
    // than the value: a `*` default would mean this variable never has to be set
    // and never fails, so a deployment serving the UI from another origin would
    // discover the omission only when a user reported that nothing loads.
    // Defaulting to the development origin makes that deployment fail on its
    // first cross-origin request instead, which is a failure the person
    // deploying sees.
    expect(parse().CORS_ALLOWED_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('splits and trims a comma-separated allowlist', () => {
    expect(
      parse({ CORS_ALLOWED_ORIGINS: 'https://app.example.com , https://admin.example.com' })
        .CORS_ALLOWED_ORIGINS,
    ).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });

  it('refuses a wildcard, by name, at startup', () => {
    // Not silently ignored and not quietly honoured. `*` is a legitimate CORS
    // value and an illegitimate one here, so the process has to say so rather
    // than start with a policy nobody chose.
    const result = parseEnv({ ...BASE, CORS_ALLOWED_ORIGINS: '*' });

    expect(result.success).toBe(false);
    expect(result.issues.join('\n')).toContain('CORS_ALLOWED_ORIGINS');
  });

  it('refuses anything that is not a bare origin', () => {
    // A browser sends `Origin: https://app.example.com` - no path, no trailing
    // slash. An allowlist entry carrying either matches nothing, and the symptom
    // is every request failing with no clue as to why, so it is rejected here.
    for (const value of [
      'https://app.example.com/',
      'https://app.example.com/api',
      'app.example.com',
      'not a url',
      '',
    ]) {
      expect(parseEnv({ ...BASE, CORS_ALLOWED_ORIGINS: value }).success, value).toBe(false);
    }
  });

  it('accepts an origin with an explicit port and one without', () => {
    expect(parse({ CORS_ALLOWED_ORIGINS: 'http://localhost:4173' }).CORS_ALLOWED_ORIGINS).toEqual([
      'http://localhost:4173',
    ]);
    expect(parse({ CORS_ALLOWED_ORIGINS: 'https://cv.example.com' }).CORS_ALLOWED_ORIGINS).toEqual([
      'https://cv.example.com',
    ]);
  });
});
