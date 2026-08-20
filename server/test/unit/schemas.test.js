import { describe, expect, it } from 'vitest';
import {
  listRolesQuerySchema,
  roleBodySchema,
  specificRoleErrorCode,
} from '../../src/schemas/role.schemas.js';
import {
  CANDIDATE_STATUSES,
  TERMINAL_CANDIDATE_STATUSES,
  candidateDetailQuerySchema,
  candidateStatusesQuerySchema,
  listCandidatesQuerySchema,
} from '../../src/schemas/candidate.schemas.js';
import { NON_TERMINAL_STATUSES } from '../../src/repositories/candidateStatusRepository.js';
import {
  MAX_PAGE_SIZE,
  paginationMeta,
  paginationQuery,
  toLimitOffset,
  uuidParam,
} from '../../src/schemas/common.schemas.js';

/**
 * The boundary schemas: the only thing standing between a query string and SQL.
 *
 * The assertions worth having here are the rejections. A schema that accepts
 * what it should is exercised by every API test; a schema that quietly accepts
 * `?pageSize=100000` or `?sort=; DROP TABLE` is not exercised by anything until
 * it matters.
 */

const UUID = '11111111-2222-4333-8444-555555555555';

/** A body that is valid, so each test can break exactly one thing. */
function validRoleBody(overrides = {}) {
  return {
    title: 'Senior Backend Engineer',
    description: 'Builds and runs the API.',
    criteria: [
      { label: 'Technical depth', weight: 60 },
      { label: 'Communication', weight: 40 },
    ],
    eliminationRules: [],
    ...overrides,
  };
}

describe('roleBodySchema', () => {
  it('accepts a valid role and defaults what it can', () => {
    const parsed = roleBodySchema.parse({
      title: 'Registered Nurse',
      criteria: [{ label: 'Clinical skill', weight: 100 }],
    });

    expect(parsed.description).toBe('');
    expect(parsed.eliminationRules).toEqual([]);
    expect(parsed.criteria[0].description).toBe('');
  });

  it('rejects weights that do not sum to 100, and says what they did sum to', () => {
    const result = roleBodySchema.safeParse(
      validRoleBody({ criteria: [{ label: 'A', weight: 60 }, { label: 'B', weight: 30 }] }),
    );

    expect(result.success).toBe(false);
    // The number they sent, not just the number we wanted - otherwise a
    // recruiter has to add up their own form.
    expect(result.error.issues[0].message).toContain('received 90');
    expect(specificRoleErrorCode(result.error)).toBe('WEIGHTS_MUST_SUM_TO_100');
  });

  it('rejects duplicate criterion labels case-insensitively', () => {
    const result = roleBodySchema.safeParse(
      validRoleBody({
        criteria: [
          { label: 'Communication', weight: 50 },
          { label: 'communication', weight: 50 },
        ],
      }),
    );

    // The unique constraint on (role_id, label) is case-sensitive and a person
    // is not. Without this the pair lands as a driver error instead of a message.
    expect(result.success).toBe(false);
    expect(specificRoleErrorCode(result.error)).toBe('DUPLICATE_CRITERION_LABEL');
    expect(result.error.issues[0].path).toEqual(['criteria', 1, 'label']);
  });

  it('requires at least one criterion', () => {
    // The sum-to-100 constraint trigger never fires for a role with none, so a
    // criteria-less role would slip past the database's guarantee entirely.
    expect(roleBodySchema.safeParse(validRoleBody({ criteria: [] })).success).toBe(false);
  });

  it('strips unknown keys instead of rejecting them', () => {
    const parsed = roleBodySchema.parse({ ...validRoleBody(), id: UUID, createdAt: 'yesterday' });
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('createdAt');
  });

  it('accepts every elimination rule type the scoring layer can evaluate', () => {
    const rules = [
      { label: 'Five years', type: 'min_years_experience', value: { years: 5 } },
      {
        label: 'PostgreSQL',
        type: 'required_skill',
        value: { skill: 'PostgreSQL', matchMode: 'normalized', mustBeDemonstrated: true },
      },
      {
        label: 'Degree',
        type: 'required_education_level',
        value: { level: 'bachelors' },
        onMissing: 'eliminate',
      },
      {
        label: 'RN licence',
        type: 'required_certification',
        value: { name: 'Registered Nurse', matchMode: 'normalized' },
      },
      { label: 'UK or IE', type: 'location_allowlist', value: { countryCodes: ['GB', 'IE'] } },
    ];

    const parsed = roleBodySchema.parse(validRoleBody({ eliminationRules: rules }));
    expect(parsed.eliminationRules).toHaveLength(5);
    // `onMissing` defaults to `flag`: decision 7-C says an unknown fact does not
    // eliminate unless a recruiter opted in.
    expect(parsed.eliminationRules[0].onMissing).toBe('flag');
    expect(parsed.eliminationRules[2].onMissing).toBe('eliminate');
  });

  it('refuses a rule type with no evaluator behind it', () => {
    // The union is closed on purpose (plan section 2): a rule type that reaches
    // storage without a code evaluator would throw at evaluation time.
    const result = roleBodySchema.safeParse(
      validRoleBody({
        eliminationRules: [{ label: 'Speaks French', type: 'required_language', value: { lang: 'fr' } }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('refuses a rule whose value does not match its type', () => {
    const result = roleBodySchema.safeParse(
      validRoleBody({
        eliminationRules: [
          { label: 'Five years', type: 'min_years_experience', value: { years: 'five' } },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('returns null from specificRoleErrorCode for an ordinary validation failure', () => {
    const result = roleBodySchema.safeParse(validRoleBody({ title: '' }));
    expect(result.success).toBe(false);
    expect(specificRoleErrorCode(result.error)).toBeNull();
  });
});

describe('pagination', () => {
  it('defaults to page 1 of 25', () => {
    expect(paginationQuery.parse({})).toEqual({ page: 1, pageSize: 25 });
  });

  it('coerces the strings a query string actually carries', () => {
    expect(paginationQuery.parse({ page: '3', pageSize: '10' })).toEqual({ page: 3, pageSize: 10 });
  });

  it.each(['0', '-1', '1.5', 'two'])('rejects page=%o', (page) => {
    expect(paginationQuery.safeParse({ page }).success).toBe(false);
  });

  it('caps pageSize, so one request cannot become a table scan', () => {
    expect(paginationQuery.safeParse({ pageSize: String(MAX_PAGE_SIZE) }).success).toBe(true);
    expect(paginationQuery.safeParse({ pageSize: String(MAX_PAGE_SIZE + 1) }).success).toBe(false);
  });

  it('converts a page to a limit and an offset', () => {
    expect(toLimitOffset({ page: 1, pageSize: 25 })).toEqual({ limit: 25, offset: 0 });
    expect(toLimitOffset({ page: 3, pageSize: 10 })).toEqual({ limit: 10, offset: 20 });
  });

  it('never reports zero pages', () => {
    // "Page 1 of 0" is what a client renders otherwise.
    expect(paginationMeta({ page: 1, pageSize: 25, total: 0 }).totalPages).toBe(1);
    expect(paginationMeta({ page: 1, pageSize: 25, total: 26 }).totalPages).toBe(2);
    expect(paginationMeta({ page: 1, pageSize: 25, total: 25 }).totalPages).toBe(1);
  });
});

describe('listCandidatesQuerySchema', () => {
  it('defaults to the ranked descending order', () => {
    expect(listCandidatesQuerySchema.parse({}).sort).toBe('desc');
  });

  it.each(['asc', 'desc'])('accepts sort=%s', (sort) => {
    expect(listCandidatesQuerySchema.parse({ sort }).sort).toBe(sort);
  });

  it('rejects any other sort value', () => {
    // `sort` selects one of two whole ORDER BY clauses that are interpolated
    // into SQL. The enum is what makes that interpolation safe.
    expect(listCandidatesQuerySchema.safeParse({ sort: 'match_score' }).success).toBe(false);
    expect(listCandidatesQuerySchema.safeParse({ sort: 'id; DROP TABLE candidates' }).success).toBe(
      false,
    );
  });

  it('rejects a fitCategory or status outside the column CHECK', () => {
    expect(listCandidatesQuerySchema.safeParse({ fitCategory: 'excellent' }).success).toBe(false);
    expect(listCandidatesQuerySchema.safeParse({ status: 'queued' }).success).toBe(false);
    for (const status of CANDIDATE_STATUSES) {
      expect(listCandidatesQuerySchema.safeParse({ status }).success).toBe(true);
    }
  });

  it('rejects a roleId that is not a uuid', () => {
    expect(listCandidatesQuerySchema.safeParse({ roleId: 'all' }).success).toBe(false);
  });
});

describe('the candidate status vocabulary', () => {
  it('publishes the five values the column CHECK allows, in pipeline order', () => {
    expect(CANDIDATE_STATUSES).toEqual(['pending', 'parsing', 'evaluating', 'done', 'failed']);
  });

  it('derives the terminal subset rather than listing it a second time', () => {
    // The assertion that matters is not "it equals ['done','failed']" - a second
    // literal would satisfy that on the day it was written. It is that terminal
    // and non-terminal PARTITION the vocabulary: every status is classified, no
    // status is classified twice, and the two lists between them account for
    // every value the column can hold.
    //
    // A sixth status therefore cannot be added anywhere without this failing,
    // which is the property `/config`'s `terminalStatuses` is worth publishing
    // for. A polling client stops on that list; a list that quietly missed a new
    // status would be a poll that never stops.
    const partition = [...TERMINAL_CANDIDATE_STATUSES, ...NON_TERMINAL_STATUSES];

    expect([...partition].sort()).toEqual([...CANDIDATE_STATUSES].sort());
    expect(new Set(partition).size).toBe(CANDIDATE_STATUSES.length);
  });

  it('keeps the terminal subset in the vocabulary and in its order', () => {
    expect(TERMINAL_CANDIDATE_STATUSES.every((s) => CANDIDATE_STATUSES.includes(s))).toBe(true);
    expect(TERMINAL_CANDIDATE_STATUSES).toEqual(
      CANDIDATE_STATUSES.filter((s) => TERMINAL_CANDIDATE_STATUSES.includes(s)),
    );
  });

  it('is frozen, so no caller can edit the stop condition for everybody else', () => {
    expect(Object.isFrozen(CANDIDATE_STATUSES)).toBe(true);
    expect(Object.isFrozen(TERMINAL_CANDIDATE_STATUSES)).toBe(true);
  });
});

describe('listCandidatesQuerySchema.statusIn', () => {
  it('is absent by default, so nothing changes for a caller that does not send it', () => {
    expect(listCandidatesQuerySchema.parse({}).statusIn).toBeUndefined();
  });

  it('splits, trims and validates a comma-separated set', () => {
    expect(listCandidatesQuerySchema.parse({ statusIn: 'parsing, evaluating ,failed' }).statusIn)
      .toEqual(['parsing', 'evaluating', 'failed']);
  });

  it('accepts a single value, which is the degenerate case of a set', () => {
    expect(listCandidatesQuerySchema.parse({ statusIn: 'done' }).statusIn).toEqual(['done']);
  });

  it('accepts the whole vocabulary at once', () => {
    expect(
      listCandidatesQuerySchema.parse({ statusIn: CANDIDATE_STATUSES.join(',') }).statusIn,
    ).toEqual([...CANDIDATE_STATUSES]);
  });

  it('rejects a value outside the column CHECK', () => {
    // The enum is what makes `status = ANY($n)` safe upstream: nothing that is
    // not one of five fixed strings can ever be in that array.
    expect(listCandidatesQuerySchema.safeParse({ statusIn: 'done,queued' }).success).toBe(false);
    expect(
      listCandidatesQuerySchema.safeParse({ statusIn: "done','failed') OR 1=1--" }).success,
    ).toBe(false);
  });

  it('rejects an empty list however it is spelled', () => {
    expect(listCandidatesQuerySchema.safeParse({ statusIn: '' }).success).toBe(false);
    expect(listCandidatesQuerySchema.safeParse({ statusIn: ',,' }).success).toBe(false);
    expect(listCandidatesQuerySchema.safeParse({ statusIn: ' , ' }).success).toBe(false);
  });

  it('caps the set at the number of statuses that exist', () => {
    // A repeated value is a client bug, not a reason for a bigger query. The cap
    // is the vocabulary size, so the array bound to `= ANY($n)` can never be
    // longer than the column's own CHECK - whatever the query string says.
    const atCap = Array.from({ length: CANDIDATE_STATUSES.length }, () => 'done').join(',');
    const overCap = Array.from({ length: CANDIDATE_STATUSES.length + 1 }, () => 'done').join(',');

    expect(listCandidatesQuerySchema.safeParse({ statusIn: atCap }).success).toBe(true);
    expect(listCandidatesQuerySchema.safeParse({ statusIn: overCap }).success).toBe(false);
  });

  it('coexists with the single status param, which it does not replace', () => {
    // `status` is still in the contract and still means what it meant. Both
    // filter one column and both are applied, composing with AND like every
    // other pair of filters on this endpoint.
    const parsed = listCandidatesQuerySchema.parse({ status: 'done', statusIn: 'done,failed' });

    expect(parsed.status).toBe('done');
    expect(parsed.statusIn).toEqual(['done', 'failed']);
  });
});

describe('candidateStatusesQuerySchema', () => {
  it('splits and trims a comma-separated id list', () => {
    const other = '22222222-3333-4444-8555-666666666666';
    expect(candidateStatusesQuerySchema.parse({ ids: `${UUID}, ${other} ` }).ids).toEqual([
      UUID,
      other,
    ]);
  });

  it('rejects an empty list and a list with a non-uuid in it', () => {
    expect(candidateStatusesQuerySchema.safeParse({ ids: '' }).success).toBe(false);
    expect(candidateStatusesQuerySchema.safeParse({ ids: ',,' }).success).toBe(false);
    expect(candidateStatusesQuerySchema.safeParse({ ids: `${UUID},nope` }).success).toBe(false);
  });

  it('caps the number of ids, so a poll cannot become an unbounded ANY()', () => {
    const many = Array.from({ length: 201 }, () => UUID).join(',');
    expect(candidateStatusesQuerySchema.safeParse({ ids: many }).success).toBe(false);
  });
});

describe('candidateDetailQuerySchema', () => {
  it('excludes raw text unless it is asked for explicitly', () => {
    expect(candidateDetailQuerySchema.parse({}).includeRawText).toBe(false);
    expect(candidateDetailQuerySchema.parse({ includeRawText: 'true' }).includeRawText).toBe(true);
    expect(candidateDetailQuerySchema.parse({ includeRawText: 'false' }).includeRawText).toBe(false);
  });

  it('rejects a value that is neither true nor false', () => {
    // Not coerced from "1" or "yes": a truthiness rule here decides whether an
    // entire CV goes over the wire.
    expect(candidateDetailQuerySchema.safeParse({ includeRawText: '1' }).success).toBe(false);
  });
});

describe('listRolesQuerySchema', () => {
  it('hides archived roles unless asked', () => {
    expect(listRolesQuerySchema.parse({}).includeArchived).toBe(false);
    expect(listRolesQuerySchema.parse({ includeArchived: 'true' }).includeArchived).toBe(true);
  });
});

describe('uuidParam', () => {
  it('rejects a route parameter that is not a uuid', () => {
    // Otherwise the value reaches Postgres as $1::uuid and comes back as a
    // driver error - a 500 for what is plainly a client mistake.
    expect(uuidParam.safeParse('statuses').success).toBe(false);
    expect(uuidParam.safeParse(UUID).success).toBe(true);
  });
});
