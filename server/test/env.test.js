import { describe, expect, it } from 'vitest';
import { parseEnv, resolveDatabaseUrl } from '../src/config/env.js';

/**
 * Pure tests: `parseEnv` is exported precisely so the failure paths can be
 * exercised without the module-level `process.exit(1)` taking the runner with it.
 */

const DEV_URL = 'postgres://user:pw@localhost:5442/cv_screening';
const TEST_URL = 'postgres://user:pw@localhost:5442/cv_screening_test';

describe('parseEnv', () => {
  it('accepts a minimal development environment and applies defaults', () => {
    const result = parseEnv({ DATABASE_URL: DEV_URL });

    expect(result.success).toBe(true);
    expect(result.env).toMatchObject({
      NODE_ENV: 'development',
      DATABASE_URL: DEV_URL,
      DB_POOL_MAX: 10,
    });
  });

  it('coerces DB_POOL_MAX from its string environment value', () => {
    const result = parseEnv({ DATABASE_URL: DEV_URL, DB_POOL_MAX: '25' });

    expect(result.success).toBe(true);
    expect(result.env.DB_POOL_MAX).toBe(25);
  });

  it('rejects a missing DATABASE_URL by name', () => {
    const result = parseEnv({});

    expect(result.success).toBe(false);
    expect(result.issues.join('\n')).toContain('DATABASE_URL');
  });

  it('rejects a connection string that is not postgres', () => {
    const result = parseEnv({ DATABASE_URL: 'mysql://user:pw@localhost/db' });

    expect(result.success).toBe(false);
    expect(result.issues.join('\n')).toContain('postgres://');
  });

  it('rejects an unknown NODE_ENV', () => {
    const result = parseEnv({ NODE_ENV: 'staging', DATABASE_URL: DEV_URL });

    expect(result.success).toBe(false);
    expect(result.issues.join('\n')).toContain('NODE_ENV');
  });

  it('requires TEST_DATABASE_URL under NODE_ENV=test', () => {
    const result = parseEnv({ NODE_ENV: 'test', DATABASE_URL: DEV_URL });

    expect(result.success).toBe(false);
    expect(result.issues).toContain('TEST_DATABASE_URL: is required when NODE_ENV=test');
  });

  it('refuses a test database that is the same as the development one', () => {
    const result = parseEnv({
      NODE_ENV: 'test',
      DATABASE_URL: DEV_URL,
      TEST_DATABASE_URL: DEV_URL,
    });

    expect(result.success).toBe(false);
    expect(result.issues.join('\n')).toContain('must not equal DATABASE_URL');
  });

  it('does not require TEST_DATABASE_URL outside of tests', () => {
    const result = parseEnv({ NODE_ENV: 'production', DATABASE_URL: DEV_URL });

    expect(result.success).toBe(true);
  });

  it('freezes the parsed environment so nothing can mutate config at runtime', () => {
    const result = parseEnv({ DATABASE_URL: DEV_URL });

    expect(Object.isFrozen(result.env)).toBe(true);
  });
});

describe('resolveDatabaseUrl', () => {
  it('returns the test database under NODE_ENV=test', () => {
    const url = resolveDatabaseUrl({
      NODE_ENV: 'test',
      DATABASE_URL: DEV_URL,
      TEST_DATABASE_URL: TEST_URL,
      DB_POOL_MAX: 10,
    });

    expect(url).toBe(TEST_URL);
  });

  it('returns the primary database everywhere else', () => {
    const url = resolveDatabaseUrl({
      NODE_ENV: 'development',
      DATABASE_URL: DEV_URL,
      TEST_DATABASE_URL: TEST_URL,
      DB_POOL_MAX: 10,
    });

    expect(url).toBe(DEV_URL);
  });
});
