/**
 * The role configuration form, used by both `/roles/new` and `/roles/:id/edit`.
 *
 * One component for both because `PUT` is a full replacement of exactly the
 * shape `POST` takes (plan section 3), so an edit is a create with the boxes
 * pre-filled. Splitting them would be two copies of the sum-to-100 rule.
 *
 * ## Submit behaviour
 *
 * Save is **always enabled**. Pressing it validates; if anything is wrong it
 * renders the summary, moves focus to it, and sends no request. If the request
 * is sent and the server rejects it - which it can, on rules this form does not
 * duplicate - the server's own message and `requestId` are shown, and **nothing
 * the user typed is lost**. A form that clears itself on a 422 is a form nobody
 * fills in twice.
 */

import { useEffect, useReducer, useRef, useState } from 'react';
import { useConfig } from '../../config/ConfigProvider.jsx';
import { ErrorSummary } from '../../components/ErrorSummary.jsx';
import { ErrorState } from '../../components/States.jsx';
import {
  NumberField,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/Field.jsx';
import { humanizeToken } from '../../lib/format.js';
import { EliminationRuleFields } from './EliminationRuleFields.jsx';
import { WeightsFooter } from './WeightsFooter.jsx';
import {
  errorFor,
  roleFormReducer,
  toRoleRequestBody,
  validateRoleForm,
  weightTotal,
} from './roleFormState.js';

/**
 * @param {object} props
 * @param {any} props.initialForm
 * @param {string} props.submitLabel
 * @param {(body: object) => Promise<void>} props.onSubmit rejects with an ApiError
 * @param {import('react').ReactNode} [props.secondaryAction]
 */
export function RoleForm({ initialForm, submitLabel, onSubmit, secondaryAction }) {
  const config = useConfig();
  const [state, dispatch] = useReducer(roleFormReducer, initialForm);
  const [errors, setErrors] = useState(/** @type {Array<{field: string, message: string}>} */ ([]));
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState(/** @type {any} */ (null));
  const summaryRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const shouldFocusSummary = useRef(false);

  useEffect(() => {
    if (shouldFocusSummary.current && errors.length > 0) {
      summaryRef.current?.focus();
      shouldFocusSummary.current = false;
    }
  }, [errors]);

  const total = weightTotal(state);
  const ruleTypes = config.eliminationRules.types;
  const descriptors = config.eliminationRules.descriptors;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (submitting) return;

    const found = validateRoleForm(state, config);
    setErrors(found);
    if (found.length > 0) {
      shouldFocusSummary.current = true;
      return;
    }

    setServerError(null);
    setSubmitting(true);
    try {
      await onSubmit(toRoleRequestBody(state, config));
    } catch (caught) {
      setServerError(caught);
    } finally {
      // Runs even after a successful submit that navigates away; React drops the
      // update on an unmounted component, and leaving the flag set would leave a
      // permanently disabled button if navigation were ever removed.
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <ErrorSummary
        ref={summaryRef}
        title="This role cannot be saved yet"
        errors={errors}
      />

      {serverError !== null ? (
        <ErrorState
          title="The server rejected this role"
          error={serverError}
          hint="Nothing you typed has been lost. Correct the problem above and save again."
        />
      ) : null}

      <section className="panel">
        <h2>The role</h2>
        <TextField
          label="Title"
          value={state.title}
          maxLength={200}
          error={errorFor(errors, 'title')}
          disabled={submitting}
          onChange={(value) => dispatch({ type: 'setField', field: 'title', value })}
        />
        <TextAreaField
          label="Description"
          hint="What the job actually involves. This is context for a person reading the rubric; it is not sent to the model."
          value={state.description}
          maxLength={10000}
          disabled={submitting}
          onChange={(value) => dispatch({ type: 'setField', field: 'description', value })}
        />
      </section>

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Scoring criteria</h2>
            <p className="muted">
              The model rates each criterion 0 to {config.scoring.ratingMax} with a reason and a
              quote from the CV. Code multiplies each rating by the weight below and adds them up —
              the model never sees the weights and never produces the score.
            </p>
          </div>
          <button
            type="button"
            className="button"
            disabled={submitting}
            onClick={() => dispatch({ type: 'addCriterion' })}
          >
            Add criterion
          </button>
        </div>

        {errorFor(errors, 'criteria') ? (
          <p className="field__error">{errorFor(errors, 'criteria')}</p>
        ) : null}

        {state.criteria.map((criterion, index) => (
          <fieldset key={criterion.key}>
            <legend>Criterion {index + 1}</legend>
            <TextField
              label="Label"
              value={criterion.label}
              maxLength={120}
              error={errorFor(errors, `criteria.${criterion.key}.label`)}
              disabled={submitting}
              onChange={(value) =>
                dispatch({ type: 'updateCriterion', key: criterion.key, field: 'label', value })
              }
            />
            <TextAreaField
              label="What good looks like"
              hint="Shown to the model as the criterion's definition. The more concrete it is, the less the rating depends on the model's assumptions."
              value={criterion.description}
              maxLength={2000}
              disabled={submitting}
              onChange={(value) =>
                dispatch({
                  type: 'updateCriterion',
                  key: criterion.key,
                  field: 'description',
                  value,
                })
              }
            />
            <NumberField
              label="Weight"
              value={criterion.weight}
              min={config.scoring.weightMin}
              max={config.scoring.weightMax}
              hint={`Whole number, ${config.scoring.weightMin} to ${config.scoring.weightMax}. All criteria must total ${config.scoring.requiredWeightSum}.`}
              error={errorFor(errors, `criteria.${criterion.key}.weight`)}
              disabled={submitting}
              onChange={(value) =>
                dispatch({ type: 'updateCriterion', key: criterion.key, field: 'weight', value })
              }
            />
            {state.criteria.length > 1 ? (
              <button
                type="button"
                className="button button--small button--danger"
                disabled={submitting}
                onClick={() => dispatch({ type: 'removeCriterion', key: criterion.key })}
              >
                Remove criterion {index + 1}
              </button>
            ) : null}
          </fieldset>
        ))}

        <WeightsFooter total={total} required={config.scoring.requiredWeightSum} />
      </section>

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2>Elimination rules</h2>
            <p className="muted">
              Hard requirements, checked in code against the extracted CV — never by the model. A
              rule the CV positively contradicts eliminates the candidate. A rule the CV cannot
              answer is recorded as unchecked and flagged, unless you set it to eliminate.
              Eliminated candidates keep their score.
            </p>
          </div>
          <button
            type="button"
            className="button"
            disabled={submitting}
            onClick={() =>
              dispatch({
                type: 'addRule',
                ruleType: ruleTypes[0],
                descriptor: descriptors[ruleTypes[0]],
                onMissing: config.eliminationRules.onMissingModes[0],
              })
            }
          >
            Add rule
          </button>
        </div>

        {state.eliminationRules.length === 0 ? (
          <p className="muted">
            No elimination rules. Every candidate will be ranked on score alone.
          </p>
        ) : null}

        {state.eliminationRules.map((rule, index) => (
          <fieldset key={rule.key}>
            <legend>Rule {index + 1}</legend>
            <TextField
              label="Label"
              hint="Shown beside an eliminated candidate as the reason. Write it as the requirement, not as the failure."
              value={rule.label}
              maxLength={200}
              error={errorFor(errors, `rules.${rule.key}.label`)}
              disabled={submitting}
              onChange={(value) =>
                dispatch({ type: 'updateRule', key: rule.key, field: 'label', value })
              }
            />
            <div className="field-grid">
              <SelectField
                label="Requirement type"
                value={rule.type}
                options={ruleTypes.map((type) => ({
                  value: type,
                  label: descriptors[type]?.label ?? humanizeToken(type),
                }))}
                error={errorFor(errors, `rules.${rule.key}.type`)}
                disabled={submitting}
                onChange={(ruleType) =>
                  dispatch({
                    type: 'changeRuleType',
                    key: rule.key,
                    ruleType,
                    descriptor: descriptors[ruleType],
                  })
                }
              />
              <SelectField
                label="When the CV does not say"
                value={rule.onMissing}
                options={config.eliminationRules.onMissingModes.map((mode) => ({
                  value: mode,
                  label:
                    mode === 'flag'
                      ? 'Flag for review (recommended)'
                      : 'Eliminate the candidate',
                }))}
                hint="Flagging is the default because an unreadable CV is a technical failure, not a candidate's."
                disabled={submitting}
                onChange={(value) =>
                  dispatch({ type: 'updateRule', key: rule.key, field: 'onMissing', value })
                }
              />
            </div>

            {descriptors[rule.type] ? (
              <EliminationRuleFields
                rule={rule}
                descriptor={descriptors[rule.type]}
                errors={errors}
                disabled={submitting}
                onChange={(field, value) =>
                  dispatch({ type: 'updateRuleValue', key: rule.key, field, value })
                }
              />
            ) : null}

            <button
              type="button"
              className="button button--small button--danger"
              disabled={submitting}
              onClick={() => dispatch({ type: 'removeRule', key: rule.key })}
            >
              Remove rule {index + 1}
            </button>
          </fieldset>
        ))}
      </section>

      <div className="button-row">
        <button type="submit" className="button button--primary" disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </button>
        {secondaryAction}
      </div>
    </form>
  );
}
