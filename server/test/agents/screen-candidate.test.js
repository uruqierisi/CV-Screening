import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_DEADLINE_MS,
  screenCandidate,
} from '../../src/agents/pipeline/screen-candidate.js';
import {
  AgentInputError,
  AgentRefusalError,
  AgentTimeoutError,
} from '../../src/agents/client/errors.js';
import { IncompleteEvaluationError } from '../../src/agents/errors.js';
import { fakeAnthropic } from './helpers/fake-anthropic.js';
import {
  GOLDEN_CV_TEXT,
  GOLDEN_EVALUATION,
  GOLDEN_EXPECTED,
  GOLDEN_NOW_ISO,
  GOLDEN_ROLE,
  extractedProfile,
} from './fixtures/golden.js';

/**
 * The whole layer composed: CV text in, a scored candidate out.
 *
 * The golden fixture is reused deliberately. Phase 2a proved that these ratings
 * and this role produce 72.5 and a Potential Match; this file proves the
 * pipeline delivers exactly those ratings to exactly that function, so a
 * regression anywhere in between shows up as the number a recruiter would have
 * seen rather than as an internal shape nobody would notice.
 */

const NOW = new Date(GOLDEN_NOW_ISO);

/** What the model returns from extraction: flat, sparse, no derived fields. */
const modelProfile = extractedProfile;

const HAPPY_PATH = [{ json: modelProfile() }, { json: GOLDEN_EVALUATION }];

const screen = (client, overrides = {}) =>
  screenCandidate({ client, role: GOLDEN_ROLE, cvText: GOLDEN_CV_TEXT, now: NOW, ...overrides });

describe('the happy path', () => {
  it('produces the score the deterministic core produces for these ratings', async () => {
    const { scored } = await screen(fakeAnthropic(HAPPY_PATH));

    expect(scored.score).toBe(GOLDEN_EXPECTED.score);
    expect(scored.scoreRaw).toBe(GOLDEN_EXPECTED.scoreRaw);
    expect(scored.fitCategory).toBe(GOLDEN_EXPECTED.fitCategory);
    // The audit trail reconciles: the Contribution column sums to the score.
    expect(
      scored.evaluationMatrix.criteria.reduce((sum, row) => sum + row.weightedPoints, 0),
    ).toBe(scored.scoreRaw);
  });

  it('makes exactly two calls, in order, one per stage', async () => {
    const client = fakeAnthropic(HAPPY_PATH);
    await screen(client);

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].params.output_config.effort).toBe('low');
    expect(client.calls[1].params.output_config.effort).toBe('high');
  });

  it('adds up what the candidate cost', async () => {
    const client = fakeAnthropic([
      { json: modelProfile(), usage: { input_tokens: 3_000, output_tokens: 1_800 } },
      { json: GOLDEN_EVALUATION, usage: { input_tokens: 1_500, output_tokens: 800 } },
    ]);

    const { diagnostics } = await screen(client);

    expect(diagnostics.usage).toEqual({ inputTokens: 4_500, outputTokens: 2_600 });
    expect(diagnostics.deadlineMs).toBe(CANDIDATE_DEADLINE_MS);
  });

  it('treats an unreported usage figure as unknown rather than as free', async () => {
    const client = fakeAnthropic([
      { json: modelProfile(), usage: null },
      { json: GOLDEN_EVALUATION, usage: { input_tokens: 1_500, output_tokens: 800 } },
    ]);

    const { diagnostics } = await screen(client);
    expect(diagnostics.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it('is deterministic once the ratings are fixed', async () => {
    const first = await screen(fakeAnthropic(HAPPY_PATH));
    const second = await screen(fakeAnthropic(HAPPY_PATH));

    // The claim the README makes, and the only one it should: the score is a
    // reproducible function of the ratings.
    expect(JSON.stringify(second.scored)).toBe(JSON.stringify(first.scored));
  });
});

describe('identity redaction is evaluation-only', () => {
  it('hands the judge a redacted profile and the caller a complete one', async () => {
    const client = fakeAnthropic(HAPPY_PATH);

    const { profile, scored } = await screen(client);

    // What went to the model.
    const sentToJudge = client.calls[1].params.messages[0].content;
    expect(sentToJudge).not.toContain('Priya Ramanathan');
    expect(sentToJudge).not.toContain('priya.ramanathan@example.com');
    expect(sentToJudge).toContain('"fullName": null');
    expect(sentToJudge).toContain('"email": null');

    // What came back to the recruiter. The dashboard shows people, not
    // filenames, and the detail view shows the whole person.
    expect(profile.fullName).toBe('Priya Ramanathan');
    expect(profile.email).toBe('priya.ramanathan@example.com');
    expect(scored.evaluationMatrix.criteria).toHaveLength(6);
  });

  it('does not redact the extraction call either - it sees the CV as written', async () => {
    const client = fakeAnthropic(HAPPY_PATH);
    await screen(client);

    expect(client.calls[0].params.messages[0].content).toContain('PRIYA RAMANATHAN');
  });
});

describe('failure is per candidate, and it is loud', () => {
  it('never reaches the judge when the document is not screenable', async () => {
    const client = fakeAnthropic([]);

    const error = await screen(client, { cvText: 'scanned page, no text layer' }).catch(
      (thrown) => thrown,
    );

    expect(error).toBeInstanceOf(AgentInputError);
    expect(client.calls).toHaveLength(0);
  });

  it('stops at the stage that failed and says which one', async () => {
    const client = fakeAnthropic([
      { json: modelProfile() },
      { stopReason: 'refusal', stopDetails: { type: 'refusal', category: 'general_harms' } },
    ]);

    const error = await screen(client).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentRefusalError);
    expect(error.details.stage).toBe('evaluation');
    expect(error.retryable).toBe(false);
  });

  it('refuses to score an evaluation that is missing a criterion', async () => {
    // Substituting 0 would silently depress the score and renormalizing would
    // silently inflate it, and both are invisible to a recruiter reading the
    // number. A visibly failed candidate is recoverable; a quietly mis-scored
    // one is not.
    //
    // Three scripted responses for two stages, because the evaluation call now
    // spends its one semantic retry on this before giving up: a missing
    // criterion is a failure of the *generation*, and a second generation told
    // which id it dropped usually returns it. Two incomplete ones in a row is a
    // model failing the same instruction twice, and the candidate fails.
    const incomplete = {
      json: { ...GOLDEN_EVALUATION, ratings: GOLDEN_EVALUATION.ratings.slice(0, 5) },
    };
    const client = fakeAnthropic([{ json: modelProfile() }, incomplete, incomplete]);

    const error = await screen(client).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(IncompleteEvaluationError);
    expect(error.code).toBe('AGENT_INCOMPLETE_EVAL');
    expect(error.missingCriterionIds).toEqual(['c-comms']);
    // Extraction plus two evaluation generations, and no third.
    expect(client.calls).toHaveLength(3);
  });

  it('recovers a candidate whose first evaluation came up short', async () => {
    // The cost asymmetry that decided the label: one extra call, against
    // discarding a complete evaluation and showing a recruiter a failed
    // candidate.
    const client = fakeAnthropic([
      { json: modelProfile() },
      { json: { ...GOLDEN_EVALUATION, ratings: GOLDEN_EVALUATION.ratings.slice(0, 5) } },
      { json: GOLDEN_EVALUATION },
    ]);

    const { scored, diagnostics } = await screen(client);

    expect(diagnostics.evaluation.attempts).toBe(2);
    expect(scored.score).toBe(GOLDEN_EXPECTED.score);
    expect(scored.fitCategory).toBe(GOLDEN_EXPECTED.fitCategory);
  });

  it('returns nothing partial - a failure is a throw, never a zero', async () => {
    const client = fakeAnthropic([
      { json: modelProfile() },
      { throws: new Anthropic.InternalServerError(503, {}, undefined, new Headers()) },
    ]);

    const result = await screen(client).then(
      (value) => value,
      () => 'threw',
    );

    expect(result).toBe('threw');
  });
});

describe('the hard deadline', () => {
  it('is 240 seconds, which the BullMQ job timeout has to exceed', () => {
    expect(CANDIDATE_DEADLINE_MS).toBe(240_000);
  });

  it('aborts a call that outlives it, and reports the candidate scope', async () => {
    const client = fakeAnthropic([{ hangs: true }]);

    const error = await screen(client, { deadlineMs: 20 }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentTimeoutError);
    expect(error.code).toBe('AGENT_TIMEOUT');
    expect(error.details).toEqual({ stage: 'extraction', scope: 'candidate', limitMs: 20 });
    // Worth another attempt: a slow minute is not a permanent one.
    expect(error.retryable).toBe(true);
  });

  it('honours a caller\'s own cancellation, such as a worker draining', async () => {
    const controller = new AbortController();
    const client = fakeAnthropic([{ hangs: true }]);

    const screening = screen(client, { signal: controller.signal }).catch((thrown) => thrown);
    controller.abort();

    expect(await screening).toBeInstanceOf(AgentTimeoutError);
  });

  it('still bounds the second call after the first one has finished', async () => {
    const client = fakeAnthropic([{ json: modelProfile() }, { hangs: true }]);

    const error = await screen(client, { deadlineMs: 60 }).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(AgentTimeoutError);
    expect(error.details.stage).toBe('evaluation');
  });
});

describe('nothing candidate-identifying reaches a log line', () => {
  /**
   * The sentinel test plan section 5.4 asks for. A string that could only have
   * come from the CV is planted in it, and every failure path is then made to
   * throw; the serialized error must not contain it.
   *
   * `details` is what a worker writes to a structured log. A CV in a log is a
   * second, unmanaged copy of somebody's personal data.
   */
  const SENTINEL = 'ZZQXSENTINELQZZ';
  const cvText = GOLDEN_CV_TEXT.replace('Northwind Logistics', `Northwind ${SENTINEL} Logistics`);

  const scenarios = [
    {
      what: 'a refusal that quotes the document back',
      script: [
        { json: modelProfile() },
        {
          stopReason: 'refusal',
          stopDetails: {
            type: 'refusal',
            category: 'general_harms',
            explanation: `the document mentions ${SENTINEL}`,
          },
        },
      ],
    },
    {
      what: 'a schema mismatch on a field holding CV text',
      script: [
        { json: modelProfile({ fullName: { nested: SENTINEL } }) },
        { json: modelProfile({ fullName: { nested: SENTINEL } }) },
      ],
    },
    {
      what: 'truncation part way through the profile',
      script: [
        { stopReason: 'max_tokens', text: `{"fullName": "${SENTINEL}` },
        { stopReason: 'max_tokens', text: `{"fullName": "${SENTINEL}` },
      ],
    },
    {
      what: 'a response that is prose instead of JSON',
      script: [
        { text: `Here is ${SENTINEL}'s profile:` },
        { text: `Here is ${SENTINEL}'s profile:` },
      ],
    },
    {
      what: 'a document that never gets past the input guard',
      cvText: `${SENTINEL} only`,
      script: [],
    },
  ];

  for (const { what, script, cvText: override } of scenarios) {
    it(`keeps the CV out of the error from ${what}`, async () => {
      const error = await screen(fakeAnthropic(script), {
        cvText: override ?? cvText,
      }).catch((thrown) => thrown);

      expect(error).toBeInstanceOf(Error);
      const logged = JSON.stringify(error.toJSON());

      expect(logged, `details: ${logged}`).not.toContain(SENTINEL);
      // And the line still says something useful about what went wrong.
      expect(logged).toContain('"code"');
      expect(logged).toContain('"stage"');
    });
  }
});
