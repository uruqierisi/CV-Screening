/**
 * The two endpoints that describe the server rather than its data: `/config` and
 * `/health`.
 *
 * `/config` exists so upload limits, elimination-rule descriptors and tier
 * thresholds are defined **once, server-side** (plan section 3). The alternative
 * is a set of client constants that agree with the server on the day they are
 * written and drift from it thereafter - and the specific drift that matters
 * here is the tier thresholds, because a client that recomputes a tier from a
 * score would silently disagree with an eliminated candidate's `unmatched`.
 */

import {
  EDUCATION_LEVELS,
  ELIMINATION_RULE_TYPES,
  FIT_CATEGORIES,
  MATCH_MODES,
  ON_MISSING_MODES,
  RATING_MAX,
  RATING_MIN,
  REQUIRED_WEIGHT_SUM,
  SCORE_MAX,
  SCORE_MIN,
  TIER_THRESHOLDS,
  WEIGHT_MAX,
  WEIGHT_MIN,
} from '../agents/index.js';
import { SUPPORTED_MIME_TYPES } from '../extraction/index.js';
import { env } from '../config/env.js';
import { ok } from '../http/boundary.js';
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../schemas/common.schemas.js';
import {
  CANDIDATE_STATUSES,
  MAX_STATUS_IDS,
  TERMINAL_CANDIDATE_STATUSES,
} from '../schemas/candidate.schemas.js';
import { JOB_STATUSES } from '../services/jobStatus.js';
import { pool } from '../db/pool.js';
import { redisReachable } from '../queue/connection.js';

/**
 * A rule type, described well enough for a form to render it without hard-coding
 * anything about it beyond the field names.
 *
 * The descriptors are deliberately shallow: enough to label a control and
 * populate a select, not a schema language. A client that needs more should be
 * asking for a narrower endpoint, not a richer one here.
 */
const ELIMINATION_RULE_DESCRIPTORS = Object.freeze({
  min_years_experience: {
    label: 'Minimum years of experience',
    fields: [{ name: 'years', type: 'integer', min: 0, max: 60 }],
  },
  required_skill: {
    label: 'Required skill',
    fields: [
      { name: 'skill', type: 'string' },
      { name: 'matchMode', type: 'enum', options: MATCH_MODES },
      { name: 'mustBeDemonstrated', type: 'boolean' },
    ],
  },
  required_education_level: {
    label: 'Required education level',
    fields: [{ name: 'level', type: 'enum', options: EDUCATION_LEVELS }],
  },
  required_certification: {
    label: 'Required certification',
    fields: [
      { name: 'name', type: 'string' },
      { name: 'matchMode', type: 'enum', options: MATCH_MODES },
    ],
  },
  location_allowlist: {
    label: 'Allowed locations',
    fields: [{ name: 'countryCodes', type: 'string[]', pattern: 'ISO-3166-1 alpha-2, upper case' }],
  },
});

/**
 * `GET /api/v1/config` -> 200
 *
 * @param {import('fastify').FastifyRequest} _request
 * @param {import('fastify').FastifyReply} reply
 */
export async function getConfig(_request, reply) {
  return reply.send(
    ok({
      upload: {
        maxFileBytes: env.MAX_UPLOAD_BYTES,
        maxBatchFiles: env.MAX_BATCH_FILES,
        acceptedMimeTypes: SUPPORTED_MIME_TYPES,
      },
      scoring: {
        requiredWeightSum: REQUIRED_WEIGHT_SUM,
        weightMin: WEIGHT_MIN,
        weightMax: WEIGHT_MAX,
        ratingMin: RATING_MIN,
        ratingMax: RATING_MAX,
        scoreMin: SCORE_MIN,
        scoreMax: SCORE_MAX,
        // The client never recomputes a tier from a score - elimination
        // overrides score, and a client reimplementation would diverge the day a
        // threshold moves. These are here to render a legend, not to decide one.
        tierThresholds: TIER_THRESHOLDS,
        fitCategories: FIT_CATEGORIES,
      },
      eliminationRules: {
        types: ELIMINATION_RULE_TYPES,
        onMissingModes: ON_MISSING_MODES,
        descriptors: ELIMINATION_RULE_DESCRIPTORS,
      },
      candidates: {
        statuses: CANDIDATE_STATUSES,
        // The polling stop condition, published rather than left for a client to
        // restate. `statuses` alone tells a dashboard what the column can hold
        // and not when to stop asking, so every client had to carry its own
        // `['done','failed']` - the last duplicated constant in the frontend,
        // and a stop condition is the worst possible thing to keep two copies
        // of: one copy drifting means a poll that never stops or one that stops
        // on a candidate still being screened.
        //
        // Derived from the same map `statuses` comes from, so a sixth status
        // cannot be added without answering whether it belongs here.
        terminalStatuses: TERMINAL_CANDIDATE_STATUSES,
        maxStatusIds: MAX_STATUS_IDS,
      },
      jobs: {
        statuses: Object.values(JOB_STATUSES),
      },
      pagination: {
        defaultPageSize: DEFAULT_PAGE_SIZE,
        maxPageSize: MAX_PAGE_SIZE,
      },
    }),
  );
}

/**
 * `GET /api/v1/health` -> 200 when both dependencies answer, 503 when one does
 * not.
 *
 * A health check that returns 200 while Postgres is unreachable is worse than no
 * health check, because it is what a load balancer believes. Both probes are
 * cheap and neither opens a connection it would not otherwise have.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function getHealth(request, reply) {
  const [database, redis] = await Promise.all([databaseReachable(request), redisReachable()]);

  const healthy = database && redis;

  return reply.status(healthy ? 200 : 503).send(
    ok({
      status: healthy ? 'ok' : 'degraded',
      dependencies: { database, redis },
    }),
  );
}

/**
 * @param {import('fastify').FastifyRequest} request
 * @returns {Promise<boolean>}
 */
async function databaseReachable(request) {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (error) {
    // Logged rather than returned: the reason a database is unreachable is a
    // connection string and a hostname, and neither belongs in a public
    // liveness response.
    request.log.error({ err: error }, 'database health check failed');
    return false;
  }
}
