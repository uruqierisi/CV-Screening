import { describe, expect, it } from 'vitest';
import {
  computeExperience,
  describeUndeterminedEntry,
  explainMissingExperience,
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
 * A work-history entry. There is no `isCurrent` any more: an absent `endDate`
 * is the one encoding for "this role has not ended".
 *
 * @param {string | null} startDate
 * @param {string | null} endDate
 */
function job(startDate, endDate) {
  return { employer: null, title: null, startDate, endDate, summary: null };
}

/**
 * The same, with the two fields a recruiter recognises an entry by.
 *
 * @param {string | null} startDate
 * @param {string | null} endDate
 * @param {{ employer?: string | null, title?: string | null }} who
 */
function namedJob(startDate, endDate, who) {
  return { ...job(startDate, endDate), employer: null, title: null, ...who };
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
    it('closes an interval at now when the entry has no end date', () => {
      // This changed with `isCurrent`. An entry used to need `isCurrent: true`
      // to be counted, and one with neither was discarded as `missing_end` -
      // which threw away the ordinary "March 2021 -" current role and could null
      // out a candidate's entire experience. Two encodings of one fact became
      // one, and the extraction prompt states it in the same words.
      const result = computeExperience([job('2025-03', null)], { now: NOW });

      expect(result.segments).toEqual([{ start: '2025-03', end: '2026-03', months: 13 }]);
      expect(result.computedYearsExperience).toBe(1.1);
      expect(result.unusable).toEqual([]);
      expect(result.undetermined).toEqual([]);
    });

    it('reports no reason called missing_end, because there is no such failure', () => {
      // An entry with no end date is never *unusable*: it is either current, or
      // it is undetermined, and those are two different reports. Pinned so
      // nobody re-derives a third state from the code.
      const reasons = computeExperience(
        [job('2019-01', null), job(null, null), job('2021-01', '2019-01')],
        { now: NOW },
      ).unusable.map((entry) => entry.reason);

      expect(reasons).toEqual(['missing_start', 'ends_before_start']);
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

  describe('an absent end date is current only when nothing starts after it', () => {
    it('closes the entry with the latest start at now', () => {
      const result = computeExperience([job('2018-01', '2020-12'), job('2021-03', null)], {
        now: NOW,
      });

      expect(result.segments).toEqual([
        { start: '2018-01', end: '2020-12', months: 36 },
        { start: '2021-03', end: '2026-03', months: 61 },
      ]);
      expect(result.computedYearsExperience).toBe(8.1);
      expect(result.undetermined).toEqual([]);
    });

    it('nulls the whole value when a later role starts after the open entry', () => {
      // The defect this rule exists for: the same entry used to be closed at
      // `now` and produce a decade of experience out of a job that had ended.
      const result = computeExperience([job('2016-01', null), job('2017-06', '2019-06')], {
        now: NOW,
      });

      expect(result.computedYearsExperience).toBeNull();
      expect(result.totalMonths).toBeNull();
      // Not a partial answer either. Dropping the entry and totalling the rest
      // would undercount, which is the same crime in the other direction.
      expect(result.segments).toEqual([]);
      expect(result.undetermined).toEqual([
        {
          index: 0,
          reason: 'open_end_superseded',
          employer: null,
          title: null,
          startDate: '2016-01',
          coveredByOtherRoles: false,
        },
      ]);
    });

    it('reads the ordering from the dates, not from the order the CV lists them', () => {
      const listedNewestFirst = computeExperience(
        [job('2017-06', '2019-06'), job('2016-01', null)],
        { now: NOW },
      );

      expect(listedNewestFirst.computedYearsExperience).toBeNull();
      expect(listedNewestFirst.undetermined.map((entry) => entry.index)).toEqual([1]);
    });

    it('treats entries tied at the latest start as concurrent current roles', () => {
      // Two open entries beginning the same month are two jobs held at once, not
      // an ambiguity - and merged, not summed.
      const result = computeExperience([job('2021-03', null), job('2021-03', null)], { now: NOW });

      expect(result.segments).toEqual([{ start: '2021-03', end: '2026-03', months: 61 }]);
      expect(result.computedYearsExperience).toBe(5.1);
      expect(result.undetermined).toEqual([]);
    });

    it('lets an explicit Present beat the entry position', () => {
      // The word is a claim the candidate made. Ordering only decides what an
      // *absence* means.
      const result = computeExperience([job('2016-01', 'Present'), job('2018-01', '2019-01')], {
        now: NOW,
      });

      expect(result.computedYearsExperience).toBe(10.3);
      expect(result.undetermined).toEqual([]);
    });

    it('counts a role that has not begun as a later start, and says so twice', () => {
      // The accepted cost, pinned rather than left to be discovered: a CV that
      // lists a role starting in the future makes the current role's absent end
      // date ambiguous, and the answer becomes "we could not tell". That is the
      // direction 7-C asks for - nobody is eliminated by it.
      const result = computeExperience([job('2021-03', null), job('2027-01', '2028-01')], {
        now: NOW,
      });

      expect(result.computedYearsExperience).toBeNull();
      expect(result.unusable).toEqual([{ index: 1, reason: 'starts_in_the_future' }]);
      expect(result.undetermined.map((entry) => entry.index)).toEqual([0]);
    });

    describe('the coverage exception', () => {
      const covered = [job('2016-01', null), job('2015-01', '2019-12'), job('2020-01', null)];

      it('stays determinate when the resolvable roles already span the entry through now', () => {
        const result = computeExperience(covered, { now: NOW });

        expect(result.computedYearsExperience).toBe(11.3);
        expect(result.undetermined).toEqual([
          {
            index: 0,
            reason: 'open_end_superseded',
            employer: null,
            title: null,
            startDate: '2016-01',
            coveredByOtherRoles: true,
          },
        ]);
      });

      it('gives exactly the answer it would give without the entry', () => {
        // Which is the entire argument for the exception: whatever end date the
        // CV lost, the merged union is the same, so there is nothing to be
        // uncertain about.
        const withEntry = computeExperience(covered, { now: NOW });
        const withoutEntry = computeExperience(covered.slice(1), { now: NOW });

        expect(withEntry.computedYearsExperience).toBe(withoutEntry.computedYearsExperience);
        expect(withEntry.totalMonths).toBe(withoutEntry.totalMonths);
        expect(withEntry.segments).toEqual(withoutEntry.segments);
      });

      it('does not apply when the cover starts after the entry does', () => {
        const result = computeExperience(
          [job('2016-01', null), job('2016-06', '2019-12'), job('2020-01', null)],
          { now: NOW },
        );

        // Five months of it are outside anything else, so the true end date
        // still moves the total.
        expect(result.computedYearsExperience).toBeNull();
        expect(result.undetermined[0].coveredByOtherRoles).toBe(false);
      });

      it('does not apply when the cover stops before now', () => {
        const result = computeExperience(
          [job('2015-01', null), job('2014-01', '2019-12'), job('2021-06', '2022-06')],
          { now: NOW },
        );

        expect(result.computedYearsExperience).toBeNull();
        expect(result.undetermined[0].coveredByOtherRoles).toBe(false);
      });
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
      const later = computeExperience([job('2025-03', null)], {
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

describe('the four probes from the defect report', () => {
  /**
   * The clock the defect was measured at, kept exactly so the numbers in this
   * block are the numbers in the report and can be checked against it.
   */
  const PROBE_NOW = new Date('2026-08-20T00:00:00Z');

  it('counts a current role, which was always right', () => {
    // 2021-03 through 2026-08 is 66 months. Passes a five-year minimum, and
    // should.
    const result = computeExperience([job('2021-03', null)], { now: PROBE_NOW });
    expect(result.computedYearsExperience).toBe(5.5);
  });

  it('counts a twelve-month job as twelve months when the end date is there', () => {
    // 2016-01 through 2017-01 is 13 months. Fails a five-year minimum, and
    // should.
    const result = computeExperience([job('2016-01', '2017-01')], { now: PROBE_NOW });
    expect(result.computedYearsExperience).toBe(1.1);
  });

  it('refuses to turn the same job into 10.7 years when the end date is missing', () => {
    // The headline defect. With the end date lost and a later role on the CV,
    // the old code closed this entry at `now` and reported 10.7 years - the
    // 128 months from 2016-01 to 2026-08 - which sailed through a five-year
    // minimum on a manufactured number.
    const result = computeExperience(
      [namedJob('2016-01', null, { employer: 'Mercy General', title: 'Staff Nurse' }), job('2017-06', '2019-06')],
      { now: PROBE_NOW },
    );

    expect(result.computedYearsExperience).toBeNull();
    expect(result.undetermined).toEqual([
      {
        index: 0,
        reason: 'open_end_superseded',
        employer: 'Mercy General',
        title: 'Staff Nurse',
        startDate: '2016-01',
        coveredByOtherRoles: false,
      },
    ]);
  });

  it('refuses to turn one summer internship into 11.3 years', () => {
    // 2015-06 to 2026-08 is 135 months, which is what the old code reported for
    // a three-month internship whose end date the CV did not carry.
    const result = computeExperience(
      [
        namedJob('2015-06', null, { employer: 'Riverside Clinic', title: 'Summer Intern' }),
        job('2016-01', '2017-01'),
      ],
      { now: PROBE_NOW },
    );

    expect(result.computedYearsExperience).toBeNull();
    expect(result.undetermined[0].title).toBe('Summer Intern');
  });
});

describe('describeUndeterminedEntry', () => {
  /** @param {Record<string, any>} overrides */
  const entry = (overrides) => ({
    index: 0,
    reason: 'open_end_superseded',
    employer: null,
    title: null,
    startDate: '2016-01',
    coveredByOtherRoles: false,
    ...overrides,
  });

  it('names an entry by title and employer when it has both', () => {
    expect(describeUndeterminedEntry(entry({ title: 'Staff Nurse', employer: 'Mercy General' }))).toBe(
      '"Staff Nurse" at "Mercy General" (started 2016-01)',
    );
  });

  it('falls back to whichever one the CV carried', () => {
    expect(describeUndeterminedEntry(entry({ title: 'Staff Nurse' }))).toBe(
      '"Staff Nurse" (started 2016-01)',
    );
    expect(describeUndeterminedEntry(entry({ employer: 'Mercy General' }))).toBe(
      '"Mercy General" (started 2016-01)',
    );
  });

  it('says so plainly when the entry has neither', () => {
    // Which is common: `employer` and `title` are the fields a badly-parsed CV
    // loses first, and the start date is still enough to find the entry on the
    // page.
    expect(describeUndeterminedEntry(entry({}))).toBe('an unnamed role (started 2016-01)');
  });

  it('treats a blank employer as no employer rather than printing empty quotes', () => {
    const result = computeExperience(
      [namedJob('2016-01', null, { employer: '   ', title: '' }), job('2017-06', '2019-06')],
      { now: NOW },
    );

    expect(result.undetermined[0]).toMatchObject({ employer: null, title: null });
    expect(describeUndeterminedEntry(result.undetermined[0])).toBe(
      'an unnamed role (started 2016-01)',
    );
  });
});

describe('explainMissingExperience', () => {
  it('names the entry whose end date is missing, and why that matters', () => {
    const detail = explainMissingExperience(
      [namedJob('2016-01', null, { employer: 'Mercy General', title: 'Staff Nurse' }), job('2017-06', '2019-06')],
      { now: NOW },
    );

    expect(detail).toBe(
      '"Staff Nurse" at "Mercy General" (started 2016-01) has no end date, and a later role starts after it, so its end is unknown',
    );
  });

  it('lists every offending entry rather than the first', () => {
    const detail = explainMissingExperience(
      [
        namedJob('2015-06', null, { title: 'Summer Intern' }),
        namedJob('2016-01', null, { title: 'Bank Nurse' }),
        job('2017-06', '2019-06'),
      ],
      { now: NOW },
    );

    expect(detail).toContain('"Summer Intern" (started 2015-06)');
    expect(detail).toContain('"Bank Nurse" (started 2016-01)');
    expect(detail.split('; ')).toHaveLength(2);
  });

  it('falls back to the general reason when no entry is to blame', () => {
    expect(explainMissingExperience(null, { now: NOW })).toBe('no usable employment dates');
    expect(explainMissingExperience([job(null, null)], { now: NOW })).toBe(
      'no usable employment dates',
    );
  });

  it('says nothing about an entry the other roles already cover', () => {
    // It did not cause anything: the number is determinate with or without it.
    const covered = [job('2016-01', null), job('2015-01', '2019-12'), job('2020-01', null)];
    expect(explainMissingExperience(covered, { now: NOW })).toBe('no usable employment dates');
  });
});
