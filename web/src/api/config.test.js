import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The two decisions `config.js` makes, both of which fail invisibly.
 *
 * A wrong `API_BASE` sends every request to the frontend's own origin, where the
 * host answers with its 404 page and the client reports "the server answered 404
 * with no message" - a message that points at the API, which never saw the
 * request. A wrong header means the three spending endpoints are refused with
 * `UPLOAD_TOKEN_INVALID`, or worse, are not protected at all.
 *
 * Both values come from `import.meta.env` and are captured at module scope, so
 * every case re-imports the module after stubbing rather than sharing one.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * @param {{ base?: string, token?: string }} env
 * @returns {Promise<typeof import('./config.js')>}
 */
async function loadConfig({ base = '', token = '' } = {}) {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', base);
  vi.stubEnv('VITE_UPLOAD_TOKEN', token);
  return import('./config.js');
}

describe('API_BASE', () => {
  it('is root-relative when no base URL is configured', async () => {
    // Development, through the Vite proxy. Nothing to configure, and the
    // client behaves exactly as it did before a deployment existed.
    const { API_BASE } = await loadConfig();

    expect(API_BASE).toBe('/api/v1');
  });

  it('joins a bare origin without inventing a slash', async () => {
    const { API_BASE } = await loadConfig({ base: 'https://api.example.com' });

    expect(API_BASE).toBe('https://api.example.com/api/v1');
  });

  it('strips a trailing slash, which is what a dashboard copies out', async () => {
    // `https://api.example.com//api/v1/config` is a 404 whose cause is invisible
    // in the address bar, so the slash is removed rather than rejected.
    const { API_BASE } = await loadConfig({ base: 'https://api.example.com/' });

    expect(API_BASE).toBe('https://api.example.com/api/v1');
  });

  it('strips several trailing slashes', async () => {
    const { API_BASE } = await loadConfig({ base: 'https://api.example.com///' });

    expect(API_BASE).toBe('https://api.example.com/api/v1');
  });
});

describe('spendingHeaders', () => {
  it('sends no header at all when no token is configured', async () => {
    // Not an empty header: a server that DOES have a token set would refuse an
    // empty one, which is a confusing way to discover a misconfiguration.
    const { spendingHeaders } = await loadConfig();

    expect(spendingHeaders()).toEqual({});
  });

  it('sends the header the API guard checks when a token is configured', async () => {
    const { spendingHeaders, UPLOAD_TOKEN_HEADER } = await loadConfig({ token: 'abc123' });

    expect(UPLOAD_TOKEN_HEADER).toBe('x-upload-token');
    expect(spendingHeaders()).toEqual({ 'x-upload-token': 'abc123' });
  });
});
