import { describe, expect, it } from 'vitest';
import { NetworkAccessInTestError } from '../setup/no-network.js';
import { classifyAnthropicError, createAnthropicClient } from '../../src/agents/client/anthropic-client.js';
import { AnthropicConfigurationError } from '../../src/agents/client/errors.js';

/**
 * Proof that the tripwire fires.
 *
 * A guard nobody has watched fail is not a guard - it is a comment with a
 * `beforeEach`. Three levels of proof, each stronger than the last:
 *
 * 1. a direct `fetch` is refused;
 * 2. a **real** Anthropic client, constructed here with a fake key, is refused
 *    when it tries to send a request. That is the path a mistake would actually
 *    take: somebody constructs a client in a test instead of injecting one;
 * 3. the failure names the caller, so the report tells whoever hits it what to
 *    do instead.
 *
 * If this file ever passes for the wrong reason - because `fetch` was left
 * unarmed, say - the second test is the one that notices, because a real request
 * to api.anthropic.com would then either hang or spend money.
 */

describe('the network tripwire', () => {
  it('refuses a direct fetch', async () => {
    await expect(async () => fetch('https://api.anthropic.com/v1/messages')).rejects.toThrow(
      NetworkAccessInTestError,
    );
  });

  it('refuses a real SDK client that tries to send a request', async () => {
    // A genuine client, a genuine request, no module mocking anywhere. The key
    // is obvious nonsense and is never transmitted, because nothing gets that
    // far.
    const client = createAnthropicClient({
      apiKey: 'sk-ant-not-a-real-key-for-tests',
      timeoutMs: 1_000,
      // Zero, so the SDK does not spend three attempts and two backoffs proving
      // the same point.
      maxRetries: 0,
    });

    const thrown = await client.messages
      .create({
        model: 'claude-opus-5',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'this must never leave the machine' }],
      })
      .then(
        () => null,
        (error) => error,
      );

    // The SDK wraps a transport failure in its own `APIConnectionError`, so the
    // proof that the tripwire is what stopped it lives on the cause chain. That
    // is also the honest shape of the assertion: the request was refused at the
    // socket, not intercepted somewhere friendlier.
    expect(thrown).not.toBeNull();
    expect(thrown.constructor.name).toBe('APIConnectionError');
    expect(thrown.cause).toBeInstanceOf(NetworkAccessInTestError);
    expect(thrown.cause.target).toContain('api.anthropic.com');
    // And our own classifier reads it as what it is, which is the same path a
    // real dropped connection would take through `call-structured.js`.
    expect(classifyAnthropicError(thrown)).toEqual({ kind: 'connection', status: null });
  });

  it('names the target and says what to do instead', () => {
    // Thrown synchronously rather than returned as a rejected promise, so that a
    // stray call reports at the call site instead of as an unhandled rejection
    // three ticks later.
    let error;
    try {
      fetch('https://example.invalid/anything');
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(NetworkAccessInTestError);
    expect(error.target).toBe('https://example.invalid/anything');
    expect(error.message).toContain('takes');
    expect(error.message).toContain('injection');
  });

  it('is re-armed between tests, so one test cannot disarm the next', () => {
    // Stubbing the global here is the exact mistake the `beforeEach` in the setup
    // file exists to contain. The next test gets the tripwire back.
    globalThis.fetch = /** @type {any} */ (async () => ({ ok: true }));
    expect(typeof globalThis.fetch).toBe('function');
  });

  it('has the tripwire back after the previous test replaced it', () => {
    expect(() => fetch('https://api.anthropic.com/v1/messages')).toThrow(NetworkAccessInTestError);
  });

  it('will not even build a client without a key, so a stray one cannot call out', () => {
    expect(() => createAnthropicClient({ apiKey: undefined })).toThrow(AnthropicConfigurationError);
    expect(() => createAnthropicClient({ apiKey: '   ' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => createAnthropicClient()).toThrow(AnthropicConfigurationError);
  });
});
