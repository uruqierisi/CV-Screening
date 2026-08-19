import { beforeEach, describe, expect, it } from 'vitest';
import { pool, truncateAll } from './helpers/database.js';
import { seedDatabase } from '../src/scripts/seed.js';
import { SEED_ROLES } from '../src/scripts/seedData.js';
import { countRoles, findRoleById } from '../src/repositories/rolesRepository.js';
import {
  listCriteriaByRoleId,
  sumCriteriaWeights,
} from '../src/repositories/roleCriteriaRepository.js';
import { listEliminationRulesByRoleId } from '../src/repositories/roleEliminationRulesRepository.js';

beforeEach(truncateAll);

describe('seed data', () => {
  it('defines at least two roles with distinct ids', () => {
    const ids = SEED_ROLES.map((role) => role.id);

    expect(SEED_ROLES.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(SEED_ROLES.length);
  });

  it('has weights totalling exactly 100 in every role', () => {
    for (const role of SEED_ROLES) {
      const total = role.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
      expect(total, `weights for "${role.title}"`).toBe(100);
    }
  });

  it('gives the two roles genuinely different elimination rules', () => {
    const [backend, nurse] = SEED_ROLES;

    const backendTypes = new Set(backend.eliminationRules.map((rule) => rule.type));
    const nurseTypes = new Set(nurse.eliminationRules.map((rule) => rule.type));

    // Not two variations of the same job: the rule sets barely overlap.
    expect([...backendTypes].filter((type) => nurseTypes.has(type))).toEqual([
      'min_years_experience',
    ]);
    expect(backendTypes.has('location_allowlist')).toBe(true);
    expect(nurseTypes.has('required_certification')).toBe(true);
  });

  it('exercises both on_missing behaviours, in both roles', () => {
    for (const role of SEED_ROLES) {
      const behaviours = role.eliminationRules.map((rule) => rule.onMissing ?? 'flag');

      // Decision 7-C is only visible in the data if both settings actually appear.
      expect(new Set(behaviours), `on_missing values for "${role.title}"`).toEqual(
        new Set(['flag', 'eliminate']),
      );
    }
  });
});

describe('seedDatabase', () => {
  it('creates two usable roles from an empty database', async () => {
    const results = await seedDatabase();

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.created)).toBe(true);
    expect(await countRoles(pool)).toBe(2);

    for (const seedRole of SEED_ROLES) {
      const role = await findRoleById(pool, seedRole.id);
      expect(role?.title).toBe(seedRole.title);

      // "Usable" means scoreable: at least one criterion, and weights the
      // database was willing to commit.
      expect(await sumCriteriaWeights(pool, seedRole.id)).toEqual({
        total: 100,
        count: seedRole.criteria.length,
      });
      expect(await listEliminationRulesByRoleId(pool, seedRole.id)).toHaveLength(
        seedRole.eliminationRules.length,
      );
    }
  });

  it('is re-runnable without duplicating anything', async () => {
    await seedDatabase();
    const second = await seedDatabase();

    expect(second.every((result) => result.created)).toBe(false);
    expect(await countRoles(pool)).toBe(2);

    const criteria = await pool.query('SELECT count(*) AS total FROM role_criteria');
    const rules = await pool.query('SELECT count(*) AS total FROM role_elimination_rules');
    expect(criteria.rows[0].total).toBe(12);
    expect(rules.rows[0].total).toBe(7);
  });

  it('does not bump the role version on a re-run', async () => {
    await seedDatabase();
    await seedDatabase();

    const role = await findRoleById(pool, SEED_ROLES[0].id);
    // Candidates are stamped with scored_role_version; re-seeding must not make
    // it look as though the rubric changed.
    expect(role?.version).toBe(1);
  });

  it('stores criteria in the order the seed declares them', async () => {
    await seedDatabase();

    const criteria = await listCriteriaByRoleId(pool, SEED_ROLES[0].id);
    expect(criteria.map((criterion) => criterion.label)).toEqual(
      SEED_ROLES[0].criteria.map((criterion) => criterion.label),
    );
  });
});
