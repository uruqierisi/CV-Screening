-- Up Migration
--
-- Weighted scoring criteria for a role. Plan of record section 2.
--
-- `weight` is an integer, not numeric: the score is Sum(rating * weight) with
-- rating in 0..10, so scoreRaw lands in 0..1000 and score = scoreRaw / 10 is
-- exact with no floating-point reasoning anywhere. Cost: no fractional weights.

CREATE TABLE role_criteria (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id     uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  label       text NOT NULL,
  description text NOT NULL DEFAULT '',
  weight      integer NOT NULL,
  position    integer NOT NULL,

  CONSTRAINT role_criteria_label_length_check CHECK (char_length(label) BETWEEN 1 AND 120),
  CONSTRAINT role_criteria_weight_range_check CHECK (weight BETWEEN 1 AND 100),
  CONSTRAINT role_criteria_role_id_label_key UNIQUE (role_id, label),
  -- Deferred so a full replacement can rewrite positions inside one transaction
  -- without having to order the writes to dodge a transient collision.
  CONSTRAINT role_criteria_role_id_position_key UNIQUE (role_id, position)
    DEFERRABLE INITIALLY DEFERRED
);

-- Listed in the plan's index table. Note it is partly redundant with the two
-- UNIQUE constraints above, both of which already lead with role_id.
CREATE INDEX role_criteria_role_id_idx ON role_criteria (role_id);

-- Layer 2 of the three-layer sum-to-100 invariant (zod at the boundary is layer
-- 1, an assertion in computeWeightedScore is layer 3).
--
-- Criteria are written delete-then-insert inside one transaction, so the
-- intermediate state is invalid by design. A normal trigger would reject the
-- delete; a CONSTRAINT TRIGGER declared DEFERRABLE INITIALLY DEFERRED runs at
-- COMMIT, by which point the final state is the only state it sees.
--
-- A role with zero criteria never fires this trigger - nothing to fire on. That
-- gap is closed above by zod requiring criteria.length >= 1, and below by
-- uploads to a criteria-less role being rejected ROLE_NOT_SCOREABLE.
CREATE FUNCTION role_criteria_assert_weights_sum_100() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_role_id uuid := COALESCE(NEW.role_id, OLD.role_id);
  v_sum     integer;
  v_count   integer;
BEGIN
  SELECT COALESCE(SUM(weight), 0), COUNT(*)
    INTO v_sum, v_count
    FROM role_criteria
   WHERE role_id = v_role_id;

  -- Zero criteria means the role was deleted (cascade) or emptied. Nothing to
  -- assert; see the note above about where that case is actually caught.
  IF v_count = 0 THEN
    RETURN NULL;
  END IF;

  IF v_sum <> 100 THEN
    RAISE EXCEPTION 'criteria weights for role % sum to %, expected 100', v_role_id, v_sum
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'role_criteria_weights_sum_100',
            HINT = 'Write all criteria for a role in one transaction; the check runs at COMMIT.';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER role_criteria_weights_sum_100
AFTER INSERT OR UPDATE OR DELETE ON role_criteria
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION role_criteria_assert_weights_sum_100();

-- Down Migration
DROP TABLE role_criteria;
DROP FUNCTION role_criteria_assert_weights_sum_100();
