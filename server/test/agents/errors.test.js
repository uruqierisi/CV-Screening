import { describe, expect, it } from 'vitest';
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

const ALL = [
  new IncompleteEvaluationError(['c-a', 'c-b']),
  new DuplicateRatingError(['c-a']),
  new InvalidRatingError('c-a', 11),
  new InvalidRoleError('weights are wrong', { weightSum: 80 }),
  new UnknownRuleTypeError('required_language', ['min_years_experience']),
];

describe('agent errors', () => {
  it('are all AgentErrors with a code from the worker-side namespace', () => {
    const codes = new Set(Object.values(AGENT_ERROR_CODES));

    for (const error of ALL) {
      expect(error).toBeInstanceOf(AgentError);
      expect(error).toBeInstanceOf(Error);
      expect(codes.has(error.code), error.code).toBe(true);
    }
  });

  it('are all labelled not retryable, because a pure function fails the same way twice', () => {
    for (const error of ALL) {
      expect(error.retryable).toBe(false);
    }
  });

  it('carry their own class name, so a log line says what happened', () => {
    expect(ALL.map((error) => error.name)).toEqual([
      'IncompleteEvaluationError',
      'DuplicateRatingError',
      'InvalidRatingError',
      'InvalidRoleError',
      'UnknownRuleTypeError',
    ]);
  });

  describe('toJSON', () => {
    it('serializes the fields a structured log needs and no others', () => {
      const error = new IncompleteEvaluationError(['c-a']);

      expect(error.toJSON()).toEqual({
        name: 'IncompleteEvaluationError',
        code: 'AGENT_INCOMPLETE_EVAL',
        message: 'evaluation is missing a rating for 1 criterion/criteria: c-a',
        retryable: false,
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

  describe('the one deliberate exception to "nothing here is retryable"', () => {
    // `ALL` above is every error whose input is fixed: re-running the same pure
    // function over the same argument fails identically, so retrying is waste.
    // SummaryContainsScoreError is the exception and is kept out of that list on
    // purpose - what a retry changes there is the generation, not the argument.
    // Its behaviour is tested in validate-summary.test.js; what is asserted here
    // is that the exception is exactly one error wide.
    const summaryError = new SummaryContainsScoreError({
      patternId: 'percentage',
      description: 'a percentage, in symbol or spelled form',
      match: '80%',
    });

    it('is an AgentError with a code from the same namespace', () => {
      expect(summaryError).toBeInstanceOf(AgentError);
      expect(summaryError.code).toBe(AGENT_ERROR_CODES.BAD_OUTPUT);
    });

    it('is retryable, and is the only member of the namespace that is', () => {
      expect(summaryError.retryable).toBe(true);
      expect(ALL.some((error) => error.retryable)).toBe(false);
    });
  });
});
