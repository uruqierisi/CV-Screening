/**
 * The loading state. Always labelled, never a bare animation.
 *
 * The label is a real element rather than an `aria-label` on a decorative div:
 * a sighted user waiting on a slow LLM call benefits from "Screening candidates"
 * exactly as much as a screen reader user does.
 */

/**
 * @param {{ label: string }} props
 */
export function Spinner({ label }) {
  return (
    <p className="spinner" role="status">
      <span className="spinner__mark" aria-hidden="true" />
      <span>{label}</span>
    </p>
  );
}
