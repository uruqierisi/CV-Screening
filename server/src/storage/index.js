/**
 * The storage contract, and the one place a backend is chosen.
 *
 * Three modules call storage - `services/uploadsService.js`,
 * `services/candidatesService.js` and
 * `queue/processors/screenCandidate.processor.js` - and after this file exists,
 * none of them knows which backend is in use. They import from here; the driver
 * is an environment variable.
 *
 * ## The contract
 *
 * Seven functions, and the two that are pure are pure in both drivers:
 *
 * | function            | pure | what it does                                  |
 * | ------------------- | ---- | --------------------------------------------- |
 * | `storagePathFor`    | yes  | candidate id -> relative path                  |
 * | `allocate`          | yes  | fresh id + the path derived from it            |
 * | `writeStream`       | no   | stream in, hashed in one pass                  |
 * | `readStored`        | no   | bytes back, `ENOENT`-coded when absent         |
 * | `storedFileExists`  | no   | boolean, never throws                          |
 * | `removeStored`      | no   | best effort, never throws                      |
 * | `renameStored`      | no   | move to the sniffed extension                  |
 *
 * `candidates.storage_path` holds the relative path and nothing else, in both
 * drivers, so **switching driver needs no data migration** - the same string is
 * a filesystem path under `UPLOAD_ROOT` in one and an object key in the other.
 * What it does need is the files themselves: a candidate uploaded under `local`
 * has no object in the bucket, and its retry will answer `SOURCE_FILE_MISSING`.
 *
 * ## Why the selection is here and not at each call site
 *
 * A conditional import at the top of one module is a decision made once, at
 * process start, that every caller inherits. A conditional at each call site is
 * the same decision made three times, and the day the third one is added by
 * somebody who did not know is the day the API writes to a bucket the worker
 * reads from disk.
 *
 * The switch is a static `if` over a validated enum rather than a dynamic key
 * lookup: there are two drivers, `env.js` has already rejected any third value
 * at startup, and a table would imply an extensibility nothing needs.
 */

import { env } from '../config/env.js';
import * as localDisk from './localDisk.js';
import * as s3 from './s3.js';

/**
 * The chosen backend, resolved once at import.
 *
 * `env.STORAGE_DRIVER` is an enum validated in `config/env.js`, and the `s3`
 * branch additionally requires the bucket and credentials to be present - so by
 * the time this line runs, a driver of `s3` is known to be fully configured.
 * A misconfiguration is a startup failure naming the missing variable, never a
 * runtime failure on somebody's upload.
 */
const driver = env.STORAGE_DRIVER === 's3' ? s3 : localDisk;

/**
 * Which backend is in use. Exported for the boot log and for `/health`, so an
 * operator can see what the deployed process actually resolved rather than
 * inferring it from the environment they think they set.
 *
 * @type {'local' | 's3'}
 */
export const storageDriver = env.STORAGE_DRIVER;

/* -------------------------------------------------------- pure, driver-free */

export const { storagePathFor, allocate } = localDisk;

/* ------------------------------------------------------------- driver-bound */

export const { writeStream, readStored, storedFileExists, removeStored, renameStored } = driver;

/**
 * Releases whatever the driver holds open. A no-op for local disk.
 *
 * Called from the API's and the worker's shutdown sequences, next to
 * `closePool` and `closeRedis`, so a draining process does not sit on an open
 * HTTPS agent while it waits to exit.
 *
 * @returns {Promise<void>}
 */
export async function closeStorage() {
  if (env.STORAGE_DRIVER === 's3') {
    await s3.closeStorage();
  }
}
