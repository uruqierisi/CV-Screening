import { describe, expect, it } from 'vitest';
import { JOB_STATUSES, deriveJobStatus, isTerminalJobStatus } from '../../src/services/jobStatus.js';

/**
 * The derived job status.
 *
 * `screening_jobs` has no status column, so this function is the whole
 * definition of "is this upload finished". It is five integers in and one string
 * out, which means every boundary in plan section 3's rule can be pinned here
 * rather than observed on a dashboard.
 *
 * The cases below are chosen so that a wrong comparison shows up: `<` for `<=`,
 * `>` for `>=`, `pending` for `total`, and the zero-candidate case that the plan
 * rule does not cover.
 */

/**
 * @param {Partial<Record<'pending'|'parsing'|'evaluating'|'done'|'failed', number>>} counts
 */
function counts(partial) {
  const full = { pending: 0, parsing: 0, evaluating: 0, done: 0, failed: 0, ...partial };
  return { ...full, total: full.pending + full.parsing + full.evaluating + full.done + full.failed };
}

describe('deriveJobStatus', () => {
  it('is queued when every candidate is still pending', () => {
    expect(deriveJobStatus(counts({ pending: 3 }))).toBe(JOB_STATUSES.QUEUED);
  });

  it('is in_progress the moment one candidate leaves pending', () => {
    expect(deriveJobStatus(counts({ pending: 2, parsing: 1 }))).toBe(JOB_STATUSES.IN_PROGRESS);
  });

  it('is in_progress when one is done and the rest are still pending', () => {
    // The interesting half of the "all pending" boundary: a job that has
    // produced a result is not queued, even though nothing is mid-flight.
    expect(deriveJobStatus(counts({ pending: 2, done: 1 }))).toBe(JOB_STATUSES.IN_PROGRESS);
  });

  it('is in_progress while a single candidate is evaluating', () => {
    expect(deriveJobStatus(counts({ evaluating: 1 }))).toBe(JOB_STATUSES.IN_PROGRESS);
  });

  it('is completed when every candidate is done', () => {
    expect(deriveJobStatus(counts({ done: 4 }))).toBe(JOB_STATUSES.COMPLETED);
  });

  it('is completed_with_failures when everything is terminal and one failed', () => {
    expect(deriveJobStatus(counts({ done: 3, failed: 1 }))).toBe(
      JOB_STATUSES.COMPLETED_WITH_FAILURES,
    );
  });

  it('is completed_with_failures when every candidate failed', () => {
    expect(deriveJobStatus(counts({ failed: 2 }))).toBe(JOB_STATUSES.COMPLETED_WITH_FAILURES);
  });

  it('is in_progress when a failure sits beside work that is still running', () => {
    // The trap: "any failed means completed_with_failures" is wrong, because the
    // job is not complete. Terminality is checked first, on purpose.
    expect(deriveJobStatus(counts({ failed: 1, parsing: 1 }))).toBe(JOB_STATUSES.IN_PROGRESS);
  });

  it('is completed for a job with no candidates of its own', () => {
    // Upload idempotency created this case: a batch whose files were all
    // uploaded before produces a screening job with a file count and no
    // candidates, because the duplicates keep the job id of the upload that
    // first created them. Zero satisfies both "all pending" and "all terminal"
    // vacuously; `completed` is the answer that does not send a dashboard into a
    // poll for work that will never arrive.
    expect(deriveJobStatus(counts({}))).toBe(JOB_STATUSES.COMPLETED);
  });

  it('is queued for a single pending candidate', () => {
    expect(deriveJobStatus(counts({ pending: 1 }))).toBe(JOB_STATUSES.QUEUED);
  });
});

describe('isTerminalJobStatus', () => {
  it.each([
    [JOB_STATUSES.COMPLETED, true],
    [JOB_STATUSES.COMPLETED_WITH_FAILURES, true],
    [JOB_STATUSES.QUEUED, false],
    [JOB_STATUSES.IN_PROGRESS, false],
  ])('%s -> %s', (status, expected) => {
    expect(isTerminalJobStatus(status)).toBe(expected);
  });
});
