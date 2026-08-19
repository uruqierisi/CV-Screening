import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The suite runs against a real PostgreSQL from docker-compose, so it needs the
// same .env a developer uses. Node's built-in loader is used rather than adding
// dotenv; it does not override variables already set in the real environment,
// which is what CI wants.
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// Forced AFTER the file is loaded, because .env sets NODE_ENV=development and
// env.js picks the database from it. Getting this wrong would point the suite -
// which truncates every table between tests - at the development database.
process.env.NODE_ENV = 'test';

export default defineConfig({
  test: {
    // Two projects, because the suite has two genuinely different kinds of test
    // and only one of them needs infrastructure.
    //
    // `unit` is the agent layer: pure functions, hand-written inputs, exact
    // expected outputs. It has no globalSetup, touches no socket and runs on a
    // machine with nothing installed but Node. That is not a convenience - phase
    // 2a has to be reviewable on its own, and a reviewer who has to start Docker
    // to check a tier boundary will not check the tier boundary.
    //
    // `db` is phase 1: repositories against a real Postgres, with the migrate
    // down/up globalSetup that proves every down migration still works.
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/agents/**/*.test.js'],
          // The tripwire. Phase 2b brought an SDK into the repository, so "no
          // test performs a network call" stopped being self-evident and became
          // something to enforce. `test/agents/network-tripwire.test.js` proves
          // it fires - a tripwire nobody has seen fail is not a tripwire.
          //
          // The `db` project deliberately does not get this: it talks to a real
          // Postgres, and guarding it would be theatre.
          setupFiles: ['./test/setup/no-network.js'],
        },
      },
      {
        test: {
          name: 'db',
          environment: 'node',
          include: ['test/*.test.js'],
          globalSetup: ['./test/globalSetup.js'],
          // One test database, and tests truncate it between cases. Parallel
          // files would truncate each other's fixtures mid-assertion.
          fileParallelism: false,
          env: {
            NODE_ENV: 'test',
          },
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],

    coverage: {
      provider: 'v8',
      // Only the agent layer. Coverage of the repositories is measured by the
      // integration suite and is not what this gate is about.
      include: ['src/agents/**/*.js'],
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        // The exit criterion for phase 2a, from the plan: `scoring/` at 100%,
        // line, branch, function and statement. Anything less is a blocking
        // failure, because this is the only code in the system that produces the
        // number a hiring decision is made on. Listed as its own glob so that a
        // regression names the directory in the failure message.
        'src/agents/scoring/**': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // The rest of the deterministic core is held to the same bar. It is all
        // pure functions with injected dependencies; there is nothing in it that
        // is hard to reach, so anything unreached is either dead code or an
        // untested decision.
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
