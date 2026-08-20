/**
 * `/roles/new`.
 *
 * On success the API answers 201 with the created role, and this navigates
 * straight to its upload screen - the next thing anybody wants after defining a
 * rubric is to put CVs through it.
 */

import { Link, useNavigate } from 'react-router-dom';
import { createRole } from '../api/roles.js';
import { useConfig } from '../config/ConfigProvider.jsx';
import { RoleForm } from '../features/roles/RoleForm.jsx';
import { emptyRoleForm } from '../features/roles/roleFormState.js';
import { useState } from 'react';

export function RoleNewPage() {
  const config = useConfig();
  const navigate = useNavigate();
  // Built once. Rebuilding it every render would reset the form on every
  // keystroke, since `RoleForm` seeds a reducer from it.
  const [initialForm] = useState(() => emptyRoleForm(config));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>New role</h1>
          <p className="lede">
            Define what this job is scored on and what disqualifies a candidate outright. Weights
            must total {config.scoring.requiredWeightSum}.
          </p>
        </div>
      </div>

      <RoleForm
        initialForm={initialForm}
        submitLabel="Create role"
        secondaryAction={
          <Link className="button" to="/roles">
            Cancel
          </Link>
        }
        onSubmit={async (body) => {
          const { data } = await createRole(body);
          navigate(`/upload?roleId=${data.id}`);
        }}
      />
    </>
  );
}
