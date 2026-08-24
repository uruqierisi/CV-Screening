/**
 * Where the API is, and what to send with a request that spends money.
 *
 * One module, imported by both `client.js` (fetch) and `uploads.js`
 * (XMLHttpRequest). Two copies of a base URL is the kind of duplication that
 * survives review and then fails in production on exactly one of the two
 * transports - which, here, would be uploads: the one path a reviewer notices.
 *
 * ## Why a base URL exists at all now
 *
 * Until the deployment, every URL in this client was root-relative and worked
 * because Vite's dev server proxied `/api` to the API. That is a property of the
 * dev server, not of this application, and it stops being true the moment the UI
 * is served from Vercel and the API from somewhere else: the browser asks
 * Vercel for `/api/v1/config`, Vercel answers with its own 404 page, and the
 * client reports "the server answered 404 with no message". No amount of CORS
 * configuration fixes that, because the request never left the frontend's
 * origin.
 *
 * A Vercel rewrite proxying `/api/*` to the API was the alternative. It would
 * keep everything same-origin and make CORS moot, but it puts 5 MB multipart
 * uploads through Vercel's edge proxy and its limits, and it hides the topology
 * from anyone reading the code. This is the honest version: two origins, and the
 * API's own allowlist doing real work.
 *
 * ## Both of these are public, and that is not a mistake
 *
 * `VITE_`-prefixed variables are **inlined into the bundle at build time**.
 * Anyone who opens devtools can read both of them. That is fine for the base
 * URL, which is a public endpoint, and it is the whole reason the README
 * describes `VITE_UPLOAD_TOKEN` as a speed bump rather than a security control:
 * it stops a crawler that finds the deployed URL from spending the API budget,
 * and it stops nothing else. Anything that actually needed protecting would need
 * a login, which this system does not have (plan section 0).
 */

/**
 * The API root.
 *
 * Empty by default, which yields the root-relative `/api/v1` this client has
 * always used - so `npm run dev` behaves exactly as before, through the Vite
 * proxy, with nothing to configure.
 *
 * A trailing slash is stripped rather than rejected: `https://api.example.com/`
 * is what a platform's dashboard copies out, and turning that into
 * `https://api.example.com//api/v1/config` would be a 404 whose cause is
 * invisible in the address bar.
 */
const ORIGIN = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

/** Every request in this client goes under here. */
export const API_BASE = `${ORIGIN}/api/v1`;

/** The header name the API's `uploadGuard` checks. */
export const UPLOAD_TOKEN_HEADER = 'x-upload-token';

/**
 * The shared secret, when one is configured.
 *
 * Absent in development and in the test suite, where the API's guard is also off
 * - so neither has to know this exists.
 */
const UPLOAD_TOKEN = import.meta.env.VITE_UPLOAD_TOKEN ?? '';

/**
 * Headers for a request to one of the three endpoints that spend API money: the
 * two uploads and retry.
 *
 * Returns an empty object when no token is configured, so a request in
 * development carries no header at all rather than an empty one - an empty
 * `x-upload-token` would be refused by the guard if the server *did* have a
 * token set, which is a confusing way to discover a misconfiguration.
 *
 * @returns {Record<string, string>}
 */
export function spendingHeaders() {
  return UPLOAD_TOKEN === '' ? {} : { [UPLOAD_TOKEN_HEADER]: UPLOAD_TOKEN };
}
