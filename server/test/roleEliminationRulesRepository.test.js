import { beforeEach, describe, expect, it } from 'vitest';
import { pool, truncateAll } from './helpers/database.js';
import { createRole } from './helpers/fixtures.js';
import { withTransaction } from '../src/db/withTransaction.js';
import {
  ELIMINATION_RULE_TYPES,
  listEliminationRulesByRoleId,
  listEliminationRulesByRoleIds,
  replaceEliminationRulesForRole,
} from '../src/repositories/roleEliminationRulesRepository.js';

beforeEach(truncateAll);

/** One valid rule of each supported type, as the seed and the API would write them. */
const ONE_OF_EACH_TYPE = [
  { label: 'Five years', type: 'min_years_experience', value: { years: 5 }, position: 0 },
  {
    label: 'PostgreSQL',
    type: 'required_skill',
    value: { skill: 'PostgreSQL', matchMode: 'normalized', mustBeDemonstrated: true },
    position: 1,
  },
  {
    label: 'Bachelors',
    type: 'required_education_level',
    value: { level: 'bachelors' },
    position: 2,
  },
  {
    label: 'RN licence',
    type: 'required_certification',
    value: { name: 'Registered Nurse (RN) License', matchMode: 'normalized' },
    onMissing: 'eliminate',
    position: 3,
  },
  {
    label: 'Right to work',
    type: 'location_allowlist',
    value: { countryCodes: ['GB', 'IE'] },
    onMissing: 'eliminate',
    position: 4,
  },
];

describe('replaceEliminationRulesForRole', () => {
  it('stores every supported rule type with its jsonb value intact', async () => {
    const { eliminationRules } = await createRole({ eliminationRules: ONE_OF_EACH_TYPE });

    expect(eliminationRules.map((rule) => rule.type)).toEqual([...ELIMINATION_RULE_TYPES]);
    expect(eliminationRules[1].value).toEqual({
      skill: 'PostgreSQL',
      matchMode: 'normalized',
      mustBeDemonstrated: true,
    });
    expect(eliminationRules[4].value.countryCodes).toEqual(['GB', 'IE']);
  });

  it('defaults on_missing to flag - an unknown fact does not eliminate', async () => {
    const { eliminationRules } = await createRole({
      eliminationRules: [
        { label: 'Five years', type: 'min_years_experience', value: { years: 5 }, position: 0 },
      ],
    });

    expect(eliminationRules[0].onMissing).toBe('flag');
  });

  it('honours an explicit eliminate, which is how a hard requirement opts in', async () => {
    const { eliminationRules } = await createRole({
      eliminationRules: [
        {
          label: 'RN licence',
          type: 'required_certification',
          value: { name: 'RN' },
          onMissing: 'eliminate',
          position: 0,
        },
      ],
    });

    expect(eliminationRules[0].onMissing).toBe('eliminate');
  });

  it('rejects a rule type with no code evaluator', async () => {
    const { role } = await createRole();

    // The union is closed on purpose: a type that cannot be evaluated must not be
    // storable, because an unknown type at evaluation time throws rather than
    // silently passing a candidate.
    await expect(
      withTransaction((client) =>
        replaceEliminationRulesForRole(client, role.id, [
          { label: 'Speaks French', type: 'required_language', value: { code: 'fr' }, position: 0 },
        ]),
      ),
    ).rejects.toMatchObject({ constraint: 'role_elimination_rules_type_check' });
  });

  it('rejects an on_missing outside flag | eliminate', async () => {
    const { role } = await createRole();

    await expect(
      withTransaction((client) =>
        replaceEliminationRulesForRole(client, role.id, [
          {
            label: 'Five years',
            type: 'min_years_experience',
            value: { years: 5 },
            onMissing: /** @type {any} */ ('maybe'),
            position: 0,
          },
        ]),
      ),
    ).rejects.toMatchObject({ constraint: 'role_elimination_rules_on_missing_check' });
  });

  it('replaces the whole set, and accepts an empty one', async () => {
    const { role } = await createRole({ eliminationRules: ONE_OF_EACH_TYPE });

    await withTransaction((client) => replaceEliminationRulesForRole(client, role.id, []));

    // A role with no elimination rules is a legitimate configuration: scoring
    // alone, no hard requirements.
    expect(await listEliminationRulesByRoleId(pool, role.id)).toEqual([]);
  });

  it('refuses to run outside a transaction', async () => {
    const { role } = await createRole();

    await expect(
      replaceEliminationRulesForRole(/** @type {any} */ (pool), role.id, []),
    ).rejects.toThrow(/must be called with a transaction client/);
  });
});

describe('listEliminationRulesByRoleIds', () => {
  it('loads rules for several roles in one query', async () => {
    const first = await createRole({
      title: 'First',
      eliminationRules: ONE_OF_EACH_TYPE.slice(0, 2),
    });
    const second = await createRole({
      title: 'Second',
      eliminationRules: ONE_OF_EACH_TYPE.slice(2),
    });

    const byRole = await listEliminationRulesByRoleIds(pool, [first.role.id, second.role.id]);

    expect(byRole.get(first.role.id)).toHaveLength(2);
    expect(byRole.get(second.role.id)).toHaveLength(3);
  });

  it('returns an empty map for an empty id list', async () => {
    expect(await listEliminationRulesByRoleIds(pool, [])).toEqual(new Map());
  });
});

describe('position uniqueness (database layer)', () => {
  /** PostgreSQL SQLSTATE for unique_violation. */
  const UNIQUE_VIOLATION = '23505';

  it('rejects two rules of one role sharing a position', async () => {
    const { role } = await createRole();

    // Position is the display order of an ordered list. Two rules at position 1
    // means the order between them is whatever the planner felt like, and it can
    // differ between two reads of the same role.
    await expect(
      withTransaction((client) =>
        replaceEliminationRulesForRole(client, role.id, [
          { label: 'Five years', type: 'min_years_experience', value: { years: 5 }, position: 1 },
          { label: 'Two years', type: 'min_years_experience', value: { years: 2 }, position: 1 },
        ]),
      ),
    ).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: 'role_elimination_rules_role_id_position_key',
    });
  });

  it('allows the same position under two different roles', async () => {
    const first = await createRole({
      title: 'First',
      eliminationRules: [
        { label: 'Five years', type: 'min_years_experience', value: { years: 5 }, position: 0 },
      ],
    });
    const second = await createRole({
      title: 'Second',
      eliminationRules: [
        { label: 'Two years', type: 'min_years_experience', value: { years: 2 }, position: 0 },
      ],
    });

    // The constraint is per role, not global: every role's list starts at 0.
    expect(first.eliminationRules[0].position).toBe(0);
    expect(second.eliminationRules[0].position).toBe(0);
  });

  it('accepts a delete-then-insert reordering inside one transaction', async () => {
    const { role } = await createRole({ eliminationRules: ONE_OF_EACH_TYPE });

    const reversed = ONE_OF_EACH_TYPE.map((rule, index) => ({
      ...rule,
      position: ONE_OF_EACH_TYPE.length - 1 - index,
    }));

    await expect(
      withTransaction((client) => replaceEliminationRulesForRole(client, role.id, reversed)),
    ).resolves.toHaveLength(ONE_OF_EACH_TYPE.length);

    const stored = await listEliminationRulesByRoleId(pool, role.id);
    expect(stored.map((rule) => rule.label)).toEqual([
      'Right to work',
      'RN licence',
      'Bachelors',
      'PostgreSQL',
      'Five years',
    ]);
  });

  it('tolerates a mid-transaction collision, resolving it at COMMIT', async () => {
    const { role } = await createRole({ eliminationRules: ONE_OF_EACH_TYPE.slice(0, 2) });
    const [first, second] = await listEliminationRulesByRoleId(pool, role.id);
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Swapping two positions by UPDATE passes through a state where both rows
      // sit at position 1. A non-deferred constraint would throw on this first
      // statement, and that is the whole reason this one is DEFERRABLE INITIALLY
      // DEFERRED - same as role_criteria.
      await expect(
        client.query('UPDATE role_elimination_rules SET position = 1 WHERE id = $1', [first.id]),
      ).resolves.toBeDefined();
      await client.query('UPDATE role_elimination_rules SET position = 0 WHERE id = $1', [
        second.id,
      ]);

      await expect(client.query('COMMIT')).resolves.toBeDefined();
    } finally {
      client.release();
    }

    const stored = await listEliminationRulesByRoleId(pool, role.id);
    expect(stored.map((rule) => rule.label)).toEqual([second.label, first.label]);
  });
});
