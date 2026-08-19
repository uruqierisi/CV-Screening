/**
 * Years of experience, derived from work-history dates rather than believed.
 *
 * The model returns only `statedYearsExperience` - what the CV literally claims.
 * This module computes `computedYearsExperience` from the dates, and the
 * elimination rules read the computed value only. The stated value survives as a
 * discrepancy signal ("CV claims 10 years; dates support 6.5"), which is
 * information a recruiter wants and a number no model should be trusted to
 * produce.
 *
 * Two properties are non-negotiable:
 *
 * - **Overlapping employment is merged, never summed.** Two concurrent jobs in
 *   2021 are one year of experience, not two. Anything else rewards a CV for
 *   listing consultancy clients separately.
 * - **`now` is injected.** Reaching for `Date.now()` here would make every test
 *   of this file expire, and would make a candidate's score depend on when the
 *   worker happened to run.
 *
 * And one deliberate asymmetry: an unresolvable history yields **null**, not 0.
 * Null means "we could not tell" and makes a minimum-experience rule
 * indeterminate; 0 means "no experience" and would fail it. Decision 7-C says
 * absence must never be evidence of failure, and this is where that starts.
 *
 * Granularity is whole months, inclusive of both endpoints: 2020-01 to 2020-12 is
 * 12 months. Day-level precision is discarded, because CVs almost never carry it
 * and pretending otherwise would produce a false precision in the output.
 *
 * Month names are parsed in English only. Plan section 8 already records
 * non-English CVs as a known limitation; this is one of the places it bites, and
 * the failure mode is an unusable entry - reported, never guessed at.
 */

import { MONTHS_PER_YEAR } from '../constants.js';
import { normalizeForMatch } from '../util/text.js';

/**
 * @typedef {import('../schemas/profile.schema.js').WorkExperience} WorkExperience
 * @typedef {import('../schemas/profile.schema.js').Profile} Profile
 *
 * @typedef {object} ExperienceSegment
 * @property {string} start inclusive, `YYYY-MM`
 * @property {string} end inclusive, `YYYY-MM`
 * @property {number} months inclusive month count
 *
 * @typedef {object} UnusableEntry
 * @property {number} index position in the work history as extracted
 * @property {'missing_start' | 'unparseable_start' | 'missing_end' | 'unparseable_end'
 *   | 'ends_before_start' | 'starts_in_the_future'} reason
 *
 * @typedef {object} ComputedExperience
 * @property {number | null} computedYearsExperience one decimal, or null if nothing resolved
 * @property {number | null} totalMonths merged months, or null if nothing resolved
 * @property {ExperienceSegment[]} segments the merged intervals, chronologically
 * @property {UnusableEntry[]} unusable entries that could not be turned into an interval
 */

/**
 * Null-prototype on purpose: a lookup against a plain object literal would
 * resolve `constructor` or `toString` to something truthy, and a work-history
 * entry dated "constructor 2019" would then produce arithmetic on a function
 * instead of an unparseable-date report.
 */
const MONTH_NAMES = Object.freeze(
  Object.assign(Object.create(null), {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  }),
);

/**
 * Words a CV uses for "this job has not ended". Checked before date parsing,
 * because none of them is a date.
 */
const PRESENT_WORDS = Object.freeze([
  'present',
  'current',
  'currently',
  'now',
  'ongoing',
  'to date',
  'today',
]);

const ISO_PATTERN = /^(\d{4})(?:[-/](\d{1,2}))?(?:[-/](\d{1,2}))?$/;
const MONTH_NAME_FIRST_PATTERN = /^([a-z]+)\.? (\d{4})$/;
const MONTH_NAME_LAST_PATTERN = /^(\d{1,2})[-/](\d{4})$/;

/**
 * @param {number} year
 * @param {number} month 1..12
 * @returns {number} months since year 0, so intervals compare as plain integers
 */
function toMonthIndex(year, month) {
  return year * MONTHS_PER_YEAR + (month - 1);
}

/**
 * @param {number} monthIndex
 * @returns {string} `YYYY-MM`
 */
function toIsoMonth(monthIndex) {
  const year = Math.floor(monthIndex / MONTHS_PER_YEAR);
  const month = (monthIndex % MONTHS_PER_YEAR) + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/**
 * Parses a CV date into a year and, if it says so, a month.
 *
 * @param {string} value
 * @returns {{ year: number, month: number | null } | null} null when nothing usable is there
 */
export function parseCvDate(value) {
  const normalized = normalizeForMatch(value);
  if (normalized.length === 0) {
    return null;
  }

  const iso = ISO_PATTERN.exec(normalized);
  if (iso !== null) {
    const year = Number(iso[1]);
    if (iso[2] === undefined) {
      return { year, month: null };
    }
    const month = Number(iso[2]);
    return month >= 1 && month <= MONTHS_PER_YEAR ? { year, month } : null;
  }

  const named = MONTH_NAME_FIRST_PATTERN.exec(normalized);
  if (named !== null) {
    const month = MONTH_NAMES[named[1]];
    return month === undefined ? null : { year: Number(named[2]), month };
  }

  const numericFirst = MONTH_NAME_LAST_PATTERN.exec(normalized);
  if (numericFirst !== null) {
    const month = Number(numericFirst[1]);
    return month >= 1 && month <= MONTHS_PER_YEAR ? { year: Number(numericFirst[2]), month } : null;
  }

  return null;
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isPresentWord(value) {
  return PRESENT_WORDS.includes(normalizeForMatch(value));
}

/**
 * Turns one work-history entry into a closed month interval, or explains why it
 * could not.
 *
 * A year-only start is taken as January and a year-only end as December: the
 * entry says "2019 to 2021", and reading that as one month in each year would
 * understate three years of work as two.
 *
 * @param {WorkExperience} entry
 * @param {number} nowIndex
 * @returns {{ start: number, end: number } | { reason: UnusableEntry['reason'] }}
 */
function resolveInterval(entry, nowIndex) {
  if (entry.startDate === null) {
    return { reason: 'missing_start' };
  }

  const start = parseCvDate(entry.startDate);
  if (start === null) {
    return { reason: 'unparseable_start' };
  }

  const startIndex = toMonthIndex(start.year, start.month ?? 1);
  if (startIndex > nowIndex) {
    return { reason: 'starts_in_the_future' };
  }

  const endIndex = resolveEndIndex(entry, nowIndex);
  if (typeof endIndex !== 'number') {
    return endIndex;
  }

  if (endIndex < startIndex) {
    return { reason: 'ends_before_start' };
  }

  return { start: startIndex, end: endIndex };
}

/**
 * @param {WorkExperience} entry
 * @param {number} nowIndex
 * @returns {number | { reason: UnusableEntry['reason'] }}
 */
function resolveEndIndex(entry, nowIndex) {
  if (entry.endDate === null) {
    // `isCurrent` is tri-state on purpose. True closes the interval at `now`;
    // null means the CV did not say, and guessing "still there" would hand a
    // candidate every month since their last dated job.
    return entry.isCurrent === true ? nowIndex : { reason: 'missing_end' };
  }

  if (isPresentWord(entry.endDate)) {
    return nowIndex;
  }

  const end = parseCvDate(entry.endDate);
  if (end === null) {
    return { reason: 'unparseable_end' };
  }

  const endIndex = toMonthIndex(end.year, end.month ?? MONTHS_PER_YEAR);
  // A future end date is a typo or an expected leaving date. Either way it is not
  // experience already had, so it is clamped rather than counted or discarded.
  return Math.min(endIndex, nowIndex);
}

/**
 * Merges overlapping and adjacent intervals. THE function of this module: two
 * jobs held at once are one span of time.
 *
 * @param {{ start: number, end: number }[] } intervals
 * @returns {{ start: number, end: number }[]}
 */
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  /** @type {{ start: number, end: number }[]} */
  const merged = [];

  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    // `last.end + 1` merges adjacency as well as overlap: leaving one job in June
    // and starting the next in July is continuous employment, and reporting it as
    // two segments would be noise in the audit trail.
    if (last !== undefined && interval.start <= last.end + 1) {
      last.end = Math.max(last.end, interval.end);
      continue;
    }
    merged.push({ start: interval.start, end: interval.end });
  }

  return merged;
}

/**
 * @param {WorkExperience[] | null} workHistory
 * @param {object} params
 * @param {Date} params.now injected, never read from the clock
 * @returns {ComputedExperience}
 * @throws {TypeError} if `now` is not a valid Date - a missing clock must be
 *   loud, because the silent alternative is a score that changes with the date
 */
export function computeExperience(workHistory, { now } = /** @type {any} */ ({})) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('computeExperience requires an injected `now` Date');
  }

  const nowIndex = toMonthIndex(now.getUTCFullYear(), now.getUTCMonth() + 1);
  const entries = Array.isArray(workHistory) ? workHistory : [];

  /** @type {{ start: number, end: number }[]} */
  const intervals = [];
  /** @type {UnusableEntry[]} */
  const unusable = [];

  entries.forEach((entry, index) => {
    const resolved = resolveInterval(entry, nowIndex);
    if ('reason' in resolved) {
      unusable.push({ index, reason: resolved.reason });
      return;
    }
    intervals.push(resolved);
  });

  if (intervals.length === 0) {
    // Null, not zero. See the header: absence is not evidence of failure.
    return { computedYearsExperience: null, totalMonths: null, segments: [], unusable };
  }

  const merged = mergeIntervals(intervals);
  const segments = merged.map((interval) => ({
    start: toIsoMonth(interval.start),
    end: toIsoMonth(interval.end),
    months: interval.end - interval.start + 1,
  }));
  const totalMonths = segments.reduce((sum, segment) => sum + segment.months, 0);

  return {
    computedYearsExperience: monthsToYears(totalMonths),
    totalMonths,
    segments,
    unusable,
  };
}

/**
 * Months to years at one decimal.
 *
 * The rounding cannot move a candidate across an integer year boundary: for that
 * it would need a month count in [12y - 0.6, 12y), which contains no integer. So
 * a minimum-experience rule comparing against the rounded value gives the same
 * answer as one comparing months, and the recruiter sees a number that matches
 * what the rule did.
 *
 * @param {number} months
 * @returns {number}
 */
export function monthsToYears(months) {
  return Math.round((months * 10) / MONTHS_PER_YEAR) / 10;
}

/**
 * Returns a copy of the profile carrying `computedYearsExperience`.
 *
 * A copy, not a mutation: the extracted profile is the audit record of what the
 * model said, and code that edits it in place makes "what did extraction
 * actually return" unanswerable.
 *
 * @param {Profile} profile
 * @param {object} params
 * @param {Date} params.now
 * @returns {{ profile: import('../schemas/profile.schema.js').VerifiedProfile, experience: ComputedExperience }}
 */
export function withComputedExperience(profile, { now }) {
  const experience = computeExperience(profile.workHistory, { now });
  return {
    profile: { ...profile, computedYearsExperience: experience.computedYearsExperience },
    experience,
  };
}
