/**
 * Everything that is not a finished, scored candidate: still working, or failed.
 *
 * It sits **above** the ranked table so that the table below can contain only
 * `done` rows and stay stable under a score sort. Purely presentational - the
 * dashboard owns the poll and hands the patched rows down.
 *
 * A failed candidate carries a recruiter-facing `errorCode` here and a full
 * `errorMessage` on its detail page. The message is not in the list projection
 * (deliberately - it would be carried on every row of a 25-row page to be shown
 * on none of them), so this panel shows the code, offers the retry, and links to
 * the page that explains it.
 */

import { Link } from 'react-router-dom';
import { Badge, StatusBadge } from '../../components/Badge.jsx';
import { formatDateTime } from '../../lib/format.js';
import { isTerminalCandidateStatus } from '../../lib/candidateStatus.js';

/**
 * @param {object} props
 * @param {any[]} props.rows
 * @param {(candidateId: string) => void} props.onRetry
 * @param {string | null} props.retrying id of the candidate whose retry is in flight
 * @param {boolean} props.truncated
 */
export function ProcessingPanel({ rows, onRetry, retrying, truncated }) {
  const working = rows.filter((row) => !isTerminalCandidateStatus(row.status));
  const failed = rows.filter((row) => row.status === 'failed');

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>Processing</h2>
        <p className="muted">
          {working.length} still being screened, {failed.length} failed. These are kept out of the
          ranked table below so it does not reorder while you read it.
        </p>
      </div>

      {truncated ? (
        <div className="notice notice--warn">
          <span>
            More than 100 candidates share one of these statuses, so this panel is showing the
            first 100 of them.
          </span>
        </div>
      ) : null}

      <div className="table-wrap">
        <table className="data">
          <caption>Candidates that are not yet scored, or that failed to screen.</caption>
          <thead>
            <tr>
              <th scope="col">Candidate</th>
              <th scope="col">Status</th>
              <th scope="col">Uploaded</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link className="candidate-link" to={`/candidates/${row.id}`}>
                    {row.candidateName ?? row.originalFilename}
                  </Link>
                  {row.candidateName ? (
                    <span className="row-subline">{row.originalFilename}</span>
                  ) : null}
                </td>
                <td>
                  <StatusBadge status={row.status} />
                  {row.status === 'failed' && row.errorCode ? (
                    <span className="row-subline row-subline--danger">
                      <Badge modifier="danger">{row.errorCode}</Badge>
                    </span>
                  ) : null}
                </td>
                <td className="muted">{formatDateTime(row.createdAt)}</td>
                <td>
                  <div className="button-row">
                    {row.status === 'failed' ? (
                      <button
                        type="button"
                        className="button button--small"
                        disabled={retrying === row.id}
                        onClick={() => onRetry(row.id)}
                      >
                        {retrying === row.id ? 'Re-queueing…' : 'Retry'}
                      </button>
                    ) : null}
                    <Link className="button button--small" to={`/candidates/${row.id}`}>
                      {row.status === 'failed' ? 'Why it failed' : 'Open'}
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
