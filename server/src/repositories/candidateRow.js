/**
 * Column lists and row mappers shared by the candidate repositories.
 *
 * Split out so the read module and the status-transition module agree on the
 * shape of a candidate without one importing the other.
 *
 * Three projections, because `candidates` holds columns that must not be read
 * casually: `raw_text` is an entire CV and `parsed_profile` / `evaluation_matrix`
 * are sizeable JSON. A ranked list of 25 rows that dragged those along would move
 * megabytes to render a table of names and scores.
 *
 * @typedef {object} Candidate
 * @property {string} id
 * @property {string} roleId
 * @property {string} jobId
 * @property {string} originalFilename
 * @property {string | null} candidateName
 * @property {string} storagePath relative to UPLOAD_ROOT, never absolute
 * @property {string} contentSha256
 * @property {string} mimeType
 * @property {number} byteSize
 * @property {'pending'|'parsing'|'evaluating'|'done'|'failed'} status
 * @property {Record<string, any> | null} parsedProfile
 * @property {Record<string, any> | null} evaluationMatrix
 * @property {Record<string, any> | null} eliminationDetails
 * @property {boolean} eliminated
 * @property {string | null} eliminatedBy label of the rule that failed
 * @property {number | null} matchScore kept even when eliminated - see below
 * @property {'strong_match'|'potential_match'|'unmatched'|null} fitCategory
 * @property {string | null} aiJustification
 * @property {number | null} scoredRoleVersion
 * @property {string | null} errorCode
 * @property {string | null} errorMessage
 * @property {number} attempts
 * @property {Date} createdAt
 * @property {Date} updatedAt
 * @property {Date | null} completedAt
 * @property {string} [rawText] present only when explicitly requested
 *
 * @typedef {Pick<Candidate, 'id'|'roleId'|'jobId'|'candidateName'|'originalFilename'
 *   |'status'|'matchScore'|'fitCategory'|'eliminated'|'eliminatedBy'|'errorCode'
 *   |'createdAt'|'completedAt'>} CandidateListRow
 *
 * @typedef {Pick<Candidate, 'id'|'status'|'candidateName'|'matchScore'|'fitCategory'
 *   |'eliminated'|'eliminatedBy'|'errorCode'|'updatedAt'|'completedAt'>} CandidateStatusRow
 */

/** Everything except `raw_text`. */
export const CANDIDATE_FULL_COLUMNS = `
  id, role_id, job_id, original_filename, candidate_name, storage_path, content_sha256,
  mime_type, byte_size, status, parsed_profile, evaluation_matrix, elimination_details,
  eliminated, eliminated_by, match_score, fit_category, ai_justification,
  scored_role_version, error_code, error_message, attempts, created_at, updated_at,
  completed_at`;

/** The ranked-list projection from the API contract. */
export const CANDIDATE_LIST_COLUMNS = `
  id, role_id, job_id, candidate_name, original_filename, status, match_score,
  fit_category, eliminated, eliminated_by, error_code, created_at, completed_at`;

/** The polling projection: everything a dashboard row patches in place, nothing else. */
export const CANDIDATE_STATUS_COLUMNS = `
  id, status, candidate_name, match_score, fit_category, eliminated, eliminated_by,
  error_code, updated_at, completed_at`;

/**
 * @param {Record<string, any>} row
 * @returns {Candidate}
 */
export function toCandidate(row) {
  /** @type {Candidate} */
  const candidate = {
    id: row.id,
    roleId: row.role_id,
    jobId: row.job_id,
    originalFilename: row.original_filename,
    candidateName: row.candidate_name,
    storagePath: row.storage_path,
    contentSha256: row.content_sha256,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    status: row.status,
    parsedProfile: row.parsed_profile,
    evaluationMatrix: row.evaluation_matrix,
    eliminationDetails: row.elimination_details,
    eliminated: row.eliminated,
    eliminatedBy: row.eliminated_by,
    // An eliminated candidate KEEPS its score; only fit_category is forced to
    // 'unmatched'. "Eliminated, but would have scored 88" is the point.
    matchScore: row.match_score,
    fitCategory: row.fit_category,
    aiJustification: row.ai_justification,
    scoredRoleVersion: row.scored_role_version,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };

  if (row.raw_text !== undefined) {
    candidate.rawText = row.raw_text;
  }

  return candidate;
}

/**
 * @param {Record<string, any>} row
 * @returns {CandidateListRow}
 */
export function toCandidateListRow(row) {
  return {
    id: row.id,
    roleId: row.role_id,
    jobId: row.job_id,
    candidateName: row.candidate_name,
    originalFilename: row.original_filename,
    status: row.status,
    matchScore: row.match_score,
    fitCategory: row.fit_category,
    eliminated: row.eliminated,
    eliminatedBy: row.eliminated_by,
    errorCode: row.error_code,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/**
 * @param {Record<string, any>} row
 * @returns {CandidateStatusRow}
 */
export function toCandidateStatusRow(row) {
  return {
    id: row.id,
    status: row.status,
    candidateName: row.candidate_name,
    matchScore: row.match_score,
    fitCategory: row.fit_category,
    eliminated: row.eliminated,
    eliminatedBy: row.eliminated_by,
    errorCode: row.error_code,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}
