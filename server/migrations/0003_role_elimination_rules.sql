-- Up Migration
--
-- Hard requirements evaluated in code against the extracted profile.
-- Plan of record section 2 and section 7-C.
--
-- The `type` enum is CLOSED: a rule type with no code evaluator cannot be
-- stored, and an unknown type at evaluation time throws rather than silently
-- passing. A unit test in the agent layer asserts this CHECK and the evaluator
-- registry are the same set - which is why the list lives here as a plain CHECK
-- and not as a PostgreSQL enum type (adding a value to a CHECK is a migration
-- the reviewer can read; ALTER TYPE ... ADD VALUE is not transactional).
--
-- `required_language` was proposed and dropped - not in the spec.
-- `required_certification` is in, because the spec names mandatory
-- certifications explicitly.
--
-- `on_missing` implements decision 7-C: an absent fact is `indeterminate`, and
-- the candidate is flagged as unchecked rather than rejected. A recruiter opts
-- into hard rejection per rule for a genuinely hard requirement such as a
-- licence or work authorisation.

CREATE TABLE role_elimination_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id    uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  label      text NOT NULL,
  type       text NOT NULL,
  value      jsonb NOT NULL,
  on_missing text NOT NULL DEFAULT 'flag',
  position   integer NOT NULL,

  CONSTRAINT role_elimination_rules_type_check CHECK (type IN (
    'min_years_experience',
    'required_skill',
    'required_education_level',
    'required_certification',
    'location_allowlist'
  )),
  CONSTRAINT role_elimination_rules_on_missing_check
    CHECK (on_missing IN ('flag', 'eliminate'))
);

-- NOTE: unlike role_criteria.position, the plan does not declare (role_id,
-- position) unique here, so it is not constrained. Two rules on one role may
-- share a position and the display order between them is then arbitrary. Raised
-- rather than silently fixed - adding the constraint later is a one-line
-- migration.

-- PostgreSQL does not auto-index foreign key columns; this one carries the
-- "load every rule for this role" read on the upload path.
CREATE INDEX role_elimination_rules_role_id_idx ON role_elimination_rules (role_id);

-- Down Migration
DROP TABLE role_elimination_rules;
