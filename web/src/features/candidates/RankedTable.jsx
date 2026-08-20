/**
 * The ranked table. Finished, scored candidates only.
 *
 * Everything still working and everything that failed lives in the Processing
 * panel above this, which is what makes the table **stable under a score sort**:
 * a row cannot appear in the middle of it because a background job finished, and
 * a poll never reorders it. When candidates do finish, a bar above offers to
 * refresh - the recruiter chooses the moment the table moves.
 *
 * ## The eliminated row
 *
 * An eliminated candidate keeps its score, and the row shows all of it: the
 * number, the Unmatched tier, a ⊘ glyph, and a sub-line naming the rule that
 * removed them. Without that line the row reads "78.0, Unmatched, no reason",
 * and a recruiter who sees that once stops trusting the tool.
 */

import { Link } from 'react-router-dom';
import { TierBadge } from '../../components/Badge.jsx';
import { formatDateTime, formatScore } from '../../lib/format.js';

/**
 * @param {object} props
 * @param {any[]} props.candidates
 * @param {'asc'|'desc'} props.sort
 * @param {(sort: 'asc'|'desc') => void} props.onSortChange
 * @param {number} props.rankOffset the 1-based rank of the first row on this page
 */
export function RankedTable({ candidates, sort, onSortChange, rankOffset }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <caption>
          Scored candidates, {sort === 'desc' ? 'best first' : 'worst first'}. Candidates still
          being screened are listed above and are not in this table.
        </caption>
        <thead>
          <tr>
            <th scope="col" className="numeric">
              #
            </th>
            <th scope="col">Candidate</th>
            <th scope="col" className="numeric">
              <button
                type="button"
                className="sort-button"
                aria-pressed={true}
                onClick={() => onSortChange(sort === 'desc' ? 'asc' : 'desc')}
              >
                Score
                <span aria-hidden="true">{sort === 'desc' ? '▼' : '▲'}</span>
                <span className="visually-hidden">
                  {sort === 'desc'
                    ? ', sorted highest first. Activate to sort lowest first.'
                    : ', sorted lowest first. Activate to sort highest first.'}
                </span>
              </button>
            </th>
            <th scope="col">Tier</th>
            <th scope="col">Screened</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((candidate, index) => (
            <tr key={candidate.id}>
              <td className="numeric muted">{rankOffset + index}</td>
              <td>
                <Link className="candidate-link" to={`/candidates/${candidate.id}`}>
                  {candidate.candidateName ?? candidate.originalFilename}
                </Link>
                {candidate.candidateName ? (
                  <span className="row-subline">{candidate.originalFilename}</span>
                ) : null}
                {candidate.eliminated ? (
                  <span className="row-subline row-subline--danger">
                    <span aria-hidden="true">⊘ </span>
                    Eliminated by “{candidate.eliminatedBy}”. The score is what it would have
                    scored.
                  </span>
                ) : null}
              </td>
              <td className="numeric">
                <strong>{formatScore(candidate.matchScore)}</strong>
              </td>
              <td>
                <TierBadge fitCategory={candidate.fitCategory} />
              </td>
              <td className="muted">{formatDateTime(candidate.completedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
