/**
 * Formatting. No business rules, no thresholds, no API knowledge.
 */

/**
 * A score, always to one decimal.
 *
 * `numeric(4,1)` crosses the wire as a Number, so 50.0 arrives as `50` and would
 * render as "50" beside a "81.5" in the row above it. One decimal everywhere is
 * what makes a column of scores line up and read as one measurement.
 *
 * A null score is not zero and is never rendered as one: an unscored candidate
 * gets an em dash, and the column it sits in is labelled.
 *
 * @param {number | null | undefined} score
 * @returns {string}
 */
export function formatScore(score) {
  if (score === null || score === undefined || Number.isNaN(score)) return '—';
  return score.toFixed(1);
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * A timestamp a person can read, in their own locale and timezone.
 *
 * @param {string | null | undefined} iso
 * @returns {string}
 */
export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Just the clock time, for "Last updated 1:04pm".
 *
 * @param {number | null | undefined} epochMs
 * @returns {string}
 */
export function formatClockTime(epochMs) {
  if (epochMs === null || epochMs === undefined) return '—';
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Elapsed time, counted up rather than down.
 *
 * Counting up is the honest direction: nothing here knows how long an LLM call
 * will take, and a countdown would be inventing an estimate.
 *
 * @param {number} milliseconds
 * @returns {string}
 */
export function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Turns `min_years_experience` into "Min years experience" for a heading.
 *
 * Used only where `/config` gives no descriptor label - everywhere a descriptor
 * exists, the server's own `label` is shown instead.
 *
 * @param {string} value
 * @returns {string}
 */
export function humanizeToken(value) {
  const spaced = String(value).replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * @param {number} count
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string}
 */
export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
