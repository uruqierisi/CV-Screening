import { pathToFileURL } from 'node:url';
import { closePool, pool } from '../db/pool.js';
import { withTransaction } from '../db/withTransaction.js';
import { findRoleById, insertRole } from '../repositories/rolesRepository.js';
import { replaceCriteriaForRole } from '../repositories/roleCriteriaRepository.js';
import { replaceEliminationRulesForRole } from '../repositories/roleEliminationRulesRepository.js';
import { SEED_ROLES } from './seedData.js';

/**
 * Loads the seed roles.
 *
 * Re-runnable: role ids are fixed constants, so a second run finds the existing
 * role and replaces its criteria and rules rather than creating a duplicate. It
 * deliberately does not touch an existing role's title, description or version -
 * re-seeding a database someone has been working in should not silently bump a
 * version number that candidates are stamped with.
 *
 * Each role is written in its own transaction. The criteria are delete-then-insert
 * inside it, so the sum-to-100 constraint trigger is checked at COMMIT and a seed
 * whose weights were edited to something other than 100 fails here rather than
 * producing an unscoreable role.
 *
 * @param {{ pool?: import('pg').Pool }} [options]
 * @returns {Promise<Array<{ id: string, title: string, created: boolean, criteriaCount: number, eliminationRuleCount: number }>>}
 */
export async function seedDatabase(options = {}) {
  const targetPool = options.pool ?? pool;
  const results = [];

  for (const seedRole of SEED_ROLES) {
    const result = await withTransaction(async (client) => {
      const existing = await findRoleById(client, seedRole.id);

      if (!existing) {
        await insertRole(client, {
          id: seedRole.id,
          title: seedRole.title,
          description: seedRole.description,
        });
      }

      const criteria = await replaceCriteriaForRole(client, seedRole.id, seedRole.criteria);
      const rules = await replaceEliminationRulesForRole(
        client,
        seedRole.id,
        seedRole.eliminationRules,
      );

      return {
        id: seedRole.id,
        title: seedRole.title,
        created: !existing,
        criteriaCount: criteria.length,
        eliminationRuleCount: rules.length,
      };
    }, { pool: targetPool });

    results.push(result);
  }

  return results;
}

async function main() {
  const results = await seedDatabase();

  for (const result of results) {
    process.stdout.write(
      `${result.created ? 'created' : 'updated'} ${result.id}  ${result.title}\n` +
        `  ${result.criteriaCount} criteria, ${result.eliminationRuleCount} elimination rules\n`,
    );
  }

  process.stdout.write(`seed complete: ${results.length} roles\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((error) => {
      process.stderr.write(`seed failed: ${error.message}\n`);
      process.exitCode = 1;
    })
    .finally(closePool);
}
