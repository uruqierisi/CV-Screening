/**
 * The list of everything wrong with a form, at the top of it.
 *
 * `role="alert"` and focus moved here on a failed submit, so a keyboard or
 * screen-reader user is taken to the problem rather than left at the bottom of
 * the page wondering why the button did nothing. The messages are the same
 * strings shown under each control - one source, two places, so they cannot
 * disagree.
 */

import { forwardRef } from 'react';

export const ErrorSummary = forwardRef(
  /**
   * @param {{ title: string, errors: Array<{ field: string, message: string }> }} props
   * @param {import('react').ForwardedRef<HTMLDivElement>} ref
   */
  function ErrorSummary({ title, errors }, ref) {
    if (errors.length === 0) return null;

    return (
      <div className="state state--error" role="alert" tabIndex={-1} ref={ref}>
        <h2 className="state__title">{title}</h2>
        <ul>
          {errors.map((error) => (
            <li key={`${error.field}:${error.message}`}>{error.message}</li>
          ))}
        </ul>
      </div>
    );
  },
);
