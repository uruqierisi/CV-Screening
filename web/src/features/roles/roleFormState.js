/**
 * The role form's state, its validation and its request body - all pure.
 *
 * Kept out of the component because this is the part with rules in it. The
 * component renders what these functions return; these functions never touch the
 * DOM, which makes the sum-to-100 rule and the per-rule field rules testable by
 * calling a function with an object.
 *
 * ## Everything numeric comes from `/config`
 *
 * `requiredWeightSum`, `weightMin`, `weightMax`, the rule types, the enum
 * options and each rule field's `min`/`max` are arguments to these functions,
 * read from `GET /api/v1/config`. There is no `100` and no `0..60` written here.
 * The server validates all of it again; this layer exists so a recruiter is told
 * before a request is sent, not so the server can be trusted less.
 */

/**
 * A stable client-side key for a list row.
 *
 * List keys come from server ids everywhere a server id exists. Criteria and
 * rules being **created** have none yet - they do not exist server-side until
 * the form is saved - so they get a generated key that lives as long as the row
 * does. An array index would reuse a key across a delete and hand the next row
 * the previous row's input state.
 *
 * @returns {string}
 */
let keyCounter = 0;
export function nextRowKey() {
  keyCounter += 1;
  return `row-${keyCounter}`;
}

/**
 * @param {Record<string, any>} descriptor a `/config` rule descriptor
 * @returns {Record<string, any>} an empty value object for that rule type
 */
export function emptyRuleValue(descriptor) {
  const value = {};
  for (const field of descriptor.fields) {
    if (field.type === 'boolean') value[field.name] = false;
    else if (field.type === 'enum') value[field.name] = field.options[0];
    else value[field.name] = '';
  }
  return value;
}

/**
 * @param {any} config the whole `/config` payload
 * @returns {object} a form with one blank criterion carrying the whole weight
 */
export function emptyRoleForm(config) {
  return {
    title: '',
    description: '',
    criteria: [
      {
        key: nextRowKey(),
        id: null,
        label: '',
        description: '',
        // The first criterion starts at the full required sum, so a
        // single-criterion role is valid without touching the number, and the
        // footer starts at "complete" rather than at a warning.
        weight: config.scoring.requiredWeightSum,
      },
    ],
    eliminationRules: [],
  };
}

/**
 * Turns a role from `GET /roles/:id` into form state.
 *
 * The DTO and the PUT body are the same shape by design, so this is a mapping
 * rather than a translation - the only additions are the row keys and the
 * `string[]` fields flattened to a comma-separated string for a text input.
 *
 * @param {any} role
 * @param {any} config
 * @returns {object}
 */
export function roleFormFromDto(role, config) {
  return {
    title: role.title,
    description: role.description ?? '',
    criteria: role.criteria.map((criterion) => ({
      key: criterion.id,
      id: criterion.id,
      label: criterion.label,
      description: criterion.description ?? '',
      weight: criterion.weight,
    })),
    eliminationRules: role.eliminationRules.map((rule) => ({
      key: rule.id,
      id: rule.id,
      label: rule.label,
      type: rule.type,
      onMissing: rule.onMissing,
      value: fromStoredValue(rule.type, rule.value, config),
    })),
  };
}

/**
 * @param {string} type
 * @param {Record<string, any>} value
 * @param {any} config
 * @returns {Record<string, any>}
 */
function fromStoredValue(type, value, config) {
  const descriptor = config.eliminationRules.descriptors[type];
  if (!descriptor) return { ...value };
  const form = {};
  for (const field of descriptor.fields) {
    const stored = value?.[field.name];
    form[field.name] =
      field.type === 'string[]'
        ? (Array.isArray(stored) ? stored : []).join(', ')
        : (stored ?? (field.type === 'boolean' ? false : ''));
  }
  return form;
}

/**
 * The reducer. One `useReducer` for the whole form, because the pieces are not
 * independent: a criterion's weight is only meaningful against the other
 * criteria's weights.
 *
 * Every case returns new objects and new arrays. Nothing is mutated in place.
 *
 * @param {any} state
 * @param {any} action
 * @returns {any}
 */
export function roleFormReducer(state, action) {
  switch (action.type) {
    case 'replace':
      return action.form;

    case 'setField':
      return { ...state, [action.field]: action.value };

    case 'addCriterion':
      return {
        ...state,
        criteria: [
          ...state.criteria,
          { key: nextRowKey(), id: null, label: '', description: '', weight: '' },
        ],
      };

    case 'removeCriterion':
      return {
        ...state,
        criteria: state.criteria.filter((criterion) => criterion.key !== action.key),
      };

    case 'updateCriterion':
      return {
        ...state,
        criteria: state.criteria.map((criterion) =>
          criterion.key === action.key
            ? { ...criterion, [action.field]: action.value }
            : criterion,
        ),
      };

    case 'addRule':
      return {
        ...state,
        eliminationRules: [
          ...state.eliminationRules,
          {
            key: nextRowKey(),
            id: null,
            label: '',
            type: action.ruleType,
            onMissing: action.onMissing,
            value: emptyRuleValue(action.descriptor),
          },
        ],
      };

    case 'removeRule':
      return {
        ...state,
        eliminationRules: state.eliminationRules.filter((rule) => rule.key !== action.key),
      };

    case 'updateRule':
      return {
        ...state,
        eliminationRules: state.eliminationRules.map((rule) =>
          rule.key === action.key ? { ...rule, [action.field]: action.value } : rule,
        ),
      };

    case 'changeRuleType':
      return {
        ...state,
        eliminationRules: state.eliminationRules.map((rule) =>
          rule.key === action.key
            ? // A new type means new fields; carrying the old value object over
              // would leave keys the new type does not define, which the server
              // strips and the form would still render.
              { ...rule, type: action.ruleType, value: emptyRuleValue(action.descriptor) }
            : rule,
        ),
      };

    case 'updateRuleValue':
      return {
        ...state,
        eliminationRules: state.eliminationRules.map((rule) =>
          rule.key === action.key
            ? { ...rule, value: { ...rule.value, [action.field]: action.value } }
            : rule,
        ),
      };

    default:
      throw new Error(`Unknown role form action: ${action.type}`);
  }
}

/**
 * The current weight total. Derived during render, never stored - a stored total
 * is a second copy that has to be kept in step with the thing it counts.
 *
 * @param {any} state
 * @returns {number}
 */
export function weightTotal(state) {
  return state.criteria.reduce(
    (total, criterion) => total + (criterion.weight === '' ? 0 : Number(criterion.weight)),
    0,
  );
}

/**
 * Validates the whole form.
 *
 * Returns a flat list, each entry naming the field it concerns, so the same list
 * can drive both the summary at the top and the message under the control. The
 * order is the reading order of the form, which is the order the summary should
 * list them in.
 *
 * @param {any} state
 * @param {any} config
 * @returns {Array<{ field: string, message: string }>}
 */
export function validateRoleForm(state, config) {
  const { requiredWeightSum, weightMin, weightMax } = config.scoring;
  /** @type {Array<{ field: string, message: string }>} */
  const errors = [];

  if (state.title.trim().length === 0) {
    errors.push({ field: 'title', message: 'Give the role a title.' });
  } else if (state.title.trim().length > 200) {
    errors.push({ field: 'title', message: 'The title is limited to 200 characters.' });
  }

  if (state.criteria.length === 0) {
    errors.push({
      field: 'criteria',
      message: 'A role needs at least one scoring criterion, or nothing can be scored against it.',
    });
  }

  const seen = new Map();
  state.criteria.forEach((criterion) => {
    const label = criterion.label.trim();
    if (label.length === 0) {
      errors.push({ field: `criteria.${criterion.key}.label`, message: 'Give this criterion a label.' });
    } else if (label.length > 120) {
      errors.push({
        field: `criteria.${criterion.key}.label`,
        message: 'A criterion label is limited to 120 characters.',
      });
    } else {
      // Case-insensitive, matching the server: "Communication" and
      // "communication" are one criterion to a person.
      const key = label.toLocaleLowerCase();
      if (seen.has(key)) {
        errors.push({
          field: `criteria.${criterion.key}.label`,
          message: `Another criterion is already called "${seen.get(key)}". Each label must be different.`,
        });
      } else {
        seen.set(key, label);
      }
    }

    const weight = criterion.weight;
    if (weight === '' || !Number.isInteger(Number(weight))) {
      errors.push({
        field: `criteria.${criterion.key}.weight`,
        message: 'Give this criterion a whole-number weight.',
      });
    } else if (Number(weight) < weightMin || Number(weight) > weightMax) {
      errors.push({
        field: `criteria.${criterion.key}.weight`,
        message: `A weight must be between ${weightMin} and ${weightMax}.`,
      });
    }
  });

  const total = weightTotal(state);
  if (total !== requiredWeightSum) {
    errors.push({
      field: 'weights',
      message: `Criterion weights must total ${requiredWeightSum}. They currently total ${total}.`,
    });
  }

  state.eliminationRules.forEach((rule) => {
    if (rule.label.trim().length === 0) {
      errors.push({
        field: `rules.${rule.key}.label`,
        message: 'Give this elimination rule a label. It is the text shown beside an eliminated candidate.',
      });
    }

    const descriptor = config.eliminationRules.descriptors[rule.type];
    if (!descriptor) {
      errors.push({
        field: `rules.${rule.key}.type`,
        message: `This server does not define a rule type called "${rule.type}".`,
      });
      return;
    }

    for (const field of descriptor.fields) {
      errors.push(...validateRuleField(rule, field));
    }
  });

  return errors;
}

/**
 * @param {any} rule
 * @param {any} field a descriptor field from `/config`
 * @returns {Array<{ field: string, message: string }>}
 */
function validateRuleField(rule, field) {
  const path = `rules.${rule.key}.value.${field.name}`;
  const value = rule.value[field.name];

  if (field.type === 'integer') {
    if (value === '' || !Number.isInteger(Number(value))) {
      return [{ field: path, message: 'Enter a whole number.' }];
    }
    if (Number(value) < field.min || Number(value) > field.max) {
      return [{ field: path, message: `Enter a number between ${field.min} and ${field.max}.` }];
    }
    return [];
  }

  if (field.type === 'string') {
    return String(value ?? '').trim().length === 0
      ? [{ field: path, message: 'This field cannot be empty.' }]
      : [];
  }

  if (field.type === 'string[]') {
    const codes = splitCodes(String(value ?? ''));
    if (codes.length === 0) {
      return [{ field: path, message: 'List at least one country code, separated by commas.' }];
    }
    const bad = codes.filter((code) => !/^[A-Z]{2}$/.test(code));
    return bad.length > 0
      ? [
          {
            field: path,
            message: `Country codes are two letters, ISO-3166-1 alpha-2. "${bad[0]}" is not one.`,
          },
        ]
      : [];
  }

  if (field.type === 'enum') {
    return field.options.includes(value)
      ? []
      : [{ field: path, message: 'Choose one of the listed options.' }];
  }

  return [];
}

/**
 * @param {string} raw
 * @returns {string[]}
 */
export function splitCodes(raw) {
  return raw
    .split(',')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code.length > 0);
}

/**
 * The POST/PUT body.
 *
 * `position` is deliberately absent: the server takes order from the array,
 * which is what a form actually produces. `id` is absent for the same reason -
 * a PUT is a full replacement, and criteria are rewritten rather than matched up.
 *
 * @param {any} state
 * @param {any} config
 * @returns {object}
 */
export function toRoleRequestBody(state, config) {
  return {
    title: state.title.trim(),
    description: state.description.trim(),
    criteria: state.criteria.map((criterion) => ({
      label: criterion.label.trim(),
      description: criterion.description.trim(),
      weight: Number(criterion.weight),
    })),
    eliminationRules: state.eliminationRules.map((rule) => ({
      label: rule.label.trim(),
      type: rule.type,
      onMissing: rule.onMissing,
      value: toStoredValue(rule, config),
    })),
  };
}

/**
 * @param {any} rule
 * @param {any} config
 * @returns {Record<string, any>}
 */
function toStoredValue(rule, config) {
  const descriptor = config.eliminationRules.descriptors[rule.type];
  const value = {};
  for (const field of descriptor.fields) {
    const raw = rule.value[field.name];
    if (field.type === 'integer') value[field.name] = Number(raw);
    else if (field.type === 'boolean') value[field.name] = Boolean(raw);
    else if (field.type === 'string[]') value[field.name] = splitCodes(String(raw ?? ''));
    else value[field.name] = String(raw ?? '').trim();
  }
  return value;
}

/**
 * @param {Array<{ field: string, message: string }>} errors
 * @param {string} field
 * @returns {string | null}
 */
export function errorFor(errors, field) {
  const match = errors.find((error) => error.field === field);
  return match ? match.message : null;
}
