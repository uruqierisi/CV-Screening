import { z } from 'zod';

/**
 * Process configuration.
 *
 * Environment variables only, parsed once at import time. A bad or missing value
 * kills the process here rather than surfacing as a confusing runtime failure
 * three layers in.
 *
 * Phase 1 declares only what the data layer actually uses. Later phases extend
 * `baseEnvSchema` in place (Redis URL, Anthropic key, upload root, HTTP port).
 * Keeping the schema minimal means an unused-but-required variable can never
 * block a reviewer from running the migrations.
 */

const postgresUrl = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
    { message: 'must be a postgres:// or postgresql:// connection string' },
  );

const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: postgresUrl,
  /**
   * Required only under NODE_ENV=test. Tests truncate every table between cases,
   * so it must not be the development database.
   */
  TEST_DATABASE_URL: postgresUrl.optional(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

const envSchema = baseEnvSchema.superRefine((value, ctx) => {
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
