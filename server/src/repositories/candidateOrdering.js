/**
 * The ranking rule for candidates, defined once, in SQL.
 *
 * Plan of record section 2: there is deliberately no JavaScript comparator
 * anywhere in this system. A second ranking definition is a bug waiting to
 * happen - the day one of the two changes, the dashboard and the API disagree
 * and nobody can tell which is right.
 *
 * `NULLS LAST` is the load-bearing part: not-yet-scored candidates sort last in
 * BOTH directions, so an in-progress batch never pushes real results off page 1.
 * `id DESC` is the tiebreaker that makes paging stable when scores tie - without
 * it, two rows on 88.0 can swap between page 1 and page 2 requests and a row is
 * silently skipped.
 */

/** @typedef {'desc' | 'asc'} RankingDirection */

const ORDER_BY_CLAUSES = Object.freeze({
  // Matches candidates_role_ranking_idx / candidates_role_fit_ranking_idx exactly.
  desc: 'ORDER BY match_score DESC NULLS LAST, id DESC',
  // NOTE: not index-ordered. A backwards scan of the DESC index yields
  // ASC NULLS FIRST, so this direction sorts. Acceptable at the row counts this
  // system sees; if "worst first" ever becomes a common view, it needs its own
  // (role_id, match_score ASC NULLS LAST, id DESC) index.
  asc: 'ORDER BY match_score ASC NULLS LAST, id DESC',
});

/**
 * @param {RankingDirection} [direction]
 * @returns {string} an ORDER BY clause, safe to interpolate (never user input)
 */
export function candidateRankingOrderBy(direction = 'desc') {
  const clause = ORDER_BY_CLAUSES[direction];
  if (!clause) {
    throw new Error(`unknown ranking direction "${direction}"`);
  }
  return clause;
}

/** @type {readonly RankingDirection[]} */
export const RANKING_DIRECTIONS = Object.freeze(['desc', 'asc']);
