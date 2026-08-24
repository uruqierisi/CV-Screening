/**
 * Strips JSON punctuation the model copied along with a quote.
 *
 * ## Why this is needed, given that the response parses cleanly
 *
 * `evaluation.prompt.js` hands the model the profile as
 * `JSON.stringify(profile, null, 2)` inside `<profile>` tags, and asks it to
 * quote the part of the profile it relied on. A model copying a span faithfully
 * out of pretty-printed JSON can run past the end of the string value it was
 * reading and take the syntax that followed with it:
 *
 * ```
 *   evidence: 'Led the payments platform team of six engineers"},'
 * ```
 *
 * Nothing upstream catches that, and nothing upstream is wrong not to. The
 * response is valid JSON - the model escaped the inner quote correctly - and it
 * satisfies the schema, because `evidence` is `z.string().nullable()` and that
 * is a string. The fault is in the *content* of a field, which is exactly the
 * class of problem the schema cannot express and a retry would not reliably fix.
 *
 * So it is corrected deterministically here, in the same spirit as
 * `verify-evidence.js`: the model produces a claim, and code checks the part of
 * it a machine can check. This runs on every evaluation, costs nothing, and the
 * matrix is the screen a reviewer reads hardest - a trailing `"},` there reads
 * as a broken system and undermines the evidence beside it.
 *
 * ## Both columns, because it is one failure
 *
 * `reason` and `evidence` render in the same table cell, come from the same
 * prompt and quote the same JSON blob. `reason` is asked for as prose so it is
 * the less exposed of the two, but "less exposed" is not a property worth
 * relying on when the fix is the same function. The one difference is what
 * emptiness means: `evidence` is nullable and `null` is a real answer, while
 * `reason` is `z.string().min(1)` and has no empty state to fall back to - so a
 * `reason` that cleans away to nothing keeps what the model wrote. A trailing
 * brace is better than a blank cell where a justification should be.
 *
 * ## What it will not do
 *
 * It does not hunt for JSON inside the text, and it does not repair prose. Three
 * conservative passes, each with a reason to believe the characters it removes
 * were never part of the quote:
 *
 * 1. A trailing run of `}`, `]` and `,` is structure. Prose does not end that
 *    way, and a quote ending in a dangling comma was cut mid-list either way.
 * 2. A trailing `"` is removed only when the quote count is **odd**, which means
 *    it closes nothing. `he said "hi",` keeps its closing quote; a span that ran
 *    off the end of a JSON string loses the one it stole.
 * 3. Wrapping quotes are removed only when there are **exactly two** in the
 *    whole string, so `"Led the platform"` unwraps and
 *    `"hello" and later "goodbye"` is left alone.
 *
 * Anything that survives all three is returned unchanged.
 */

/** Structural characters that end a JSON value, and never end an English quote. */
const TRAILING_STRUCTURE = /[\s}\],]+$/;

/** The mirror case: a copy that began before the opening quote of a value. */
const LEADING_STRUCTURE = /^[\s{[,]+/;

/**
 * The core rule, shared by both fields.
 *
 * Returns `null` for a value that is empty once cleaned. Each caller decides
 * what that means for its own field, because the two fields disagree about it.
 *
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function stripJsonArtifacts(value) {
  if (typeof value !== 'string') return null;

  let text = value.trim();
  if (text.length === 0) return null;

  // Pass 1, then 2, then 1 again: removing an unbalanced quote can expose the
  // structure that was in front of it (`...platform"}` -> `...platform"` ->
  // `...platform`), and removing structure can expose the quote.
  text = text.replace(TRAILING_STRUCTURE, '').replace(LEADING_STRUCTURE, '');

  if (text.endsWith('"') && countQuotes(text) % 2 === 1) {
    text = text.slice(0, -1).replace(TRAILING_STRUCTURE, '');
  }

  if (text.length > 1 && text.startsWith('"') && text.endsWith('"') && countQuotes(text) === 2) {
    text = text.slice(1, -1);
  }

  const cleaned = text.trim();
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * One evidence string, cleaned.
 *
 * `null` for a value that was only punctuation, rather than an empty string: the
 * matrix already has a branch for "the model cited no evidence", and it says
 * something useful. An empty blockquote says nothing and looks like a rendering
 * fault.
 *
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function cleanEvidence(value) {
  return stripJsonArtifacts(value);
}

/**
 * One reason string, cleaned, and never emptied.
 *
 * The schema requires a non-empty reason, and there is no honest empty value to
 * substitute: a blank justification column is a worse artifact than the one
 * being removed. So a reason that cleans away to nothing keeps what the model
 * wrote, and a non-string keeps whatever it was for the schema to reject.
 *
 * @template T
 * @param {T} value
 * @returns {T | string}
 */
export function cleanReason(value) {
  if (typeof value !== 'string') return value;
  return stripJsonArtifacts(value) ?? value;
}

/**
 * The whole evaluation, with both text fields of every rating cleaned.
 *
 * Returns a new object rather than mutating: the raw response is what the retry
 * logic and the usage accounting refer to, and a function that quietly edited it
 * in place would make those two disagree about what the model said.
 *
 * @param {import('../schemas/evaluation.schema.js').Evaluation} evaluation
 * @returns {import('../schemas/evaluation.schema.js').Evaluation}
 */
export function normalizeEvaluation(evaluation) {
  return {
    ...evaluation,
    ratings: evaluation.ratings.map((rating) => ({
      ...rating,
      reason: cleanReason(rating.reason),
      evidence: cleanEvidence(rating.evidence),
    })),
  };
}

/**
 * @param {string} text
 * @returns {number}
 */
function countQuotes(text) {
  let count = 0;
  for (const character of text) {
    if (character === '"') count += 1;
  }
  return count;
}
