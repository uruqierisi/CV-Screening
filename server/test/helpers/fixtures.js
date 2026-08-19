import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../src/db/withTransaction.js';
import { insertRole } from '../../src/repositories/rolesRepository.js';
import { replaceCriteriaForRole } from '../../src/repositories/roleCriteriaRepository.js';
import { replaceEliminationRulesForRole } from '../../src/repositories/roleEliminationRulesRepository.js';
import { insertScreeningJob } from '../../src/repositories/screeningJobsRepository.js';
import { insertCandidates } from '../../src/repositories/candidatesRepository.js';
import {
  markCandidateDone,
  markCandidateEvaluating,
  markCandidateParsing,
} from '../../src/repositories/candidateStatusRepository.js';
import { pool } from './database.js';

/**
 * Fixture builders.
 *
 * These use the real repositories rather than raw INSERTs, so a fixture that
 * stops compiling is a signal that a repository contract changed - and so no test
 * can accidentally create a row the application itself could not have created.
 */

/** Two criteria that already sum to 100, for tests that do not care about weights. */
const DEFAULT_CRITERIA = [
  { label: 'Technical depth', weight: 60, position: 0 },
  { label: 'Communication', weight: 40, position: 1 },
];

/**
 * Creates a role with criteria and elimination rules in one transaction, the way
 * POST /roles will.
 *
 * @param {object} [input]
 * @param {string} [input.title]
 * @param {string} [input.description]
 * @param {import('../../src/repositories/roleCriteriaRepository.js').RoleCriterionInput[]} [input.criteria]
 * @param {import('../../src/repositories/roleEliminationRulesRepository.js').EliminationRuleInput[]} [input.eliminationRules]
 * @returns {Promise<{ role: import('../../src/repositories/rolesRepository.js').Role, criteria: any[], eliminationRules: any[] }>}
 */
export async function createRole(input = {}) {
  const {
    title = 'Senior Backend Engineer',
    description = '',
    criteria = DEFAULT_CRITERIA,
    eliminationRules = [],
  } = input;

  return withTransaction(async (client) => {
    const role = await insertRole(client, { title, description });
    const insertedCriteria = await replaceCriteriaForRole(client, role.id, criteria);
    const insertedRules = await replaceEliminationRulesForRole(client, role.id, eliminationRules);
    return { role, criteria: insertedCriteria, eliminationRules: insertedRules };
  });
}

/**
 * One valid candidate insert payload. Every field is overridable; the defaults
 * are what a real upload of a small PDF looks like.
 *
 * @param {Partial<import('../../src/repositories/candidatesRepository.js').CandidateInsertInput>} [overrides]
 * @returns {import('../../src/repositories/candidatesRepository.js').CandidateInsertInput}
 */
export function candidateInput(overrides = {}) {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    originalFilename: 'jane-doe-cv.pdf',
    // Mirrors the real storage rule: a path derived from the candidate id,
    // relative to UPLOAD_ROOT, never absolute.
    storagePath: `${id}.pdf`,
    contentSha256: 'a'.repeat(64),
    mimeType: 'application/pdf',
    byteSize: 128_000,
    ...overrides,
  };
}

/**
 * Creates a screening job and its candidates in one transaction, the way an
 * upload will - job first, candidates second, committed together.
 *
 * @param {{ roleId: string, candidates?: Array<Partial<import('../../src/repositories/candidatesRepository.js').CandidateInsertInput>> }} input
 * @returns {Promise<{ job: import('../../src/repositories/screeningJobsRepository.js').ScreeningJob, candidates: import('../../src/repositories/candidateRow.js').Candidate[] }>}
 */
export async function createScreeningJob({ roleId, candidates = [{}] }) {
  const inputs = candidates.map((overrides) => candidateInput(overrides));

  return withTransaction(async (client) => {
    const job = await insertScreeningJob(client, { roleId, fileCount: inputs.length });
    const inserted = await insertCandidates(client, {
      roleId,
      jobId: job.id,
      candidates: inputs,
    });
    return { job, candidates: inserted };
  });
}

/**
 * Walks a candidate through the real transition sequence to `done`.
 *
 * Deliberately not a single UPDATE: the guarded transitions only accept the
 * status they expect, so this also proves the happy path is reachable.
 *
 * @param {string} candidateId
 * @param {Partial<Parameters<typeof markCandidateDone>[1]>} [result]
 * @returns {Promise<import('../../src/repositories/candidateRow.js').Candidate>}
 */
export async function driveCandidateToDone(candidateId, result = {}) {
  await markCandidateParsing(pool, candidateId);
  await markCandidateEvaluating(pool, { candidateId, rawText: 'Jane Doe\nSenior Engineer\n' });

  const outcome = await markCandidateDone(pool, {
    candidateId,
    candidateName: 'Jane Doe',
    parsedProfile: { name: 'Jane Doe', skills: [] },
    evaluationMatrix: { scoreRaw: 880, criteria: [] },
    eliminationDetails: { failures: [], indeterminate: [] },
    eliminated: false,
    eliminatedBy: null,
    matchScore: 88.0,
    fitCategory: 'strong_match',
    aiJustification: 'Strong backend depth with demonstrated PostgreSQL work.',
    scoredRoleVersion: 1,
    ...result,
  });

  if (!outcome.ok) {
    throw new Error(`fixture could not reach done: ${outcome.reason}`);
  }

  return outcome.candidate;
}
