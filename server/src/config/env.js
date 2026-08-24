import { z } from 'zod';

/**
 * Process configuration.
 *
 * Environment variables only, parsed once at import time. A bad or missing value
 * kills the process here rather than surfacing as a confusing runtime failure
 * three layers in.
 *
 * Phase 1 declared only what the data layer uses; phase 2b added the Anthropic
 * key; phase 4 adds the HTTP server, the upload limits, the queue and the
 * concurrency dial; phase 5 adds the CORS allowlist. Everything phase 4 added carries a default, deliberately: a
 * reviewer who copies `.env.example` and starts Docker gets a working system,
 * and an unused-but-required variable can never block `npm run migrate`.
 *
 * The two values with no default remain the two that cannot have one - the
 * database URL, and the Anthropic key (which is checked at the point of use, so
 * that nothing which spends no tokens is blocked by its absence).
 */

const postgresUrl = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
    { message: 'must be a postgres:// or postgresql:// connection string' },
  );

/**
 * A bare HTTP origin: scheme, host and optional port, and nothing else.
 *
 * `z.string().url()` is not enough here. It accepts `http://localhost:5173/api`
 * and `http://localhost:5173/`, neither of which a browser ever sends as an
 * `Origin` header - so an allowlist built from one would silently match nothing
 * and every cross-origin request would fail with no clue as to why. Comparing
 * against `new URL(value).origin` rejects both at startup, by name.
 */
const httpOrigin = z.string().refine(
  (value) => {
    try {
      return new URL(value).origin === value;
    } catch {
      return false;
    }
  },
  {
    message:
      'must be a bare origin - scheme, host and optional port, no path and no trailing slash (e.g. http://localhost:5173)',
  },
);

/**
 * A boolean from an environment variable, which is always a string.
 *
 * `z.coerce.boolean()` is the wrong tool and the reason is worth stating: it
 * applies JavaScript truthiness, so the string `'false'` coerces to `true`. A
 * deployment that sets `RUN_WORKER_IN_PROCESS=false` to turn the worker off
 * would turn it on. This accepts the spellings an operator actually types and
 * rejects everything else by name.
 */
const envBoolean = (/** @type {boolean} */ fallback) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true' || value === '1' || value === 'yes');

/**
 * An optional secret or credential. Blank is the same as absent, because
 * `.env.example` ships these lines empty and an empty string is not a value.
 */
const optionalSecret = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value === undefined ? '' : value.trim();
    return trimmed === '' ? undefined : trimmed;
  });

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: postgresUrl,
  /**
   * Required only under NODE_ENV=test. Tests truncate every table between cases,
   * so it must not be the development database.
   */
  TEST_DATABASE_URL: postgresUrl.optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  /**
   * The Anthropic API key. **Optional here, and required at the point of use.**
   *
   * Making it required at import would mean `npm run migrate`, `npm run seed`
   * and the entire phase 2a unit suite refuse to run on a machine that has no
   * key - none of which spends a token. The place a missing key must be fatal is
   * where the client is constructed, which is worker start-up, and
   * `createAnthropicClient` throws there with a message naming this variable.
   *
   * An empty value is the same as an absent one, because `.env.example` ships
   * the line empty and a blank string is not a credential.
   */
  ANTHROPIC_API_KEY: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value === undefined ? '' : value.trim();
      return trimmed === '' ? undefined : trimmed;
    }),

  /* ------------------------------------------------------------ phase 4 */

  /** The HTTP listen address. `server.js` reads these; `app.js` never does. */
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),

  /** Fastify's log level. `silent` is what the test suite uses. */
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  /**
   * Where uploaded CVs live. Relative paths resolve against the process working
   * directory; `storage/localDisk.js` is the only module that joins anything to
   * it, and `candidates.storage_path` stays relative so the root can move.
   *
   * Plan section 8 records the limit this implies: the API and the worker must
   * share a filesystem.
   */
  UPLOAD_ROOT: z.string().min(1).default('./uploads'),

  /**
   * Per-file upload ceiling, bytes. A text CV is tens of kilobytes and a
   * design-heavy PDF is low single-digit megabytes; 5 MiB refuses the
   * hundred-page scan without refusing anybody's real CV.
   */
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .default(5 * 1024 * 1024),

  /** Files in one batch upload. Plan section 4 reasons about a 50-CV batch. */
  MAX_BATCH_FILES: z.coerce.number().int().min(1).max(200).default(50),

  /**
   * **The concurrency dial** - plan section 4, item 4.
   *
   * The number of candidates a single worker process screens at once, and
   * therefore the bound on in-flight Anthropic requests for the whole system
   * (one worker process is the deployment; run two and this is per process).
   * Each candidate is two *sequential* model calls, so N here is at most N
   * concurrent HTTP requests upstream, never 2N.
   *
   * Default 4, and the arithmetic behind it: one candidate measures ~8.2k input
   * and ~3.2k output tokens (plan section 9) across 2 calls, and takes tens of
   * seconds. Four in flight is roughly 8-10 requests and ~70k input tokens per
   * minute - comfortably inside a standard Anthropic tier, and four times
   * faster than serial. A 50-CV batch is then 50 queued jobs and 4 API calls,
   * which is the whole point: without this, it is 50 simultaneous calls and a
   * wall of 429s.
   *
   * It is one number an operator turns down to 1 during an incident, without a
   * deploy and without touching the queue.
   */
  SCREENING_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),

  /**
   * BullMQ connection. Required at the point of use rather than at import, for
   * the same reason as the Anthropic key: `npm run migrate`, the seed and the
   * unit suite must all run on a machine with no Redis.
   */
  REDIS_URL: z
    .string()
    .min(1)
    .default('redis://localhost:6389')
    .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), {
      message: 'must be a redis:// or rediss:// connection string',
    }),

  /**
   * **How long the worker blocks on an empty queue**, seconds. BullMQ's
   * `drainDelay`, surfaced as a dial because on a metered Redis it is a cost
   * control rather than a tuning knob.
   *
   * Measured against `bullmq@6.1.2` and a real Redis (`INFO commandstats`, empty
   * queue, concurrency 1): at the library default of 5 the worker issues roughly
   * **96-106 commands per minute** while doing nothing at all. That is not one
   * blocking pop - each idle cycle is a `bzpopmin`, an `evalsha`, the six inner
   * commands Redis counts for that script, and a connection `ping`.
   *
   * At ~6,000 commands per awake hour, Upstash's free tier of 500,000 per month
   * is 79-87 awake-hours - and an always-on worker would spend it nine times
   * over. Raising this divides the idle cycle proportionally and costs nothing
   * in latency, because a job added while the worker is blocked wakes the
   * `bzpopmin` immediately rather than waiting out the timeout. Both halves of
   * that claim are measured in `test/queue/idleCost.test.js`.
   *
   * The default stays at BullMQ's 5 so development behaves exactly as it always
   * has; the deployment raises it.
   */
  SCREENING_DRAIN_DELAY_S: z.coerce.number().int().min(1).max(300).default(5),

  /**
   * Attempts per candidate, BullMQ-side, and the backoff between them. This is
   * the transient-failure budget for the *queue* layer; the agent layer has its
   * own single semantic retry inside one attempt (plan section 5.4), and the two
   * are deliberately separate numbers.
   */
  SCREENING_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  SCREENING_JOB_BACKOFF_MS: z.coerce.number().int().min(100).max(600_000).default(10_000),

  /**
   * Rate limiting, applied to the two upload endpoints only (plan section 3).
   * With no auth the only principal is the client IP, so this is a cost guard
   * rather than a security control - it bounds how fast one caller can spend
   * real API money.
   */
  UPLOAD_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000).default(30),
  UPLOAD_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),

  /**
   * How long a candidate may sit in a non-terminal status before
   * `scripts/reconcileStuck.js` considers it stranded.
   *
   * The floor is 300_000 rather than something smaller, and it is a real
   * constraint rather than a round number: the agent layer's hard per-candidate
   * deadline is 240s, so a sweep with a shorter cutoff would re-enqueue work
   * that is still running - doubling the API bill it exists to protect. The
   * literal is used rather than importing `CANDIDATE_DEADLINE_MS`, because that
   * constant lives behind `agents/index.js`, which pulls in the Anthropic SDK,
   * and this module is imported by `npm run migrate`.
   */
  STUCK_CANDIDATE_AGE_MS: z.coerce.number().int().min(300_000).default(900_000),

  /* ------------------------------------------------------------ phase 5 */

  /**
   * **The CORS allowlist**, comma-separated. Read by `app.js` and by nothing
   * else.
   *
   * It exists because until now the browser client only worked through Vite's
   * dev-server proxy, and "it works because of a dev-server proxy" is not an
   * answer for anybody deploying this: the moment the API and the UI are served
   * from two origins, every request fails preflight and the API is the thing
   * that is wrong.
   *
   * **The default is the development origin, and it is deliberately not `*`.**
   * `*` would make this variable optional forever - the API would work
   * everywhere, including from any page on the internet, and nobody would ever
   * discover they had not configured it. With a dev-origin default, a
   * production deployment that forgets this variable fails immediately and
   * visibly on the first cross-origin request, which is the failure worth
   * having. (`*` is also incompatible with credentialed requests, so choosing it
   * now would foreclose auth later; that is the second reason, not the first.)
   *
   * `http://localhost:5173` is Vite's default and is what `web/vite.config.js`
   * pins its dev server to.
   *
   * A literal `*` here does not disable the allowlist - it fails `httpOrigin`
   * and stops the process, which is the same loud failure by another route.
   */
  CORS_ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .pipe(z.array(httpOrigin).min(1)),

  /* ------------------------------------------------ phase 6: deployment */

  /**
   * **Which storage backend is in use**, read by `storage/index.js` and by
   * nothing else.
   *
   * `local` is the development default and keeps every existing behaviour
   * exactly as it was. `s3` is what a deployment sets when the API and the
   * worker do not share a filesystem - which is every deployment that runs them
   * as two processes, and also every free-tier host that wipes the disk on
   * restart. The relative path stored in `candidates.storage_path` is the same
   * string under both, so the switch needs no data migration.
   */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),

  /**
   * The S3-compatible bucket, endpoint, region and credentials. Optional here
   * and **required by the superRefine below when `STORAGE_DRIVER=s3`** - so a
   * machine with no bucket runs migrations, the seed and the whole unit suite
   * exactly as before, and a deployment that selects `s3` without credentials
   * fails at startup naming the variable rather than on a recruiter's upload.
   *
   * `S3_ENDPOINT` is what makes this provider-agnostic: Backblaze B2 is
   * `https://s3.<region>.backblazeb2.com`, Cloudflare R2 is
   * `https://<account>.r2.cloudflarestorage.com`, and AWS is the one that can
   * be omitted.
   */
  S3_BUCKET: optionalSecret,
  S3_ENDPOINT: optionalSecret,
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY_ID: optionalSecret,
  S3_SECRET_ACCESS_KEY: optionalSecret,
  /** See the note in `storage/s3.js`; true works on B2 and R2, false is AWS. */
  S3_FORCE_PATH_STYLE: envBoolean(true),

  /**
   * **Runs the screening worker inside the API process.**
   *
   * Off by default, which is the honest default: `src/worker.js` is the
   * worker's entry point, it is what `npm run worker` starts, and it is what a
   * deployment with two processes runs. This flag exists because free hosting
   * tiers do not offer a second always-on process, and one process that screens
   * is worth more than two that do not exist.
   *
   * It is a **deployment toggle, not a second implementation**: `server.js`
   * calls the same exported `buildScreeningWorker()` that `worker.js` does, with
   * the same concurrency, the same lock duration and the same drain. Nothing
   * about the queue, the processor or the agent layer knows which mode it is in.
   *
   * What it costs is fault isolation, and that is recorded in the README rather
   * than hidden: a crash while parsing a PDF now takes the HTTP API down with
   * it, where before it took down only the worker.
   */
  RUN_WORKER_IN_PROCESS: envBoolean(false),

  /**
   * **The shared secret the two upload endpoints and the retry endpoint check.**
   *
   * Absent means the guard is off, which is what keeps local development and the
   * entire test suite untouched. Present means every request to a
   * money-spending endpoint must carry it in `x-upload-token`.
   *
   * This is **not authentication and the README says so in those words**. The
   * frontend has to send it, so it is a build-time value in the client bundle
   * and visible to anyone who opens devtools. It exists to stop a crawler or a
   * passer-by spending the API budget on a public URL - a speed bump, sitting
   * alongside the per-IP rate limit, not an access control.
   */
  UPLOAD_ACCESS_TOKEN: optionalSecret,

  /**
   * How long `/health` waits for a dependency before calling it unreachable.
   *
   * There has to be a bound, and the reason is specific rather than defensive:
   * the Redis connection is built with `enableOfflineQueue: true`, so a command
   * issued while disconnected is *buffered* rather than rejected, and the ping
   * never settles. Without this, a health check against a dead Redis hangs
   * instead of answering 503 - and a health check that hangs is one a load
   * balancer cannot act on, which is the failure the endpoint exists to prevent.
   *
   * Two seconds: longer than a healthy round trip to a hosted Postgres or Redis
   * by an order of magnitude, and shorter than any platform's health-check
   * timeout.
   */
  DEPENDENCY_CHECK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
});

/**
 * The four variables the S3 driver cannot work without. `S3_REGION` is absent
 * from this list because it carries a default that B2 and R2 both tolerate.
 *
 * @type {readonly ['S3_BUCKET', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']}
 */
const REQUIRED_S3_KEYS = Object.freeze([
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
]);

const envSchema = baseEnvSchema.superRefine((value, ctx) => {
  // Checked here rather than inside `storage/s3.js`, so that a deployment which
  // selects the S3 driver without credentials dies at startup naming the
  // variable - instead of accepting an upload, writing it to staging, and
  // failing on the PUT with the recruiter watching.
  if (value.STORAGE_DRIVER === 's3') {
    for (const key of REQUIRED_S3_KEYS) {
      if (!value[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'is required when STORAGE_DRIVER=s3',
        });
      }
    }
  }

  if (value.NODE_ENV !== 'test') return;

  if (!value.TEST_DATABASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TEST_DATABASE_URL'],
      message: 'is required when NODE_ENV=test',
    });
    return;
  }

  if (value.TEST_DATABASE_URL === value.DATABASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['TEST_DATABASE_URL'],
      message: 'must not equal DATABASE_URL - the test suite truncates every table',
    });
  }
});

/**
 * @typedef {z.infer<typeof baseEnvSchema>} Env
 */

/**
 * Parses an environment-variable bag. Pure, so failure paths are testable
 * without terminating the test runner.
 *
 * @param {Record<string, string | undefined>} rawEnv
 * @returns {{ success: true, env: Env } | { success: false, issues: string[] }}
 */
export function parseEnv(rawEnv) {
  const result = envSchema.safeParse(rawEnv);
  if (result.success) {
    return { success: true, env: Object.freeze(result.data) };
  }

  const issues = result.error.issues.map((issue) => {
    const path = issue.path.join('.') || '(root)';
    return `${path}: ${issue.message}`;
  });

  return { success: false, issues };
}

/**
 * Picks the connection string for the current NODE_ENV. Centralised so no other
 * module has to remember that tests use a different database.
 *
 * @param {Env} env
 * @returns {string}
 */
export function resolveDatabaseUrl(env) {
  if (env.NODE_ENV === 'test') {
    // superRefine guarantees this is present under NODE_ENV=test.
    return /** @type {string} */ (env.TEST_DATABASE_URL);
  }
  return env.DATABASE_URL;
}

const parsed = parseEnv(process.env);

if (!parsed.success) {
  // Written to stderr rather than thrown: a stack trace here points at this file,
  // which tells the reader nothing about which variable is wrong.
  process.stderr.write(
    `Invalid environment configuration:\n${parsed.issues.map((i) => `  - ${i}`).join('\n')}\n`,
  );
  process.exit(1);
}

/** @type {Env} */
export const env = parsed.env;

/** @type {string} Connection string for the current NODE_ENV. */
export const databaseUrl = resolveDatabaseUrl(env);
