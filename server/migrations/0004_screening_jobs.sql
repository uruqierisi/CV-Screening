-- Up Migration
--
-- One upload request = one screening job, fanning out to N queue jobs.
-- Plan of record section 2.
--
-- There is deliberately NO status column. Job status is derived by aggregating
-- candidates.status (all pending -> queued; any non-terminal -> in_progress;
-- all terminal with >= 1 failed -> completed_with_failures; else completed).
-- A stored status is a second copy of the truth and drifts the moment a worker
-- dies mid-update.
--
-- ON DELETE RESTRICT on role_id: a role with screening history cannot be
-- deleted out from under it. DELETE /roles archives instead.

CREATE TABLE screening_jobs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id    uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  file_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE screening_jobs;
