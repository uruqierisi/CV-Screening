/**
 * Job status, derived.
 *
 * `screening_jobs` has no status column, on purpose (plan section 2). A stored
 * status is a second copy of the truth, and it drifts the moment a worker dies
 * between "I am about to write done" and writing it. So status is computed from
 * the candidates every time it is asked for, which costs one indexed aggregate
 * over `(job_id, status)` and can never disagree with the rows it summarises.
 *
 * This file is a pure function over five integers. It has no database in it,
 * which is what lets the whole rule be tested without infrastructure - the
 * boundaries between `queued`, `in_progress` and the two completions are exactly
 * the kind of thing that should be provable by reading a test, not by watching a
 * dashboard.
 */

/** @typedef {import('../repositories/screeningJobsRepository.js').CandidateStatusCounts} CandidateStatusCounts */

/** The four values plan section 3 defines. */
export const JOB_STATUSES = Object.freeze({
  QUEUED: 'queued',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  COMPLETED_WITH_FAILURES: 'completed_with_failures',
});

/**
 * Plan section 3's rule, and one case it does not cover.
 *
 * The rule as written: all pending -> `queued`; any non-terminal -> `in_progress`;
 * all terminal with at least one failed -> `completed_with_failures`; else
 * `completed`.
 *
 * **The case it does not cover is a job with no candidates at all, and phase 4
 * created one.** Upload idempotency means a batch whose files were all uploaded
 * before produces a screening job with a `file_count` and zero candidates of its
 * own - the duplicates keep the `job_id` of the upload that first created them,
 * because re-pointing them would corrupt the older job's aggregate.
 *
 * Zero candidates satisfies "all pending" and "all terminal" vacuously, so the
 * rule as written is ambiguous there. It resolves to **`completed`**, and the
 * reason is behavioural rather than logical: a job with nothing outstanding is
 * finished, and answering `queued` would send the dashboard into a poll for work
 * that will never arrive.
 *
 * @param {CandidateStatusCounts} counts
 * @returns {string} one of {@link JOB_STATUSES}
 */
export function deriveJobStatus(counts) {
  if (counts.total === 0) {
    return JOB_STATUSES.COMPLETED;
  }

  if (counts.pending === counts.total) {
    return JOB_STATUSES.QUEUED;
  }

  const terminal = counts.done + counts.failed;
  if (terminal < counts.total) {
    return JOB_STATUSES.IN_PROGRESS;
  }

  return counts.failed > 0 ? JOB_STATUSES.COMPLETED_WITH_FAILURES : JOB_STATUSES.COMPLETED;
}

/**
 * True once nothing about this job can change again, which is what a polling
 * client uses to stop.
 *
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalJobStatus(status) {
  return status === JOB_STATUSES.COMPLETED || status === JOB_STATUSES.COMPLETED_WITH_FAILURES;
}
