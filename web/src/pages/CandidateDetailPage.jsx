/**
 * `/candidates/:candidateId` - one candidate, and everything behind their score.
 *
 * ## What this screen owes the reader
 *
 * A score with no working shown is an assertion. This page is the working: the
 * elimination outcomes above the matrix, the matrix with every rating's reason
 * and the verbatim quote it rests on, the contributions adding up to the score in
 * front of you, and the extracted profile the whole thing was computed from.
 *
 * ## Polling
 *
 * A candidate that is still `pending`, `parsing` or `evaluating` is polled every
 * three seconds, and the poll **stops the moment the status is `done` or
 * `failed`** - the stop condition is the data, not an attempt count. A candidate
 * that is already terminal when the page opens is never polled at all.
 *
 * ## The failed candidate
 *
 * `errorMessage` is written by the worker for a recruiter to read, and it is the
 * only place it appears in the whole API - it is not in the list projection. So
 * the retry action lives here, next to the reason, rather than on a table row
 * that could only show a code.
 */

import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getCandidate, retryCandidate } from '../api/candidates.js';
import { useConfig } from '../config/ConfigProvider.jsx';
import { usePolledResource } from '../hooks/usePolledResource.js';
import { isTerminalCandidateStatus } from '../lib/candidateStatus.js';
import { stopReasonMessage } from '../lib/pollSchedule.js';
import { reconcileMatrix, scoreDivisor } from '../lib/matrix.js';
import { formatBytes, formatClockTime, formatDateTime, formatScore } from '../lib/format.js';
import { Spinner } from '../components/Spinner.jsx';
import { ErrorState } from '../components/States.jsx';
import { Badge, StatusBadge, TierBadge } from '../components/Badge.jsx';
import { PipelineStepper } from '../features/upload/PipelineStepper.jsx';
import { EliminationPanel } from '../features/detail/EliminationPanel.jsx';
import { EvaluationMatrix } from '../features/detail/EvaluationMatrix.jsx';
import { ProfilePanel } from '../features/detail/ProfilePanel.jsx';

/** Plan section 6: the detail view polls every 3 seconds. */
const DETAIL_POLL_INTERVAL_MS = 3000;

export function CandidateDetailPage() {
  const { candidateId } = useParams();
  const config = useConfig();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(/** @type {any} */ (null));

  const fetcher = useCallback(
    (signal) => getCandidate(candidateId, { signal }),
    [candidateId],
  );

  const { data: candidate, loading, error, pollError, lastUpdatedAt, stopReason, refresh } =
    usePolledResource({
      fetcher,
      // The stop condition, stated once: this candidate has reached a terminal
      // status. Nothing else stops it and nothing else keeps it going.
      isComplete: (data) => isTerminalCandidateStatus(data?.status),
      signature: (data) => `${data?.status}:${data?.updatedAt}`,
      intervalMs: DETAIL_POLL_INTERVAL_MS,
      resetKey: candidateId,
    });

  if (loading && candidate === null) {
    return <Spinner label="Loading this candidate" />;
  }

  if (error !== null && candidate === null) {
    return (
      <ErrorState
        title="This candidate could not be loaded"
        error={error}
        hint={
          error.status === 404
            ? 'The address may be wrong, or this candidate may have been removed from the server.'
            : undefined
        }
        onRetry={error.status === 404 ? undefined : refresh}
      />
    );
  }

  const divisor = scoreDivisor(config.scoring);
  const reconciliation = reconcileMatrix(candidate.evaluationMatrix, divisor);
  const stopMessage = stopReasonMessage(stopReason);

  const onRetry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await retryCandidate(candidate.id);
      // The candidate is `pending` again, so re-read it. The poll restarts
      // because the status is no longer terminal.
      refresh();
    } catch (caught) {
      setRetryError(caught);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{candidate.candidateName ?? candidate.originalFilename}</h1>
          <p className="muted">
            {candidate.originalFilename} · {formatBytes(candidate.byteSize)} ·{' '}
            <Link to={`/dashboard?roleId=${candidate.roleId}`}>Back to the ranking</Link>
          </p>
        </div>
        {candidate.status === 'done' ? (
          <div className="score-headline">
            <span className="score-headline__value">{formatScore(candidate.matchScore)}</span>
            <TierBadge fitCategory={candidate.fitCategory} />
          </div>
        ) : (
          <StatusBadge status={candidate.status} />
        )}
      </div>

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

      {!isTerminalCandidateStatus(candidate.status) ? (
        <section className="panel">
          <h2>Screening in progress</h2>
          <PipelineStepper status={candidate.status} elapsedMs={null} />
          <p className="muted">
            This page updates itself and will stop as soon as this candidate is scored or fails.
            Screening one CV is a text extraction plus two model calls, so it takes seconds to a
            minute.
          </p>
        </section>
      ) : null}

      {candidate.status === 'failed' ? (
        <section className="panel">
          <div className="notice notice--danger" role="alert">
            <span>
              <strong>This CV could not be screened.</strong>{' '}
              {candidate.errorMessage ??
                'The worker recorded no message, which is itself worth reporting.'}
            </span>
          </div>
          <p className="muted">
            Error code <Badge modifier="danger">{candidate.errorCode}</Badge> ·{' '}
            {candidate.attempts} {candidate.attempts === 1 ? 'attempt' : 'attempts'} so far.
          </p>
          {retryError !== null ? (
            <ErrorState
              title="This candidate could not be re-queued"
              error={retryError}
              hint={
                retryError.code === 'SOURCE_FILE_MISSING'
                  ? 'The uploaded file is no longer on the server, so there is nothing left to screen. Upload the CV again.'
                  : retryError.code === 'CANDIDATE_NOT_RETRYABLE'
                    ? 'Only a candidate that has finished failing can be retried. This one may have already been re-queued.'
                    : undefined
              }
            />
          ) : null}
          <div className="button-row">
            <button
              type="button"
              className="button button--primary"
              disabled={retrying}
              onClick={onRetry}
            >
              {retrying ? 'Re-queueing…' : 'Retry this candidate'}
            </button>
            <span className="muted">
              Retrying re-runs the whole pipeline for this CV and costs another model call.
            </span>
          </div>
        </section>
      ) : null}

      {candidate.aiJustification ? (
        <section className="panel">
          <h2>The model's summary</h2>
          <p>{candidate.aiJustification}</p>
          <p className="muted">
            Written by the model as prose. Every number on this page comes from code — the model is
            not allowed to state a score, and a summary that does is rejected before it is stored.
          </p>
        </section>
      ) : null}

      <EliminationPanel
        eliminationDetails={candidate.eliminationDetails}
        eliminated={candidate.eliminated}
        eliminatedBy={candidate.eliminatedBy}
        matchScore={candidate.matchScore}
      />

      {reconciliation !== null ? (
        <EvaluationMatrix
          reconciliation={reconciliation}
          matchScore={candidate.matchScore}
          divisor={divisor}
          computedAt={candidate.evaluationMatrix.computedAt}
        />
      ) : null}

      <div className="detail-grid">
        <div>
          <ProfilePanel profile={candidate.parsedProfile} />
        </div>
        <aside>
          <section className="panel">
            <h2>Provenance</h2>
            <dl className="definition-list">
              <dt>Scored under</dt>
              <dd>
                {candidate.scoredRoleVersion === null ? (
                  'Not yet scored'
                ) : (
                  <>
                    Role version {candidate.scoredRoleVersion}.{' '}
                    <span className="muted">
                      Editing a role does not rescore anyone, so two candidates on one dashboard can
                      have been judged by different rubrics.
                    </span>
                  </>
                )}
              </dd>
              <dt>Uploaded</dt>
              <dd>{formatDateTime(candidate.createdAt)}</dd>
              <dt>Finished</dt>
              <dd>{formatDateTime(candidate.completedAt)}</dd>
              <dt>File</dt>
              <dd>
                {candidate.mimeType} · {formatBytes(candidate.byteSize)}
              </dd>
              <dt>Attempts</dt>
              <dd>{candidate.attempts}</dd>
              <dt>Candidate id</dt>
              <dd className="state__meta">{candidate.id}</dd>
            </dl>
          </section>

          <section className="panel">
            <h2>What this score is, and is not</h2>
            <p className="muted">
              The score is exact arithmetic over the ratings — the same ratings always produce the
              same number. It is <strong>not</strong> a claim that the ratings themselves are
              repeatable: the same CV screened twice can be rated differently, which is why every
              rating is shown with its evidence rather than on its own.
            </p>
            <p className="muted">
              The decimal reflects the arithmetic, not confidence in the judgement behind it.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
