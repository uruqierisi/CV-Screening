import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from './helpers/database.js';
import { ELIMINATION_RULE_TYPES } from '../src/repositories/roleEliminationRulesRepository.js';

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
      'candidates_role_content_sha256_idx',
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

  it('keeps the duplicate-CV index non-unique on purpose', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'candidates_role_content_sha256_idx'`,
    );

    // Uploads are not idempotent in v1: duplicates are detectable, not prevented.
    expect(rows[0].indexdef).not.toContain('UNIQUE');
  });

  it('indexes the foreign key columns PostgreSQL does not index for us', async () => {
    const { rows } = await pool.query(
      `SELECT tablename, indexname FROM pg_indexes
        WHERE indexname IN ('role_criteria_role_id_idx', 'role_elimination_rules_role_id_idx')`,
    );

    expect(rows).toHaveLength(2);
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
