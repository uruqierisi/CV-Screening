-- Up Migration
--
-- Make uploads idempotent on (role_id, content_sha256).
--
-- This REVERSES a decision recorded three times in the plan of record, and the
-- plan was rewritten in the same change rather than left contradicting the
-- schema:
--
--   * section 2's index table called this index "non-unique on purpose";
--   * section 3's "Not built: Idempotency-Key on upload" paragraph said a
--     double-clicked button creates duplicates and spends the budget twice;
--   * section 8 listed "Uploads are not idempotent" as a known limitation.
--
-- The owner changed the decision. Idempotency is now the index rather than a
-- header, which is the cheaper and stronger of the two: a header is a promise a
-- client has to keep, and a unique constraint is a promise the database keeps.
--
-- Conflict semantics live above this migration, in
-- `insertCandidatesIdempotent`: a duplicate upload returns the EXISTING
-- candidate rather than erroring. Same bytes, same role, same result - no second
-- LLM spend, and no 409 to make a double-clicked button look broken.
-- Re-screening a candidate that failed remains the retry endpoint's job.
--
-- ## Why a constraint rather than a unique index
--
-- ON CONFLICT (role_id, content_sha256) needs a unique index to arbitrate on; a
-- constraint creates one and additionally names the rule in the catalogue, so a
-- violation reports a constraint name rather than an index name. Both work for
-- the inference clause. The constraint is the more honest description of what
-- this is: a business rule, not a lookup that happens to be unique.
--
-- ## Existing data
--
-- Checked before writing this, on both the development and the test databases:
-- zero rows in `candidates`, therefore zero duplicate (role_id,
-- content_sha256) pairs. Stated because it will not be true forever - **on a
-- populated database this migration fails if any duplicate pair exists**, and
-- the correct response to that failure is to look at the rows, not to delete
-- anybody's candidates. The query that finds them:
--
--   SELECT role_id, content_sha256, count(*), array_agg(id)
--     FROM candidates GROUP BY 1, 2 HAVING count(*) > 1;
--
-- ## Locking
--
-- ALTER TABLE ... ADD CONSTRAINT ... UNIQUE builds the index under ACCESS
-- EXCLUSIVE on `candidates`, blocking reads and writes for the duration. The
-- runner wraps the whole history in one transaction, so CONCURRENTLY is not
-- available here - and it would not be for an ALTER TABLE in any case. This does
-- not rewrite the table; it builds one index over it. On a table with a few
-- thousand CVs that is milliseconds. **On a large table it is not**, and the
-- ordinary production procedure would be CREATE UNIQUE INDEX CONCURRENTLY
-- outside a transaction followed by ADD CONSTRAINT ... USING INDEX. Recorded
-- here so the shortcut is a choice about a table with no rows in it rather than
-- an oversight.

-- The non-unique index from migration 0005 goes first. Keeping both would leave
-- two indexes on the same column pair, one of which is a strict prefix of the
-- other in every sense that matters - it reads nothing the unique one cannot,
-- and costs a write on every insert.
DROP INDEX candidates_role_content_sha256_idx;

ALTER TABLE candidates
  ADD CONSTRAINT candidates_role_content_sha256_key UNIQUE (role_id, content_sha256);

-- Down Migration
--
-- Restores migration 0005's schema exactly, so a database rolled back to 0007 is
-- indistinguishable from one that never ran 0008. That matters here more than
-- usual: the schema test asserts the index is non-unique at 0007 and unique at
-- 0008, and a half-reverted rollback would leave the duplicate-detection index
-- missing altogether rather than merely non-unique.
--
-- Rolling back does not remove any duplicate rows, because there cannot be any:
-- the constraint prevented them for as long as it existed.
ALTER TABLE candidates DROP CONSTRAINT candidates_role_content_sha256_key;

CREATE INDEX candidates_role_content_sha256_idx ON candidates (role_id, content_sha256);
