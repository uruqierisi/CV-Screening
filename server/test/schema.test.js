import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from './helpers/database.js';
import { ELIMINATION_RULE_TYPES } from '../src/repositories/roleEliminationRulesRepository.js';
import {
  CANDIDATE_STATUSES,
  TERMINAL_CANDIDATE_STATUSES,
} from '../src/schemas/candidate.schemas.js';
import { NON_TERMINAL_STATUSES } from '../src/repositories/candidateStatusRepository.js';

/**
 * Asserts the shape of the migrated schema.
 *
 * These are not tautologies over the migration files: they catch the decisions in
 * the plan that a well-meaning later edit would quietly undo - re-adding a status
 * column, making the duplicate index unique, dropping a NULLS LAST.
 */

/**
 * @param {string} table
 * @returns {Promise<Set<string>>}
 */
async function columnsOf(table) {
  const { rows } = await pool.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
    [table],
  );
  return new Set(rows.map((row) => row.column_name));
}

describe('schema', () => {
  it('has exactly the five tables of the data model', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    const tables = rows.map((row) => row.table_name);

    expect(tables).toEqual([
      'candidates',
      // node-pg-migrate's own bookkeeping table.
      'pgmigrations',
      'role_criteria',
      'role_elimination_rules',
      'roles',
      'screening_jobs',
    ]);
  });

  it('roles has no is_active column - roles are per-candidate, not global state', async () => {
    const columns = await columnsOf('roles');

    expect(columns.has('archived_at')).toBe(true);
    expect(columns.has('is_active')).toBe(false);
  });

  it('screening_jobs has no status column - job status is derived from candidates', async () => {
    const columns = await columnsOf('screening_jobs');

    expect([...columns].sort()).toEqual(['created_at', 'file_count', 'id', 'role_id']);
  });

  it('stores criterion weight as an integer, not numeric', async () => {
    const { rows } = await pool.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'role_criteria' AND column_name = 'weight'`,
    );

    expect(rows[0].data_type).toBe('integer');
  });

  it('closes the elimination rule type enum over exactly the five supported types', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conname = 'role_elimination_rules_type_check'`,
    );
    const definition = rows[0].definition;

    for (const type of ELIMINATION_RULE_TYPES) {
      expect(definition).toContain(`'${type}'`);
    }
    // Proposed and dropped: not in the spec.
    expect(definition).not.toContain('required_language');
    // One quoted literal per supported type, and no more.
    expect(definition.match(/'[a-z_]+'::text/g)).toHaveLength(ELIMINATION_RULE_TYPES.length);
  });

  it('defers the criteria position uniqueness so a full replacement can reorder', async () => {
    const { rows } = await pool.query(
      `SELECT condeferrable, condeferred
         FROM pg_constraint
        WHERE conname = 'role_criteria_role_id_position_key'`,
    );

    expect(rows[0]).toEqual({ condeferrable: true, condeferred: true });
  });

  it('declares the sum-to-100 check as a deferred constraint trigger', async () => {
    const { rows } = await pool.query(
      `SELECT t.tgdeferrable, t.tginitdeferred, c.relname AS table_name
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname = 'role_criteria_weights_sum_100'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      tgdeferrable: true,
      tginitdeferred: true,
      table_name: 'role_criteria',
    });
  });

  it('creates the candidate indexes named in the plan, with NULLS LAST intact', async () => {
    const { rows } = await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'candidates' ORDER BY indexname`,
    );
    const byName = new Map(rows.map((row) => [row.indexname, row.indexdef]));

    expect([...byName.keys()]).toEqual([
      'candidates_active_status_idx',
      'candidates_job_status_idx',
      'candidates_pkey',
      'candidates_role_content_sha256_key',
      'candidates_role_fit_ranking_idx',
      'candidates_role_ranking_idx',
    ]);

    // The ranking indexes must match the one ORDER BY in candidateOrdering.js
    // exactly, or the dashboard's default query sorts instead of scanning.
    expect(byName.get('candidates_role_ranking_idx')).toContain(
      'role_id, match_score DESC NULLS LAST, id DESC',
    );
    expect(byName.get('candidates_role_fit_ranking_idx')).toContain(
      'role_id, fit_category, match_score DESC NULLS LAST, id DESC',
    );
    // Partial, so it stays small as the table grows.
    expect(byName.get('candidates_active_status_idx')).toContain('WHERE');
  });

  it('enforces upload idempotency with a UNIQUE (role_id, content_sha256)', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'candidates_role_content_sha256_key'`,
    );

    // Migration 0008 REVERSED the original decision here. This index was
    // "non-unique on purpose" and duplicates were detectable rather than
    // prevented; uploads are now idempotent on (role_id, content_sha256), and a
    // duplicate upload returns the existing candidate instead of creating a
    // second one. Plan sections 2, 3 and 8 were rewritten in the same change.
    expect(rows[0].indexdef).toContain('UNIQUE');
    expect(rows[0].indexdef).toContain('(role_id, content_sha256)');
  });

  it('backs the unique index with a named constraint, so a violation names the rule', async () => {
    const { rows } = await pool.query(
      `SELECT conname, contype FROM pg_constraint
        WHERE conrelid = 'candidates'::regclass AND conname = 'candidates_role_content_sha256_key'`,
    );

    // ON CONFLICT (role_id, content_sha256) only needs a unique index to
    // arbitrate on. The constraint is what makes the rule visible in the
    // catalogue as a business rule rather than as a lookup that happens to be
    // unique.
    expect(rows).toHaveLength(1);
    expect(rows[0].contype).toBe('u');
  });

  it('indexes the one foreign key column PostgreSQL does not index for us', async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes
        WHERE indexname IN ('role_elimination_rules_role_id_idx', 'screening_jobs_role_id_idx')
        ORDER BY indexname`,
    );

    // screening_jobs.role_id is an ON DELETE RESTRICT foreign key, and PostgreSQL
    // enforces RESTRICT by looking for a referencing row - without this index that
    // is a sequential scan of every screening job ever created.
    //
    // role_elimination_rules_role_id_idx is deliberately absent, and is still named
    // in the query so this asserts its absence rather than quietly forgetting it.
    // Its ON DELETE CASCADE is served by the leading column of
    // role_elimination_rules_role_id_position_key; migration 0007 dropped the
    // standalone index as a strict prefix of that one.
    expect(rows.map((row) => row.indexname)).toEqual(['screening_jobs_role_id_idx']);
  });

  // Redundant here means: the narrower index reads nothing the wider one cannot, so
  // it is pure write cost on every insert, update and delete. Two such indexes have
  // already been dropped on that argument - role_criteria(role_id) in migration 0006
  // and role_elimination_rules(role_id) in 0007 - so this asserts the invariant
  // across the whole catalogue rather than naming the two known cases, and keeps
  // holding as tables are added in later phases.
  //
  // Three exclusions are encoded in the query and none of them is an oversight:
  //
  //   * The non-unique filter is on the REDUNDANT candidate, not on the pair. A
  //     unique (a) is NOT redundant against a unique (a, b): unique (a) enforces one
  //     row per a, which unique (a, b) does not. Dropping it would change what the
  //     database permits, not merely what it can read. A non-unique prefix carries
  //     no such semantics, so it is free to go. The wider index may be either.
  //   * Partial indexes are excluded on both sides. Two indexes with different
  //     WHERE clauses cover different subsets of rows, so neither can stand in for
  //     the other whatever their key columns say.
  //   * Key columns must agree on operator class, sort direction and NULLS ordering,
  //     not just on column order. A different opclass answers different operators,
  //     and a prefix ordered differently cannot supply the wider index's ordering.
  //     Expression indexes are excluded on both sides for the same reason opclasses
  //     matter: indkey reports 0 for an expression, so two unrelated expressions on
  //     one table would compare equal.
  //
  // Read from pg_index, not by parsing indexdef. A string comparison over DDL text
  // is a re-implementation of the parser and gets DESC, NULLS FIRST and opclasses
  // wrong. Only the first indnkeyatts entries are compared, so adding an INCLUDE
  // column to an index later does not change the answer.
  it('carries no index that is a strict prefix of another index', async () => {
    const { rows } = await pool.query(
      `WITH idx AS (
         SELECT
           i.indexrelid,
           i.indrelid,
           tc.relname AS table_name,
           ic.relname AS index_name,
           i.indisunique,
           i.indnkeyatts,
           i.indpred  IS NOT NULL AS is_partial,
           i.indexprs IS NOT NULL AS is_expression,
           -- One token per key column: attribute number, operator class, and the
           -- packed DESC/NULLS FIRST flags. Equality of these arrays is exactly
           -- "the same key, indexed the same way". indkey, indclass and indoption
           -- are 0-based vectors; indnkeyatts excludes INCLUDE columns.
           (SELECT array_agg(i.indkey[k] || ':' || i.indclass[k] || ':' || i.indoption[k]
                             ORDER BY k)
              FROM generate_series(0, i.indnkeyatts - 1) AS k) AS key_signature
         FROM pg_index i
         JOIN pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_class tc ON tc.oid = i.indrelid
         JOIN pg_am    am ON am.oid = ic.relam
         JOIN pg_namespace n ON n.oid = tc.relnamespace
        WHERE n.nspname = 'public'
          -- Prefix reasoning is a btree property. A hash or GIN index on the same
          -- leading column answers different queries entirely.
          AND am.amname = 'btree'
       )
       SELECT redundant.index_name AS redundant,
              wider.index_name     AS wider,
              redundant.table_name AS table_name
         FROM idx AS redundant
         JOIN idx AS wider
           ON wider.indrelid = redundant.indrelid
          AND wider.indexrelid <> redundant.indexrelid
          -- Strict: equal key counts are the same index, not a prefix of one.
          AND wider.indnkeyatts > redundant.indnkeyatts
          AND wider.key_signature[1:redundant.indnkeyatts] = redundant.key_signature
        WHERE NOT redundant.indisunique
          AND NOT redundant.is_partial
          AND NOT wider.is_partial
          AND NOT redundant.is_expression
          AND NOT wider.is_expression
        ORDER BY redundant.table_name, redundant.index_name, wider.index_name`,
    );

    // Compared as sentences rather than as a count, so a failure names the pair and
    // the table instead of reporting that some boolean was not what it should be.
    expect(
      rows.map(
        (row) => `${row.redundant} is a strict prefix of ${row.wider} on ${row.table_name}`,
      ),
    ).toEqual([]);
  });

  it('defers the elimination-rule position uniqueness, exactly as criteria does', async () => {
    const { rows } = await pool.query(
      `SELECT condeferrable, condeferred
         FROM pg_constraint
        WHERE conname = 'role_elimination_rules_role_id_position_key'`,
    );

    // Rules are written delete-then-insert inside one transaction just as criteria
    // are, so a non-deferred constraint would reject the reordering path.
    expect(rows[0]).toEqual({ condeferrable: true, condeferred: true });
  });

  it('maintains updated_at with a BEFORE UPDATE row trigger', async () => {
    const { rows } = await pool.query(
      `SELECT event_object_table, action_timing, event_manipulation, action_orientation
         FROM information_schema.triggers
        WHERE trigger_name IN ('roles_set_updated_at', 'candidates_set_updated_at')
        ORDER BY event_object_table`,
    );

    expect(rows).toEqual([
      {
        event_object_table: 'candidates',
        action_timing: 'BEFORE',
        event_manipulation: 'UPDATE',
        action_orientation: 'ROW',
      },
      {
        event_object_table: 'roles',
        action_timing: 'BEFORE',
        event_manipulation: 'UPDATE',
        action_orientation: 'ROW',
      },
    ]);
  });

  it('leaves no table with an updated_at column without that trigger', async () => {
    const { rows } = await pool.query(
      `SELECT c.table_name
         FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.column_name = 'updated_at'
          AND NOT EXISTS (
                SELECT 1
                  FROM information_schema.triggers t
                 WHERE t.event_object_schema = c.table_schema
                   AND t.event_object_table = c.table_name
                   AND t.action_timing = 'BEFORE'
                   AND t.event_manipulation = 'UPDATE')`,
    );

    // Phrased as "which tables are missing it" rather than "these two have it", so
    // a table added in a later phase with an updated_at column and no trigger fails
    // here rather than silently relying on every future UPDATE remembering.
    expect(rows).toEqual([]);
  });
});

describe('candidates integrity constraints', () => {
  /** @type {string[]} */
  let constraints;

  beforeAll(async () => {
    const { rows } = await pool.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'candidates'::regclass AND contype = 'c'
        ORDER BY conname`,
    );
    constraints = rows.map((row) => row.conname);
  });

  it('declares the four integrity checks from the data model', () => {
    expect(constraints).toEqual(
      expect.arrayContaining([
        'candidates_done_is_complete_check',
        'candidates_failed_has_error_code_check',
        'candidates_error_pair_check',
        'candidates_terminal_has_completed_at_check',
      ]),
    );
  });
});

describe('the candidate status vocabulary is one vocabulary', () => {
  /**
   * The values `candidates_status_check` actually allows, read out of the live
   * catalogue rather than out of the migration file.
   *
   * @returns {Promise<string[]>}
   */
  async function statusesFromColumnCheck() {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'candidates'::regclass AND conname = 'candidates_status_check'`,
    );
    // Postgres rewrites `IN (...)` as `= ANY (ARRAY['a'::text, ...])`, so the
    // quoted literals are pulled out rather than the list parsed.
    return [...rows[0].def.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]);
  }

  it('publishes exactly the statuses the column can hold', async () => {
    expect([...CANDIDATE_STATUSES].sort()).toEqual((await statusesFromColumnCheck()).sort());
  });

  it('classifies every one of them as terminal or not', async () => {
    // This is what makes `/config`'s `terminalStatuses` a derived fact rather
    // than a second literal that happens to agree today. A sixth status added to
    // the column - which is a migration, the only way one can be added - fails
    // here unless it has been classified, and a status classified as both fails
    // on the size check.
    //
    // The stop condition a dashboard polls against is the thing being protected:
    // a terminal status missing from the list is a poll that never stops, and a
    // non-terminal one wrongly in it is a poll that stops on a candidate still
    // being screened.
    const fromDatabase = await statusesFromColumnCheck();
    const partition = [...TERMINAL_CANDIDATE_STATUSES, ...NON_TERMINAL_STATUSES];

    expect([...partition].sort()).toEqual([...fromDatabase].sort());
    expect(new Set(partition).size).toBe(fromDatabase.length);
  });

  it('names done and failed as the terminal pair, and no others', async () => {
    // The current answer, pinned. The two tests above are the ones that survive a
    // sixth status; this one is the one that reads as documentation.
    expect(TERMINAL_CANDIDATE_STATUSES).toEqual(['done', 'failed']);
  });
});
