-- Up Migration
--
-- Four corrections to the Phase 1 schema, all of them items raised in the Phase 1
-- handoff and approved as a batch. They travel together because they are one
-- review: two index corrections, one missing constraint, and one piece of
-- correctness that was being maintained by convention.
--
-- Locking, stated plainly because the migration runner wraps the whole history in
-- one transaction and CONCURRENTLY is therefore not available here: the ALTER
-- TABLE below takes ACCESS EXCLUSIVE on role_elimination_rules while it builds
-- its unique index, and CREATE INDEX takes SHARE on screening_jobs (blocking
-- writes, not reads). Both tables are small - a role has a handful of rules and a
-- screening job is one row per upload - so this is milliseconds. Neither
-- statement rewrites a table.

-- 1. Drop the redundant role_criteria(role_id) index.
--
-- role_criteria_role_id_idx is a strict prefix of BOTH unique constraints on the
-- table - (role_id, label) and (role_id, position) - either of which already
-- serves a lookup or a foreign-key check on role_id alone. A prefix index reads
-- nothing the wider ones cannot, and costs an extra write on every insert,
-- update and delete of a criterion. Migration 0002 flagged it as "partly
-- redundant" and kept it because the plan's index table listed it; the plan is
-- corrected in the same change as this migration.
DROP INDEX role_criteria_role_id_idx;

-- 2. Index screening_jobs(role_id).
--
-- This foreign key is ON DELETE RESTRICT, and PostgreSQL enforces RESTRICT by
-- querying the referencing table for a matching row. With no index that is a
-- sequential scan of every screening job ever created, on every attempt to
-- delete a role - and DELETE /roles archives rather than hard-deletes, so the
-- scan would happen on a path nobody is watching. The same index serves
-- "list this role's screening jobs".
CREATE INDEX screening_jobs_role_id_idx ON screening_jobs (role_id);

-- 3. Make role_elimination_rules.position unique per role.
--
-- Migration 0003 recorded this asymmetry with role_criteria as raised-not-fixed.
-- There was never a justification for it: both tables are ordered lists owned by
-- a role, both are written delete-then-insert inside one transaction by their
-- repository, and both are read back ORDER BY position. Two rules sharing a
-- position means an arbitrary display order that changes between reads.
--
-- DEFERRABLE INITIALLY DEFERRED for exactly the reason role_criteria's is: a full
-- replacement rewrites positions inside one transaction and passes through
-- intermediate states that collide. A non-deferred constraint would reject the
-- reordering path the repository actually uses.
--
-- Checked against the seeded database before writing this: no role has duplicate
-- rule positions, so this constraint validates without touching a row.
ALTER TABLE role_elimination_rules
  ADD CONSTRAINT role_elimination_rules_role_id_position_key UNIQUE (role_id, position)
  DEFERRABLE INITIALLY DEFERRED;

-- 4. Maintain updated_at in the database, not by convention.
--
-- Every repository that updates a row currently remembers to write
-- `updated_at = now()`. That is not a design - it is a rule that holds until the
-- first UPDATE written by someone who did not know about it, at which point
-- findStuckCandidates (which sweeps on `updated_at < cutoff`) silently stops
-- seeing a candidate that is genuinely stuck. Moving the guarantee into the table
-- makes it hold for raw SQL, for a psql session, and for code not yet written.
-- The explicit assignments in the repositories stay: they are now redundant, and
-- redundant agreement is cheaper to read than a hidden mechanism.
--
-- now() vs clock_timestamp(), chosen deliberately:
--
--   now() is transaction start time. Every row changed by one transaction
--   therefore gets the same updated_at, which is the truth: those rows became
--   visible atomically, and ordering them among themselves by an accident of
--   execution order would be inventing precision. It also matches the column
--   DEFAULT and every existing `updated_at = now()` in the repositories, so all
--   three sources of this value agree and the trigger is a genuine no-op wherever
--   the caller already set it.
--
--   clock_timestamp() is per-statement wall clock. The one thing it buys is
--   accuracy inside a long transaction, where now() records when the transaction
--   began rather than when the row changed. Rejected because every writer here is
--   a single-statement autocommit UPDATE (the status transitions) or a short
--   role-replacement transaction, and the staleness window findStuckCandidates
--   works in is minutes. A skew large enough to matter would require a
--   transaction held open for minutes, which is the bug, not this timestamp.
--
-- Two guards, both load-bearing:
--
--   * An UPDATE that changes nothing at all leaves updated_at alone. rolesRepository
--     .archiveRole is idempotent by contract - archiving an already-archived role
--     must be a true no-op, and it keeps updated_at still via a CASE. Postgres
--     still writes a new row version for an UPDATE whose values are unchanged, so
--     without this guard the trigger would bump a timestamp on a call that changed
--     nothing and quietly break that contract.
--   * An UPDATE that sets updated_at itself is left alone. Backdating a row is a
--     legitimate operation - it is how the stuck-candidate sweep is tested, and how
--     a backfill would work. The trigger's job is to supply a value nobody
--     supplied, not to overrule the caller.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Row-wise comparison, so it stays generic across tables. IS NOT DISTINCT FROM
  -- rather than = because = on rows containing NULLs yields NULL, and half these
  -- columns are nullable.
  IF NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;

  RETURN NEW;
END;
$$;

-- Applied to every table that has an updated_at column, which is roles and
-- candidates and nothing else: role_criteria and role_elimination_rules are
-- replaced wholesale rather than updated and carry no timestamps at all, and
-- screening_jobs is insert-only with created_at alone.
CREATE TRIGGER roles_set_updated_at
BEFORE UPDATE ON roles
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER candidates_set_updated_at
BEFORE UPDATE ON candidates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TRIGGER candidates_set_updated_at ON candidates;
DROP TRIGGER roles_set_updated_at ON roles;
DROP FUNCTION set_updated_at();

ALTER TABLE role_elimination_rules
  DROP CONSTRAINT role_elimination_rules_role_id_position_key;

DROP INDEX screening_jobs_role_id_idx;

-- Recreated exactly as migration 0002 declared it, so down really is down: a
-- database rolled back to 0005 is indistinguishable from one that never ran 0006.
CREATE INDEX role_criteria_role_id_idx ON role_criteria (role_id);
