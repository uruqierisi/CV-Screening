/**
 * What a candidate status means to this client.
 *
 * ## The one thing `/config` does not say
 *
 * `/config` returns `candidates.statuses` - the five values the column can hold -
 * but it does not say **which of them are terminal**, and the polling stop
 * condition is exactly that question. `GET /jobs/:jobId` carries a `terminal`
 * boolean, but that is the derived status of a *job*, and the dashboard polls
 * candidate statuses rather than a job.
 *
 * So the set below is the one piece of API semantics this client restates, and
 * it is restated **here, once**, rather than as a `status === 'done'` scattered
 * through components. It is not the kind of constant plan section 3 was written
 * to prevent duplicating: a tier threshold is a tuning decision that can move,
 * whereas `done` and `failed` being the ends of the pipeline is the shape of the
 * state machine, asserted by a CHECK constraint and by four integrity
 * constraints on the candidates table.
 *
 * Recorded as a gap regardless: a `terminalStatuses` array in `/config` would
 * close it, and `isTerminalCandidateStatus` is the only line that would change.
 */

/** The two statuses after which nothing about a candidate changes on its own. */
export const TERMINAL_CANDIDATE_STATUSES = Object.freeze(['done', 'failed']);

/** The three that mean the pipeline still owes an answer. */
export const ACTIVE_CANDIDATE_STATUSES = Object.freeze(['pending', 'parsing', 'evaluating']);

/**
 * @param {string | null | undefined} status
 * @returns {boolean}
 */
export function isTerminalCandidateStatus(status) {
  return TERMINAL_CANDIDATE_STATUSES.includes(/** @type {string} */ (status));
}

/**
 * **The polling stop condition, as a pure function.**
 *
 * Not "after N attempts" and not "on a timer": the stop condition is the data.
 * Polling stops when every candidate being watched has reached `done` or
 * `failed`, and an empty set is finished by the same rule that makes a job with
 * no candidates `completed` server-side - there is nothing outstanding, so there
 * is nothing to wait for.
 *
 * @param {Array<{ status?: string }>} candidates
 * @returns {boolean}
 */
export function allCandidatesTerminal(candidates) {
  return candidates.every((candidate) => isTerminalCandidateStatus(candidate.status));
}

/**
 * Human labels for the five statuses, and the stepper stage each belongs to.
 *
 * The labels are recruiter-facing and say what the system is doing rather than
 * naming a column value: "Queued" beats "pending" to somebody who has just
 * pressed Upload.
 */
export const CANDIDATE_STATUS_LABELS = Object.freeze({
  pending: 'Queued',
  parsing: 'Reading the CV',
  evaluating: 'Evaluating against the role',
  done: 'Scored',
  failed: 'Failed',
});

/**
 * @param {string | null | undefined} status
 * @returns {string}
 */
export function candidateStatusLabel(status) {
  return CANDIDATE_STATUS_LABELS[/** @type {string} */ (status)] ?? String(status ?? 'unknown');
}
