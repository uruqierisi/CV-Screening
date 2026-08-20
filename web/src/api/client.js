/**
 * The only module in this application that calls `fetch`.
 *
 * Everything else in `src/api/` is a thin named function over `request`, and
 * everything outside `src/api/` takes data as an argument. That is what makes
 * "which endpoints does this client use" answerable by reading one directory.
 *
 * ## The error envelope is a type, not a string
 *
 * The API answers `{ error: { code, message, details, requestId } }` (plan
 * section 3). All four are kept on `ApiError`:
 *
 * - `code` is what a screen branches on - `WEIGHTS_MUST_SUM_TO_100` goes next to
 *   the weights footer, `ROLE_ARCHIVED` next to the role picker.
 * - `message` was written in the repository for a person to read, so it is shown
 *   verbatim. This client never invents "Something went wrong" over the top of a
 *   message the server took the trouble to write.
 * - `requestId` is the only handle a user has when they report a problem, so it
 *   is rendered with every error, always.
 * - `status` is kept separately because the poller stops on a 404 and nothing
 *   else, and reading that off an HTTP status is more honest than matching a
 *   code string.
 */

/** Same-origin. The dev server proxies `/api` to the API (see `vite.config.js`). */
const API_BASE = '/api/v1';

/**
 * A failed request, with everything the envelope carried.
 */
export class ApiError extends Error {
  /**
   * @param {object} input
   * @param {string} input.code
   * @param {string} input.message
   * @param {number} input.status
   * @param {string | null} [input.requestId]
   * @param {unknown} [input.details]
   */
  constructor({ code, message, status, requestId = null, details = null }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.details = details;
  }
}

/**
 * A network failure, a DNS failure, a dev server with no API behind it.
 *
 * Given its own code so the UI can say "could not reach the server" rather than
 * attributing a browser-level failure to the API. There is no `requestId`,
 * because no request ever arrived - and pretending otherwise would send someone
 * looking for a log line that does not exist.
 *
 * @param {unknown} cause
 * @returns {ApiError}
 */
function unreachable(cause) {
  return new ApiError({
    code: 'NETWORK_UNREACHABLE',
    message: 'Could not reach the screening API. Check that the server is running, then try again.',
    status: 0,
    details: { cause: cause instanceof Error ? cause.message : String(cause) },
  });
}

/**
 * Builds `?a=1&b=2` from an object, dropping anything undefined or null.
 *
 * Dropping rather than sending empty is deliberate: the API's query schemas
 * default an absent parameter and reject an empty one, so `fitCategory: ''`
 * would be a 400 where "no filter" was meant.
 *
 * @param {Record<string, string | number | boolean | undefined | null>} [params]
 * @returns {string}
 */
export function toQueryString(params) {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

/**
 * One request, one parsed envelope.
 *
 * @param {string} path path under `/api/v1`, starting with `/`
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {unknown} [options.body] serialized as JSON when present
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ data: any, meta: any }>}
 * @throws {ApiError}
 */
export async function request(path, { method = 'GET', body, signal } = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    // An abort is the caller's own doing and must stay an abort: the poller
    // counts failures and an abort is not one (plan section 6).
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw unreachable(error);
  }

  const payload = await readJson(response);

  if (!response.ok) {
    const envelope = payload?.error;
    throw new ApiError({
      code: typeof envelope?.code === 'string' ? envelope.code : 'INTERNAL_ERROR',
      message:
        typeof envelope?.message === 'string' && envelope.message.length > 0
          ? envelope.message
          : `The server answered ${response.status} with no message.`,
      status: response.status,
      requestId: envelope?.requestId ?? null,
      details: envelope?.details ?? null,
    });
  }

  return { data: payload?.data, meta: payload?.meta };
}

/**
 * Reads a body that is supposed to be JSON and may not be.
 *
 * A proxy answering HTML, or a 502 from something in front of the API, is a real
 * failure mode of this exact setup. Returning null here lets the caller above
 * produce a described error instead of a `SyntaxError` from deep in the stack.
 *
 * @param {Response} response
 * @returns {Promise<any>}
 */
async function readJson(response) {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
