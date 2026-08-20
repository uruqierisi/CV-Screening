/**
 * How a tier is displayed. **Never how a tier is decided.**
 *
 * The client does not recompute `score >= 85`. Elimination overrides score, so a
 * candidate can hold 88 points and be `unmatched`, and a client that derived the
 * tier from the number would contradict the badge sitting next to it. Tier is
 * always the server's `fitCategory` (plan section 6), and this module maps that
 * string to text, a glyph and a class name - nothing else.
 *
 * The thresholds are still shown to a recruiter, as a legend, and they come from
 * `/config`'s `scoring.tierThresholds`. `tierLegend` below formats them; it does
 * not know their values.
 */

/**
 * Presentation for each `fitCategory` the server defines.
 *
 * Tier is conveyed by text **and** glyph **and** colour, never colour alone -
 * the glyph is what survives a monochrome print and a red/green colour-blind
 * reader.
 */
const TIER_PRESENTATION = Object.freeze({
  strong_match: { label: 'Strong Match', glyph: '●', modifier: 'strong' },
  potential_match: { label: 'Potential Match', glyph: '◑', modifier: 'potential' },
  unmatched: { label: 'Unmatched', glyph: '○', modifier: 'unmatched' },
});

/**
 * @param {string | null | undefined} fitCategory
 * @returns {{ label: string, glyph: string, modifier: string }}
 */
export function tierPresentation(fitCategory) {
  return (
    TIER_PRESENTATION[/** @type {string} */ (fitCategory)] ?? {
      // A category this client has never heard of is shown as itself rather than
      // hidden or coerced into a tier. If the server grows a fourth tier, a
      // recruiter should see the new word, not a silent misfiling.
      label: String(fitCategory ?? 'Not scored'),
      glyph: '◌',
      modifier: 'unknown',
    }
  );
}

/**
 * The legend text for the tier bands, built from the server's own thresholds.
 *
 * Half-open bands (plan section 7-B): `[85, 100]`, `[65, 85)`, `[0, 65)`. The
 * numbers are arguments; the shape of the sentence is the only thing hard-coded.
 *
 * @param {{ STRONG_MATCH_MIN: number, POTENTIAL_MATCH_MIN: number }} thresholds
 * @param {number} scoreMax
 * @returns {Array<{ fitCategory: string, label: string, range: string }>}
 */
export function tierLegend(thresholds, scoreMax) {
  const strong = thresholds.STRONG_MATCH_MIN;
  const potential = thresholds.POTENTIAL_MATCH_MIN;
  return [
    {
      fitCategory: 'strong_match',
      label: TIER_PRESENTATION.strong_match.label,
      range: `${strong} to ${scoreMax}`,
    },
    {
      fitCategory: 'potential_match',
      label: TIER_PRESENTATION.potential_match.label,
      range: `${potential} up to but not including ${strong}`,
    },
    {
      fitCategory: 'unmatched',
      label: TIER_PRESENTATION.unmatched.label,
      range: `below ${potential}, or eliminated at any score`,
    },
  ];
}
