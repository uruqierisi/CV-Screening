import { describe, expect, test } from 'vitest';
import {
  emptyRoleForm,
  errorFor,
  roleFormFromDto,
  roleFormReducer,
  splitCodes,
  toRoleRequestBody,
  validateRoleForm,
  weightTotal,
} from './roleFormState.js';

/** `/config` as the server returns it, trimmed to what these functions read. */
const CONFIG = {
  scoring: { requiredWeightSum: 100, weightMin: 1, weightMax: 100, ratingMax: 10 },
  eliminationRules: {
    types: [
      'min_years_experience',
      'required_skill',
      'required_education_level',
      'required_certification',
      'location_allowlist',
    ],
    onMissingModes: ['flag', 'eliminate'],
    descriptors: {
      min_years_experience: {
        label: 'Minimum years of experience',
        fields: [{ name: 'years', type: 'integer', min: 0, max: 60 }],
      },
      required_skill: {
        label: 'Required skill',
        fields: [
          { name: 'skill', type: 'string' },
          { name: 'matchMode', type: 'enum', options: ['exact', 'normalized'] },
          { name: 'mustBeDemonstrated', type: 'boolean' },
        ],
      },
      location_allowlist: {
        label: 'Allowed locations',
        fields: [
          { name: 'countryCodes', type: 'string[]', pattern: 'ISO-3166-1 alpha-2, upper case' },
        ],
      },
    },
  },
};

/** A form that should pass every rule. */
function validForm() {
  return {
    title: 'Senior Backend Engineer',
    description: 'Payments platform.',
    criteria: [
      { key: 'a', id: null, label: 'Backend depth', description: '', weight: 60 },
      { key: 'b', id: null, label: 'Testing', description: '', weight: 40 },
    ],
    eliminationRules: [
      {
        key: 'r1',
        id: null,
        label: 'At least 5 years',
        type: 'min_years_experience',
        onMissing: 'flag',
        value: { years: 5 },
      },
    ],
  };
}

describe('emptyRoleForm', () => {
  test('starts valid: one criterion carrying the whole required weight', () => {
    const form = emptyRoleForm(CONFIG);
    expect(weightTotal(form)).toBe(CONFIG.scoring.requiredWeightSum);
    // The title is still empty, so it is not submittable - but the weights
    // footer starts at "complete" rather than at a warning nobody caused.
    expect(errorFor(validateRoleForm(form, CONFIG), 'weights')).toBeNull();
  });
});

describe('validateRoleForm', () => {
  test('a complete role has nothing wrong with it', () => {
    expect(validateRoleForm(validForm(), CONFIG)).toEqual([]);
  });

  test('weights that do not total the required sum name the total that was sent', () => {
    const form = validForm();
    form.criteria[1].weight = 32;

    const message = errorFor(validateRoleForm(form, CONFIG), 'weights');
    expect(message).toContain('100');
    expect(message).toContain('92');
  });

  test('weights over the required sum are caught too, not just under', () => {
    const form = validForm();
    form.criteria[1].weight = 60;
    expect(errorFor(validateRoleForm(form, CONFIG), 'weights')).toContain('120');
  });

  test('duplicate criterion labels are caught case-insensitively', () => {
    const form = validForm();
    form.criteria[1].label = 'backend DEPTH';

    expect(errorFor(validateRoleForm(form, CONFIG), 'criteria.b.label')).toContain(
      'Backend depth',
    );
  });

  test('an empty title is reported against the title field', () => {
    const form = { ...validForm(), title: '   ' };
    expect(errorFor(validateRoleForm(form, CONFIG), 'title')).not.toBeNull();
  });

  test('an empty weight is not read as zero', () => {
    const form = validForm();
    form.criteria[0].weight = '';

    const errors = validateRoleForm(form, CONFIG);
    expect(errorFor(errors, 'criteria.a.weight')).not.toBeNull();
  });

  test('a weight outside the configured range names the range', () => {
    const form = validForm();
    form.criteria[0].weight = 0;
    form.criteria[1].weight = 100;

    expect(errorFor(validateRoleForm(form, CONFIG), 'criteria.a.weight')).toContain('1');
  });

  test('a rule integer field is checked against the descriptor bounds, not a hard-coded pair', () => {
    const form = validForm();
    form.eliminationRules[0].value.years = 61;

    expect(errorFor(validateRoleForm(form, CONFIG), 'rules.r1.value.years')).toContain('60');
  });

  test('a country code that is not two letters is rejected and quoted back', () => {
    const form = validForm();
    form.eliminationRules = [
      {
        key: 'r2',
        id: null,
        label: 'UK or Ireland',
        type: 'location_allowlist',
        onMissing: 'eliminate',
        value: { countryCodes: 'GB, IE, Germany' },
      },
    ];

    expect(errorFor(validateRoleForm(form, CONFIG), 'rules.r2.value.countryCodes')).toContain(
      'GERMANY',
    );
  });

  test('an empty required string on a rule is caught', () => {
    const form = validForm();
    form.eliminationRules = [
      {
        key: 'r3',
        id: null,
        label: 'Needs PostgreSQL',
        type: 'required_skill',
        onMissing: 'flag',
        value: { skill: '', matchMode: 'normalized', mustBeDemonstrated: true },
      },
    ];

    expect(errorFor(validateRoleForm(form, CONFIG), 'rules.r3.value.skill')).not.toBeNull();
  });

  test('a rule type this server does not define is reported rather than sent', () => {
    const form = validForm();
    form.eliminationRules[0].type = 'required_language';

    expect(errorFor(validateRoleForm(form, CONFIG), 'rules.r1.type')).toContain(
      'required_language',
    );
  });
});

describe('toRoleRequestBody', () => {
  test('sends the shape the API takes, with no client-invented fields', () => {
    const body = toRoleRequestBody(validForm(), CONFIG);

    expect(Object.keys(body).sort()).toEqual([
      'criteria',
      'description',
      'eliminationRules',
      'title',
    ]);
    // `position` is the array order and `id` is not a client field: a PUT is a
    // full replacement, so criteria are rewritten rather than matched up.
    expect(Object.keys(body.criteria[0]).sort()).toEqual(['description', 'label', 'weight']);
    expect(Object.keys(body.eliminationRules[0]).sort()).toEqual([
      'label',
      'onMissing',
      'type',
      'value',
    ]);
  });

  test('coerces the form strings into the types the contract declares', () => {
    const form = validForm();
    form.criteria[0].weight = '60';
    form.eliminationRules = [
      {
        key: 'r4',
        id: null,
        label: 'UK only',
        type: 'location_allowlist',
        onMissing: 'eliminate',
        value: { countryCodes: 'gb, ie' },
      },
    ];

    const body = toRoleRequestBody(form, CONFIG);
    expect(body.criteria[0].weight).toBe(60);
    expect(body.eliminationRules[0].value.countryCodes).toEqual(['GB', 'IE']);
  });
});

describe('roleFormFromDto', () => {
  test('round-trips a role from the API back into a body the API accepts', () => {
    const dto = {
      id: 'role-1',
      title: 'Registered Nurse',
      description: 'ICU.',
      version: 1,
      archived: false,
      criteria: [
        { id: 'c1', label: 'Critical care', description: 'ICU time.', weight: 100, position: 0 },
      ],
      eliminationRules: [
        {
          id: 'e1',
          label: 'UK or Ireland',
          type: 'location_allowlist',
          value: { countryCodes: ['GB', 'IE'] },
          onMissing: 'eliminate',
          position: 0,
        },
      ],
    };

    const form = roleFormFromDto(dto, CONFIG);
    expect(validateRoleForm(form, CONFIG)).toEqual([]);
    expect(toRoleRequestBody(form, CONFIG).eliminationRules[0].value.countryCodes).toEqual([
      'GB',
      'IE',
    ]);
  });

  test('list keys come from server ids when the row already exists', () => {
    const dto = {
      title: 'X',
      description: '',
      criteria: [{ id: 'c1', label: 'A', description: '', weight: 100, position: 0 }],
      eliminationRules: [],
    };
    expect(roleFormFromDto(dto, CONFIG).criteria[0].key).toBe('c1');
  });
});

describe('roleFormReducer', () => {
  test('removing a criterion leaves the others' + ' keys alone', () => {
    const form = validForm();
    const next = roleFormReducer(form, { type: 'removeCriterion', key: 'a' });

    expect(next.criteria.map((criterion) => criterion.key)).toEqual(['b']);
    // The original is untouched: no case mutates in place.
    expect(form.criteria).toHaveLength(2);
  });

  test('changing a rule type replaces its value with the new type’s fields', () => {
    const form = validForm();
    const next = roleFormReducer(form, {
      type: 'changeRuleType',
      key: 'r1',
      ruleType: 'required_skill',
      descriptor: CONFIG.eliminationRules.descriptors.required_skill,
    });

    expect(next.eliminationRules[0].value).toEqual({
      skill: '',
      matchMode: 'exact',
      mustBeDemonstrated: false,
    });
    expect(next.eliminationRules[0].value.years).toBeUndefined();
  });

  test('an unknown action throws rather than silently returning the old state', () => {
    expect(() => roleFormReducer(validForm(), { type: 'nonsense' })).toThrow(/nonsense/);
  });
});

describe('splitCodes', () => {
  test('trims, upper-cases and drops the empties a trailing comma leaves', () => {
    expect(splitCodes(' gb ,ie, ,de,')).toEqual(['GB', 'IE', 'DE']);
  });
});
