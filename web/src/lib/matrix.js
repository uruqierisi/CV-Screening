/**
 * The arithmetic behind the evaluation matrix, done in one place so the table
 * can show its working.
 *
 * The API guarantees `weightedPoints = rating × weight` and
 * `Σ weightedPoints === scoreRaw` (plan section 3). This module does not trust
 * that guarantee - it **checks** it, and returns the check. That is the whole
 * difference between a Contribution column and an audit trail: a footer that
 * says "500 points, which is the score" is worth nothing unless something
 * noticed when it was not.
 *
 * ## The divisor is derived, not typed in
 *
 * `score = scoreRaw / 10` is true because ratings run 0..`ratingMax` and weights
 * sum to `requiredWeightSum`, so `scoreRaw` runs 0..`ratingMax × requiredWeightSum`
 * while the score runs 0..`scoreMax`. All four numbers come from `/config`, so
 * the divisor falls out of them rather than being a `10` in a component - which
 * is the same rule that keeps 85 and 65 out of this client.
 */

/**
 * @param {{ ratingMax: number, requiredWeightSum: number, scoreMax: number }} scoring
 *   the `scoring` block of `/config`
 * @returns {number}
 */
export function scoreDivisor(scoring) {
  const rawMax = scoring.ratingMax * scoring.requiredWeightSum;
  if (!Number.isFinite(rawMax) || rawMax === 0 || !Number.isFinite(scoring.scoreMax)) return 1;
  return rawMax / scoring.scoreMax;
}

/**
 * @typedef {object} MatrixRow
 * @property {string} criterionId
 * @property {string} label
 * @property {number} weight
 * @property {number} rating
 * @property {number} weightedPoints
 * @property {string} reason
 * @property {string | null} evidence
 * @property {boolean} arithmeticHolds `weightedPoints === rating × weight` for this row
 *
 * @typedef {object} Reconciliation
 * @property {MatrixRow[]} rows in the role's criterion order, as the server sent them
 * @property {number} weightSum
 * @property {number} pointsSum
 * @property {number} scoreRaw as the server reported it
 * @property {number} score `scoreRaw` divided down
 * @property {boolean} reconciles `pointsSum === scoreRaw` and every row holds
 */

/**
 * @param {{ scoreRaw: number, criteria: any[] } | null | undefined} matrix
 * @param {number} divisor
 * @returns {Reconciliation | null} null when there is no matrix to reconcile
 */
export function reconcileMatrix(matrix, divisor) {
  if (!matrix || !Array.isArray(matrix.criteria)) return null;

  const rows = matrix.criteria.map((row) => ({
    criterionId: row.criterionId,
    label: row.label,
    weight: row.weight,
    rating: row.rating,
    weightedPoints: row.weightedPoints,
    reason: row.reason,
    evidence: row.evidence ?? null,
    arithmeticHolds: row.weightedPoints === row.rating * row.weight,
  }));

  const weightSum = rows.reduce((total, row) => total + row.weight, 0);
  const pointsSum = rows.reduce((total, row) => total + row.weightedPoints, 0);
  const scoreRaw = matrix.scoreRaw;

  return {
    rows,
    weightSum,
    pointsSum,
    scoreRaw,
    score: scoreRaw / divisor,
    reconciles: pointsSum === scoreRaw && rows.every((row) => row.arithmeticHolds),
  };
}
