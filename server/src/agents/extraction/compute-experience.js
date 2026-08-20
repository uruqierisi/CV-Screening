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
 * Three properties are non-negotiable:
 *
 * - **Overlapping employment is merged, never summed.** Two concurrent jobs in
 *   2021 are one year of experience, not two. Anything else rewards a CV for
 *   listing consultancy clients separately.
 * - **`now` is injected.** Reaching for `Date.now()` here would make every test
 *   of this file expire, and would make a candidate's score depend on when the
 *   worker happened to run.
 * - **A number comes back only when the dates support one.** Where they do not,
 *   the answer is `null` - never a plausible figure derived from a guess.
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
 *
 * ## An absent end date is *current* only when nothing starts after it
 *
 * This is the one judgement in this file worth arguing with, and it has been
 * wrong twice in opposite directions. Both are kept, because the rule below is
 * only defensible against both of them.
 *
 * **First encoding.** The work-history entry carried a tri-state `isCurrent`
 * beside `endDate`, so an entry with neither was "the CV did not say when this
 * ended" and became an **unusable** entry contributing nothing. That threw away
 * the ordinary "March 2021 -" current role and could null out a candidate's
 * entire experience. It also cost an optional parameter out of a schema budget
 * of 24 - see `profile.schema.js` - so `isCurrent` was deleted.
 *
 * **Second encoding, and the defect it caused.** With `isCurrent` gone, *every*
 * absent `endDate` was read as "still there" and closed at `now`. That is right
 * for a current role and badly wrong for a finished one whose end date the
 * extraction lost. Measured at `now = 2026-08`, a single twelve-month job
 * written `2016-01 - 2017-01` computes **1.1 years** and fails a five-year
 * minimum; the *same job* with its end date missing computed **10.7 years** and
 * passed it. One summer internship dated `2015-06` with no end computed **11.3
 * years**. The elimination detail then read *"10.7 years computed from dates,
 * minimum 5"* - a manufactured number wearing the clothes of a measurement.
 *
 * **The rule now.** An entry with `endDate === null` is **current, and closes at
 * `now`, if and only if no other entry in the work history starts strictly
 * later.** A CV lists roles as a sequence; if the candidate started another role
 * after this one, this one ended, whatever the CV forgot to say. Entries tied at
 * the latest start date are concurrent current roles, not an ambiguity, and all
 * of them close at `now`.
 *
 * Otherwise the absent end is an **extraction gap**, and
 * `computedYearsExperience` becomes `null` - the whole value, not just that
 * entry. Dropping the entry and totalling the rest would undercount, which is
 * the same crime in the other direction and produces the same thing this module
 * exists to refuse: a confident number nobody can account for. The recruiter is
 * told the years could not be determined and which entry caused it, and
 * `on_missing` then decides, exactly as it does for every other unknown fact.
 *
 * **The one exception, because it costs nothing to be right here.** If the
 * intervals that *are* resolvable already cover the span from the unresolvable
 * entry's start through `now`, then whatever its true end date, the merged union
 * is unchanged - the entry cannot move the total by a single month. The answer
 * stays determinate and is returned. Without this, a CV listing contiguous or
 * overlapping roles would go indeterminate over a gap that provably cannot
 * change the answer, which is a false alarm, and false alarms train a recruiter
 * to ignore the badge.
 *
 * Everything else about `endDate` is unchanged: an explicit "Present" or
 * "Current" is still a current role however the entry is ordered, a future end
 * date is still clamped back to `now`, and an unparseable end date is still its
 * own `unusable` reason.
 *
 * **The cost of the rule, stated rather than buried.** A CV that lists a genuine
 * current role *before* a short later contract - or that lists a role starting in
 * the future - now yields `null` where the old code yielded a number. That is
 * the trade decision 7-C asks for: an admitted gap a recruiter can see beats a
 * confident wrong number they cannot.
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
 * @property {'missing_start' | 'unparseable_start' | 'unparseable_end'
 *   | 'ends_before_start' | 'starts_in_the_future'} reason
 *
 * @typedef {object} UndeterminedEntry an open-ended entry that is not current
 * @property {number} index position in the work history as extracted
 * @property {'open_end_superseded'} reason a later role starts after this one, so
 *   the absent end date is an extraction gap rather than "still there"
 * @property {string | null} employer as extracted, so the entry can be named
 * @property {string | null} title as extracted
 * @property {string} startDate as the CV wrote it
 * @property {boolean} coveredByOtherRoles when true, the resolvable intervals
 *   already span this entry's start through `now`, so no possible end date
 *   changes the total and the result stays determinate
 *
 * @typedef {object} ComputedExperience
 * @property {number | null} computedYearsExperience one decimal, or null when the
 *   dates do not determine an answer
 * @property {number | null} totalMonths merged months, or null on the same terms
 * @property {ExperienceSegment[]} segments the merged intervals, chronologically;
 *   empty whenever the result is null, because half a timeline reads as fact
 * @property {UnusableEntry[]} unusable entries that could not be turned into an interval
 * @property {UndeterminedEntry[]} undetermined open-ended entries that are not
 *   current; any one of them with `coveredByOtherRoles: false` nulls the result
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
 * A field a recruiter will read, or null. An empty or whitespace-only employer is
 * not a name, and printing one in an elimination reason produces `""`.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function textOrNull(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * The start of one entry as a month index, or why there is not one.
 *
 * A year-only start is taken as January: the entry says "2019 to 2021", and
 * reading that as one month in each year would understate three years of work as
 * two.
 *
 * @param {WorkExperience} entry
 * @returns {{ startIndex: number } | { reason: 'missing_start' | 'unparseable_start' }}
 */
function resolveStart(entry) {
  if (entry.startDate === null) {
    return { reason: 'missing_start' };
  }

  const start = parseCvDate(entry.startDate);
  if (start === null) {
    return { reason: 'unparseable_start' };
  }

  return { startIndex: toMonthIndex(start.year, start.month ?? 1) };
}

/**
 * The latest start date anywhere in the history, which is the whole basis of the
 * current-role rule: an entry with no end date is current exactly when nothing
 * starts after it.
 *
 * Entries whose start cannot be read are ignored - they cannot establish an
 * ordering. Entries whose *end* is unusable are **not** ignored: a later role
 * with a garbled end date is still a later role, and still says the earlier one
 * finished.
 *
 * @param {WorkExperience[]} entries
 * @returns {number | null} null when no entry has a readable start date
 */
function findLatestStartIndex(entries) {
  /** @type {number | null} */
  let latest = null;

  for (const entry of entries) {
    const start = resolveStart(entry);
    if ('startIndex' in start && (latest === null || start.startIndex > latest)) {
      latest = start.startIndex;
    }
  }

  return latest;
}

/**
 * Turns one work-history entry into a closed month interval, or explains why it
 * could not.
 *
 * A year-only end is taken as December, the mirror image of the reason a
 * year-only start is taken as January.
 *
 * @param {WorkExperience} entry
 * @param {object} ctx
 * @param {number} ctx.nowIndex
 * @param {number | null} ctx.latestStartIndex
 * @returns {{ start: number, end: number }
 *   | { undetermined: true, startIndex: number }
 *   | { reason: UnusableEntry['reason'] }}
 */
function resolveInterval(entry, { nowIndex, latestStartIndex }) {
  const start = resolveStart(entry);
  if ('reason' in start) {
    return start;
  }

  const { startIndex } = start;
  if (startIndex > nowIndex) {
    return { reason: 'starts_in_the_future' };
  }

  const endIndex = resolveEndIndex(entry, { nowIndex, startIndex, latestStartIndex });
  if (typeof endIndex !== 'number') {
    return 'reason' in endIndex ? endIndex : { undetermined: true, startIndex };
  }

  if (endIndex < startIndex) {
    return { reason: 'ends_before_start' };
  }

  return { start: startIndex, end: endIndex };
}

/**
 * @param {WorkExperience} entry
 * @param {object} ctx
 * @param {number} ctx.nowIndex
 * @param {number} ctx.startIndex this entry's start, already resolved
 * @param {number | null} ctx.latestStartIndex never null when this is reached -
 *   this entry has a readable start, so at least one exists
 * @returns {number | { undetermined: true } | { reason: UnusableEntry['reason'] }}
 */
function resolveEndIndex(entry, { nowIndex, startIndex, latestStartIndex }) {
  if (entry.endDate === null) {
    // The rule from the header. `>=` rather than `===` so that entries tied at
    // the latest start are all current: two concurrent roles both written with no
    // end date are two current roles, not an ambiguity.
    return startIndex >= /** @type {number} */ (latestStartIndex)
      ? nowIndex
      : { undetermined: true };
  }

  if (isPresentWord(entry.endDate)) {
    // An explicit word beats position in the list. The candidate said it.
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
 * The coverage exception: is `[startIndex, nowIndex]` already inside one merged
 * segment?
 *
 * The segments are disjoint and non-adjacent by the time this runs, so a span
 * they cover must sit inside a single one of them. If it does, an entry starting
 * at `startIndex` contributes nothing whatever its true end date - every possible
 * end lies between its start and `now`, and that whole range is already counted.
 *
 * @param {{ start: number, end: number }[]} merged
 * @param {number} startIndex
 * @param {number} nowIndex
 * @returns {boolean}
 */
function coversThroughNow(merged, startIndex, nowIndex) {
  return merged.some((segment) => segment.start <= startIndex && segment.end >= nowIndex);
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
  const latestStartIndex = findLatestStartIndex(entries);

  /** @type {{ start: number, end: number }[]} */
  const intervals = [];
  /** @type {UnusableEntry[]} */
  const unusable = [];
  /** @type {{ index: number, entry: WorkExperience, startIndex: number }[]} */
  const openEnded = [];

  entries.forEach((entry, index) => {
    const resolved = resolveInterval(entry, { nowIndex, latestStartIndex });
    if ('reason' in resolved) {
      unusable.push({ index, reason: resolved.reason });
      return;
    }
    if ('undetermined' in resolved) {
      openEnded.push({ index, entry, startIndex: resolved.startIndex });
      return;
    }
    intervals.push(resolved);
  });

  const merged = mergeIntervals(intervals);

  /** @type {UndeterminedEntry[]} */
  const undetermined = openEnded.map(({ index, entry, startIndex }) => ({
    index,
    reason: /** @type {'open_end_superseded'} */ ('open_end_superseded'),
    employer: textOrNull(entry.employer),
    title: textOrNull(entry.title),
    startDate: /** @type {string} */ (entry.startDate),
    coveredByOtherRoles: coversThroughNow(merged, startIndex, nowIndex),
  }));

  const blocking = undetermined.filter((entry) => !entry.coveredByOtherRoles);

  if (intervals.length === 0 || blocking.length > 0) {
    // Null, not zero - and null for the whole value rather than a total with the
    // offending entry quietly dropped. See the header: absence is not evidence of
    // failure, and an undercount is not an improvement on an overcount.
    return {
      computedYearsExperience: null,
      totalMonths: null,
      segments: [],
      unusable,
      undetermined,
    };
  }

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
    undetermined,
  };
}

/**
 * Names one open-ended entry the way a recruiter would recognise it on the page.
 *
 * @param {UndeterminedEntry} entry
 * @returns {string}
 */
export function describeUndeterminedEntry(entry) {
  const title = entry.title === null ? null : `"${entry.title}"`;
  const employer = entry.employer === null ? null : `"${entry.employer}"`;
  const named =
    title !== null && employer !== null
      ? `${title} at ${employer}`
      : (title ?? employer ?? 'an unnamed role');

  return `${named} (started ${entry.startDate})`;
}

/**
 * Why the years could not be determined, in one clause a recruiter can act on.
 *
 * Called only when `computedYearsExperience` is null. It recomputes rather than
 * reading a stored diagnostic, because the diagnostic is not on the profile:
 * `parsed_profile` holds the facts the model extracted, not this module's
 * working. The recomputation is pure, bounded by the length of the work history,
 * and takes the same injected `now` as the rest of the evaluation - so it agrees
 * with the stored value whenever the caller passes the clock that value was
 * computed with. Where it does not agree, the generic clause is returned rather
 * than a claim about a specific entry.
 *
 * @param {WorkExperience[] | null} workHistory
 * @param {object} params
 * @param {Date} params.now
 * @returns {string}
 */
export function explainMissingExperience(workHistory, { now }) {
  const { undetermined } = computeExperience(workHistory, { now });
  const blocking = undetermined.filter((entry) => !entry.coveredByOtherRoles);

  if (blocking.length === 0) {
    return 'no usable employment dates';
  }

  return blocking
    .map(
      (entry) =>
        `${describeUndeterminedEntry(entry)} has no end date, and a later role starts after it, so its end is unknown`,
    )
    .join('; ');
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
