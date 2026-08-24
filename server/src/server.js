/**
 * The API entrypoint. The only file in the repository that binds a port.
 *
 * It does three things and stops: build the app, listen, and shut down cleanly
 * on a signal. Everything else is in `app.js`, which is what the tests import.
 *
 * ## The co-located worker
 *
 * With `RUN_WORKER_IN_PROCESS=true` this process also hosts the screening
 * worker, by calling the same `startScreeningWorker()` that `src/worker.js`
 * calls. It is a **deployment toggle**: free hosting tiers offer one always-on
 * process, and one process that screens is worth more than two that do not
 * exist. Off by default, and `npm run worker` is unaffected either way.
 *
 * What it costs is fault isolation - a crash in PDF parsing now takes the HTTP
 * API down with it - and that is recorded in the README's Known Limitations
 * rather than left for a reviewer to discover.
 *
 * ## Shutdown
 *
 * The order is load-bearing and each step is waiting for the one before it:
 *
 * 1. `app.close()` stops accepting connections and waits for in-flight requests,
 *    so an upload that is mid-write finishes rather than leaving a half-written
 *    file with no row.
 * 2. The worker drains: it stops taking new jobs and lets in-flight candidates
 *    finish, aborting their model calls if they outrun the grace period. An
 *    aborted call is a retryable `AGENT_TIMEOUT`, which the processor releases
 *    back to `pending` - so a deploy stalls a screening rather than stranding it
 *    in `evaluating`.
 * 3. Only then the storage client, the queue, Redis and the pool - because a
 *    request or a candidate still finishing may need any of them.
 *
 * Getting 2 before 3 is the whole reason the worker is drained here rather than
 * left to its own signal handler: it shares this process's pool and Redis
 * connection, and closing those first would abort the very work the drain is
 * waiting for.
 */

import { buildApp } from './app.js';
import { env } from './config/env.js';
import { assertSchemaMigrated } from './db/assertSchema.js';
import { closePool, pool } from './db/pool.js';
import { closeRedis } from './queue/connection.js';
import { closeScreeningQueue } from './queue/screeningQueue.js';
import { closeStorage, storageDriver } from './storage/index.js';
import { startScreeningWorker } from './worker.js';

/** Signals that mean "stop": Ctrl-C, and what a container runtime sends. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'];

async function main() {
  const app = await buildApp();

  // Before the port opens, because `/health` cannot catch this one: its database
  // probe is `SELECT 1`, which succeeds against a database with no tables, so an
  // unmigrated deployment reports healthy and then fails every real request on a
  // missing relation. Refusing to start is the visible failure; a green deploy
  // that 500s on everything is the invisible one.
  const schema = await assertSchemaMigrated(pool);
  app.log.info({ ...schema }, 'schema check passed');

  // The deployed configuration, in one line, at boot.
  //
  // `CORS_ALLOWED_ORIGINS` is here for a specific reason: when an origin does
  // not match, `@fastify/cors` simply omits the `Access-Control-Allow-Origin`
  // header and the request is logged as an ordinary 200. The failure exists only
  // in the browser console, and nothing server-side says "I refused an origin".
  // On a hosted platform with no shell, this log line is the only way to see
  // what the running process actually parsed - which turns a misconfigured
  // deployment from an hour of guessing into a two-line comparison.
  //
  // The storage driver and the worker mode are here on the same argument: both
  // are environment-selected, both change behaviour invisibly, and both are
  // things an operator will otherwise infer from the environment they *think*
  // they set.
  app.log.info(
    {
      corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
      storageDriver,
      workerInProcess: env.RUN_WORKER_IN_PROCESS,
      uploadTokenRequired: env.UPLOAD_ACCESS_TOKEN !== undefined,
    },
    'api configuration',
  );

  const screening = env.RUN_WORKER_IN_PROCESS
    ? startScreeningWorker({ logger: app.log })
    : null;

  let closing = false;
  const shutdown = async (/** @type {string} */ signal) => {
    // A second Ctrl-C during a slow drain must not start a second shutdown.
    if (closing) return;
    closing = true;

    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      // Before the pool and Redis close, because the candidates it is draining
      // need both in order to be released back to `pending`.
      if (screening !== null) await screening.close();
      await closeScreeningQueue();
      await closeStorage();
      await closeRedis();
      await closePool();
      // The last line the process writes, and it earns its place on a hosted
      // platform: without it, a shutdown that hung and a shutdown that finished
      // look identical in the log, because every step between here and
      // "shutting down" is silent on success. On Render the difference decides
      // whether SIGTERM drained the worker or whether SIGKILL cut it off - and
      // a candidate cut off by SIGKILL is stranded in `evaluating`.
      app.log.info({ signal }, 'shutdown complete');
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exitCode = 1;
    }
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch(async (error) => {
  process.stderr.write(`api failed to start: ${error.message}\n`);
  process.exitCode = 1;

  // Nothing is listening yet, but the schema check above opened a pooled
  // connection and `pool.js` holds an idle client for 30 seconds. Without this
  // the process prints the reason it cannot run and then sits there for half a
  // minute before exiting - which on a platform that restarts a failed service
  // is 30 dead seconds per attempt, and looks like a hang rather than a
  // refusal.
  await closePool().catch(() => {});
});
