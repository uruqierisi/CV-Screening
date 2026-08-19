import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ELIMINATION_RULE_EVALUATORS } from '../../src/agents/scoring/elimination.js';
import { ELIMINATION_RULE_VALUE_SCHEMAS } from '../../src/agents/schemas/role.schema.js';
import { ELIMINATION_RULE_TYPES } from '../../src/agents/constants.js';
import { ELIMINATION_RULE_TYPES as REPOSITORY_RULE_TYPES } from '../../src/repositories/roleEliminationRulesRepository.js';

/**
 * The test plan section 2 asks for: the stored enum and the evaluator registry
 * are the same set.
 *
 * The stored enum is read out of the migration SQL rather than out of a running
 * database, deliberately. It keeps this test in the unit project - a reviewer can
 * verify the closed union with nothing installed - and it checks the definition
 * that actually creates the constraint, which is the thing that would drift.
 *
 * Four copies of this list exist, one in each layer that has to agree about it:
 * the CHECK constraint, the repository constant, the agent-layer constant (which
 * the zod value schemas key off), and the evaluator registry. Four is more copies
 * than anyone wants, and this test is the price of not collapsing them into a
 * shared import that would drag the database layer into the agent layer.
 *
 * If this fails, the fix is never to relax the test. A type that can be stored
 * and not evaluated throws on every candidate that role screens; a type that can
 * be evaluated and not stored is dead code.
 */

const MIGRATION_PATH = fileURLToPath(
  new URL('../../migrations/0003_role_elimination_rules.sql', import.meta.url),
);

/**
 * @returns {string[]} the values inside the `type` CHECK constraint
 */
function readStoredRuleTypes() {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const match = /CONSTRAINT role_elimination_rules_type_check CHECK \(type IN \(([^)]*)\)\)/.exec(
    sql,
  );

  if (match === null) {
    throw new Error('could not find the type CHECK constraint in migration 0003');
  }

  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((found) => found[1]).sort();
}

describe('the elimination rule union is closed', () => {
  const stored = readStoredRuleTypes();

  it('reads a non-trivial set out of the migration', () => {
    // Guards the regex itself: a parser that silently returned [] would make
    // every assertion below vacuous.
    expect(stored.length).toBeGreaterThanOrEqual(5);
    expect(stored).toContain('min_years_experience');
  });

  it('matches the evaluator registry exactly', () => {
    expect(Object.keys(ELIMINATION_RULE_EVALUATORS).sort()).toEqual(stored);
  });

  it('matches the agent-layer constant exactly', () => {
    expect([...ELIMINATION_RULE_TYPES].sort()).toEqual(stored);
  });

  it('matches the repository constant exactly', () => {
    expect([...REPOSITORY_RULE_TYPES].sort()).toEqual(stored);
  });

  it('has a value schema for every type', () => {
    expect(Object.keys(ELIMINATION_RULE_VALUE_SCHEMAS).sort()).toEqual(stored);
  });

  it('does not include required_language, which the plan dropped', () => {
    expect(stored).not.toContain('required_language');
  });

  it('gives every evaluator a callable implementation', () => {
    for (const type of stored) {
      expect(typeof ELIMINATION_RULE_EVALUATORS[type]).toBe('function');
    }
  });
});
