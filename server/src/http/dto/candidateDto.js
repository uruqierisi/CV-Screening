/**
 * Candidate rows to response payloads.
 *
 * Three shapes, and the difference between them is the whole reason this file
 * exists: a 25-row page must not carry a profile, a matrix or a CV, and a detail
 * view is useless without them.
 *
 * ## The `aiJustification` decision, closed
 *
 * Plan section 3 recorded an open gap: `ai_justification` is written by the
 * worker (the model's `summary`, prose only) and no response shape carried it.
 * It was left open twice. **It is answered here: `aiJustification` is part of the
 * candidate detail payload, and of nothing else.**
 *
 * Why detail and not the list: it is two or three sentences of per-candidate
 * prose that a recruiter reads once, when they have opened one person. Shipping
 * it in a ranked page multiplies it by the page size to render a table of names
 * and scores that has nowhere to put it - the same argument that keeps
 * `parsed_profile` and `evaluation_matrix` out of the list projection.
 *
 * Why not "written and never read": the column is the only place the model's own
 * synthesis survives. Every other piece of model output on the detail screen is
 * per-criterion; the summary is the one sentence that says what this candidate
 * is like. Storing it and never showing it would mean paying for it on every
 * candidate and throwing it away.
 *
 * The list projection in the repository is unchanged, so this decision costs no
 * extra column read on the hot path.
 */

/**
 * @typedef {import('../../repositories/candidateRow.js').Candidate} Candidate
 * @typedef {import('../../repositories/candidateRow.js').CandidateListRow} CandidateListRow
 * @typedef {import('../../repositories/candidateRow.js').CandidateStatusRow} CandidateStatusRow
 */

/**
 * Dates cross the wire as ISO 8601 strings, always, including the nullable ones.
 *
 * Fastify's serializer would do this for a `Date`, but not identically for a
 * null, and a field that is sometimes a string and sometimes something else is
 * the kind of thing a client discovers in production.
 *
 * @param {Date | string | null | undefined} value
 * @returns {string | null}
 */
function isoOrNull(value) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The ranked-list row from plan section 3. Nothing else may be added here
 * without asking what it costs multiplied by the page size.
 *
 * @param {CandidateListRow} row
 * @returns {Record<string, unknown>}
 */
export function toCandidateListDto(row) {
  return {
    id: row.id,
    roleId: row.roleId,
    jobId: row.jobId,
    candidateName: row.candidateName,
    originalFilename: row.originalFilename,
    status: row.status,
    matchScore: row.matchScore,
    fitCategory: row.fitCategory,
    // An eliminated candidate keeps its score and carries the failing rule's
    // label. Without `eliminatedBy` the table reads "78 points, Unmatched, no
    // reason", which is what makes a recruiter stop trusting the tool.
    eliminated: row.eliminated,
    eliminatedBy: row.eliminatedBy,
    errorCode: row.errorCode,
    createdAt: isoOrNull(row.createdAt),
    completedAt: isoOrNull(row.completedAt),
  };
}

/**
 * The poll payload. Deliberately the smallest thing that lets the dashboard
 * patch a row in place without reordering it.
 *
 * @param {CandidateStatusRow} row
 * @returns {Record<string, unknown>}
 */
export function toCandidateStatusDto(row) {
  return {
    id: row.id,
    status: row.status,
    candidateName: row.candidateName,
    matchScore: row.matchScore,
    fitCategory: row.fitCategory,
    eliminated: row.eliminated,
    eliminatedBy: row.eliminatedBy,
    errorCode: row.errorCode,
    updatedAt: isoOrNull(row.updatedAt),
    completedAt: isoOrNull(row.completedAt),
  };
}

/**
 * The detail payload: the list row, plus everything that justifies it.
 *
 * `errorMessage` is included and `errorCode` is already in the list row. Both
 * come from the **worker-side** namespace and arrive inside a 200 - a candidate
 * that failed to screen is a successful read of a failed candidate, and the
 * message is one the extraction or agent layer wrote for a recruiter.
 *
 * @param {Candidate} candidate
 * @returns {Record<string, unknown>}
 */
export function toCandidateDetailDto(candidate) {
  const detail = {
    ...toCandidateListDto(candidate),
    parsedProfile: candidate.parsedProfile,
    evaluationMatrix: candidate.evaluationMatrix,
    eliminationDetails: candidate.eliminationDetails,
    // The decision recorded at the top of this file.
    aiJustification: candidate.aiJustification,
    errorMessage: candidate.errorMessage,
    // The role version this score was produced under. Roles are editable and
    // there is no rescore path (plan section 8), so two candidates on one
    // dashboard can have been scored against different rubrics; this is the only
    // thing that says so.
    scoredRoleVersion: candidate.scoredRoleVersion,
    mimeType: candidate.mimeType,
    byteSize: candidate.byteSize,
    attempts: candidate.attempts,
    updatedAt: isoOrNull(candidate.updatedAt),
  };

  // Present only when `?includeRawText=true` asked for it, and absent - not
  // null - otherwise, so the two cases are distinguishable.
  if (candidate.rawText !== undefined) {
    return { ...detail, rawText: candidate.rawText };
  }
  return detail;
}

/**
 * The per-file entry in an upload response.
 *
 * `duplicate` is the observable half of upload idempotency: same bytes, same
 * role, same candidate, no new work. The caller can tell which files were new
 * and which already existed without diffing anything.
 *
 * `status` is the candidate's **real** status rather than a hard-coded
 * `"pending"`. For a new candidate those are the same string; for a duplicate of
 * something already screened it is `done`, and saying `pending` there would send
 * the dashboard into a poll for work that finished last week.
 *
 * @param {{ candidate: Candidate, created: boolean }} entry
 * @returns {Record<string, unknown>}
 */
export function toUploadedCandidateDto({ candidate, created }) {
  return {
    id: candidate.id,
    originalFilename: candidate.originalFilename,
    status: candidate.status,
    duplicate: !created,
  };
}
