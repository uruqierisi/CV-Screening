/**
 * The boundary parse, and the response envelope.
 *
 * Two small things that belong together because they are the same rule seen from
 * both sides: nothing unparsed goes in, nothing unshaped comes out.
 */

import { validationError } from '../errors/AppError.js';

/**
 * Parses one piece of external input and throws `VALIDATION_FAILED` if it does
 * not fit.
 *
 * Every controller calls this for its params, its query and its body, and hands
 * the *result* downward. A service never receives a `request`, a `params` object
 * or anything else the framework built - it receives values that have already
 * been proven to have the shape its JSDoc claims.
 *
 * @template T
 * @param {import('zod').ZodType<T>} schema
 * @param {unknown} value
 * @param {string} [message] shown to the client; the field list is in `details`
 * @returns {T}
 * @throws {import('../errors/AppError.js').AppError} VALIDATION_FAILED
 */
export function parseOrThrow(schema, value, message) {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw validationError(result.error, message);
  }
  return result.data;
}

/**
 * The success envelope from plan section 3: `{ data, meta? }`.
 *
 * `meta` is omitted rather than sent as `null` when there is none, so a client
 * can branch on its presence.
 *
 * @template T
 * @param {T} data
 * @param {Record<string, unknown>} [meta]
 * @returns {{ data: T, meta?: Record<string, unknown> }}
 */
export function ok(data, meta) {
  return meta === undefined ? { data } : { data, meta };
}
