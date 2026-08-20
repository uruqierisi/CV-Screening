/**
 * The candidate read contract: the dashboard's list, its poll, and the detail
 * view.
 *
 * Everything here is a query string, so everything is a string on arrival and
 * every numeric or boolean field is coerced. The enums are the point: `sort`,
 * `fitCategory` and `status` all reach SQL, and an enum at the boundary is what
 * makes "only fixed column names are interpolated" true upstream in the
 * repository rather than merely intended.
 */

import { z } from 'zod';
import { FIT_CATEGORIES } from '../agents/index.js';
import { RANKING_DIRECTIONS } from '../repositories/candidateOrdering.js';
import { paginationQuery } from './common.schemas.js';

/** The five values `candidates.status` can hold, per the column's CHECK. */
export const CANDIDATE_STATUSES = Object.freeze([
  'pending',
  'parsing',
  'evaluating',
  'done',
  'failed',
]);

/** Ids per `GET /candidates/statuses` request. */
export const MAX_STATUS_IDS = 200;

/**
 * `GET /api/v1/candidates`.
 *
 * `roleId` is optional at this layer even though the dashboard always sends one:
 * "every candidate across every role" is a legitimate read, and the ranking
 * index leads with `role_id` so the filtered case - the one that matters - is
 * the one that is fast.
 */
export const listCandidatesQuerySchema = paginationQuery.extend({
  roleId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  fitCategory: z.enum(FIT_CATEGORIES).optional(),
  status: z.enum(/** @type {[string, ...string[]]} */ (CANDIDATE_STATUSES)).optional(),
  // Named `sort` rather than `order` because it selects one of two whole ORDER BY
  // clauses in `candidateOrdering.js`, not a direction applied to a column named
  // elsewhere. There is exactly one ranking definition and this picks an end of it.
  sort: z.enum(/** @type {[string, ...string[]]} */ (RANKING_DIRECTIONS)).default('desc'),
});

/**
 * `GET /api/v1/candidates/statuses?ids=a,b,c`.
 *
 * A comma-separated list rather than repeated `ids=` parameters: the dashboard
 * builds it from the rows on screen, and one canonical encoding means one thing
 * to validate. The cap is what keeps a poll from turning into an unbounded
 * `id = ANY($1)`.
 */
export const candidateStatusesQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    )
    .pipe(z.array(z.string().uuid()).min(1).max(MAX_STATUS_IDS)),
});

/**
 * `GET /api/v1/candidates/:candidateId`.
 *
 * `rawText` is an entire CV. It is excluded from the detail payload unless asked
 * for explicitly, so the ordinary detail read moves kilobytes rather than
 * hundreds of them, and so a log of response sizes does not quietly become a
 * log of CV lengths.
 */
export const candidateDetailQuerySchema = z.object({
  includeRawText: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
