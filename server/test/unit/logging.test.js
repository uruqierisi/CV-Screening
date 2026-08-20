import { describe, expect, it } from 'vitest';
import { REDACTED_LOG_PATHS, toAgentLogger } from '../../src/util/logging.js';

/**
 * The logging seam.
 *
 * Small, and load-bearing twice: once because the two logger interfaces take
 * their arguments in opposite orders, and once because redaction is configured
 * here rather than remembered at each call site.
 */

describe('toAgentLogger', () => {
  it('flips the argument order pino and the agent layer disagree about', () => {
    /** @type {any[]} */
    const calls = [];
    const pinoish = { warn: (mergingObject, message) => calls.push([mergingObject, message]) };

    // The agent layer calls warn(message, context): a pure function warning about
    // input it dropped has a sentence to say and some ids to attach.
    toAgentLogger(pinoish).warn('dropped a rating for an unknown criterion', { criterionId: 'c9' });

    expect(calls).toEqual([[{ criterionId: 'c9' }, 'dropped a rating for an unknown criterion']]);
  });

  it('supplies an empty context when the caller passes none', () => {
    /** @type {any[]} */
    const calls = [];
    toAgentLogger({ warn: (a, b) => calls.push([a, b]) }).warn('something happened');
    expect(calls).toEqual([[{}, 'something happened']]);
  });

  it('swallows warnings when there is no logger to hand', () => {
    // Every agent-layer function has to stay callable without one.
    expect(() => toAgentLogger(undefined).warn('x', {})).not.toThrow();
    expect(() => toAgentLogger(/** @type {any} */ ({})).warn('x', {})).not.toThrow();
    expect(() => toAgentLogger(/** @type {any} */ ({ warn: 'not a function' })).warn('x')).not.toThrow();
  });
});

describe('REDACTED_LOG_PATHS', () => {
  it('covers every header and field a credential reaches this process through', () => {
    expect(REDACTED_LOG_PATHS).toContain('req.headers.authorization');
    expect(REDACTED_LOG_PATHS).toContain('req.headers["x-api-key"]');
    // An SDK options object serialized whole is how an API key usually escapes.
    expect(REDACTED_LOG_PATHS).toContain('apiKey');
    expect(REDACTED_LOG_PATHS).toContain('*.apiKey');
    expect(REDACTED_LOG_PATHS).toContain('ANTHROPIC_API_KEY');
  });

  it('is frozen, so no module can quietly remove a path', () => {
    expect(Object.isFrozen(REDACTED_LOG_PATHS)).toBe(true);
  });
});
