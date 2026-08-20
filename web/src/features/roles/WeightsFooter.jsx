/**
 * The sticky weights bar. Always present, three redundant signals.
 *
 * Plan section 6, and the reasoning is worth restating because it looks like
 * over-engineering until you have watched somebody use it:
 *
 * - a **proportional bar**, which answers "roughly how far off am I" at a glance;
 * - the **literal text** `Weights total 92 of 100 — 8 left to assign`, which
 *   answers "by exactly how much", and is the only one of the three that works
 *   without sight;
 * - a **glyph**, ✓ or ⚠, which is the fastest read and the one that survives a
 *   colour-blind reader and a monochrome screen.
 *
 * The text sits in an `aria-live="polite"` region, debounced, so typing into a
 * weight box does not produce a stream of announcements - one, after the typing
 * stops.
 *
 * **Save stays enabled when the total is wrong.** A disabled button with no
 * adjacent reason makes people hunt for the cause; pressing Save runs validation,
 * renders the summary, moves focus to it, and sends no request.
 */

import { useEffect, useState } from 'react';

/** Long enough that typing does not announce every keystroke, short enough to feel immediate. */
const ANNOUNCE_DEBOUNCE_MS = 400;

/**
 * @param {{ total: number, required: number }} props
 */
export function WeightsFooter({ total, required }) {
  const remaining = required - total;
  const complete = remaining === 0;
  const over = remaining < 0;

  const text = complete
    ? `Weights total ${total} of ${required} — complete`
    : over
      ? `Weights total ${total} of ${required} — ${Math.abs(remaining)} over`
      : `Weights total ${total} of ${required} — ${remaining} left to assign`;

  const [announced, setAnnounced] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setAnnounced(text), ANNOUNCE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const percent = required === 0 ? 0 : Math.min(100, Math.round((total / required) * 100));
  const fillModifier = complete ? 'ok' : over ? 'over' : 'under';

  return (
    <div className="weights-bar">
      <span aria-hidden="true" style={{ fontSize: '1.2rem' }}>
        {complete ? '✓' : '⚠'}
      </span>
      <div
        className="weights-bar__meter"
        role="progressbar"
        aria-valuenow={total}
        aria-valuemin={0}
        aria-valuemax={required}
        aria-label="Criterion weight total"
      >
        <div
          className={`weights-bar__fill weights-bar__fill--${fillModifier}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {/*
        The visible text updates immediately; the live region announces the
        debounced copy. Two nodes rather than one, because a live region that is
        also the visible text has to choose between the two, and the visible text
        should never lag.
      */}
      <span className="weights-bar__text">{text}</span>
      <span className="visually-hidden" aria-live="polite">
        {announced}
      </span>
    </div>
  );
}
