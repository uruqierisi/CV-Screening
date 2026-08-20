/**
 * `/dashboard` - the ranked candidate list for one role.
 *
 * ## Filters live in the URL
 *
 * `roleId`, `tier`, `sort` and `page` are all query parameters, so "Strong Match
 * candidates for Senior Backend Engineer, worst first" is a link a recruiter can
 * bookmark and send to a colleague. Filter changes use `replace` so the back
 * button steps out of the dashboard rather than back through eight filter
 * states; navigating to a candidate uses `push`, which is what back is for.
 *
 * ## Two reads and one poll
 *
 * - The **ranked table** is `GET /candidates?status=done`, filtered, sorted and
 *   paginated by the server. One request per view.
 * - The **Processing panel** is `listAttentionCandidates`, which is the four
 *   non-`done` statuses. See `api/candidates.js` for why it is four requests.
 * - The **poll** is `GET /candidates/statuses?ids=…` over the non-terminal ids
 *   only, and it patches those rows in place. **It never reorders the table**,
 *   and it stops the moment every id it is watching reaches `done` or `failed`.
 *
 * When candidates finish, the table does not move on its own. A bar appears
 * offering to refresh the ranking, and the recruiter chooses when a row they are
 * reading is allowed to jump.
 */

import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  listAttentionCandidates,
  listCandidateStatuses,
  listCandidates,
  retryCandidate,
} from '../api/candidates.js';
import { listRoles } from '../api/roles.js';
import { useConfig } from '../config/ConfigProvider.jsx';
import { useResource } from '../hooks/useResource.js';
import { usePolledResource } from '../hooks/usePolledResource.js';
import { allCandidatesTerminal, isTerminalCandidateStatus } from '../lib/candidateStatus.js';
import { stopReasonMessage } from '../lib/pollSchedule.js';
import { formatClockTime, pluralize } from '../lib/format.js';
import { tierLegend } from '../lib/tiers.js';
import { Spinner } from '../components/Spinner.jsx';
import { EmptyState, ErrorState } from '../components/States.jsx';
import { SelectField } from '../components/Field.jsx';
import { TierFilter } from '../features/candidates/TierFilter.jsx';
import { RankedTable } from '../features/candidates/RankedTable.jsx';
import { ProcessingPanel } from '../features/candidates/ProcessingPanel.jsx';

/** Plan section 6: the dashboard polls every 5 seconds. */
const DASHBOARD_POLL_INTERVAL_MS = 5000;

export function DashboardPage() {
  const config = useConfig();
  const [searchParams, setSearchParams] = useSearchParams();

  const roleId = searchParams.get('roleId') ?? '';
  const tier = searchParams.get('tier') ?? '';
  const sort = searchParams.get('sort') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const pageSize = config.pagination.defaultPageSize;

  const [retrying, setRetrying] = useState(/** @type {string | null} */ (null));
  const [retryError, setRetryError] = useState(/** @type {any} */ (null));

  const rolesFetcher = useCallback(
    (signal) => listRoles({ pageSize: 100, includeArchived: true, signal }),
    [],
  );
  const { data: roles, loading: rolesLoading, error: rolesError } = useResource(rolesFetcher);

  // With no role chosen there is nothing to rank - a score only means something
  // against the rubric that produced it. Both reads answer empty rather than
  // firing five requests for a screen that renders "choose a role".
  const noRole = roleId === '';

  const rankedFetcher = useCallback(
    (signal) =>
      noRole
        ? Promise.resolve({ data: [], meta: { page: 1, pageSize, total: 0, totalPages: 1 } })
        : listCandidates({
            roleId,
            // Only finished candidates are ranked. Everything else is above the
            // table, which is what keeps the table stable.
            status: 'done',
            fitCategory: tier || undefined,
            sort,
            page,
            pageSize,
            signal,
          }),
    [noRole, roleId, tier, sort, page, pageSize],
  );
  const ranked = useResource(rankedFetcher);

  const attentionFetcher = useCallback(
    (signal) =>
      noRole
        ? Promise.resolve({ data: [], meta: { truncated: false } })
        : listAttentionCandidates({
            roleId,
            pageSize: config.pagination.maxPageSize,
            signal,
          }),
    [noRole, roleId, config.pagination.maxPageSize],
  );
  const attention = useResource(attentionFetcher);

  const attentionRows = attention.data ?? [];

  // Only the non-terminal rows are worth polling. A failed candidate does not
  // change on its own; it changes when somebody presses Retry, and that path
  // reloads instead.
  const pollIds = useMemo(
    () =>
      attentionRows
        .filter((row) => !isTerminalCandidateStatus(row.status))
        .map((row) => row.id)
        .slice(0, config.candidates.maxStatusIds),
    [attentionRows, config.candidates.maxStatusIds],
  );

  const pollFetcher = useCallback(
    (signal) => listCandidateStatuses(pollIds, { signal }),
    [pollIds],
  );

  const poll = usePolledResource({
    fetcher: pollFetcher,
    isComplete: (rows) => allCandidatesTerminal(rows ?? []),
    signature: (rows) => (rows ?? []).map((row) => `${row.id}:${row.status}`).join('|'),
    intervalMs: DASHBOARD_POLL_INTERVAL_MS,
    // An empty id list would send `?ids=` and be rejected. Nothing outstanding
    // is also, correctly, nothing to poll.
    enabled: pollIds.length > 0,
    resetKey: pollIds.join(','),
  });

  // Server data patched with server data. Nothing is copied into component
  // state, so nothing can drift.
  const patchedRows = useMemo(() => {
    const patches = new Map((poll.data ?? []).map((row) => [row.id, row]));
    return attentionRows.map((row) => {
      const patch = patches.get(row.id);
      return patch === undefined ? row : { ...row, ...patch };
    });
  }, [attentionRows, poll.data]);

  // How many rows the poll has moved to `done` since this page last read the
  // list. Matched by id rather than by position, so it stays correct whatever
  // order either list arrives in.
  const finishedSinceLoad = useMemo(() => {
    const wasDone = new Map(attentionRows.map((row) => [row.id, row.status === 'done']));
    return patchedRows.filter((row) => row.status === 'done' && wasDone.get(row.id) === false)
      .length;
  }, [patchedRows, attentionRows]);

  const refreshEverything = () => {
    ranked.reload();
    attention.reload();
  };

  const onRetry = async (candidateId) => {
    setRetrying(candidateId);
    setRetryError(null);
    try {
      await retryCandidate(candidateId);
      // The candidate is `pending` again, so the Processing panel has to re-read
      // it - and the poll restarts because its id list changed.
      attention.reload();
    } catch (caught) {
      setRetryError(caught);
    } finally {
      setRetrying(null);
    }
  };

  const setParam = (updates) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value === '' || value === null) next.delete(key);
      else next.set(key, String(value));
    }
    // A filter change is not a place in history worth going back to.
    setSearchParams(next, { replace: true });
  };

  if (rolesLoading) return <Spinner label="Loading roles" />;

  if (rolesError !== null) {
    return <ErrorState title="The role list could not be loaded" error={rolesError} />;
  }

  const selectedRole = roles.find((role) => role.id === roleId) ?? null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Candidate ranking</h1>
          <p className="lede">
            Scores are computed in code from the model's per-criterion ratings. Open a candidate to
            see every rating, the reason for it and the quote from the CV it rests on.
          </p>
        </div>
      </div>

      <section className="panel">
        <div className="filter-bar">
          <SelectField
            label="Role"
            value={roleId}
            options={[
              { value: '', label: 'Choose a role…' },
              ...roles.map((role) => ({
                value: role.id,
                label: `${role.title} (v${role.version})${role.archived ? ' — archived' : ''}`,
              })),
            ]}
            onChange={(value) => setParam({ roleId: value, page: '' })}
          />
          {roleId !== '' ? (
            <TierFilter
              fitCategories={config.scoring.fitCategories}
              value={tier}
              counts={ranked.meta?.counts ?? null}
              total={
                ranked.meta?.counts
                  ? Object.values(ranked.meta.counts).reduce(
                      (sum, count) => sum + Number(count),
                      0,
                    )
                  : 0
              }
              onChange={(value) => setParam({ tier: value, page: '' })}
            />
          ) : null}
        </div>

        <details>
          <summary>How the tiers are defined</summary>
          <ul className="plain-list" style={{ marginTop: 'var(--space-3)' }}>
            {tierLegend(config.scoring.tierThresholds, config.scoring.scoreMax).map((band) => (
              <li key={band.fitCategory}>
                <strong>{band.label}</strong>: {band.range}.
              </li>
            ))}
          </ul>
          <p className="muted">
            These bands come from the server, not from this page. Elimination overrides the score
            entirely, so an eliminated candidate is Unmatched whatever it scored.
          </p>
        </details>
      </section>

      {roleId === '' ? (
        <EmptyState
          title="Choose a role"
          message="A score only means something against the rubric it was produced by, so there is no ranking across roles. Pick one above."
          action={
            <Link className="button" to="/roles">
              See all roles
            </Link>
          }
        />
      ) : null}

      {roleId !== '' && selectedRole !== null && selectedRole.version > 1 ? (
        <div className="notice notice--warn">
          <span>
            This role has been edited — it is now version {selectedRole.version}. Candidates
            screened under an earlier version keep the score they were given; there is no rescore.
            Open a candidate to see which version it was scored under.
          </span>
        </div>
      ) : null}

      {retryError !== null ? (
        <ErrorState
          title="That candidate could not be re-queued"
          error={retryError}
          hint={
            retryError.code === 'SOURCE_FILE_MISSING'
              ? 'The uploaded file is no longer on the server, so there is nothing to screen. Upload the CV again.'
              : undefined
          }
          onRetry={() => setRetryError(null)}
          retryLabel="Dismiss"
        />
      ) : null}

      {roleId !== '' && attention.loading ? <Spinner label="Loading in-flight candidates" /> : null}

      {roleId !== '' && attention.error !== null ? (
        <ErrorState
          title="The in-flight candidates could not be read"
          error={attention.error}
          hint="The ranked table below is unaffected."
          onRetry={attention.reload}
        />
      ) : null}

      {roleId !== '' && attention.error === null && patchedRows.length > 0 ? (
        <>
          {poll.pollError !== null ? (
            <div className="notice notice--warn" role="status">
              <span>
                Live updates paused — cannot reach the server ({poll.pollError.message}). Last
                updated {formatClockTime(poll.lastUpdatedAt)}.
              </span>
            </div>
          ) : null}

          {stopReasonMessage(poll.stopReason) !== null ? (
            <div className="notice notice--danger" role="status">
              <span>{stopReasonMessage(poll.stopReason)}</span>
              <button type="button" className="button button--small" onClick={poll.refresh}>
                Resume
              </button>
            </div>
          ) : null}

          {finishedSinceLoad > 0 ? (
            <div className="notice notice--info" role="status">
              <span>
                {pluralize(finishedSinceLoad, 'candidate')} finished scoring. The ranking below has
                not moved yet.
              </span>
              <button type="button" className="button button--small" onClick={refreshEverything}>
                Refresh ranking
              </button>
            </div>
          ) : null}

          <ProcessingPanel
            rows={patchedRows}
            onRetry={onRetry}
            retrying={retrying}
            truncated={attention.meta?.truncated ?? false}
          />
        </>
      ) : null}

      {roleId !== '' ? (
        <section className="panel">
          <div className="panel__head">
            <h2>Ranked candidates</h2>
            <button type="button" className="button button--small" onClick={refreshEverything}>
              Refresh
            </button>
          </div>

          {ranked.loading ? <Spinner label="Ranking candidates" /> : null}

          {!ranked.loading && ranked.error !== null ? (
            <ErrorState
              title="The ranking could not be loaded"
              error={ranked.error}
              onRetry={ranked.reload}
            />
          ) : null}

          {!ranked.loading && ranked.error === null && ranked.data?.length === 0 ? (
            <EmptyState
              title={tier === '' ? 'No candidate has finished screening yet' : 'No candidate in this tier'}
              message={
                tier === ''
                  ? 'Nothing has been scored against this role. Upload some CVs, or wait for the ones above to finish.'
                  : 'Nobody scored into this tier. Clear the filter to see every scored candidate.'
              }
              action={
                tier === '' ? (
                  <Link className="button button--primary" to={`/upload?roleId=${roleId}`}>
                    Upload CVs
                  </Link>
                ) : (
                  <button type="button" className="button" onClick={() => setParam({ tier: '' })}>
                    Clear the tier filter
                  </button>
                )
              }
            />
          ) : null}

          {!ranked.loading && ranked.error === null && ranked.data?.length > 0 ? (
            <>
              <RankedTable
                candidates={ranked.data}
                sort={sort}
                onSortChange={(next) => setParam({ sort: next, page: '' })}
                rankOffset={(page - 1) * pageSize + 1}
              />
              <nav className="pagination" aria-label="Ranking pages">
                <button
                  type="button"
                  className="button button--small"
                  disabled={page <= 1}
                  onClick={() => setParam({ page: page - 1 })}
                >
                  Previous
                </button>
                <span>
                  Page {ranked.meta?.page ?? page} of {ranked.meta?.totalPages ?? 1} —{' '}
                  {pluralize(ranked.meta?.total ?? 0, 'scored candidate')}
                </span>
                <button
                  type="button"
                  className="button button--small"
                  disabled={page >= (ranked.meta?.totalPages ?? 1)}
                  onClick={() => setParam({ page: page + 1 })}
                >
                  Next
                </button>
              </nav>
            </>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
