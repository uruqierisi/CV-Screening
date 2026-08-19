import { describe, expect, it, vi } from 'vitest';
import {
  EVALUATION_EFFORT,
  EVALUATION_MAX_TOKENS,
  EVALUATION_TIMEOUT_MS,
  evaluateCandidate,
} from '../../src/agents/evaluation/evaluate-candidate.js';
import { AgentBadOutputError } from '../../src/agents/client/errors.js';
import { IncompleteEvaluationError, InvalidRoleError } from '../../src/agents/errors.js';
import { fakeAnthropic } from './helpers/fake-anthropic.js';
import { GOLDEN_EVALUATION, GOLDEN_PROFILE, GOLDEN_ROLE } from './fixtures/golden.js';

/**
 * The judging call. Three properties are load-bearing and each has its own
 * section: what the model is not shown, that it cannot report a number, and that
 * a summary which states one is refused.
 */

const evaluate = (client, overrides = {}) =>
  evaluateCandidate({ client, role: GOLDEN_ROLE, profile: GOLDEN_PROFILE, ...overrides });

const ok = { json: GOLDEN_EVALUATION };

describe('the call', () => {
  it('uses the settings the plan specifies for a judgement task', async () => {
    const client = fakeAnthropic([ok]);
    await evaluate(client);

    // High effort: this is the one place in the pipeline where paying for more
    // reasoning buys something a human will read.
    expect(EVALUATION_EFFORT).toBe('high');
    expect(client.calls[0].params.output_config.effort).toBe('high');
    expect(client.calls[0].params.max_tokens).toBe(EVALUATION_MAX_TOKENS);
    expect(EVALUATION_TIMEOUT_MS).toBe(90_000);
    expect(client.calls[0].options.timeout).toBe(90_000);
  });

  it('sends no sampling parameters, because this model family rejects them', async () => {
    // `temperature: 0` was asked for and returns a 400 here. What replaces it is
    // documented at the call site: effort controls variance, and determinism
    // lives in `scoring/`.
    const client = fakeAnthropic([ok]);
    await evaluate(client);

    for (const removed of ['temperature', 'top_p', 'top_k', 'thinking']) {
      expect(client.calls[0].params, removed).not.toHaveProperty(removed);
    }
  });

  it('rejects a role it cannot score against before spending anything', async () => {
    const client = fakeAnthropic([]);
    const broken = { ...GOLDEN_ROLE, criteria: GOLDEN_ROLE.criteria.slice(0, 2) };

    await expect(evaluate(client, { role: broken })).rejects.toBeInstanceOf(InvalidRoleError);
    expect(client.calls).toHaveLength(0);
  });
});

describe('what the model is not shown', () => {
  it('withholds the weights, the rules and the raw CV', async () => {
    const client = fakeAnthropic([ok]);
    await evaluate(client);

    const { system, messages } = client.calls[0].params;
    const sent = `${system}\n${messages[0].content}`;

    for (const criterion of GOLDEN_ROLE.criteria) {
      expect(sent).toContain(criterion.id);
      expect(sent).toContain(criterion.label);
    }
    // No weight reaches the prompt - the criteria are projected field by field,
    // so one cannot arrive inside an object somebody spread.
    expect(messages[0].content).not.toMatch(/weight/i);
    expect(sent).not.toMatch(/eliminat/i);
    expect(sent).not.toContain('cutting p99 latency from 1.8s to 240ms');
  });

  it('redacts the candidate before the profile reaches the prompt', async () => {
    const client = fakeAnthropic([ok]);
    await evaluate(client);

    const sent = client.calls[0].params.messages[0].content;
    expect(sent).not.toContain('Priya Ramanathan');
    expect(sent).not.toContain('priya.ramanathan@example.com');
    expect(sent).toContain('"fullName": null');
    // And the signal the criteria are actually about is all still there.
    expect(sent).toContain('University of Leeds');
    expect(sent).toContain('Northwind Logistics');
  });

  it('does not redact the caller\'s copy', async () => {
    const profile = { ...GOLDEN_PROFILE };
    await evaluate(fakeAnthropic([ok]), { profile });

    expect(profile.fullName).toBe('Priya Ramanathan');
    expect(GOLDEN_PROFILE.email).toBe('priya.ramanathan@example.com');
  });
});

describe('what the model cannot report', () => {
  it('has nowhere to put a score, so an invented one fails validation', async () => {
    const client = fakeAnthropic([
      { json: { ...GOLDEN_EVALUATION, matchScore: 87 } },
      { json: { ...GOLDEN_EVALUATION, matchScore: 87 } },
    ]);

    const error = await evaluate(client).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentBadOutputError);
    expect(error.reason).toBe('schema_mismatch');
  });

  it('discards a rating for a criterion the role does not define', async () => {
    const client = fakeAnthropic([
      {
        json: {
          ...GOLDEN_EVALUATION,
          ratings: [
            ...GOLDEN_EVALUATION.ratings,
            { criterionId: 'c-invented', rating: 10, reason: 'x', evidence: null },
          ],
        },
      },
      { json: GOLDEN_EVALUATION },
    ]);

    // Constrained by the schema's dynamic enum: the first response is refused
    // and the retry is clean.
    const { evaluation, diagnostics } = await evaluate(client);
    expect(diagnostics.attempts).toBe(2);
    expect(evaluation.ratings).toHaveLength(6);
  });

  it('returns the ratings verbatim, in whatever order they arrived', async () => {
    const shuffled = { ...GOLDEN_EVALUATION, ratings: [...GOLDEN_EVALUATION.ratings].reverse() };
    const { evaluation } = await evaluate(fakeAnthropic([{ json: shuffled }]));

    // Reordering is the scorer's job, and it does it against the role's order.
    // Doing it here as well would be a second definition of the same thing.
    expect(evaluation.ratings.map((rating) => rating.criterionId)).toEqual(
      shuffled.ratings.map((rating) => rating.criterionId),
    );
  });
});

describe('a response that is missing a criterion', () => {
  /**
   * The check runs here, in the evaluation call's validation hook, rather than
   * downstream in the scorer - because here the model is still in the loop. A
   * second reconcile of the same object fails identically and costs nothing but
   * time; a second *generation*, told which ids were dropped, is a different
   * response. `reconcile-ratings.js` still refuses an incomplete evaluation and
   * is unchanged: one rule at two boundaries, and only this one can recover.
   */
  const missing = (...ids) => ({
    json: {
      ...GOLDEN_EVALUATION,
      ratings: GOLDEN_EVALUATION.ratings.filter((rating) => !ids.includes(rating.criterionId)),
    },
  });

  it('retries once and succeeds when the second generation is complete', async () => {
    const client = fakeAnthropic([missing('c-comms'), { json: GOLDEN_EVALUATION }]);

    const { evaluation, diagnostics } = await evaluate(client);

    expect(client.calls).toHaveLength(2);
    expect(diagnostics.attempts).toBe(2);
    expect(evaluation.ratings).toHaveLength(6);
  });

  it('names the exact missing ids in the retry, which is what makes it work', async () => {
    const client = fakeAnthropic([missing('c-api', 'c-comms'), { json: GOLDEN_EVALUATION }]);

    await evaluate(client);

    const retry = client.calls[1].params.messages[0].content;
    expect(retry).toContain('CORRECTION');
    expect(retry).toContain('c-api');
    expect(retry).toContain('c-comms');
    expect(retry).toContain('2 of the 6 criteria you were given were not rated');
    // The ids it did rate are not listed as problems.
    expect(retry).not.toContain('ratings.c-node');
  });

  it('fails with IncompleteEvaluationError when the retry is still short, and stops there', async () => {
    const client = fakeAnthropic([missing('c-comms'), missing('c-comms'), { json: GOLDEN_EVALUATION }]);

    const error = await evaluate(client).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(IncompleteEvaluationError);
    expect(error.code).toBe('AGENT_INCOMPLETE_EVAL');
    expect(error.missingCriterionIds).toEqual(['c-comms']);
    // One retry, not two. A third generation is another whole bill for a model
    // that has now failed the same instruction twice.
    expect(client.calls).toHaveLength(2);
  });

  it('reports the second response\'s ids, not the first\'s', async () => {
    const client = fakeAnthropic([missing('c-comms'), missing('c-node', 'c-test')]);

    const error = await evaluate(client).catch((thrown) => thrown);

    expect(error.missingCriterionIds).toEqual(['c-node', 'c-test']);
  });

  it('is labelled retryable, because a further generation could still be complete', async () => {
    // The owner's call, overriding 2a: this is a generation failure, not an
    // argument failure. The worker owns what to do about the label.
    const client = fakeAnthropic([missing('c-comms'), missing('c-comms')]);

    const error = await evaluate(client).catch((thrown) => thrown);

    expect(error.retryable).toBe(true);
  });

  it('keeps the candidate out of the failure it logs', async () => {
    const client = fakeAnthropic([missing('c-comms'), missing('c-comms')]);

    const error = await evaluate(client).catch((thrown) => thrown);
    const logged = JSON.stringify(error.toJSON());

    expect(error.details).toEqual({ missingCriterionIds: ['c-comms'] });
    expect(logged).not.toContain('Priya');
    expect(logged).not.toContain('Northwind');
    // Not even the criterion's label - ids and counts only.
    expect(logged).not.toContain('Collaboration and written communication');
  });

  it('warns once, naming the reason and no response text', async () => {
    const warn = vi.fn();
    const client = fakeAnthropic([missing('c-comms'), { json: GOLDEN_EVALUATION }]);

    await evaluate(client, { logger: { warn } });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({
      stage: 'evaluation',
      attempt: 1,
      reason: 'incomplete_evaluation',
    });
  });

  it('spends its one retry on the ratings when the summary is wrong too', async () => {
    // Only the first failing rule is reported. Completeness is the bigger fault,
    // so it goes first and the summary failure surfaces on the way out.
    const client = fakeAnthropic([
      {
        json: {
          ...GOLDEN_EVALUATION,
          ratings: GOLDEN_EVALUATION.ratings.slice(0, 5),
          summary: 'Roughly an 80% match.',
        },
      },
      { json: { ...GOLDEN_EVALUATION, summary: 'Roughly an 80% match.' } },
    ]);

    const error = await evaluate(client).catch((thrown) => thrown);

    expect(client.calls[1].params.messages[0].content).toContain('c-comms');
    expect(error).toBeInstanceOf(AgentBadOutputError);
    expect(error.reason).toBe('rejected_summary');
  });
});

describe('the summary', () => {
  const withSummary = (summary) => ({ json: { ...GOLDEN_EVALUATION, summary } });

  it('accepts prose, including prose that counts things', async () => {
    const { evaluation } = await evaluate(
      fakeAnthropic([
        withSummary('Meets four of the six criteria; eight years of backend work behind it.'),
      ]),
    );

    expect(evaluation.summary).toContain('four of the six criteria');
  });

  it('refuses a figure on the score and retries once', async () => {
    const client = fakeAnthropic([withSummary('Roughly an 80% match.'), withSummary('A close fit.')]);

    const { evaluation, diagnostics } = await evaluate(client);

    expect(diagnostics.attempts).toBe(2);
    expect(evaluation.summary).toBe('A close fit.');
    // The offending phrase goes back to the model, because the model wrote it and
    // naming it is what makes the retry work.
    const retry = client.calls[1].params.messages[0].content;
    expect(retry).toContain('80%');
    expect(retry).toMatch(/in digits or in words/i);
  });

  it('fails the candidate when the correction states one too', async () => {
    const client = fakeAnthropic([
      withSummary('Roughly an 80% match.'),
      withSummary('I would rate them 8/10 overall.'),
    ]);

    const error = await evaluate(client).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentBadOutputError);
    expect(error.reason).toBe('rejected_summary');
    expect(error.details.patternId).toBe('out_of_ten_or_hundred');
    // Nothing is repaired. Silently stripping the number would hide a model that
    // is drifting.
    expect(error.retryable).toBe(false);
  });

  it('accepts null, because "nothing to add" is a legal answer', async () => {
    const { evaluation } = await evaluate(fakeAnthropic([withSummary(null)]));
    expect(evaluation.summary).toBeNull();
  });
});

describe('diagnostics', () => {
  it('records the prompt version, the attempts and the cost', async () => {
    const { diagnostics } = await evaluate(fakeAnthropic([ok]));

    expect(diagnostics).toEqual({
      promptVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      attempts: 1,
      usage: { inputTokens: 1234, outputTokens: 567 },
      criteriaCount: 6,
    });
  });
});
