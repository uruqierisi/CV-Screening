/**
 * The tier filter, built from `/config`'s `fitCategories` and the counts the
 * list endpoint returns.
 *
 * The counts come from `meta.counts`, which the server computes across the whole
 * filtered set rather than the current page - a 25-row page cannot say how many
 * Strong Matches exist, and that number is the label on the control somebody is
 * about to press.
 *
 * Real `<button>`s with `aria-pressed`, not styled divs: this is a set of
 * toggles, it is reachable by Tab, and it has visible focus.
 */

import { tierPresentation } from '../../lib/tiers.js';

/**
 * @param {object} props
 * @param {string[]} props.fitCategories from `/config`
 * @param {string} props.value the active filter, or '' for all
 * @param {(next: string) => void} props.onChange
 * @param {Record<string, number> | null} props.counts from the list response's meta
 * @param {number} props.total
 */
export function TierFilter({ fitCategories, value, onChange, counts, total }) {
  return (
    <div className="field">
      <span className="field__label" id="tier-filter-label">
        Filter by tier
      </span>
      <div className="tier-filter" role="group" aria-labelledby="tier-filter-label">
        <button
          type="button"
          className="tier-filter__option"
          aria-pressed={value === ''}
          onClick={() => onChange('')}
        >
          All scored
          <span className="muted">{total}</span>
        </button>
        {fitCategories.map((category) => {
          const { label, glyph } = tierPresentation(category);
          return (
            <button
              key={category}
              type="button"
              className="tier-filter__option"
              aria-pressed={value === category}
              onClick={() => onChange(value === category ? '' : category)}
            >
              <span aria-hidden="true">{glyph}</span>
              {label}
              <span className="muted">{counts?.[category] ?? 0}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
