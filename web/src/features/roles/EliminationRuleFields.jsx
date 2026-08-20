/**
 * The value fields for one elimination rule, rendered from `/config`.
 *
 * Nothing here knows that `min_years_experience` takes a `years` between 0 and
 * 60, or that `location_allowlist` takes ISO country codes. It reads the
 * descriptor the server publishes and renders a control per field type. A sixth
 * rule type added server-side appears in this form with no change here - which
 * is the entire reason `/config` carries descriptors rather than the client
 * carrying a copy of the union.
 *
 * The one piece of judgement is the `string[]` control: a comma-separated text
 * input rather than a repeater, because the only `string[]` field in the
 * contract is a short list of two-letter codes and a repeater would be four
 * clicks to type "GB, IE, DE".
 */

import { CheckboxField, NumberField, SelectField, TextField } from '../../components/Field.jsx';
import { humanizeToken } from '../../lib/format.js';
import { errorFor } from './roleFormState.js';

/**
 * @param {object} props
 * @param {any} props.rule
 * @param {any} props.descriptor
 * @param {Array<{ field: string, message: string }>} props.errors
 * @param {(field: string, value: any) => void} props.onChange
 * @param {boolean} props.disabled
 */
export function EliminationRuleFields({ rule, descriptor, errors, onChange, disabled }) {
  return (
    <div className="field-grid">
      {descriptor.fields.map((field) => {
        const path = `rules.${rule.key}.value.${field.name}`;
        const error = errorFor(errors, path);
        const label = humanizeToken(field.name);
        const value = rule.value[field.name];

        if (field.type === 'boolean') {
          return (
            <CheckboxField
              key={field.name}
              label={
                field.name === 'mustBeDemonstrated'
                  ? 'Must be demonstrated, not just listed'
                  : label
              }
              checked={Boolean(value)}
              disabled={disabled}
              onChange={(checked) => onChange(field.name, checked)}
            />
          );
        }

        if (field.type === 'enum') {
          return (
            <SelectField
              key={field.name}
              label={label}
              value={String(value ?? field.options[0])}
              options={field.options.map((option) => ({
                value: option,
                label: humanizeToken(option),
              }))}
              error={error}
              disabled={disabled}
              onChange={(next) => onChange(field.name, next)}
            />
          );
        }

        if (field.type === 'integer') {
          return (
            <NumberField
              key={field.name}
              label={label}
              value={value === '' ? '' : Number(value)}
              min={field.min}
              max={field.max}
              hint={`${field.min} to ${field.max}`}
              error={error}
              disabled={disabled}
              onChange={(next) => onChange(field.name, next)}
            />
          );
        }

        return (
          <TextField
            key={field.name}
            label={label}
            value={String(value ?? '')}
            hint={
              field.type === 'string[]'
                ? `Comma separated. ${field.pattern ?? ''}`.trim()
                : undefined
            }
            error={error}
            disabled={disabled}
            onChange={(next) => onChange(field.name, next)}
          />
        );
      })}
    </div>
  );
}
