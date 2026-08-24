// Set BEFORE `src/` is imported. `config/env.js` parses the environment once, at
// import time, and freezes it - so the only way to exercise the hook's
// configured path is to assign here and import dynamically below. The pure
// policy function takes the token as an argument and needs none of this; it is
// the hook, which reads `env` directly, that does.
process.env.UPLOAD_ACCESS_TOKEN = 'a-deployment-secret';

const { describe, expect, it } = await import('vitest');
const { UPLOAD_TOKEN_HEADER, checkUploadToken, secretEquals, uploadTokenHook } = await import(
  '../../src/http/uploadGuard.js'
);

/**
 * The shared secret on the three endpoints that spend API money.
 *
 * The policy is a pure function of the method and the headers, so it is tested
 * as one - no server, no socket, no route table. The Fastify hook underneath it
 * has no branches of its own and is exercised at the end for the one thing it
 * does decide: throw rather than reply.
 *
 * What is being protected here is a real number. The deployment runs on an API
 * key with roughly seven screenings of credit left, and the two upload endpoints
 * plus retry are the only ways to spend it. This is not an access control and
 * the README says so; it is the difference between a crawler finding the URL and
 * a crawler emptying the account.
 */

const TOKEN = 'a-deployment-secret';

describe('when no token is configured', () => {
  it('allows everything, which is what keeps development and the suite untouched', () => {
    // The guard is opt-in. An absent `UPLOAD_ACCESS_TOKEN` is not a
    // misconfiguration - it is a developer's laptop, and it is every existing
    // test in this repository, none of which was changed to add a header.
    expect(
      checkUploadToken({ method: 'POST', headers: {}, expectedToken: undefined }),
    ).toBeNull();
  });
});

describe('when a token is configured', () => {
  it('allows a request carrying the right value', () => {
    expect(
      checkUploadToken({
        method: 'POST',
        headers: { [UPLOAD_TOKEN_HEADER]: TOKEN },
        expectedToken: TOKEN,
      }),
    ).toBeNull();
  });

  it('refuses a request with no token at all', () => {
    const failure = checkUploadToken({ method: 'POST', headers: {}, expectedToken: TOKEN });

    expect(failure?.code).toBe('UPLOAD_TOKEN_INVALID');
    // 403, not 401: there is no authentication scheme here and no principal to
    // authenticate, so 401 would oblige a `WWW-Authenticate` header describing a
    // scheme that does not exist.
    expect(failure?.status).toBe(403);
  });

  it('refuses a request with the wrong token', () => {
    expect(
      checkUploadToken({
        method: 'POST',
        headers: { [UPLOAD_TOKEN_HEADER]: 'not-the-secret' },
        expectedToken: TOKEN,
      })?.code,
    ).toBe('UPLOAD_TOKEN_INVALID');
  });

  it('refuses a repeated header rather than picking one of the values', () => {
    // A duplicated header arrives as an array. Choosing between two different
    // values would be guessing, and a client sending two does not know what it
    // is sending.
    expect(
      checkUploadToken({
        method: 'POST',
        headers: { [UPLOAD_TOKEN_HEADER]: [TOKEN, 'other'] },
        expectedToken: TOKEN,
      })?.code,
    ).toBe('UPLOAD_TOKEN_INVALID');
  });

  it('tells the client nothing it could use to guess', () => {
    const failure = checkUploadToken({ method: 'POST', headers: {}, expectedToken: TOKEN });

    // No `details`: not the expected length, not whether the header was absent
    // or merely wrong. A recruiter using the real client never sees this
    // message, so it owes an attacker nothing.
    expect(failure?.details).toBeUndefined();
    expect(failure?.message).not.toContain(TOKEN);
  });

  it('lets a CORS preflight through untouched', () => {
    // The browser sends OPTIONS precisely to ask whether it may send
    // `x-upload-token`, so by definition the preflight cannot carry it.
    // Refusing here would make every guarded cross-origin request fail before
    // the real request was ever attempted - and the browser would report it as
    // an opaque CORS error with no mention of a token, which is an afternoon
    // spent debugging the wrong layer.
    expect(
      checkUploadToken({ method: 'OPTIONS', headers: {}, expectedToken: TOKEN }),
    ).toBeNull();
  });
});

describe('the comparison', () => {
  it('is true only for identical values', () => {
    expect(secretEquals('abc', 'abc')).toBe(true);
    expect(secretEquals('abc', 'abd')).toBe(false);
  });

  it('handles values of different lengths without throwing', () => {
    // `timingSafeEqual` throws on buffers of different lengths, which would leak
    // the secret's length through an exception. Hashing both sides first makes
    // the comparison always defined, whatever arrives.
    expect(secretEquals('short', 'a-much-longer-value')).toBe(false);
    expect(secretEquals('', TOKEN)).toBe(false);
  });
});

describe('the Fastify hook', () => {
  it('throws so the central error handler owns the envelope', async () => {
    // Thrown rather than replied: `errorHandler.js` adds the `requestId` and
    // looks up the status, and a hook that sent its own response would be the
    // one place in the API answering in a different shape.
    await expect(
      uploadTokenHook(
        /** @type {any} */ ({ method: 'POST', headers: { [UPLOAD_TOKEN_HEADER]: 'wrong' } }),
        /** @type {any} */ ({}),
      ),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOKEN_INVALID' });
  });

  it('resolves quietly for a request that carries the right token', async () => {
    await expect(
      uploadTokenHook(
        /** @type {any} */ ({ method: 'POST', headers: { [UPLOAD_TOKEN_HEADER]: TOKEN } }),
        /** @type {any} */ ({}),
      ),
    ).resolves.toBeUndefined();
  });
});
