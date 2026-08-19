import { describe, expect, it } from 'vitest';
import * as errorsModule from '../../src/agents/errors.js';
import {
  AgentError,
  DuplicateRatingError,
  IncompleteEvaluationError,
  InvalidRatingError,
  InvalidRoleError,
  SummaryContainsScoreError,
  UnknownRuleTypeError,
} from '../../src/agents/errors.js';
import { AGENT_ERROR_CODES } from '../../src/agents/constants.js';

/**
 * These errors end up in two places that matter: `candidates.error_code`, which
 * a recruiter sees the consequences of, and the logs, which must never become a
 * second copy of somebody's CV. So the tests are about the code, the
 * retryability label, and what is and is not in `details`.
 */

/**
 * The two whose retry changes the **generation** rather than the argument: the
 * model returned a response that came up short, and asking again produces a
 * different response rather than a second reading of the same one.
 */
const RETRYABLE = [
  new IncompleteEvaluationError(['c-a', 'c-b']),
  new SummaryContainsScoreError({
    patternId: 'percentage',
    description: 'a percentage, in symbol or spelled form',
    match: '80%',
  }),
];

/**
 * Everything whose input is fixed. Re-running the same pure function over the
 * same argument fails identically, so a retry is waste.
 */
const NOT_RETRYABLE = [
  new DuplicateRatingError(['c-a']),
  new InvalidRatingError('c-a', 11),
  new InvalidRoleError('weights are wrong', { weightSum: 80 }),
  new UnknownRuleTypeError('required_language', ['min_years_experience']),
];

const ALL = [...RETRYABLE, ...NOT_RETRYABLE];

describe('agent errors', () => {
  it('are all AgentErrors with a code from the worker-side namespace', () => {
    const codes = new Set(Object.values(AGENT_ERROR_CODES));

    for (const error of ALL) {
      expect(error).toBeInstanceOf(AgentError);
      expect(error).toBeInstanceOf(Error);
      expect(codes.has(error.code), error.code).toBe(true);
    }
  });

  it('carry their own class name, so a log line says what happened', () => {
    expect(ALL.map((error) => error.name)).toEqual([
      'IncompleteEvaluationError',
      'SummaryContainsScoreError',
      'DuplicateRatingError',
      'InvalidRatingError',
      'InvalidRoleError',
      'UnknownRuleTypeError',
    ]);
  });

  it('are every error class this module exports, so the sets below are exhaustive', () => {
    // Without this, "the retryable set is exactly these two" would only be a
    // claim about the errors somebody remembered to list. A new class added to
    // the module and to neither set fails here first.
    const exported = Object.keys(errorsModule)
      .filter((name) => name !== 'AgentError')
      .sort();

    expect([...new Set(ALL.map((error) => error.name))].sort()).toEqual(exported);
  });

  describe('toJSON', () => {
    it('serializes the fields a structured log needs and no others', () => {
      const error = new IncompleteEvaluationError(['c-a']);

      expect(error.toJSON()).toEqual({
        name: 'IncompleteEvaluationError',
        code: 'AGENT_INCOMPLETE_EVAL',
        message: 'evaluation is missing a rating for 1 criterion/criteria: c-a',
        retryable: true,
        details: { missingCriterionIds: ['c-a'] },
      });
    });

    it('leaves the stack to the logger', () => {
      for (const error of ALL) {
        expect(Object.keys(error.toJSON()).sort()).toEqual([
          'code',
          'details',
          'message',
          'name',
          'retryable',
        ]);
      }
    });

    it('survives JSON.stringify, which is how it will actually be logged', () => {
      const serialized = JSON.parse(JSON.stringify(new UnknownRuleTypeError('nope', ['a', 'b'])));

      expect(serialized.code).toBe('AGENT_UNKNOWN_RULE');
      expect(serialized.details).toEqual({ type: 'nope', knownTypes: ['a', 'b'] });
    });
  });

  it('never puts free text into details', () => {
    // `details` goes to the logs. Ids, labels, enums and counts only - never a
    // span of a CV, and never a value that came out of a model as prose.
    for (const error of ALL) {
      for (const value of Object.values(error.details)) {
        const values = Array.isArray(value) ? value : [value];
        for (const entry of values) {
          if (typeof entry === 'string') {
            expect(entry.length).toBeLessThan(100);
            expect(entry).not.toContain('\n');
          }
        }
      }
    }
  });

  it('defaults InvalidRoleError details to an empty object rather than undefined', () => {
    expect(new InvalidRoleError('no criteria').details).toEqual({});
  });

  describe('the deliberate exceptions to "nothing here is retryable"', () => {
    // The rule is that a pure function re-run over the same argument fails
    // identically, so a retry is waste. Both exceptions are the same shape of
    // exception: what a retry changes for either is the *generation*, not the
    // argument - the model returned a response that came up short, and asking
    // again produces a different one. Their behaviour is tested where each is
    // raised (evaluate-candidate.test.js, validate-summary.test.js); what is
    // asserted here is that the exception is exactly two errors wide, and which
    // two.
    it('is exactly this set, named, and no wider', () => {
      expect(ALL.filter((error) => error.retryable).map((error) => error.name)).toEqual([
        'IncompleteEvaluationError',
        'SummaryContainsScoreError',
      ]);
    });

    it('leaves every other member labelled not retryable', () => {
      for (const error of NOT_RETRYABLE) {
        expect(error.retryable, error.name).toBe(false);
      }
    });

    it('carries codes from the same worker-side namespace as the rest', () => {
      const [incomplete, summary] = RETRYABLE;

      expect(incomplete).toBeInstanceOf(AgentError);
      expect(incomplete.code).toBe(AGENT_ERROR_CODES.INCOMPLETE_EVAL);
      expect(summary).toBeInstanceOf(AgentError);
      expect(summary.code).toBe(AGENT_ERROR_CODES.BAD_OUTPUT);
    });

    it('names the exact ids a retry has to fix, and nothing else', () => {
      // The ids are what make the retry worth spending: a model told which
      // criteria it dropped usually returns them. They are also all that goes to
      // the log - no labels, no profile text.
      const [incomplete] = RETRYABLE;

      expect(incomplete.missingCriterionIds).toEqual(['c-a', 'c-b']);
      expect(incomplete.details).toEqual({ missingCriterionIds: ['c-a', 'c-b'] });
    });
  });
});
