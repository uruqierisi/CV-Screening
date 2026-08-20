import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { TEST_UPLOAD_ROOT } from './test/uploadRoot.js';

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
    // `unit` is the agent layer and, since phase 3, the extraction layer: pure
    // functions, hand-written inputs, exact expected outputs. It has no
    // globalSetup, touches no socket and runs on a machine with nothing
    // installed but Node. That is not a convenience - phase 2a has to be
    // reviewable on its own, and a reviewer who has to start Docker to check a
    // tier boundary will not check the tier boundary.
    //
    // Phase 3's tests belong here rather than in `db` for the same reason and
    // one more: they read real PDF, DOCX and TXT fixtures off the disk beside
    // them and need nothing else, so `--project unit` still passes with Postgres
    // stopped.
    //
    // `db` is phase 1: repositories against a real Postgres, with the migrate
    // down/up globalSetup that proves every down migration still works.
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'test/agents/**/*.test.js',
            'test/extraction/**/*.test.js',
            // Phase 4's pure units: the error-code table, the derived job
            // status, the boundary schemas, the DTOs, the storage path rule and
            // the queue's own configuration. Every one of them is a decision
            // with branches and no infrastructure, and putting them here means
            // a reviewer can check the code-to-status mapping without starting
            // Docker.
            'test/unit/**/*.test.js',
          ],
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
          include: [
            'test/*.test.js',
            // Phase 4's integration surface. `api/` drives the real Fastify
            // instance through `app.inject()` - real router, real plugins, real
            // error handler, no socket - against a real Postgres. `pipeline/`
            // runs the worker's processor end to end against that same Postgres
            // with an INJECTED FAKE Anthropic client, exactly as the agent
            // layer's own suite does: no module mocking, no network, and the
            // real JSON parsing and schema validation still run.
            'test/api/**/*.test.js',
            'test/pipeline/**/*.test.js',
            // The one group that needs Redis, kept separate so it is obvious
            // which tests do.
            'test/queue/**/*.test.js',
          ],
          globalSetup: ['./test/globalSetup.js'],
          // One test database, and tests truncate it between cases. Parallel
          // files would truncate each other's fixtures mid-assertion.
          fileParallelism: false,
          env: {
            NODE_ENV: 'test',
            // The suite gets its own upload root, and owns it.
            //
            // Until now it shared `./uploads` with development, and three tests
            // assert `uploadedFileCount() === 0` after a rejected upload by
            // counting every file under the root. That passed for as long as
            // nobody had actually used the app: the first real upload put a file
            // there, and three tests went red for a reason that had nothing to
            // do with them. A test that passes only because nobody has used the
            // app yet is not passing.
            //
            // `globalSetup` empties this before the run and removes it after, so
            // the count starts at zero and the repository is left clean.
            UPLOAD_ROOT: TEST_UPLOAD_ROOT,
          },
          testTimeout: 20_000,
          hookTimeout: 30_000,
        },
      },
    ],

    coverage: {
      provider: 'v8',
      // The two framework-agnostic layers. Coverage of the repositories is
      // measured by the integration suite and is not what this gate is about.
      //
      // `src/extraction/**` joined in phase 3. It was not added on the
      // assumption that it would pass - it was added *because* it does, at 100%
      // on all four counters, with no coverage-ignore hints anywhere and no
      // threshold lowered to accommodate it. Where a defensive branch could not
      // be reached by a test, the branch was removed rather than excused: the
      // ZIP reader returns failures instead of throwing them, so no caller
      // needs a re-throw it cannot exercise, and the PDF error mapping is an
      // exported pure function rather than a private one reachable only through
      // a manufactured PDF. See the note on the `src/extraction/**` block below.
      include: [
        'src/agents/**/*.js',
        'src/extraction/**/*.js',
        // Phase 4 adds the parts of the API layer that are pure decisions rather
        // than plumbing, and adds them on the same terms the previous two were:
        // because they already reach 100%, with no ignore hints and no threshold
        // lowered to accommodate them.
        //
        // What is deliberately NOT here, and why: the routes, the controllers,
        // the services, the repositories, the queue wiring, `app.js`,
        // `server.js` and `worker.js`. Those are covered by the integration
        // suite in `test/api/**` and `test/pipeline/**`, which needs Postgres -
        // and this gate has to stay runnable by `--project unit` on a machine
        // with nothing installed but Node. Gating them here would either force
        // Docker on a reviewer checking a tier boundary, or drop the bar to a
        // percentage, and both are worse than measuring them separately.
        'src/errors/**/*.js',
        'src/schemas/**/*.js',
        'src/http/boundary.js',
        'src/http/errorHandler.js',
        'src/http/dto/**/*.js',
        'src/services/jobStatus.js',
        'src/queue/candidateFailure.js',
        'src/util/logging.js',
      ],
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
        // Phase 3's document parsing, listed as its own glob for the same
        // reason as `scoring/`: a regression should name the directory in the
        // failure message rather than move a global percentage.
        //
        // It earns the same bar on a different argument. `scoring/` is held to
        // 100% because it produces the number. This is held to 100% because it
        // is the only code in the system that touches an untrusted file, and
        // every uncovered branch in a parser is a byte sequence nobody has
        // tried. The inputs are cheap - the fixtures are generated by a
        // committed script - so there is no honest reason for a gap.
        'src/extraction/**': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // Phase 4's decision surface, listed as its own glob for the same reason
        // the two above are: a regression should name the directory.
        //
        // The argument for 100% here is the one the other two make in their own
        // terms. `errors/**` is the table that turns a code into an HTTP status,
        // and an uncovered row is a status nobody has checked. `schemas/**` is
        // the only thing standing between a query string and SQL. `dto/**`
        // decides what leaves the process, which is where a CV or a credential
        // escapes. `jobStatus.js` is the whole definition of "is this upload
        // finished". `candidateFailure.js` keeps the two error namespaces apart.
        // None of them touches infrastructure, so anything unreached is either
        // dead code or an untested decision.
        'src/errors/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/schemas/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/http/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/services/jobStatus.js': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/queue/candidateFailure.js': {
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
