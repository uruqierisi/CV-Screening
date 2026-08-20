import { describe, expect, it } from 'vitest';
import { SEED_ROLES } from '../../src/scripts/seedData.js';
import { parseRole } from '../../src/agents/schemas/role.schema.js';
import { ELIMINATION_RULE_EVALUATORS } from '../../src/agents/scoring/elimination.js';

/**
 * The seed roles, run through the schema that decides whether a role can be
 * scored against at all.
 *
 * This test exists because the two disagreed and nothing said so. `seedData.js`
 * left `onMissing` off two of the backend role's three rules and three of the
 * nurse role's four, relying on the column default (`NOT NULL DEFAULT 'flag'`).
 * `parseRole` requires it explicitly - decision 7-C is too consequential to
 * infer - so a role built from the seed literal rather than read back from the
 * database failed on sight:
 *
 * > `InvalidRoleError: role definition cannot be scored against`
 * > `eliminationRules.0.onMissing: Required`
 *
 * A default in one layer and a requirement in another is a drift the seed data
 * cannot detect by being inserted successfully, because the database fills the
 * gap on the way in. Only running the literal through the agent schema catches
 * it, which is why this test lives with the agent layer and needs no Postgres.
 *
 * It deliberately does **not** assert a particular `onMissing` per rule beyond
 * the two that were always explicit: the values are a product decision that
 * belongs in `seedData.js`, and copying them here would just be a second place
 * to edit. What it asserts is that every rule states one.
 */

/**
 * The seed carries no ids: the database generates them. `parseRole` requires
 * them, because a criterion id is the key the model rates against. Synthesising
 * them here is exactly what the seed script's caller does with the rows it gets
 * back, and it keeps the test about the fields the seed actually owns.
 *
 * @param {(typeof SEED_ROLES)[number]} seedRole
 */
function asScoringRole(seedRole) {
  return {
    id: seedRole.id,
    title: seedRole.title,
    version: 1,
    criteria: seedRole.criteria.map((criterion, index) => ({
      ...criterion,
      id: `${seedRole.id}-c${index}`,
    })),
    eliminationRules: seedRole.eliminationRules.map((rule, index) => ({
      ...rule,
      id: `${seedRole.id}-r${index}`,
    })),
  };
}

describe('the seeded roles', () => {
  it('are the two the plan asks for, and they are genuinely different', () => {
    // Guards everything below: an empty or single-entry list would make the
    // per-role assertions vacuous.
    expect(SEED_ROLES).toHaveLength(2);
    const types = SEED_ROLES.map((role) => role.eliminationRules.map((rule) => rule.type));
    expect(new Set(types[0])).not.toEqual(new Set(types[1]));
  });

  it.each(SEED_ROLES.map((role) => [role.title, role]))(
    'can be scored against: %s',
    (_title, seedRole) => {
      expect(() => parseRole(asScoringRole(seedRole))).not.toThrow();
    },
  );

  it.each(SEED_ROLES.map((role) => [role.title, role]))(
    'states onMissing on every elimination rule: %s',
    (_title, seedRole) => {
      // The specific defect. Left to the column default, these rules are valid
      // in the database and invalid to the scorer.
      for (const rule of seedRole.eliminationRules) {
        expect(['flag', 'eliminate'], rule.label).toContain(rule.onMissing);
      }
    },
  );

  it('keeps the hard requirements hard and everything else flagged', () => {
    // The behaviour the explicit values had to preserve: the two rules that were
    // already explicit stay `eliminate`, and every rule that was relying on the
    // column default stays `flag`. This is a regression test on the fix, not a
    // restatement of the product decision.
    const eliminating = SEED_ROLES.flatMap((role) =>
      role.eliminationRules.filter((rule) => rule.onMissing === 'eliminate').map((r) => r.label),
    );

    expect(eliminating).toEqual([
      'Authorised to work in the UK, Ireland or Germany',
      'Current Registered Nurse (RN) licence',
    ]);
  });

  it('uses only rule types that have an evaluator', () => {
    // The closed union, checked against the seed rather than against itself. A
    // seeded rule with no evaluator would throw at screening time, per candidate,
    // long after the seed appeared to succeed.
    for (const role of SEED_ROLES) {
      for (const rule of role.eliminationRules) {
        expect(Object.keys(ELIMINATION_RULE_EVALUATORS), rule.label).toContain(rule.type);
      }
    }
  });

  it('gives every role criteria whose weights sum to 100', () => {
    // Asserted here as well as by `parseRole` above, because this is the one that
    // tells a reader what broke when the seed is edited.
    for (const role of SEED_ROLES) {
      const sum = role.criteria.reduce((total, criterion) => total + criterion.weight, 0);
      expect(sum, role.title).toBe(100);
    }
  });
});
