import { describe, expect, it, vi } from 'vitest';
import {
  EXTRACTION_EFFORT,
  EXTRACTION_MAX_TOKENS,
  EXTRACTION_TIMEOUT_MS,
  extractProfile,
} from '../../src/agents/extraction/extract-profile.js';
import { AgentInputError } from '../../src/agents/client/errors.js';
import { fakeAnthropic } from './helpers/fake-anthropic.js';
import { GOLDEN_CV_TEXT, GOLDEN_PROFILE } from './fixtures/golden.js';

/**
 * Extraction as a whole: the guard, the call, and the three deterministic steps
 * that make its output trustworthy.
 *
 * The interesting assertions are not about the call - `call-structured.test.js`
 * owns that - but about what happens to what comes back. A model that claims
 * evidence it does not have, or an email that arrived mangled, must not reach
 * the profile a hiring decision is made from.
 */

const NOW = new Date('2026-03-15T09:30:00.000Z');

/** The model's own output shape: no `computedYearsExperience`, no `evidenceVerified`. */
function modelProfile(overrides = {}) {
  const { computedYearsExperience, skills, ...rest } = GOLDEN_PROFILE;
  return {
    ...rest,
    skills: skills.map(({ name, evidenceType, evidenceQuote }) => ({
      name,
      evidenceType,
      evidenceQuote,
    })),
    ...overrides,
  };
}

const extract = (client, overrides = {}) =>
  extractProfile({ client, cvText: GOLDEN_CV_TEXT, now: NOW, ...overrides });

describe('the input guard', () => {
  it('fails before spending a token on text that is not a CV', async () => {
    const client = fakeAnthropic([]);

    const error = await extractProfile({ client, cvText: 'page 1 of 3', now: NOW }).catch(
      (thrown) => thrown,
    );

    expect(error).toBeInstanceOf(AgentInputError);
    expect(error.code).toBe('EMPTY_DOCUMENT');
    // The cheapest possible failure: no call was made at all.
    expect(client.calls).toHaveLength(0);
  });

  it('reports counts, never a span of the document', async () => {
    const error = await extractProfile({
      client: fakeAnthropic([]),
      cvText: 'Confidential: Priya Ramanathan, +44 161 496 0000',
      now: NOW,
    }).catch((thrown) => thrown);

    expect(error.details.failures).toEqual(['too_short', 'no_cv_signal']);
    expect(error.details.characters).toBe(48);
    expect(JSON.stringify(error.toJSON())).not.toContain('Priya');
    expect(JSON.stringify(error.toJSON())).not.toContain('496');
  });
});

describe('the call', () => {
  it('uses the settings the plan specifies for a transcription task', async () => {
    const client = fakeAnthropic([{ json: modelProfile() }]);
    await extract(client);

    // Effort low: thinking on transcription is billed output spent on nothing,
    // and it is the biggest single cost lever in the system.
    expect(EXTRACTION_EFFORT).toBe('low');
    expect(client.calls[0].params.output_config.effort).toBe('low');
    expect(client.calls[0].params.max_tokens).toBe(EXTRACTION_MAX_TOKENS);
    // Milliseconds, and two minutes rather than two seconds.
    expect(EXTRACTION_TIMEOUT_MS).toBe(120_000);
    expect(client.calls[0].options.timeout).toBe(120_000);
  });

  it('sends the CV and no role information whatsoever', async () => {
    const client = fakeAnthropic([{ json: modelProfile() }]);
    await extract(client);

    const { system, messages } = client.calls[0].params;
    expect(messages[0].content).toContain(GOLDEN_CV_TEXT);
    expect(`${system}${messages[0].content}`).not.toMatch(/criteri|weight|rating|score/i);
  });
});

describe('what happens to the response', () => {
  it('normalizes, verifies and computes, in that order', async () => {
    const client = fakeAnthropic([{ json: modelProfile({ email: '  PRIYA@EXAMPLE.COM ' }) }]);

    const { profile, diagnostics } = await extract(client);

    // Normalized.
    expect(profile.email).toBe('priya@example.com');
    // Verified: both quotes are really in the CV.
    expect(profile.skills.filter((skill) => skill.evidenceVerified === true)).toHaveLength(2);
    expect(diagnostics.evidence.verifiedCount).toBe(2);
    // Computed from the dates, not believed from the CV's own claim of 9.
    expect(profile.computedYearsExperience).toBe(7.8);
    expect(profile.statedYearsExperience).toBe(9);
  });

  it('downgrades a demonstrated skill whose quote is not in the CV', async () => {
    const client = fakeAnthropic([
      {
        json: modelProfile({
          skills: [
            {
              name: 'Kafka',
              evidenceType: 'demonstrated',
              evidenceQuote: 'architected the Kafka event bus',
            },
          ],
        }),
      },
    ]);

    const { profile, diagnostics } = await extract(client);

    expect(profile.skills[0].evidenceType).toBe('listed_only');
    expect(profile.skills[0].evidenceVerified).toBe(false);
    // The quote is kept: it is the evidence that the model fabricated one, and
    // deleting it would erase the only trace.
    expect(profile.skills[0].evidenceQuote).toBe('architected the Kafka event bus');
    expect(diagnostics.evidence.downgraded).toEqual([
      { skill: 'Kafka', reason: 'quote_not_found' },
    ]);
  });

  it('warns about a fabricated quote, with a rate rather than a name', async () => {
    const warn = vi.fn();
    const client = fakeAnthropic([
      {
        json: modelProfile({
          skills: [{ name: 'Kafka', evidenceType: 'demonstrated', evidenceQuote: 'not in the CV' }],
        }),
      },
    ]);

    await extract(client, { logger: { warn } });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toEqual({ stage: 'extraction', downgraded: 1, verified: 0 });
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('Priya');
  });

  it('says nothing when every claim held up', async () => {
    const warn = vi.fn();
    await extract(fakeAnthropic([{ json: modelProfile() }]), { logger: { warn } });
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns diagnostics a human could debug a bad profile with', async () => {
    const client = fakeAnthropic([{ json: modelProfile({ email: 'not an address' }) }]);

    const { diagnostics } = await extract(client);

    expect(diagnostics.promptVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(diagnostics.attempts).toBe(1);
    expect(diagnostics.usage).toEqual({ inputTokens: 1234, outputTokens: 567 });
    expect(diagnostics.normalization).toContainEqual({
      field: 'email',
      action: 'nulled_invalid',
      reason: 'not_an_address',
    });
    expect(diagnostics.experience.segments).toHaveLength(1);
    expect(diagnostics.inputAssessment.characters).toBeGreaterThan(200);
  });

  it('reads the clock it is given and no other', async () => {
    // A candidate's experience must not depend on when the worker ran.
    const client = fakeAnthropic([{ json: modelProfile() }, { json: modelProfile() }]);

    const early = await extract(client, { now: new Date('2022-01-15T00:00:00.000Z') });
    const late = await extract(client, { now: new Date('2026-03-15T00:00:00.000Z') });

    expect(early.profile.computedYearsExperience).toBeLessThan(
      late.profile.computedYearsExperience,
    );
  });

  it('passes the candidate deadline down to the call', async () => {
    const controller = new AbortController();
    const client = fakeAnthropic([{ json: modelProfile() }]);

    await extract(client, { signal: controller.signal, deadlineMs: 240_000 });

    expect(client.calls[0].options.signal).toBe(controller.signal);
  });
});
