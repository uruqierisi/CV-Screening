/**
 * The candidate read contract: the dashboard's list, its poll, and the detail
 * view.
 *
 * Everything here is a query string, so everything is a string on arrival and
 * every numeric or boolean field is coerced. The enums are the point: `sort`,
 * `fitCategory`, `status` and `statusIn` all reach SQL, and an enum at the
 * boundary is what makes "only fixed column names are interpolated" true
 * upstream in the repository rather than merely intended.
 */

import { z } from 'zod';
import { FIT_CATEGORIES } from '../agents/index.js';
import { RANKING_DIRECTIONS } from '../repositories/candidateOrdering.js';
import { paginationQuery } from './common.schemas.js';

/**
 * The five values `candidates.status` can hold, per the column's CHECK - each
 * carrying the one other fact a client needs about it: whether it is terminal.
 *
 * **Written as a map rather than as two lists, because two lists is how a stop
 * condition ends up stated twice.** `/config` publishes both the vocabulary and
 * the terminal subset, and a client polls until a candidate reaches one of the
 * latter. If that subset were its own literal - here or in the frontend - a
 * sixth status could be added without it changing, and the poll would either
 * never stop or stop early. Deriving both lists from one map means the question
 * "is it terminal?" has to be answered at the point a status is added, which is
 * the only place anybody knows the answer.
 *
 * `Object.keys` preserves insertion order, so `CANDIDATE_STATUSES` is still the
 * pipeline order the column's CHECK lists.
 */
const CANDIDATE_STATUS_IS_TERMINAL = Object.freeze({
  pending: false,
  parsing: false,
  evaluating: false,
  done: true,
  failed: true,
});

/** The five values `candidates.status` can hold, in pipeline order. */
export const CANDIDATE_STATUSES = Object.freeze(Object.keys(CANDIDATE_STATUS_IS_TERMINAL));

/**
 * The subset nothing moves out of except through the retry endpoint - and
 * therefore the polling stop condition, published by `GET /config`.
 *
 * Derived, never listed. See the map above for why.
 */
export const TERMINAL_CANDIDATE_STATUSES = Object.freeze(
  CANDIDATE_STATUSES.filter((status) => CANDIDATE_STATUS_IS_TERMINAL[status]),
);

/** Ids per `GET /candidates/statuses` request. */
export const MAX_STATUS_IDS = 200;

/**
 * `?statusIn=parsing,evaluating,failed` - the same enum, as a set.
 *
 * It exists because "everything still working, plus everything that failed" is
 * one filter and a single `status` cannot express it: the dashboard was issuing
 * four parallel filtered requests to build one panel. Four requests to express
 * one filter is the API being wrong, not the client being clever.
 *
 * Comma-separated rather than repeated `statusIn=` parameters, matching
 * `/candidates/statuses?ids=` exactly - one canonical encoding means one thing
 * to validate, and one shape for a reviewer to recognise.
 *
 * **The cap is the number of statuses that exist.** A list longer than the
 * vocabulary is a client repeating a value, and the right answer to that is a
 * 400 rather than a longer parameter list: the point of the cap is that the
 * array reaching `= ANY($n)` is bounded by the column's own CHECK, whatever the
 * query string says.
 */
const statusInQuery = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((status) => status.trim())
      .filter((status) => status.length > 0),
  )
  .pipe(
    z
      .array(z.enum(/** @type {[string, ...string[]]} */ (CANDIDATE_STATUSES)))
      .min(1)
      .max(CANDIDATE_STATUSES.length),
  );

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
  // `statusIn` is additional to `status`, not a replacement for it. Both filter
  // the same column and both are applied, composing with AND exactly as `roleId`
  // and `jobId` do - so `?status=done&statusIn=done,failed` means "done", and
  // `?status=done&statusIn=failed` is an empty page rather than an error. That is
  // the least surprising rule available and it needs no new error code; a client
  // sending both is asking for an intersection and gets one.
  statusIn: statusInQuery.optional(),
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
