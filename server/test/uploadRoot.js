/**
 * The upload root the test suite owns, in one place.
 *
 * Two things need this value and they run in different processes, which is the
 * whole reason this module exists:
 *
 * - `vitest.config.js` sets it as `UPLOAD_ROOT` in the `db` project's `env`, so
 *   the code under test resolves it through `src/config/env.js` as it always
 *   does.
 * - `test/globalSetup.js` empties it before the run and removes it after, and
 *   **runs in vitest's main process**, where the project-level `env` has not
 *   been applied. Reading `env.UPLOAD_ROOT` there yields the *development*
 *   default, which is how the first version of this cleanup tried to delete a
 *   reviewer's uploaded CVs.
 *
 * So neither side derives it from the other. Both import it from here, and the
 * `uploads-` prefix is load-bearing: `globalSetup` refuses to remove any
 * directory not named that way, so a careless edit to this constant fails the
 * run instead of deleting the wrong tree.
 */

/** @type {string} */
export const TEST_UPLOAD_ROOT = './uploads-test';
