/**
 * `/roles` - every role, and the four things you can do with one.
 *
 * A role is the prerequisite for the rest of the application, so this list is
 * also where the empty state matters most: a first-time reader lands here with
 * nothing, and the empty state has to say what a role is for as well as offer
 * the button.
 */

import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { archiveRole, listRoles } from '../api/roles.js';
import { useResource } from '../hooks/useResource.js';
import { ErrorState, EmptyState } from '../components/States.jsx';
import { Spinner } from '../components/Spinner.jsx';
import { Badge } from '../components/Badge.jsx';
import { CheckboxField } from '../components/Field.jsx';
import { formatDateTime, pluralize } from '../lib/format.js';

export function RolesPage() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const [archiving, setArchiving] = useState(/** @type {string | null} */ (null));
  const [archiveError, setArchiveError] = useState(/** @type {any} */ (null));

  const fetcher = useCallback(
    (signal) => listRoles({ includeArchived, pageSize: 100, signal }),
    [includeArchived],
  );
  const { data: roles, loading, error, reload } = useResource(fetcher);

  const onArchive = async (role) => {
    // A confirm rather than a modal: this is the only destructive control in the
    // application, and building a dialog component for one use is the wrong
    // trade. Archiving is a soft, idempotent, reversible-by-the-database action,
    // so the confirm says so instead of implying data loss.
    const confirmed = window.confirm(
      `Archive "${role.title}"? It stops appearing in the role list and cannot be uploaded to. Candidates already screened against it keep their scores.`,
    );
    if (!confirmed) return;

    setArchiving(role.id);
    setArchiveError(null);
    try {
      await archiveRole(role.id);
      reload();
    } catch (caught) {
      setArchiveError(caught);
    } finally {
      setArchiving(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Job roles</h1>
          <p className="lede">
            A role is a weighted rubric plus its hard requirements. Every CV is screened against
            exactly one role, and a candidate's score only means anything next to the role it was
            scored against.
          </p>
        </div>
        <Link className="button button--primary" to="/roles/new">
          New role
        </Link>
      </div>

      <div className="panel">
        <CheckboxField
          label="Include archived roles"
          checked={includeArchived}
          onChange={setIncludeArchived}
        />

        {archiveError !== null ? (
          <ErrorState
            title="That role could not be archived"
            error={archiveError}
            onRetry={() => setArchiveError(null)}
            retryLabel="Dismiss"
          />
        ) : null}

        {loading ? <Spinner label="Loading roles" /> : null}

        {!loading && error !== null ? (
          <ErrorState
            title="The role list could not be loaded"
            error={error}
            onRetry={reload}
          />
        ) : null}

        {!loading && error === null && roles?.length === 0 ? (
          <EmptyState
            title={includeArchived ? 'No roles at all yet' : 'No active roles'}
            message={
              includeArchived
                ? 'Nothing has been created on this server. Create a role with its criteria and weights, then upload CVs against it.'
                : 'Every role has been archived. Tick "Include archived roles" to see them, or create a new one.'
            }
            action={
              <Link className="button button--primary" to="/roles/new">
                Create the first role
              </Link>
            }
          />
        ) : null}

        {!loading && error === null && roles?.length > 0 ? (
          <div className="table-wrap">
            <table className="data">
              <caption>{pluralize(roles.length, 'role')}, newest first.</caption>
              <thead>
                <tr>
                  <th scope="col">Role</th>
                  <th scope="col">Rubric</th>
                  <th scope="col">Version</th>
                  <th scope="col">Updated</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr key={role.id}>
                    <td>
                      <span className="candidate-link">{role.title}</span>{' '}
                      {role.archived ? <Badge modifier="neutral">Archived</Badge> : null}
                      {role.description ? (
                        <span className="row-subline">{role.description}</span>
                      ) : null}
                    </td>
                    <td>
                      {pluralize(role.criteria.length, 'criterion', 'criteria')},{' '}
                      {pluralize(role.eliminationRules.length, 'elimination rule')}
                    </td>
                    <td className="numeric">v{role.version}</td>
                    <td>{formatDateTime(role.updatedAt)}</td>
                    <td>
                      <div className="button-row">
                        <Link
                          className="button button--small"
                          to={`/dashboard?roleId=${role.id}`}
                        >
                          Dashboard
                        </Link>
                        {!role.archived ? (
                          <Link
                            className="button button--small"
                            to={`/upload?roleId=${role.id}`}
                          >
                            Upload CVs
                          </Link>
                        ) : null}
                        <Link className="button button--small" to={`/roles/${role.id}/edit`}>
                          Edit
                        </Link>
                        {!role.archived ? (
                          <button
                            type="button"
                            className="button button--small button--danger"
                            disabled={archiving === role.id}
                            onClick={() => onArchive(role)}
                          >
                            {archiving === role.id ? 'Archiving…' : 'Archive'}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      <p className="muted">
        Editing a role bumps its version. There is no rescore path, so candidates screened before an
        edit keep the score they were given and the dashboard says which version each was scored
        under.
      </p>
    </>
  );
}
