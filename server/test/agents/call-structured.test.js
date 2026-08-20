import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { SEMANTIC_RETRIES, callStructured } from '../../src/agents/client/call-structured.js';
import { MODEL_ID } from '../../src/agents/client/anthropic-client.js';
import {
  AgentBadOutputError,
  AgentInputTooLargeError,
  AgentRateLimitError,
  AgentRefusalError,
  AgentSchemaRejectedError,
  AgentTimeoutError,
  AgentUpstreamError,
} from '../../src/agents/client/errors.js';
import { fakeAnthropic } from './helpers/fake-anthropic.js';

/**
 * The failure matrix of plan section 5.4, one row at a time.
 *
 * Two rules run through the whole file and are worth stating before the cases:
 *
 * 1. **`stop_reason` is read before `parsed_output`.** A null caused by
 *    truncation wants the same request with a bigger budget; a null caused by an
 *    unsatisfiable schema wants a corrected request. By the time you are looking
 *    at the null there is nothing left to tell them apart.
 * 2. **Transport failures are never retried here.** The SDK already spent two
 *    attempts on them. Every transport test therefore asserts the call count as
 *    well as the error, because a second attempt from this layer would be a
 *    silent doubling of the bill.
 */

const ANSWER = z.object({ answer: z.string() }).strict();

const PROMPT = { system: 'you are a fixture', user: 'answer the question' };

/**
 * @param {object} [overrides]
 */
function call(overrides = {}) {
  return callStructured({
    schema: ANSWER,
    prompt: PROMPT,
    stage: 'extraction',
    effort: 'low',
    maxTokens: 1_000,
    timeoutMs: 30_000,
    ...overrides,
  });
}

const ok = { json: { answer: 'forty-two' } };

describe('the request', () => {
  it('sends the model, the schema, the effort and nothing that returns a 400', async () => {
    const client = fakeAnthropic([ok]);
    await call({ client, effort: 'high', maxTokens: 2_048, timeoutMs: 90_000 });

    const { params, options } = client.calls[0];

    expect(params.model).toBe(MODEL_ID);
    expect(params.max_tokens).toBe(2_048);
    expect(params.system).toBe(PROMPT.system);
    expect(params.messages).toEqual([{ role: 'user', content: PROMPT.user }]);
    expect(params.output_config.effort).toBe('high');
    expect(params.output_config.format.type).toBe('json_schema');

    // Each of these returns a 400 on this model family. `temperature: 0` was
    // asked for and cannot be had - see the note at the evaluation call site for
    // what replaces it.
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('top_p');
    expect(params).not.toHaveProperty('top_k');
    // Thinking is adaptive by default and `budget_tokens` is removed, so the
    // parameter is omitted entirely rather than sent as `{ type: 'adaptive' }`.
    expect(params).not.toHaveProperty('thinking');
    // Prefill returns a 400. The schema constrains the shape instead.
    expect(params.messages.every((message) => message.role === 'user')).toBe(true);
    // The deprecated top-level parameter is not used.
    expect(params).not.toHaveProperty('output_format');

    // Bounded, in milliseconds, and cancellable.
    expect(options.timeout).toBe(90_000);
    expect(options).toHaveProperty('signal');
  });

  it('returns the validated object, the attempt count and what it cost', async () => {
    const client = fakeAnthropic([{ ...ok, usage: { input_tokens: 4_500, output_tokens: 2_600 } }]);

    await expect(call({ client })).resolves.toEqual({
      data: { answer: 'forty-two' },
      attempts: 1,
      usage: { inputTokens: 4_500, outputTokens: 2_600 },
      stopReason: 'end_turn',
    });
  });

  it('treats a missing usage block as unknown rather than as zero', async () => {
    // A total that silently understates spend is worse than no total.
    const result = await call({ client: fakeAnthropic([{ ...ok, usage: null }]) });
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it('retries exactly once, and says so as a constant rather than a magic number', () => {
    expect(SEMANTIC_RETRIES).toBe(1);
  });
});

describe('truncation', () => {
  it('retries with a doubled token budget and succeeds', async () => {
    const client = fakeAnthropic([{ stopReason: 'max_tokens', text: '{"answer": "for' }, ok]);

    const result = await call({ client, maxTokens: 1_000 });

    expect(result.attempts).toBe(2);
    expect(client.calls[0].params.max_tokens).toBe(1_000);
    // The one failure where the *request* changes rather than the instruction.
    expect(client.calls[1].params.max_tokens).toBe(2_000);
    expect(client.calls[1].params.messages[0].content).toContain('CORRECTION');
    expect(client.calls[1].params.messages[0].content).toContain('cut off');
  });

  it('fails as AGENT_BAD_OUTPUT when doubling was not enough', async () => {
    const client = fakeAnthropic([
      { stopReason: 'max_tokens', text: '{"ans' },
      { stopReason: 'max_tokens', text: '{"ans' },
    ]);

    const error = await call({ client }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentBadOutputError);
    expect(error.code).toBe('AGENT_BAD_OUTPUT');
    expect(error.reason).toBe('truncated');
    expect(error.attempts).toBe(2);
    // The semantic retry has already run; a worker retry would repeat it.
    expect(error.retryable).toBe(false);
    expect(client.calls).toHaveLength(2);
  });
});

describe('output that does not validate', () => {
  it('feeds the failing paths back and accepts the correction', async () => {
    const client = fakeAnthropic([{ json: { answer: 7 } }, ok]);

    const result = await call({ client });

    expect(result.attempts).toBe(2);
    const retryText = client.calls[1].params.messages[0].content;
    expect(retryText).toContain('did not match the required schema');
    expect(retryText).toContain('answer');
    // The original request is preserved in full; the correction is appended.
    expect(retryText.startsWith(PROMPT.user)).toBe(true);
  });

  it('keeps zod messages out of the logged details but sends them to the model', async () => {
    const client = fakeAnthropic([{ json: { answer: 7 } }, { json: { answer: 7 } }]);

    const error = await call({ client }).catch((thrown) => thrown);

    expect(error.reason).toBe('schema_mismatch');
    expect(error.details.issues).toEqual([{ path: 'answer', code: 'invalid_type' }]);
    // A zod message can echo the offending value - the enum variant does - and
    // `details` goes to a log.
    expect(JSON.stringify(error.details)).not.toContain('Expected');
    expect(client.calls[1].params.messages[0].content).toContain('Expected');
  });

  it('retries text that is not JSON at all', async () => {
    const client = fakeAnthropic([{ text: 'Sure! Here is the profile you asked for.' }, ok]);

    const result = await call({ client });
    expect(result.attempts).toBe(2);
    expect(client.calls[1].params.messages[0].content).toContain('not valid JSON');
  });

  it('fails as invalid_json when the second attempt is prose too', async () => {
    const client = fakeAnthropic([{ text: 'not json' }, { text: 'still not json' }]);

    const error = await call({ client }).catch((thrown) => thrown);
    expect(error.reason).toBe('invalid_json');
  });

  it('retries a response with no text block at all', async () => {
    const client = fakeAnthropic([{ noText: true }, ok]);

    const result = await call({ client });
    expect(result.attempts).toBe(2);
    expect(client.calls[1].params.messages[0].content).toContain('no JSON object');
  });

  it('fails as no_output when the second attempt is empty too', async () => {
    const client = fakeAnthropic([{ noText: true }, { noText: true }]);

    const error = await call({ client }).catch((thrown) => thrown);
    expect(error.reason).toBe('no_output');
  });
});

describe('refusal', () => {
  it('is never retried, at either layer', async () => {
    const client = fakeAnthropic([
      {
        stopReason: 'refusal',
        stopDetails: { type: 'refusal', category: 'general_harms', explanation: 'because' },
      },
      ok,
    ]);

    const error = await call({ client }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentRefusalError);
    expect(error.code).toBe('AGENT_REFUSED');
    expect(error.retryable).toBe(false);
    // One call. Rescuing a refusal with another attempt - or another model -
    // would put non-comparable ratings into the same batch.
    expect(client.calls).toHaveLength(1);
  });

  it('keeps the policy category and drops the model-authored explanation', async () => {
    const client = fakeAnthropic([
      {
        stopReason: 'refusal',
        stopDetails: {
          type: 'refusal',
          category: 'general_harms',
          // The field most likely to quote a CV back into a log line.
          explanation: 'the document describes a person named Priya Ramanathan',
        },
      },
    ]);

    const error = await call({ client }).catch((thrown) => thrown);

    expect(error.category).toBe('general_harms');
    expect(JSON.stringify(error.toJSON())).not.toContain('Priya');
    expect(JSON.stringify(error.toJSON())).toContain('general_harms');
  });

  it('survives a refusal with no details, which is the one place they are read', async () => {
    const client = fakeAnthropic([{ stopReason: 'refusal', stopDetails: null }]);

    const error = await call({ client }).catch((thrown) => thrown);
    expect(error).toBeInstanceOf(AgentRefusalError);
    expect(error.category).toBeNull();
  });
});

describe('stop reasons that are not a finished answer', () => {
  it('reports a context overflow as an input problem, not a model problem', async () => {
    const client = fakeAnthropic([{ stopReason: 'model_context_window_exceeded' }]);

    const error = await call({ client }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentInputTooLargeError);
    expect(error.code).toBe('AGENT_INPUT_TOO_LARGE');
    expect(error.retryable).toBe(false);
    expect(error.details.inputCharacters).toBe(PROMPT.system.length + PROMPT.user.length);
    expect(client.calls).toHaveLength(1);
  });

  it('refuses to treat a paused turn as a finished one', async () => {
    const client = fakeAnthropic([{ stopReason: 'pause_turn', json: { answer: 'partial' } }, ok]);

    const error = await call({ client }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentBadOutputError);
    expect(error.reason).toBe('unsupported_stop_reason');
    expect(error.details.stopReason).toBe('pause_turn');
    // Not retried: this layer does not implement continuation, and a second
    // attempt would pause again.
    expect(client.calls).toHaveLength(1);
  });

  it('accepts a stop sequence as a completed answer', async () => {
    const client = fakeAnthropic([{ ...ok, stopReason: 'stop_sequence' }]);
    await expect(call({ client })).resolves.toMatchObject({ stopReason: 'stop_sequence' });
  });

  it('treats a missing stop reason as unfinished rather than assuming the best', async () => {
    const client = fakeAnthropic([{ ...ok, stopReason: null }]);

    const error = await call({ client }).catch((thrown) => thrown);
    expect(error.reason).toBe('unsupported_stop_reason');
    expect(error.details.stopReason).toBeNull();
  });
});

describe('transport failures, which the SDK has already retried twice', () => {
  const failWith = (error) => fakeAnthropic([{ throws: error }, ok]);

  it('passes a rate limit up with the server\'s own retry-after', async () => {
    const client = failWith(
      new Anthropic.RateLimitError(429, {}, undefined, new Headers({ 'retry-after': '30' })),
    );

    const error = await call({ client }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentRateLimitError);
    expect(error.code).toBe('AGENT_RATE_LIMIT');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(30);
    expect(client.calls).toHaveLength(1);
  });

  it('labels a dropped connection and a 5xx as worth another attempt', async () => {
    for (const thrown of [
      new Anthropic.APIConnectionError({ message: 'socket hang up' }),
      new Anthropic.InternalServerError(503, {}, undefined, new Headers()),
    ]) {
      const error = await call({ client: failWith(thrown) }).catch((caught) => caught);
      expect(error).toBeInstanceOf(AgentUpstreamError);
      expect(error.code).toBe('AGENT_UPSTREAM');
      expect(error.retryable).toBe(true);
    }
  });

  it('labels a 401 and an unclassifiable failure as not worth another attempt', async () => {
    for (const thrown of [
      new Anthropic.AuthenticationError(401, {}, undefined, new Headers()),
      new Anthropic.NotFoundError(404, {}, undefined, new Headers()),
      new Error('something nobody has classified'),
    ]) {
      const error = await call({ client: failWith(thrown) }).catch((caught) => caught);
      expect(error).toBeInstanceOf(AgentUpstreamError);
      expect(error.retryable).toBe(false);
    }
  });

  it('separates a too-large request from every other 400', async () => {
    const overflow = new Anthropic.BadRequestError(
      400,
      { type: 'error', error: { type: 'context_window_exceeded', message: 'too long' } },
      undefined,
      new Headers(),
    );
    const somethingElse = new Anthropic.BadRequestError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'bad field' } },
      undefined,
      new Headers(),
    );

    await expect(call({ client: failWith(overflow) })).rejects.toBeInstanceOf(
      AgentInputTooLargeError,
    );

    const other = await call({ client: failWith(somethingElse) }).catch((thrown) => thrown);
    expect(other).toBeInstanceOf(AgentUpstreamError);
    expect(other.details.kind).toBe('bad_request');
    expect(other.retryable).toBe(false);
  });

  describe('a 400 that rejects the schema we sent', () => {
    /** @param {string} message */
    const rejectedSchema = (message) =>
      new Anthropic.BadRequestError(
        400,
        { type: 'error', error: { type: 'invalid_request_error', message } },
        undefined,
        new Headers(),
      );

    /** The message that actually arrived, quoted exactly. */
    const REAL_MESSAGE =
      'Schemas contains too many parameters with union types (32 parameters with type ' +
      'arrays or anyOf). This causes exponential compilation cost. Reduce the number of ' +
      'nullable or union-typed parameters (limit: 16 parameters with unions).';

    /**
     * The **second** message that actually arrived, quoted exactly.
     *
     * The API enforces two independent caps, and fixing the first by trading
     * every `.nullable()` for `.optional()` walked straight into the second.
     * Nothing in the original signature list matched this prose, so a permanent
     * fault in our own schema was reported as an upstream failure - which sends
     * whoever reads the log to the network and the status page.
     */
    const REAL_OPTIONAL_MESSAGE =
      'Schemas contains too many optional parameters (31), which would make grammar ' +
      'compilation inefficient. Reduce the number of optional parameters in your tool ' +
      'schemas (limit: 24).';

    it('gives it its own code, because the fault is in this repository', async () => {
      const error = await call({ client: failWith(rejectedSchema(REAL_MESSAGE)) }).catch(
        (thrown) => thrown,
      );

      expect(error).toBeInstanceOf(AgentSchemaRejectedError);
      expect(error.code).toBe('AGENT_SCHEMA_REJECTED');
      // Never retryable. The request did not reach the model and will not until
      // somebody edits a schema; retrying spends money to fail identically.
      expect(error.retryable).toBe(false);
      expect(error.details).toMatchObject({
        stage: 'extraction',
        status: 400,
        signature: 'too_many_union_parameters',
      });
    });

    it('keeps the upstream prose out of the log line', async () => {
      // `details` records how the failure was recognised, not what upstream said
      // about it. The signature id is ours; the message is not.
      const error = await call({ client: failWith(rejectedSchema(REAL_MESSAGE)) }).catch(
        (thrown) => thrown,
      );

      expect(JSON.stringify(error.toJSON())).not.toContain('exponential');
      expect(error.message).toMatch(/configuration fault in the agent layer/);
    });

    it('recognises the optional-parameter cap as its own fault, not the union one', async () => {
      const error = await call({ client: failWith(rejectedSchema(REAL_OPTIONAL_MESSAGE)) }).catch(
        (thrown) => thrown,
      );

      expect(error).toBeInstanceOf(AgentSchemaRejectedError);
      expect(error.retryable).toBe(false);
      // Its own signature id, because the two caps send a reader to opposite
      // edits: one wants fewer nullables, the other wants fewer optionals, and
      // trading one for the other is what caused this in the first place.
      expect(error.details.signature).toBe('too_many_optional_parameters');
      expect(JSON.stringify(error.toJSON())).not.toContain('inefficient');
    });

    it.each([
      ['a reworded union limit', 'Your schema has too many union-typed parameters.'],
      ['a compilation-cost phrasing', 'This schema causes exponential compilation cost.'],
      ['an unsupported construct', 'The output schema is not supported: recursive $ref.'],
      ['a reworded optional limit', 'This schema declares too many optional parameters.'],
      ['a grammar-compilation phrasing', 'That schema would make grammar compilation slow.'],
    ])('recognises %s', async (_what, message) => {
      const error = await call({ client: failWith(rejectedSchema(message)) }).catch(
        (thrown) => thrown,
      );
      expect(error).toBeInstanceOf(AgentSchemaRejectedError);
    });

    it.each([
      ['a 400 with no schema in it at all', 'max_tokens: must be greater than 0'],
      ['a 400 that says schema but nothing this file knows', 'schema validation is enabled'],
    ])('leaves %s exactly where it was', async (_what, message) => {
      // The detection keys on upstream prose, which is fragile, so the important
      // half of the guarantee is this one: a miss costs an improvement, never a
      // behaviour. Anything unmatched is still an `AgentUpstreamError`.
      const error = await call({ client: failWith(rejectedSchema(message)) }).catch(
        (thrown) => thrown,
      );

      expect(error).toBeInstanceOf(AgentUpstreamError);
      expect(error.code).toBe('AGENT_UPSTREAM');
      expect(error.retryable).toBe(false);
    });

    it('ignores a 400 whose message is not a string', async () => {
      const malformed = new Anthropic.BadRequestError(
        400,
        { type: 'error', error: { type: 'invalid_request_error' } },
        undefined,
        new Headers(),
      );

      await expect(call({ client: failWith(malformed) })).rejects.toBeInstanceOf(
        AgentUpstreamError,
      );
    });
  });

  it('distinguishes a call timeout from a candidate deadline', async () => {
    const timedOut = await call({
      client: failWith(new Anthropic.APIConnectionTimeoutError({})),
      timeoutMs: 90_000,
    }).catch((thrown) => thrown);

    expect(timedOut).toBeInstanceOf(AgentTimeoutError);
    expect(timedOut.code).toBe('AGENT_TIMEOUT');
    expect(timedOut.retryable).toBe(true);
    expect(timedOut.details).toMatchObject({ scope: 'call', limitMs: 90_000 });

    const aborted = await call({
      client: failWith(new Anthropic.APIUserAbortError()),
      timeoutMs: 90_000,
      deadlineMs: 240_000,
    }).catch((thrown) => thrown);

    expect(aborted.details).toMatchObject({ scope: 'candidate', limitMs: 240_000 });
  });

  it('reports the call timeout when an abort arrives with no deadline stated', async () => {
    const aborted = await call({
      client: fakeAnthropic([{ throws: new Anthropic.APIUserAbortError() }]),
      timeoutMs: 45_000,
    }).catch((thrown) => thrown);

    expect(aborted.details).toMatchObject({ scope: 'candidate', limitMs: 45_000 });
  });
});

describe('the caller\'s own validation', () => {
  const rejectOnce = () => {
    let calls = 0;
    return () => {
      calls += 1;
      return calls === 1
        ? { reason: 'rejected_summary', problem: 'it stated a score', context: { patternId: 'percentage' } }
        : null;
    };
  };

  it('takes the ordinary semantic retry path', async () => {
    const client = fakeAnthropic([ok, ok]);

    const result = await call({ client, validate: rejectOnce() });

    expect(result.attempts).toBe(2);
    expect(client.calls[1].params.messages[0].content).toContain('it stated a score');
  });

  it('fails the candidate when the correction is refused too', async () => {
    const client = fakeAnthropic([ok, ok]);

    const error = await call({
      client,
      validate: () => ({
        reason: 'rejected_summary',
        problem: 'it stated a score again',
        context: { patternId: 'percentage' },
      }),
    }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentBadOutputError);
    expect(error.reason).toBe('rejected_summary');
    expect(error.details.patternId).toBe('percentage');
  });

  it('feeds its own issues back the way the schema-mismatch path feeds back zod\'s', async () => {
    const client = fakeAnthropic([ok, ok]);

    await call({
      client,
      validate: (() => {
        let first = true;
        return () => {
          if (!first) {
            return null;
          }
          first = false;
          return {
            reason: 'incomplete_evaluation',
            problem: 'two things were not rated',
            issues: [
              { path: 'ratings.c-api', message: 'no rating was returned for this criterion' },
              { path: 'ratings.c-comms', message: 'no rating was returned for this criterion' },
            ],
            context: { missingCriterionIds: ['c-api', 'c-comms'] },
          };
        };
      })(),
    });

    const retry = client.calls[1].params.messages[0].content;
    expect(retry).toContain('two things were not rated');
    expect(retry).toContain('- ratings.c-api: no rating was returned for this criterion');
    expect(retry).toContain('- ratings.c-comms: no rating was returned for this criterion');
  });

  it('lets the rule own the error it ends with, rather than flattening it here', async () => {
    // This file owns *when* to stop trying. It does not own what a caller's
    // domain failure is called: `IncompleteEvaluation` is a fact about an
    // evaluation, carries the ids somebody acts on, and would lose both if it
    // were folded into AGENT_BAD_OUTPUT on the way out.
    class RuleFailed extends Error {}
    const client = fakeAnthropic([ok, ok]);

    const error = await call({
      client,
      validate: () => ({
        reason: 'incomplete_evaluation',
        problem: 'still short',
        context: { missingCriterionIds: ['c-comms'] },
        finalError: () => new RuleFailed('the caller\'s own error'),
      }),
    }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(RuleFailed);
    expect(error).not.toBeInstanceOf(AgentBadOutputError);
    expect(client.calls).toHaveLength(2);
  });

  it('is optional, and its absence is not a branch anybody has to think about', async () => {
    await expect(call({ client: fakeAnthropic([ok]) })).resolves.toMatchObject({ attempts: 1 });
  });
});

/**
 * The unstructured path, which extraction takes.
 *
 * The point of every case here is that **nothing downstream of the response
 * changed**. The same schema validates it, the same reasons come back, the same
 * single retry is spent, and `invalid_json` was already a row in the matrix
 * before this path existed - it is what a grammar-decoded response that never
 * arrived used to look like. A second retry mechanism for "the model answered in
 * prose" would have been a second budget for the same failure.
 */
describe('asking for JSON without sending a schema', () => {
  const text = (overrides = {}) => call({ responseFormat: 'text', ...overrides });

  it('sends no format, keeps the effort, and takes messages.create', async () => {
    const client = fakeAnthropic([ok]);
    await text({ client, effort: 'low', maxTokens: 6_000, timeoutMs: 120_000 });

    const { params, options, method } = client.calls[0];

    // The change itself. A format back on this request would compile a grammar
    // and hang, which is what this whole path exists to avoid.
    expect(method).toBe('create');
    expect(params.output_config).not.toHaveProperty('format');
    expect(params).not.toHaveProperty('output_format');
    // `effort` belongs to `output_config`, not to the schema, so it survives.
    expect(params.output_config.effort).toBe('low');
    // Everything else about the request is unchanged.
    expect(params.model).toBe(MODEL_ID);
    expect(params.max_tokens).toBe(6_000);
    expect(params.system).toBe(PROMPT.system);
    expect(params.messages).toEqual([{ role: 'user', content: PROMPT.user }]);
    expect(options.timeout).toBe(120_000);
  });

  it('validates the body against the same schema and returns the same result', async () => {
    await expect(
      text({ client: fakeAnthropic([{ ...ok, usage: { input_tokens: 9, output_tokens: 8 } }]) }),
    ).resolves.toEqual({
      data: { answer: 'forty-two' },
      attempts: 1,
      usage: { inputTokens: 9, outputTokens: 8 },
      stopReason: 'end_turn',
    });
  });

  it('accepts a response the model wrapped in a code fence, without a retry', async () => {
    // The prompt forbids the fence; this is what stops the fraction of a percent
    // that arrives with one anyway from costing a whole second generation.
    const client = fakeAnthropic([{ text: '```json\n{"answer": "forty-two"}\n```' }]);

    const result = await text({ client });

    expect(result.data).toEqual({ answer: 'forty-two' });
    expect(result.attempts).toBe(1);
    expect(client.calls).toHaveLength(1);
  });

  it('sends a preamble down the ordinary invalid_json retry, not a repair path', async () => {
    // Deliberately not rescued by hunting for the first brace: a preamble is a
    // model doing something other than what it was told, and the retry says so
    // in words the model can act on.
    const client = fakeAnthropic([
      { text: 'Sure! Here is the profile:\n```json\n{"answer": "forty-two"}\n```' },
      ok,
    ]);

    const result = await text({ client });

    expect(result.attempts).toBe(2);
    expect(client.calls[1].params.messages[0].content).toContain('not valid JSON');
    // The same shared budget, not a second one.
    expect(client.calls).toHaveLength(SEMANTIC_RETRIES + 1);
  });

  it('fails as invalid_json when the second body is prose too', async () => {
    const client = fakeAnthropic([{ text: 'no JSON here' }, { text: 'still none' }]);

    const error = await text({ client }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentBadOutputError);
    expect(error.reason).toBe('invalid_json');
    expect(error.attempts).toBe(2);
    expect(client.calls).toHaveLength(2);
  });

  it('feeds zod\'s paths back exactly as the structured path does', async () => {
    const client = fakeAnthropic([{ json: { answer: 7 } }, ok]);

    const result = await text({ client });

    expect(result.attempts).toBe(2);
    const retry = client.calls[1].params.messages[0].content;
    expect(retry).toContain('did not match the required schema');
    expect(retry).toContain('answer');
  });

  it('rejects a key the schema does not define, which strict parsing now has to catch', async () => {
    // With a grammar the model could not emit `overallScore`. Without one it can,
    // and `.strict()` is what makes that a loud failure instead of a stripped key.
    const client = fakeAnthropic([
      { json: { answer: 'forty-two', overallScore: 88 } },
      { json: { answer: 'forty-two', overallScore: 88 } },
    ]);

    const error = await text({ client }).catch((thrown) => thrown);

    expect(error.reason).toBe('schema_mismatch');
    expect(error.details.issues).toEqual([{ path: '', code: 'unrecognized_keys' }]);
    // The model is told which key it invented; the log is not. A zod message
    // echoes the offending name, and `details` goes to a log line.
    expect(client.calls[1].params.messages[0].content).toContain('overallScore');
    expect(JSON.stringify(error.details)).not.toContain('overallScore');
  });

  it('retries a truncated body with a doubled budget, as it always did', async () => {
    // Worth its own case on this path: without a grammar the model has more room
    // to overrun, so this is the retry most likely to fire in practice.
    const client = fakeAnthropic([
      { stopReason: 'max_tokens', text: '{"answer": "forty-' },
      ok,
    ]);

    const result = await text({ client, maxTokens: 6_000 });

    expect(result.attempts).toBe(2);
    expect(client.calls[0].params.max_tokens).toBe(6_000);
    expect(client.calls[1].params.max_tokens).toBe(12_000);
    expect(client.calls[1].method).toBe('create');
    expect(client.calls[1].params.messages[0].content).toContain('cut off');
  });

  it('reads a response made entirely of thinking as no_output', async () => {
    const client = fakeAnthropic([{ noText: true }, { noText: true }]);

    const error = await text({ client }).catch((thrown) => thrown);

    expect(error.reason).toBe('no_output');
    expect(client.calls).toHaveLength(2);
  });

  it('never retries a refusal here either', async () => {
    const client = fakeAnthropic([
      { stopReason: 'refusal', stopDetails: { category: 'general_harms' } },
      ok,
    ]);

    const error = await text({ client }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentRefusalError);
    expect(client.calls).toHaveLength(1);
  });

  it('maps transport failures the same way, since none of that changed', async () => {
    const client = fakeAnthropic([{ throws: new Anthropic.APIConnectionTimeoutError({}) }]);

    const error = await text({ client, timeoutMs: 120_000 }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentTimeoutError);
    expect(error.details).toMatchObject({ scope: 'call', limitMs: 120_000 });
  });

  it('defaults to the schema path, so a new call site gets the stricter one', async () => {
    const client = fakeAnthropic([ok]);
    await call({ client });

    expect(client.calls[0].method).toBe('parse');
    expect(client.calls[0].params.output_config.format.type).toBe('json_schema');
  });

  it('refuses a response format nobody defined, rather than silently dropping the schema', async () => {
    // The one failure this parameter must not be able to cause quietly: a typo
    // that turns a grammar-backed call into a free-text one costs nothing at
    // request time and shows up as bad output much later.
    const client = fakeAnthropic([ok]);

    await expect(call({ client, responseFormat: 'json' })).rejects.toThrow(TypeError);
    await expect(call({ client, responseFormat: 'json' })).rejects.toThrow(/responseFormat/);
    expect(client.calls).toHaveLength(0);
  });
});

describe('logging', () => {
  it('warns once when it retries, with no prompt or response text in the line', async () => {
    const warn = vi.fn();
    const client = fakeAnthropic([{ stopReason: 'max_tokens', text: '{' }, ok]);

    await call({ client, logger: { warn } });

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, context] = warn.mock.calls[0];
    expect(message).toContain('retrying');
    expect(context).toEqual({ stage: 'extraction', attempt: 1, reason: 'truncated' });
  });

  it('says nothing at all when the first attempt is good', async () => {
    const warn = vi.fn();
    await call({ client: fakeAnthropic([ok]), logger: { warn } });
    expect(warn).not.toHaveBeenCalled();
  });
});
