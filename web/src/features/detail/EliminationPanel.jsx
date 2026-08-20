/**
 * The hard requirements, and what each one actually concluded.
 *
 * It sits **above** the evaluation matrix, because elimination is categorical
 * rather than a contribution: it does not lower a score, it overrides the tier
 * entirely. Putting it below the arithmetic would suggest it is part of it.
 *
 * ## Three outcomes, three renderings, and the third one is the point
 *
 * - **pass** - the CV positively satisfies the requirement.
 * - **fail** - the CV positively contradicts it. This is the only outcome that
 *   eliminates by default.
 * - **indeterminate** - the CV could not answer. **This is not a pass.** It means
 *   the fact was absent or underdetermined, and the server's `detail` names the
 *   entry it could not resolve - the employer, the title, the start date. Showing
 *   silence here is what turns an image-only or two-column CV into a rejection
 *   with a purely technical cause, which is the failure this whole design was
 *   built to avoid.
 *
 * An indeterminate rule on a `on_missing: eliminate` policy still shows as
 * indeterminate, and says so: that candidate was removed by a recruiter's
 * standing policy, not because they were shown to fail anything.
 *
 * ## The eliminated candidate keeps their score
 *
 * The banner says the score and the rule in the same sentence - "eliminated, but
 * would have scored 88" is the entire reason the score is retained.
 */

import { formatScore } from '../../lib/format.js';
import { Badge } from '../../components/Badge.jsx';

const OUTCOME_PRESENTATION = {
  pass: { label: 'Met', glyph: '✓', modifier: 'strong' },
  fail: { label: 'Not met', glyph: '✕', modifier: 'danger' },
  indeterminate: { label: 'Could not be determined', glyph: '?', modifier: 'warn' },
};

/**
 * @param {object} props
 * @param {any} props.eliminationDetails
 * @param {boolean} props.eliminated
 * @param {string | null} props.eliminatedBy
 * @param {number | null} props.matchScore
 */
export function EliminationPanel({ eliminationDetails, eliminated, eliminatedBy, matchScore }) {
  if (!eliminationDetails) {
    return (
      <section className="panel">
        <h2>Hard requirements</h2>
        <p className="muted">
          This candidate has not been screened yet, so no requirement has been checked.
        </p>
      </section>
    );
  }

  const results = eliminationDetails.results ?? [];
  const indeterminate = eliminationDetails.indeterminate ?? [];

  return (
    <section className="panel">
      {eliminated ? (
        <div className="notice notice--danger" role="status">
          <span>
            <strong>
              <span aria-hidden="true">⊘ </span>
              Eliminated by “{eliminatedBy}”.
            </strong>{' '}
            The score below is kept and is what this candidate would have scored:{' '}
            <strong>{formatScore(matchScore)}</strong>. Elimination overrides the tier, so they are
            Unmatched regardless of it.
          </span>
        </div>
      ) : null}

      <div className="panel__head">
        <div>
          <h2>Hard requirements</h2>
          <p className="muted">
            Checked in code against the extracted CV, never by the model. Elimination requires
            positive evidence that a requirement was not met.
          </p>
        </div>
      </div>

      {results.length === 0 ? (
        <p className="muted">This role defines no hard requirements. Nothing could eliminate.</p>
      ) : (
        <ul className="rule-list">
          {results.map((rule) => {
            const presentation = OUTCOME_PRESENTATION[rule.outcome] ?? {
              label: rule.outcome,
              glyph: '•',
              modifier: 'neutral',
            };
            return (
              <li key={rule.ruleId} className={`rule-item rule-item--${rule.outcome}`}>
                <span className="rule-item__label">{rule.label}</span>
                <p style={{ margin: 'var(--space-1) 0' }}>
                  <Badge modifier={presentation.modifier}>
                    <span aria-hidden="true">{presentation.glyph}</span>
                    {presentation.label}
                  </Badge>{' '}
                  {rule.eliminates ? <Badge modifier="danger">Eliminates</Badge> : null}
                </p>
                <p style={{ margin: 0 }}>{rule.detail}</p>
                {rule.outcome === 'indeterminate' ? (
                  <p className="muted" style={{ marginTop: 'var(--space-2)', marginBottom: 0 }}>
                    {rule.onMissing === 'eliminate'
                      ? 'This rule is set to eliminate when the CV cannot answer it, so this candidate was removed by that policy rather than by anything the CV showed.'
                      : 'This rule is set to flag rather than eliminate, so the candidate was kept and this requirement is simply unchecked. It is not a pass.'}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {indeterminate.length > 0 && !eliminated ? (
        <div className="notice notice--warn" style={{ marginTop: 'var(--space-4)' }}>
          <span>
            {indeterminate.length === 1
              ? 'One requirement could not be checked against this CV'
              : `${indeterminate.length} requirements could not be checked against this CV`}
            . They are flagged rather than failed, so this candidate needs a human to confirm them.
          </span>
        </div>
      ) : null}
    </section>
  );
}
