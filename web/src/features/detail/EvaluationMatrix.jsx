/**
 * The evaluation matrix: every criterion, its rating, its contribution, the
 * model's reason, and **the verbatim quote the rating rests on**.
 *
 * ## Why this screen exists
 *
 * The score is arithmetic over ratings, and the ratings are a model's judgement.
 * What makes that auditable rather than merely asserted is that each judgement is
 * shown with the sentence from the CV it came from. A recruiter who disagrees
 * with a 3 can see exactly what the model was looking at when it wrote the 3.
 *
 * ## The contribution column reconciles
 *
 * `weightedPoints = rating × weight` and `Σ weightedPoints = scoreRaw` are
 * guaranteed by the server, so the footer shows the addition rather than asking
 * anyone to trust it: the column totals, the total equals `scoreRaw`, and
 * `scoreRaw` divided down equals the match score printed at the top of the page.
 * `lib/matrix.js` checks all of it and this renders a warning if any part fails -
 * because a Contribution column nobody checks is decoration.
 *
 * ## Reasons are never truncated
 *
 * No tooltips, no "…", no expanding row. The reason is the product. A table that
 * hides it behind a hover has hidden the only thing on the page worth reading,
 * and hover does not exist on a phone or a keyboard.
 */

import { formatScore } from '../../lib/format.js';

/**
 * @param {object} props
 * @param {import('../../lib/matrix.js').Reconciliation} props.reconciliation
 * @param {number} props.matchScore the score the server stored on the candidate
 * @param {number} props.divisor derived from `/config` in `lib/matrix.js`
 * @param {string} props.computedAt
 */
export function EvaluationMatrix({ reconciliation, matchScore, divisor, computedAt }) {
  const { rows, weightSum, pointsSum, scoreRaw, score, reconciles } = reconciliation;
  // The stored score and the score implied by the matrix should be the same
  // number. If they are not, the row on the dashboard and the table on this page
  // are telling a recruiter two different things, and that is worth saying out loud.
  const agreesWithStoredScore = Math.abs(score - matchScore) < 0.05;

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>How this score was produced</h2>
          <p className="muted">
            The model rated each criterion and wrote the reason and the quote. Code multiplied each
            rating by its weight and added them up. The model was never shown the weights, so a
            rating is an observation rather than an attempt at the total.
          </p>
        </div>
      </div>

      {!reconciles || !agreesWithStoredScore ? (
        <div className="notice notice--danger" role="alert">
          <span>
            The contributions below do not add up to the score on this page. Do not rely on this
            candidate's ranking — the matrix totals {pointsSum} against a stated{' '}
            {scoreRaw}, and the stored score is {formatScore(matchScore)}. Report this with the
            candidate id.
          </span>
        </div>
      ) : null}

      <div className="table-wrap">
        <table className="data">
          <caption>
            Evaluation matrix, in the role's own criterion order. Computed{' '}
            {new Date(computedAt).toLocaleString()}.
          </caption>
          <thead>
            <tr>
              <th scope="col">Criterion</th>
              <th scope="col" className="numeric">
                Weight
              </th>
              <th scope="col" className="numeric">
                Rating
              </th>
              <th scope="col" className="numeric">
                Contribution
              </th>
              <th scope="col">Why, and the evidence</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.criterionId}>
                <th scope="row">{row.label}</th>
                <td className="numeric">{row.weight}</td>
                <td className="numeric">{row.rating}</td>
                <td className="numeric">
                  {row.weightedPoints}
                  <span className="row-subline">
                    {row.rating} × {row.weight}
                  </span>
                </td>
                <td>
                  <p className="matrix__reason">{row.reason}</p>
                  {row.evidence ? (
                    <blockquote className="matrix__evidence">
                      {row.evidence}
                      <cite>Evidence the model cited for this rating</cite>
                    </blockquote>
                  ) : (
                    <p className="matrix__evidence matrix__evidence--absent">
                      The model cited no evidence for this rating. Treat it as an impression rather
                      than a finding.
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td className="numeric">{weightSum}</td>
              <td className="numeric" />
              <td className="numeric">{pointsSum}</td>
              <td>
                {pointsSum} points ÷ {divisor} = <strong>{formatScore(score)}</strong>, which is
                the match score for this candidate.
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
