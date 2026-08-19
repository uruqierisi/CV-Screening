-- Up Migration
--
-- One uploaded CV and everything the pipeline learns about it.
-- Plan of record section 2.
--
-- Notes that are easy to get wrong when reading this later:
--
--  * Eliminated candidates KEEP their match_score. Only fit_category is forced
--    to 'unmatched'. A recruiter has to be able to see "eliminated, but would
--    have scored 88" - showing the work is the whole point of the product.
--  * storage_path is relative to UPLOAD_ROOT, never absolute, so the upload root
--    can move without rewriting rows.
--  * (role_id, content_sha256) is NON-UNIQUE on purpose. Uploads are not
--    idempotent in v1; duplicates are detectable after the fact, not prevented.
--  * Status transitions are guarded in the repository
--    (WHERE id = $1 AND status = $expected) so a late or duplicated queue job
--    cannot clobber a retried candidate.

CREATE TABLE candidates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id             uuid NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  job_id              uuid NOT NULL REFERENCES screening_jobs (id) ON DELETE CASCADE,
  original_filename   text NOT NULL,
  -- From the parsed profile: the dashboard shows people, not filenames. NULL
  -- until extraction succeeds.
  candidate_name      text,
  storage_path        text NOT NULL,
  content_sha256      char(64) NOT NULL,
  mime_type           text NOT NULL,
  byte_size           integer NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  raw_text            text,
  parsed_profile      jsonb,
  evaluation_matrix   jsonb,
  elimination_details jsonb,
  eliminated          boolean NOT NULL DEFAULT false,
  eliminated_by       text,
  match_score         numeric(4,1),
  fit_category        text,
  ai_justification    text,
  scored_role_version integer,
  error_code          text,
  error_message       text,
  attempts            smallint NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,

  CONSTRAINT candidates_status_check
    CHECK (status IN ('pending', 'parsing', 'evaluating', 'done', 'failed')),

  -- Extraction handles PDF, DOCX and TXT (plan section 5.5). Anything else is
  -- rejected at the HTTP boundary as UNSUPPORTED_FILE_TYPE; this is the backstop.
  CONSTRAINT candidates_mime_type_check CHECK (mime_type IN (
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain'
  )),

  CONSTRAINT candidates_match_score_range_check
    CHECK (match_score IS NULL OR (match_score >= 0 AND match_score <= 100)),

  CONSTRAINT candidates_fit_category_check
    CHECK (fit_category IS NULL OR fit_category IN ('strong_match', 'potential_match', 'unmatched')),

  -- The four integrity constraints. Each one exists because the alternative is a
  -- row the API cannot serialize into a coherent response.

  -- A 'done' candidate must actually carry a result.
  CONSTRAINT candidates_done_is_complete_check CHECK (
    status <> 'done' OR (
      match_score IS NOT NULL
      AND fit_category IS NOT NULL
      AND parsed_profile IS NOT NULL
      AND evaluation_matrix IS NOT NULL
    )
  ),

  -- A 'failed' candidate must say why, in a machine-readable way.
  CONSTRAINT candidates_failed_has_error_code_check
    CHECK (status <> 'failed' OR error_code IS NOT NULL),

  -- The pair moves together: never a code without a message, never the reverse.
  CONSTRAINT candidates_error_pair_check
    CHECK ((error_code IS NULL) = (error_message IS NULL)),

  -- A terminal candidate has a finish time; the dashboard sorts and reports on it.
  CONSTRAINT candidates_terminal_has_completed_at_check
    CHECK (status NOT IN ('done', 'failed') OR completed_at IS NOT NULL)
);

-- The six index rows from the plan's index table.

-- Dashboard default ranking. Matches ORDER BY match_score DESC NULLS LAST, id DESC
-- exactly, including the NULLS LAST, so an in-progress batch does not push scored
-- candidates off page 1.
CREATE INDEX candidates_role_ranking_idx
  ON candidates (role_id, match_score DESC NULLS LAST, id DESC);

-- Ranking with a tier filter. A separate index because PostgreSQL has no index
-- skip-scan: the one above cannot serve an equality on fit_category.
CREATE INDEX candidates_role_fit_ranking_idx
  ON candidates (role_id, fit_category, match_score DESC NULLS LAST, id DESC);

-- GET /jobs/:id derives job status by aggregating candidate status. This is the
-- hot polling query in the whole system.
CREATE INDEX candidates_job_status_idx ON candidates (job_id, status);

-- Duplicate-CV lookup. Non-unique on purpose (see header).
CREATE INDEX candidates_role_content_sha256_idx ON candidates (role_id, content_sha256);

-- Stuck-candidate sweep (scripts/reconcileStuck.js). Partial, because the rows
-- it wants are a shrinking minority of a growing table.
CREATE INDEX candidates_active_status_idx ON candidates (status)
  WHERE status IN ('pending', 'parsing', 'evaluating');

-- Down Migration
DROP TABLE candidates;
