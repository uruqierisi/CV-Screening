import { describe, expect, test } from 'vitest';
import {
  ACTIVE_CANDIDATE_STATUSES,
  TERMINAL_CANDIDATE_STATUSES,
  allCandidatesTerminal,
  candidateStatusLabel,
  isTerminalCandidateStatus,
} from './candidateStatus.js';

/**
 * The five values `candidates.status` can hold, transcribed from the column's
 * CHECK constraint. Written out here rather than imported so that the split
 * below is asserted against the contract rather than against itself.
 */
const ALL_STATUSES = ['pending', 'parsing', 'evaluating', 'done', 'failed'];

describe('the terminal/active split', () => {
  test('covers every status the API can return, exactly once', () => {
    expect([...ACTIVE_CANDIDATE_STATUSES, ...TERMINAL_CANDIDATE_STATUSES].sort()).toEqual(
      [...ALL_STATUSES].sort(),
    );
  });

  test('done and failed are terminal; nothing else is', () => {
    expect(isTerminalCandidateStatus('done')).toBe(true);
    expect(isTerminalCandidateStatus('failed')).toBe(true);
    for (const status of ACTIVE_CANDIDATE_STATUSES) {
      expect(isTerminalCandidateStatus(status)).toBe(false);
    }
  });

  test('an unknown status is not terminal, so polling keeps going rather than stopping blind', () => {
    expect(isTerminalCandidateStatus('something_new')).toBe(false);
    expect(isTerminalCandidateStatus(undefined)).toBe(false);
    expect(isTerminalCandidateStatus(null)).toBe(false);
  });
});

describe('allCandidatesTerminal - the polling stop condition', () => {
  test('is false while any candidate is still working', () => {
    expect(
      allCandidatesTerminal([{ status: 'done' }, { status: 'evaluating' }, { status: 'failed' }]),
    ).toBe(false);
  });

  test('is true when every candidate is done or failed', () => {
    expect(allCandidatesTerminal([{ status: 'done' }, { status: 'failed' }])).toBe(true);
  });

  test('a batch of failures is finished, not still working', () => {
    expect(allCandidatesTerminal([{ status: 'failed' }, { status: 'failed' }])).toBe(true);
  });

  test('watching nothing is finished - there is nothing outstanding to wait for', () => {
    // This is the case an all-duplicates upload produces: a screening job with a
    // file count and no candidates of its own. The server calls it `completed`
    // for the same reason.
    expect(allCandidatesTerminal([])).toBe(true);
  });

  test('one candidate stuck in pending keeps the poll alive', () => {
    const many = Array.from({ length: 50 }, () => ({ status: 'done' }));
    expect(allCandidatesTerminal([...many, { status: 'pending' }])).toBe(false);
  });
});

describe('candidateStatusLabel', () => {
  test('every status has a recruiter-facing label rather than a column value', () => {
    for (const status of ALL_STATUSES) {
      expect(candidateStatusLabel(status)).not.toBe(status);
    }
  });

  test('an unknown status is shown as itself rather than hidden', () => {
    expect(candidateStatusLabel('something_new')).toBe('something_new');
  });
});
