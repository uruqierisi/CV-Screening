/**
 * One-off: clean JSON punctuation out of `evaluation_matrix` rows already stored.
 *
 * `agents/evaluation/normalize-ratings.js` stops this happening to new
 * evaluations. Candidates screened before it existed keep whatever the model
 * wrote, including the trailing `"},` a quote copied out of the profile JSON
 * drags along - so a dashboard that has already screened somebody shows one row
 * with an artifact and the rest clean, which is worse than either.
 *
 * ## Why a script and not SQL
 *
 * The obvious version is an `UPDATE ... regexp_replace(...)`, and it would be
 * wrong in a way that is hard to see. The rule is not "strip trailing
 * punctuation": a closing quote is removed only when the quote count is odd, and
 * wrapping quotes only when there are exactly two in the string. A regex that
 * ignored that would turn `he said "hi",` into `he said "hi` - corrupting
 * evidence on the screen this exists to fix, in the name of fixing it.
 *
 * So the rows are read, cleaned in JavaScript by the same function that runs on
 * every new evaluation, and written back. One statement per changed candidate;
 * there will be a handful.
 *
 * ## Safe to run more than once
 *
 * Cleaning an already-clean string returns it unchanged, and a row whose JSON is
 * byte-identical after cleaning is not written at all. So a second run reports
 * zero changes and touches nothing.
 *
 * ```sh
 * # against the deployment, from your machine (direct host is not required
 * # here - this takes no advisory lock)
 * cd server
 * DATABASE_URL='postgresql://...' node src/scripts/backfillRatingText.js --dry-run
 * DATABASE_URL='postgresql://...' node src/scripts/backfillRatingText.js
 * ```
 */

import { pathToFileURL } from 'node:url';
import { pool } from '../db/pool.js';
import { cleanEvidence, cleanReason } from '../agents/evaluation/normalize-ratings.js';

/**
 * One matrix, cleaned.
 *
 * Returns the same object reference when nothing changed, so the caller can skip
 * the write with an identity check rather than a deep comparison.
 *
 * @param {Record<string, any>} matrix
 * @returns {{ matrix: Record<string, any>, changed: number }}
 */
export function cleanMatrix(matrix) {
  if (!matrix || !Array.isArray(matrix.criteria)) return { matrix, changed: 0 };

  let changed = 0;

  const criteria = matrix.criteria.map((row) => {
    const reason = cleanReason(row.reason);
    const evidence = cleanEvidence(row.evidence);

    if (reason === row.reason && evidence === (row.evidence ?? null)) return row;

    changed += 1;
    return { ...row, reason, evidence };
  });

  return changed === 0 ? { matrix, changed: 0 } : { matrix: { ...matrix, criteria }, changed };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.dryRun] report what would change and write nothing
 * @param {(message: string) => void} [options.log] injected so a test can read
 *   the report without writing to the process's stdout
 * @returns {Promise<{ scanned: number, candidates: number, rows: number }>}
 */
export async function backfillRatingText({
  dryRun = false,
  log = (message) => process.stdout.write(`${message}\n`),
} = {}) {
  const { rows } = await pool.query(
    'SELECT id, evaluation_matrix FROM candidates WHERE evaluation_matrix IS NOT NULL ORDER BY id',
  );

  let candidates = 0;
  let cleanedRows = 0;

  for (const row of rows) {
    const { matrix, changed } = cleanMatrix(row.evaluation_matrix);
    if (changed === 0) continue;

    candidates += 1;
    cleanedRows += changed;
    log(`${dryRun ? 'would clean' : 'cleaning'} ${row.id}: ${changed} criterion row(s)`);

    if (!dryRun) {
      await pool.query('UPDATE candidates SET evaluation_matrix = $2::jsonb WHERE id = $1', [
        row.id,
        JSON.stringify(matrix),
      ]);
    }
  }

  log(
    `${rows.length} scanned, ${candidates} candidate(s) ${dryRun ? 'would be' : ''} changed, ` +
      `${cleanedRows} criterion row(s) cleaned${dryRun ? ' (dry run: nothing written)' : ''}`,
  );

  return { scanned: rows.length, candidates, rows: cleanedRows };
}

// Runs only when invoked directly, so a test can import the functions above
// without the module deciding to rewrite a database on import.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dryRun = process.argv.includes('--dry-run');

  backfillRatingText({ dryRun })
    .then(() => pool.end())
    .then(() => {
      process.exitCode = 0;
    })
    .catch(async (error) => {
      process.stderr.write(`backfill failed: ${error.message}\n`);
      process.exitCode = 1;
      await pool.end().catch(() => {});
    });
}
