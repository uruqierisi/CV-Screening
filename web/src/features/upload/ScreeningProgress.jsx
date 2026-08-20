/**
 * What happens after the 202: the server pipeline, watched per candidate.
 *
 * ## What this polls, and why not `/jobs/:jobId`
 *
 * The upload response carries one entry per file, in upload order, each with its
 * candidate id. That means this screen can poll
 * `GET /candidates/statuses?ids=…` and show **which file** is parsing and which
 * one failed - where `GET /jobs/:jobId` returns counts, which can say "three
 * evaluating" but not which three. Both are legitimate poll targets and the job
 * endpoint is the cheaper one; the per-file view is worth the extra bytes on a
 * screen whose entire job is to account for the files somebody just handed over.
 *
 * The one thing the job endpoint knows and this does not - `duplicateCount` -
 * already arrives in the upload response's `meta`, so nothing is lost.
 *
 * ## The stop condition
 *
 * `allCandidatesTerminal`: every watched candidate is `done` or `failed`. Not a
 * timer, not an attempt count. A batch whose files were all duplicates of
 * already-screened CVs comes back `done` on the first poll and this stops
 * immediately, which is exactly what upload idempotency is for.
 */

import { useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { listCandidateStatuses } from '../../api/candidates.js';
import { usePolledResource } from '../../hooks/usePolledResource.js';
import { allCandidatesTerminal } from '../../lib/candidateStatus.js';
import { stopReasonMessage } from '../../lib/pollSchedule.js';
import { formatClockTime, formatScore, pluralize } from '../../lib/format.js';
import { Spinner } from '../../components/Spinner.jsx';
import { ErrorState } from '../../components/States.jsx';
import { Badge, TierBadge } from '../../components/Badge.jsx';
import { PipelineStepper } from './PipelineStepper.jsx';

/** Plan section 6: the upload screen polls every 3 seconds. */
const UPLOAD_POLL_INTERVAL_MS = 3000;

/**
 * @param {object} props
 * @param {string} props.roleId
 * @param {Array<{ id: string, originalFilename: string, status: string, duplicate: boolean }>} props.uploaded
 * @param {{ fileCount: number, created: number, duplicates: number }} props.meta
 * @param {number} props.acceptedAt epoch ms of the 202, for the elapsed clock
 */
export function ScreeningProgress({ roleId, uploaded, meta, acceptedAt }) {
  const ids = useMemo(() => uploaded.map((entry) => entry.id), [uploaded]);
  const filenameById = useMemo(
    () => new Map(uploaded.map((entry) => [entry.id, entry.originalFilename])),
    [uploaded],
  );
  const duplicateIds = useMemo(
    () => new Set(uploaded.filter((entry) => entry.duplicate).map((entry) => entry.id)),
    [uploaded],
  );

  const fetcher = useCallback((signal) => listCandidateStatuses(ids, { signal }), [ids]);

  const { data, loading, error, pollError, lastUpdatedAt, polling, stopReason, refresh } =
    usePolledResource({
      fetcher,
      isComplete: (rows) => allCandidatesTerminal(rows ?? []),
      // Backoff is driven by change, and a batch's status string list is exactly
      // what "changed" means here.
      signature: (rows) => (rows ?? []).map((row) => `${row.id}:${row.status}`).join('|'),
      intervalMs: UPLOAD_POLL_INTERVAL_MS,
      resetKey: ids.join(','),
    });

  if (loading && data === null) {
    return <Spinner label="Checking what the screening pipeline is doing" />;
  }

  if (error !== null && data === null) {
    return (
      <ErrorState
        title="The screening status could not be read"
        error={error}
        hint="The files were accepted — the upload is not lost. This screen just cannot read their progress."
        onRetry={refresh}
      />
    );
  }

  const rows = data ?? [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const finished = rows.filter((row) => row.status === 'done' || row.status === 'failed').length;
  const failed = rows.filter((row) => row.status === 'failed').length;
  const stopMessage = stopReasonMessage(stopReason);

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h2>Screening {pluralize(rows.length, 'CV')}</h2>
          <p className="muted">
            {finished} of {rows.length} finished
            {failed > 0 ? `, ${failed} failed` : ''}.{' '}
            {polling
              ? 'This page updates itself and will stop when every candidate is finished.'
              : 'Live updates are off.'}
          </p>
        </div>
        <div className="button-row">
          <button type="button" className="button" onClick={refresh}>
            Refresh
          </button>
          <Link className="button button--primary" to={`/dashboard?roleId=${roleId}`}>
            Go to the ranking
          </Link>
        </div>
      </div>

      {meta.duplicates > 0 ? (
        <div className="notice notice--info">
          <span>
            {pluralize(meta.duplicates, 'file')} had already been uploaded to this role, so{' '}
            {meta.duplicates === 1 ? 'it was' : 'they were'} not screened again and cost nothing.
            The existing candidate{meta.duplicates === 1 ? '' : 's'} {meta.duplicates === 1 ? 'is' : 'are'} shown below with
            whatever result {meta.duplicates === 1 ? 'it' : 'they'} already had.
          </span>
        </div>
      ) : null}

      {meta.fileCount !== rows.length ? (
        <div className="notice notice--warn">
          <span>
            {meta.fileCount} files were sent but {rows.length} candidate records are being watched.
            The difference is files that already belonged to an earlier upload of this role.
          </span>
        </div>
      ) : null}

      {pollError !== null ? (
        <div className="notice notice--warn" role="status">
          <span>
            Live updates paused — cannot reach the server ({pollError.message}). Last updated{' '}
            {formatClockTime(lastUpdatedAt)}.
          </span>
        </div>
      ) : null}

      {stopMessage !== null ? (
        <div className="notice notice--danger" role="status">
          <span>{stopMessage}</span>
          <button type="button" className="button button--small" onClick={refresh}>
            Refresh
          </button>
        </div>
      ) : null}

      <ul className="file-list">
        {uploaded.map((entry) => {
          const row = byId.get(entry.id);
          // A candidate the poll did not return has been deleted since the
          // upload. Saying so beats rendering an empty row forever.
          if (row === undefined) {
            return (
              <li key={entry.id} className="file-row">
                <span className="file-row__name">{entry.originalFilename}</span>
                <p className="muted">
                  This candidate is no longer on the server. It may have been removed since the
                  upload.
                </p>
              </li>
            );
          }

          return (
            <li key={entry.id} className="file-row">
              <div className="file-row__head">
                <span className="file-row__name">
                  {row.candidateName ?? filenameById.get(entry.id)}
                  {row.candidateName ? (
                    <span className="row-subline">{filenameById.get(entry.id)}</span>
                  ) : null}
                </span>
                <span className="button-row">
                  {duplicateIds.has(entry.id) ? (
                    <Badge modifier="info">Already uploaded</Badge>
                  ) : null}
                  {row.status === 'done' ? (
                    <>
                      <strong>{formatScore(row.matchScore)}</strong>
                      <TierBadge fitCategory={row.fitCategory} />
                    </>
                  ) : null}
                </span>
              </div>

              <PipelineStepper
                status={row.status}
                elapsedMs={
                  row.status === 'done' || row.status === 'failed' ? null : Date.now() - acceptedAt
                }
              />

              {row.eliminated ? (
                <p className="row-subline row-subline--danger">
                  ⊘ Eliminated by “{row.eliminatedBy}”. The score above is what it would have
                  scored.
                </p>
              ) : null}

              {row.status === 'failed' ? (
                <p className="row-subline row-subline--danger">
                  Failed with {row.errorCode}.{' '}
                  <Link to={`/candidates/${row.id}`}>Open this candidate</Link> to read the reason
                  and retry it.
                </p>
              ) : null}

              {row.status === 'done' ? (
                <p className="row-subline">
                  <Link to={`/candidates/${row.id}`}>See the evaluation and its evidence</Link>
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
