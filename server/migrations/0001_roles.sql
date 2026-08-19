-- Up Migration
--
-- Job roles. Plan of record section 2 and section 7-A.
--
-- There is deliberately no `is_active` column: every candidate carries its own
-- role_id, so several roles are screened in parallel, each with its own
-- dashboard. `archived_at` is a soft delete - DELETE /roles is an archive, never
-- a hard delete, because candidates reference roles ON DELETE RESTRICT.
--
-- `version` is bumped on every full replacement of a role definition, and
-- stamped onto a candidate as `scored_role_version` so a dashboard can show that
-- two candidates were scored under different rubrics.

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  version     integer NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT roles_title_length_check CHECK (char_length(title) BETWEEN 1 AND 200)
);

-- Down Migration
DROP TABLE roles;
