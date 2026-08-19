import { describe, expect, it } from 'vitest';
import {
  computeExperience,
  monthsToYears,
  parseCvDate,
  withComputedExperience,
} from '../../src/agents/extraction/compute-experience.js';

/**
 * `now` is injected everywhere in this file. If any of these tests would start
 * failing next month, the implementation has reached for the real clock and the
 * candidate's score has become a function of when the worker ran.
 */

const NOW = new Date('2026-03-15T00:00:00Z');

/**
 * @param {string | null} startDate
 * @param {string | null} endDate
 * @param {boolean | null} [isCurrent]
 */
function job(startDate, endDate, isCurrent = null) {
  return { employer: null, title: null, startDate, endDate, isCurrent, summary: null };
}

describe('computeExperience', () => {
  it('counts a closed interval inclusively at both ends', () => {
    const result = computeExperience([job('2020-01', '2020-12')], { now: NOW });

    expect(result.totalMonths).toBe(12);
    expect(result.computedYearsExperience).toBe(1);
    expect(result.segments).toEqual([{ start: '2020-01', end: '2020-12', months: 12 }]);
    expect(result.unusable).toEqual([]);
  });

  describe('overlapping employment', () => {
    it('is merged, never summed', () => {
      const result = computeExperience(
        [job('2020-01', '2021-12'), job('2021-01', '2022-12')],
        { now: NOW },
      );

      // Two 24-month jobs overlapping by a year: 36 months, not 48.
      expect(result.totalMonths).toBe(36);
      expect(result.computedYearsExperience).toBe(3);
      expect(result.segments).toEqual([{ start: '2020-01', end: '2022-12', months: 36 }]);
    });

    it('merges an interval fully contained in another', () => {
      const result = computeExperience(
        [job('2018-01', '2022-12'), job('2019-06', '2020-06')],
        { now: NOW },
      );

      expect(result.totalMonths).toBe(60);
      expect(result.segments).toHaveLength(1);
    });

    it('merges regardless of the order the CV lists jobs in', () => {
      const chronological = computeExperience(
        [job('2018-01', '2019-12'), job('2019-06', '2021-12')],
        { now: NOW },
      );
      const reversed = computeExperience(
        [job('2019-06', '2021-12'), job('2018-01', '2019-12')],
        { now: NOW },
      );

      expect(JSON.stringify(reversed.segments)).toBe(JSON.stringify(chronological.segments));
      expect(reversed.totalMonths).toBe(chronological.totalMonths);
    });

    it('joins adjacent employment into one continuous segment', () => {
      const result = computeExperience(
        [job('2020-01', '2020-06'), job('2020-07', '2020-12')],
        { now: NOW },
      );

      expect(result.segments).toEqual([{ start: '2020-01', end: '2020-12', months: 12 }]);
      expect(result.totalMonths).toBe(12);
    });

    it('merges two jobs that began in the same month', () => {
      const result = computeExperience(
        [job('2020-01', '2020-06'), job('2020-01', '2021-06')],
        { now: NOW },
      );

      expect(result.segments).toEqual([{ start: '2020-01', end: '2021-06', months: 18 }]);
    });

    it('keeps a real career break as two segments', () => {
      const result = computeExperience(
        [job('2018-01', '2018-12'), job('2021-01', '2021-12')],
        { now: NOW },
      );

      expect(result.segments).toHaveLength(2);
      expect(result.totalMonths).toBe(24);
    });
  });

  describe('null and unusable dates', () => {
    it('yields null, not zero, when nothing can be resolved', () => {
      const result = computeExperience([job(null, null)], { now: NOW });

      // The distinction the whole of decision 7-C rests on: null makes a
      // minimum-experience rule indeterminate, and 0 would fail it.
      expect(result.computedYearsExperience).toBeNull();
      expect(result.totalMonths).toBeNull();
      expect(result.unusable).toEqual([{ index: 0, reason: 'missing_start' }]);
    });

    it('yields null for an empty work history', () => {
      expect(computeExperience([], { now: NOW }).computedYearsExperience).toBeNull();
    });

    it('yields null when the work history is absent altogether', () => {
      const result = computeExperience(null, { now: NOW });
      expect(result.computedYearsExperience).toBeNull();
      expect(result.unusable).toEqual([]);
    });

    it('reports an unparseable start date', () => {
      const result = computeExperience([job('sometime in the spring', '2020-12')], { now: NOW });
      expect(result.unusable).toEqual([{ index: 0, reason: 'unparseable_start' }]);
      expect(result.computedYearsExperience).toBeNull();
    });

    it('reports an unparseable end date', () => {
      const result = computeExperience([job('2019-01', 'a while later')], { now: NOW });
      expect(result.unusable).toEqual([{ index: 0, reason: 'unparseable_end' }]);
    });

    it('refuses to guess that a job with no end date is still running', () => {
      const result = computeExperience([job('2019-01', null)], { now: NOW });
      expect(result.unusable).toEqual([{ index: 0, reason: 'missing_end' }]);
      expect(result.computedYearsExperience).toBeNull();
    });

    it('reports an end date before the start date', () => {
      const result = computeExperience([job('2021-01', '2019-01')], { now: NOW });
      expect(result.unusable).toEqual([{ index: 0, reason: 'ends_before_start' }]);
    });

    it('reports a start date in the future', () => {
      const result = computeExperience([job('2030-01', '2031-01')], { now: NOW });
      expect(result.unusable).toEqual([{ index: 0, reason: 'starts_in_the_future' }]);
    });

    it('keeps the usable entries when one entry is unusable', () => {
      const result = computeExperience([job(null, null), job('2020-01', '2020-12')], { now: NOW });

      expect(result.totalMonths).toBe(12);
      expect(result.unusable).toEqual([{ index: 0, reason: 'missing_start' }]);
    });
  });

  describe('open-ended employment', () => {
    it('closes an interval at now when the CV says the role is current', () => {
      const result = computeExperience([job('2025-03', null, true)], { now: NOW });

      expect(result.segments).toEqual([{ start: '2025-03', end: '2026-03', months: 13 }]);
      expect(result.computedYearsExperience).toBe(1.1);
    });

    it('accepts the words a CV uses instead of a date', () => {
      for (const word of ['Present', 'present', 'Current', 'ongoing', 'to date', 'Today', 'now']) {
        const result = computeExperience([job('2025-03', word)], { now: NOW });
        expect(result.totalMonths).toBe(13);
      }
    });

    it('clamps an end date in the future back to now', () => {
      // A notice period written into the CV is not experience already had.
      const result = computeExperience([job('2025-03', '2027-03')], { now: NOW });
      expect(result.segments).toEqual([{ start: '2025-03', end: '2026-03', months: 13 }]);
    });
  });

  describe('date formats', () => {
    it('reads a year-only start as January and a year-only end as December', () => {
      const result = computeExperience([job('2019', '2021')], { now: NOW });

      expect(result.segments).toEqual([{ start: '2019-01', end: '2021-12', months: 36 }]);
      expect(result.computedYearsExperience).toBe(3);
    });

    it('reads English month names', () => {
      const result = computeExperience([job('March 2020', 'Feb 2021')], { now: NOW });
      expect(result.totalMonths).toBe(12);
    });

    it('reads an abbreviated month with a full stop', () => {
      expect(parseCvDate('Sept. 2019')).toEqual({ year: 2019, month: 9 });
      expect(parseCvDate('mar. 2019')).toEqual({ year: 2019, month: 3 });
    });

    it('reads slashed and dashed numeric forms in both orders', () => {
      expect(parseCvDate('2019-03')).toEqual({ year: 2019, month: 3 });
      expect(parseCvDate('2019/3')).toEqual({ year: 2019, month: 3 });
      expect(parseCvDate('03/2019')).toEqual({ year: 2019, month: 3 });
      expect(parseCvDate('3-2019')).toEqual({ year: 2019, month: 3 });
      expect(parseCvDate('2019-03-14')).toEqual({ year: 2019, month: 3 });
    });

    it('returns null for anything it cannot read rather than guessing', () => {
      expect(parseCvDate('')).toBeNull();
      expect(parseCvDate('   ')).toBeNull();
      expect(parseCvDate('2019-13')).toBeNull();
      expect(parseCvDate('13/2019')).toBeNull();
      expect(parseCvDate('summer 2019')).toBeNull();
      expect(parseCvDate('19')).toBeNull();
    });

    it('does not resolve inherited object properties as month names', () => {
      // A plain object literal would answer this lookup with a function.
      expect(parseCvDate('constructor 2019')).toBeNull();
      expect(parseCvDate('toString 2019')).toBeNull();
    });
  });

  describe('the injected clock', () => {
    it('is required', () => {
      expect(() => computeExperience([])).toThrow(/injected `now` Date/);
    });

    it('must be a real Date', () => {
      expect(() =>
        computeExperience([], { now: /** @type {any} */ ('2026-03-15') }),
      ).toThrow(TypeError);
      expect(() => computeExperience([], { now: new Date('nonsense') })).toThrow(TypeError);
    });

    it('changes the answer for open-ended work, and only that', () => {
      const later = computeExperience([job('2025-03', null, true)], {
        now: new Date('2027-03-15T00:00:00Z'),
      });
      expect(later.totalMonths).toBe(25);
    });
  });
});

describe('monthsToYears', () => {
  it('rounds to one decimal', () => {
    expect(monthsToYears(0)).toBe(0);
    expect(monthsToYears(6)).toBe(0.5);
    expect(monthsToYears(12)).toBe(1);
    expect(monthsToYears(94)).toBe(7.8);
    expect(monthsToYears(71)).toBe(5.9);
  });

  it('never rounds across an integer year boundary', () => {
    // The property a minimum-experience rule depends on: comparing the rounded
    // value against a whole number of years gives the same answer as comparing
    // months, for every month count anyone will ever have.
    for (let months = 0; months <= 720; months += 1) {
      const years = monthsToYears(months);
      for (let required = 0; required <= 60; required += 1) {
        expect(years >= required).toBe(months >= required * 12);
      }
    }
  });
});

describe('withComputedExperience', () => {
  const profile = Object.freeze({
    fullName: 'A Candidate',
    workHistory: [job('2020-01', '2021-12')],
    computedYearsExperience: undefined,
  });

  it('returns a copy carrying the computed value', () => {
    const { profile: updated, experience } = withComputedExperience(profile, { now: NOW });

    expect(updated.computedYearsExperience).toBe(2);
    expect(updated.fullName).toBe('A Candidate');
    expect(experience.totalMonths).toBe(24);
  });

  it('does not touch the profile it was given', () => {
    const { profile: updated } = withComputedExperience(profile, { now: NOW });

    expect(updated).not.toBe(profile);
    expect(profile.computedYearsExperience).toBeUndefined();
  });

  it('carries null through for a profile with no usable history', () => {
    const { profile: updated } = withComputedExperience(
      { fullName: null, workHistory: null },
      { now: NOW },
    );
    expect(updated.computedYearsExperience).toBeNull();
  });
});
