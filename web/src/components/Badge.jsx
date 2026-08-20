/**
 * Badges: tier, status, and the small factual markers beside them.
 *
 * Colour is never the only carrier. A tier badge is a glyph plus the tier's name
 * plus a colour, in that order of reliability - the glyph survives a monochrome
 * print, the name survives everything.
 */

import { tierPresentation } from '../lib/tiers.js';
import { candidateStatusLabel } from '../lib/candidateStatus.js';

/**
 * @param {{ modifier?: string, children: import('react').ReactNode, title?: string }} props
 */
export function Badge({ modifier = 'neutral', children, title }) {
  return (
    <span className={`badge badge--${modifier}`} title={title}>
      {children}
    </span>
  );
}

/**
 * The tier, straight from the server's `fitCategory`. Never computed here.
 *
 * @param {{ fitCategory: string | null | undefined }} props
 */
export function TierBadge({ fitCategory }) {
  const { label, glyph, modifier } = tierPresentation(fitCategory);
  return (
    <Badge modifier={modifier}>
      <span aria-hidden="true">{glyph}</span>
      {label}
    </Badge>
  );
}

/**
 * A candidate's pipeline status.
 *
 * @param {{ status: string }} props
 */
export function StatusBadge({ status }) {
  const modifier = status === 'failed' ? 'danger' : status === 'done' ? 'neutral' : 'info';
  return <Badge modifier={modifier}>{candidateStatusLabel(status)}</Badge>;
}
