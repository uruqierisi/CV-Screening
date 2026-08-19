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
