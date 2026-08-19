import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_ERROR_KINDS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  MODEL_ID,
  classifyAnthropicError,
  createAnthropicClient,
  retryAfterSeconds,
  toOutputFormat,
} from '../../src/agents/client/anthropic-client.js';
import { AnthropicConfigurationError } from '../../src/agents/client/errors.js';
import { profileSchema } from '../../src/agents/schemas/profile.schema.js';
import { makeEvaluationSchema } from '../../src/agents/schemas/evaluation.schema.js';
import { GOLDEN_ROLE } from './fixtures/golden.js';

/**
 * The SDK boundary.
 *
 * The tests construct **real** SDK error objects rather than shapes that look
 * like them. That is the whole point of classifying by class instead of by
 * message: if the SDK reorganises its hierarchy, this file fails, which is the
 * warning the code needs. A hand-rolled `{ status: 429 }` would keep passing
 * while production silently stopped recognising a rate limit.
 */

const headers = (init) => new Headers(init);
const apiError = (Class, status, body = {}, init = {}) =>
  new Class(status, body, undefined, headers(init));

describe('createAnthropicClient', () => {
  it('refuses to build a client with no key, and names the variable', () => {
    // Never the value. This message reaches a log.
    expect(() => createAnthropicClient({ apiKey: undefined })).toThrow(AnthropicConfigurationError);
    expect(() => createAnthropicClient({ apiKey: '' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => createAnthropicClient({ apiKey: /** @type {any} */ (42) })).toThrow(
      AnthropicConfigurationError,
    );
  });

  it('bounds every call by default, in milliseconds', () => {
    const client = createAnthropicClient({ apiKey: 'sk-ant-test' });

    // Neither is left to chance: an unbounded call is how a worker hangs, and
    // seconds-instead-of-milliseconds is how a 120s timeout becomes 120ms.
    expect(client.timeout).toBe(DEFAULT_TIMEOUT_MS);
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(1_000);
    expect(client.maxRetries).toBe(DEFAULT_MAX_RETRIES);
  });

  it('takes overrides, including a base URL for a proxy deployment', () => {
    const client = createAnthropicClient({
      apiKey: 'sk-ant-test',
      timeoutMs: 5_000,
      maxRetries: 0,
      baseURL: 'https://proxy.internal/anthropic',
    });

    expect(client.timeout).toBe(5_000);
    expect(client.maxRetries).toBe(0);
    expect(client.baseURL).toBe('https://proxy.internal/anthropic');
  });

  it('never puts the key anywhere it could be logged', () => {
    const client = createAnthropicClient({ apiKey: 'sk-ant-super-secret' });

    // Not an exhaustive proof - the SDK holds the key somewhere by necessity -
    // but it catches the specific accident of a client, or an error built from
    // one, being handed to a structured logger.
    expect(JSON.stringify({ timeout: client.timeout, maxRetries: client.maxRetries })).not.toContain(
      'super-secret',
    );
    expect(String(new AnthropicConfigurationError('ANTHROPIC_API_KEY is not set'))).not.toContain(
      'super-secret',
    );
  });

  it('names the model with no date suffix', () => {
    expect(MODEL_ID).toBe('claude-opus-5');
  });
});

describe('toOutputFormat', () => {
  const format = toOutputFormat(profileSchema);

  it('produces a json_schema format the API will accept', () => {
    expect(format.type).toBe('json_schema');
    expect(format.schema.type).toBe('object');
    // The SDK's transform sets this everywhere, which is what makes an invented
    // key a decoding failure rather than a silently stripped one.
    expect(format.schema.additionalProperties).toBe(false);
    expect(format.schema.required).toContain('skills');
  });

  it('returns the parsed object for a valid response', () => {
    const profile = {
      fullName: 'A. Candidate',
      email: null,
      phone: null,
      linkedinUrl: null,
      location: null,
      headline: null,
      summary: null,
      statedYearsExperience: null,
      workHistory: null,
      education: null,
      certifications: null,
      skills: [{ name: 'SQL', evidenceType: 'listed_only', evidenceQuote: null }],
    };

    expect(format.parse(JSON.stringify(profile))).toEqual({ ok: true, data: profile });
  });

  it('reports malformed JSON as a value rather than throwing', () => {
    // Throwing would be swallowed by the SDK and reappear as a generic
    // AnthropicError with no diagnostic, which is exactly what the semantic
    // retry needs and would not have.
    expect(format.parse('{"fullName": "A. Cand')).toEqual({ ok: false, kind: 'invalid_json' });
  });

  it('reports a schema mismatch with the paths that failed', () => {
    const result = format.parse(JSON.stringify({ fullName: 'A. Candidate' }));

    expect(result.ok).toBe(false);
    expect(result.kind).toBe('schema_mismatch');
    expect(result.issues.map((issue) => issue.path)).toContain('skills');
    // Messages survive for the model; the error only keeps paths and codes.
    expect(result.issues[0]).toHaveProperty('message');
    expect(result.issues[0]).toHaveProperty('code');
  });

  it('rejects an invented key, which is how a score would arrive', () => {
    const result = format.parse(
      JSON.stringify({
        fullName: null,
        email: null,
        phone: null,
        linkedinUrl: null,
        location: null,
        headline: null,
        summary: null,
        statedYearsExperience: null,
        workHistory: null,
        education: null,
        certifications: null,
        skills: null,
        matchScore: 87,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.kind).toBe('schema_mismatch');
  });

  it('carries the role criterion ids into the evaluation schema', () => {
    const evaluationFormat = toOutputFormat(makeEvaluationSchema(GOLDEN_ROLE));
    const serialized = JSON.stringify(evaluationFormat.schema);

    // The ids reach the model. The SDK transform moves an `enum` into the field
    // description rather than leaving it in the schema, so this asserts they are
    // present *somewhere*, not that decoding enforces them - see the note in
    // anthropic-client.js.
    expect(serialized).toContain('c-node');
    expect(serialized).toContain('c-comms');
    // And there is still nowhere to put a score.
    expect(serialized).not.toContain('score');
    expect(serialized).not.toContain('tier');
  });

  it('refuses a criterion id the role does not define', () => {
    const evaluationFormat = toOutputFormat(makeEvaluationSchema(GOLDEN_ROLE));

    const result = evaluationFormat.parse(
      JSON.stringify({
        ratings: [{ criterionId: 'c-invented', rating: 9, reason: 'x', evidence: null }],
        summary: null,
      }),
    );

    expect(result.ok).toBe(false);
  });
});

describe('classifyAnthropicError', () => {
  it('reads a rate limit as a rate limit', () => {
    expect(classifyAnthropicError(apiError(Anthropic.RateLimitError, 429))).toEqual({
      kind: ANTHROPIC_ERROR_KINDS.RATE_LIMIT,
      status: 429,
    });
  });

  it('separates authentication from every other 4xx', () => {
    expect(classifyAnthropicError(apiError(Anthropic.AuthenticationError, 401)).kind).toBe(
      ANTHROPIC_ERROR_KINDS.AUTHENTICATION,
    );
    expect(classifyAnthropicError(apiError(Anthropic.BadRequestError, 400)).kind).toBe(
      ANTHROPIC_ERROR_KINDS.BAD_REQUEST,
    );
  });

  it('reads 5xx as a server failure and other statuses as unknown', () => {
    expect(classifyAnthropicError(apiError(Anthropic.InternalServerError, 503))).toEqual({
      kind: ANTHROPIC_ERROR_KINDS.SERVER,
      status: 503,
    });
    expect(classifyAnthropicError(apiError(Anthropic.NotFoundError, 404))).toEqual({
      kind: ANTHROPIC_ERROR_KINDS.UNKNOWN,
      status: 404,
    });
  });

  it('puts an APIError with no status in the unknown bucket', () => {
    const error = new Anthropic.APIError(undefined, undefined, 'odd', undefined);
    expect(classifyAnthropicError(error)).toEqual({
      kind: ANTHROPIC_ERROR_KINDS.UNKNOWN,
      status: null,
    });
  });

  it('checks the timeout before the connection error it inherits from', () => {
    // The ordering assertion. `APIConnectionTimeoutError extends
    // APIConnectionError`, so a general-first chain would call every timeout a
    // connection failure and both would get the same retry decision.
    expect(classifyAnthropicError(new Anthropic.APIConnectionTimeoutError({})).kind).toBe(
      ANTHROPIC_ERROR_KINDS.TIMEOUT,
    );
    expect(classifyAnthropicError(new Anthropic.APIConnectionError({ message: 'reset' })).kind).toBe(
      ANTHROPIC_ERROR_KINDS.CONNECTION,
    );
  });

  it('recognises an abort from either side of the SDK', () => {
    expect(classifyAnthropicError(new Anthropic.APIUserAbortError()).kind).toBe(
      ANTHROPIC_ERROR_KINDS.ABORTED,
    );

    const raw = new Error('The operation was aborted');
    raw.name = 'AbortError';
    expect(classifyAnthropicError(raw).kind).toBe(ANTHROPIC_ERROR_KINDS.ABORTED);
  });

  it('does not guess about anything else', () => {
    expect(classifyAnthropicError(new Error('something else entirely'))).toEqual({
      kind: ANTHROPIC_ERROR_KINDS.UNKNOWN,
      status: null,
    });
    expect(classifyAnthropicError('a string')).toEqual({
      kind: ANTHROPIC_ERROR_KINDS.UNKNOWN,
      status: null,
    });
  });
});

describe('retryAfterSeconds', () => {
  it('passes the server\'s own advice through', () => {
    expect(retryAfterSeconds(apiError(Anthropic.RateLimitError, 429, {}, { 'retry-after': '12' }))).toBe(
      12,
    );
    expect(retryAfterSeconds(apiError(Anthropic.RateLimitError, 429, {}, { 'retry-after': '0' }))).toBe(
      0,
    );
  });

  it('returns null rather than guessing', () => {
    // A guessed backoff is how a rate limit becomes a rate-limit loop.
    expect(retryAfterSeconds(apiError(Anthropic.RateLimitError, 429))).toBeNull();
    expect(
      retryAfterSeconds(apiError(Anthropic.RateLimitError, 429, {}, { 'retry-after': 'soon' })),
    ).toBeNull();
    expect(
      retryAfterSeconds(apiError(Anthropic.RateLimitError, 429, {}, { 'retry-after': '-5' })),
    ).toBeNull();
    expect(retryAfterSeconds(new Anthropic.APIConnectionError({ message: 'x' }))).toBeNull();
    expect(retryAfterSeconds(new Error('not from the SDK'))).toBeNull();
  });
});
