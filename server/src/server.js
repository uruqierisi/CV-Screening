/**
 * The API entrypoint. The only file in the repository that binds a port.
 *
 * It does three things and stops: build the app, listen, and shut down cleanly
 * on a signal. Everything else is in `app.js`, which is what the tests import.
 *
 * ## Shutdown
 *
 * `app.close()` stops accepting connections and waits for in-flight requests, so
 * an upload that is mid-write finishes rather than leaving a half-written file
 * with no row. Only then are the pool and the queue closed - in that order,
 * because a request still finishing may need both.
 */

import { buildApp } from './app.js';
import { env } from './config/env.js';
import { closePool } from './db/pool.js';
import { closeRedis } from './queue/connection.js';
import { closeScreeningQueue } from './queue/screeningQueue.js';

/** Signals that mean "stop": Ctrl-C, and what a container runtime sends. */
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'];

async function main() {
  const app = await buildApp();

  let closing = false;
  const shutdown = async (/** @type {string} */ signal) => {
    // A second Ctrl-C during a slow drain must not start a second shutdown.
    if (closing) return;
    closing = true;

    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closeScreeningQueue();
      await closeRedis();
      await closePool();
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

main().catch((error) => {
  process.stderr.write(`api failed to start: ${error.message}\n`);
  process.exitCode = 1;
});
