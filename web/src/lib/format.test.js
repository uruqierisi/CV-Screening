import { describe, expect, test } from 'vitest';
import { formatBytes, formatElapsed, formatScore, humanizeToken, pluralize } from './format.js';

describe('formatScore', () => {
  test('always shows one decimal, so a column of scores reads as one measurement', () => {
    // `numeric(4,1)` crosses the wire as a Number, so 50.0 arrives as 50.
    expect(formatScore(50)).toBe('50.0');
    expect(formatScore(81.5)).toBe('81.5');
    expect(formatScore(0)).toBe('0.0');
    expect(formatScore(100)).toBe('100.0');
  });

  test('an unscored candidate is a dash, never a zero', () => {
    // Zero is a real score a candidate can be given. Rendering "not yet scored"
    // as 0.0 would put an in-flight candidate at the bottom of the ranking as
    // though it had been judged.
    expect(formatScore(null)).toBe('—');
    expect(formatScore(undefined)).toBe('—');
  });
});

describe('formatBytes', () => {
  test('reads at the scale the number is at', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2659)).toBe('2.6 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('formatElapsed', () => {
  test('counts up in seconds, then minutes', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatElapsed(600_000)).toBe('10m 00s');
  });
});

describe('humanizeToken', () => {
  test('turns a contract token into a field label', () => {
    expect(humanizeToken('min_years_experience')).toBe('Min years experience');
    expect(humanizeToken('countryCodes')).toBe('CountryCodes');
    expect(humanizeToken('listed_only')).toBe('Listed only');
  });
});

describe('pluralize', () => {
  test('handles the irregular plural the criteria list needs', () => {
    expect(pluralize(1, 'criterion', 'criteria')).toBe('1 criterion');
    expect(pluralize(6, 'criterion', 'criteria')).toBe('6 criteria');
    expect(pluralize(0, 'file')).toBe('0 files');
  });
});
