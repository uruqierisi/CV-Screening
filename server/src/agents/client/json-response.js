/**
 * Turning a block of model text into a validated object, or into a diagnosis.
 *
 * This file exists because the two model calls in this system no longer get
 * their JSON the same way, and they must still fail the same way.
 *
 * - **Evaluation** sends `output_config.format`, so the API decodes against a
 *   grammar and the SDK hands back `parsed_output`.
 * - **Extraction** sends no schema at all (plan section 5.2). The model is asked
 *   for JSON in the response body and the body is parsed here.
 *
 * Everything downstream of this file is identical for both. One zod schema, one
 * discriminated result, one failure taxonomy, one shared semantic retry. The
 * difference between the two calls is confined to *where the text came from*,
 * which is the smallest place it could possibly live.
 *
 * Nothing here imports the SDK, and nothing here is I/O. It is a pair of pure
 * functions over a string.
 *
 * ## Why a result instead of an exception
 *
 * A response that does not parse is an **expected** outcome of asking a
 * probabilistic system for JSON, not an exceptional one. Returning a
 * discriminated value lets `call-structured.js` read the zod issues, feed them
 * back to the model in the one retry it is allowed, and name their paths in an
 * error - none of which survives a `throw` inside somebody else's `try`.
 */

/**
 * @typedef {{ ok: true, data: unknown }
 *   | { ok: false, kind: 'invalid_json' }
 *   | { ok: false, kind: 'schema_mismatch', issues: { path: string, code: string, message: string }[] }
 * } StructuredParseResult
 */

/**
 * A response the model wrapped in a markdown fence, unwrapped.
 *
 * **The prompt already forbids this, and it is stripped anyway.** Those are not
 * in tension: the prompt is the control that works nearly all the time, and this
 * is the two lines that stop the remaining fraction of a percent from costing a
 * whole extra generation. A model told "no code fences" mostly obeys and
 * occasionally reaches for the habit anyway, and burning the single semantic
 * retry on three backticks would be a bad trade against real money.
 *
 * **Only a fence at the very start is recognised**, and that boundary is the
 * whole design of this function. A fence is a wrapper with no content of its
 * own, so removing it loses nothing. A *preamble* - "Sure! Here is the profile:"
 * - is different in kind: it is the model doing something other than what it was
 * asked, and quietly hunting for the first `{` inside it would repair the symptom
 * of a drifting model while hiding the drift. That case stays `invalid_json`,
 * takes the retry with the correction attached, and shows up in the logs.
 *
 * Returns the input **unchanged** when there is no leading fence, so ordinary
 * prose reaches `JSON.parse` exactly as the model wrote it.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripCodeFences(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return text;
  }

  // The opening fence and its optional info string (```json, ```JSON, ```jsonc).
  const withoutOpening = trimmed.replace(/^```[\w-]*[ \t]*\r?\n?/, '');
  // The closing fence, if there is one. There is not when a fenced response was
  // also cut off - `stop_reason` has already caught that, and stripping what is
  // there is still the best available attempt.
  return withoutOpening.replace(/\r?\n?[ \t]*```[ \t]*$/, '');
}

/**
 * The text blocks of a response, joined.
 *
 * Joined rather than "the first one", because a response is a list of blocks and
 * thinking blocks sit in the same list; taking `content[0]` would read a
 * thinking block on the calls that produce one. Filtering by `type` is the only
 * thing that is stable.
 *
 * `null` when there is no text at all - an empty content array, or a response
 * made entirely of thinking. That is the same fact `parsed_output: null` states
 * on the structured path, so both arrive at the same `no_output` branch.
 *
 * @param {any} message
 * @returns {string | null}
 */
export function messageText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const text = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');

  return text.length === 0 ? null : text;
}

/**
 * Parse, then validate. Never both at once, because the two failures need
 * different answers from the retry.
 *
 * @param {{ safeParse: (value: unknown) => { success: boolean, data?: any, error?: any } }} schema
 * @param {string} content
 * @returns {StructuredParseResult}
 */
export function parseJsonResponse(schema, content) {
  /** @type {unknown} */
  let json;
  try {
    json = JSON.parse(content);
  } catch {
    // On the structured path this is almost always truncation, and `stop_reason`
    // has already said so definitively. On the unstructured path it is the
    // model answering in prose, which is exactly what the retry notice tells it
    // not to do.
    return { ok: false, kind: 'invalid_json' };
  }

  const result = schema.safeParse(json);
  if (result.success) {
    return { ok: true, data: result.data };
  }

  return {
    ok: false,
    kind: 'schema_mismatch',
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: String(issue.code),
      message: issue.message,
    })),
  };
}

/**
 * The whole unstructured path in one function: take the response the API
 * returned, find its text, defend against a fence, validate against the schema.
 *
 * `null` means there was nothing to parse, which the caller reads as
 * `no_output` - the identical branch a null `parsed_output` takes.
 *
 * @param {{ safeParse: (value: unknown) => { success: boolean, data?: any, error?: any } }} schema
 * @param {any} message
 * @returns {StructuredParseResult | null}
 */
export function parseMessageJson(schema, message) {
  const text = messageText(message);
  if (text === null) {
    return null;
  }

  return parseJsonResponse(schema, stripCodeFences(text));
}
