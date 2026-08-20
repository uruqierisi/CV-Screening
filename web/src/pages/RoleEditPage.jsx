/**
 * `/roles/:roleId/edit`.
 *
 * The warning at the top is not decoration. A `PUT` bumps the role's version and
 * **there is no rescore path** (plan section 8): candidates already screened keep
 * the score they were given, stamped with the version they were scored under, and
 * the dashboard will show two rubrics' results side by side. Somebody about to
 * change a weight should be told that before they change it, not after.
 */

import { useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getRole, replaceRole } from '../api/roles.js';
import { useConfig } from '../config/ConfigProvider.jsx';
import { useResource } from '../hooks/useResource.js';
import { ErrorState } from '../components/States.jsx';
import { Spinner } from '../components/Spinner.jsx';
import { RoleForm } from '../features/roles/RoleForm.jsx';
import { roleFormFromDto } from '../features/roles/roleFormState.js';

export function RoleEditPage() {
  const { roleId } = useParams();
  const config = useConfig();
  const navigate = useNavigate();

  const fetcher = useCallback((signal) => getRole(roleId, { signal }), [roleId]);
  const { data: role, loading, error, reload } = useResource(fetcher);

  if (loading) return <Spinner label="Loading the role" />;

  if (error !== null) {
    return (
      <ErrorState
        title="This role could not be loaded"
        error={error}
        hint={
          error.status === 404
            ? 'The address may be wrong, or the role may have been removed.'
            : undefined
        }
        onRetry={error.status === 404 ? undefined : reload}
      />
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Edit {role.title}</h1>
          <p className="lede">
            Saving replaces the whole rubric and moves the role from version {role.version} to
            version {role.version + 1}. Candidates already screened are <strong>not</strong>{' '}
            rescored — they keep the score and tier they were given, labelled with the version they
            were scored under.
          </p>
        </div>
      </div>

      {role.archived ? (
        <div className="notice notice--warn">
          <span>
            This role is archived. It can still be edited, but no new CVs can be uploaded to it.
          </span>
        </div>
      ) : null}

      <RoleForm
        // Remounts if the id in the URL changes, so the reducer re-seeds instead
        // of showing the previous role's criteria.
        key={role.id}
        initialForm={roleFormFromDto(role, config)}
        submitLabel="Save role"
        secondaryAction={
          <Link className="button" to="/roles">
            Cancel
          </Link>
        }
        onSubmit={async (body) => {
          await replaceRole(role.id, body);
          navigate('/roles');
        }}
      />
    </>
  );
}
