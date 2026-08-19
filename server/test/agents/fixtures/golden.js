/**
 * The golden fixture: one realistic candidate, hand-written, with the expected
 * output written out in full rather than snapshotted.
 *
 * A snapshot would record whatever the code did on the day it was written. These
 * numbers were worked out on paper first - 8x30 + 6x20 + 9x20 + 7x15 + 5x10 +
 * 6x5 = 240 + 120 + 180 + 105 + 50 + 30 = 725, so 72.5 and a Potential Match -
 * which means the test can fail in a way that means something.
 *
 * Everything is deep-frozen. The scoring layer claims to be pure; frozen inputs
 * turn that claim into a runtime assertion, because a stray mutation throws in
 * strict mode instead of passing silently.
 */

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze(/** @type {any} */ (value)[key]);
    }
  }
  return value;
}

/** Fixed clock. Nothing in the deterministic core may read the real one. */
export const GOLDEN_NOW_ISO = '2026-03-15T09:30:00.000Z';

export const GOLDEN_ROLE = deepFreeze({
  id: '3f8c2b1e-9d4a-4c6f-8a71-2e5b7c9d0a11',
  title: 'Senior Backend Engineer (Node.js)',
  version: 4,
  criteria: [
    {
      id: 'c-node',
      label: 'Backend engineering depth (Node.js)',
      description: 'Production Node.js, and the reasons behind the choices.',
      weight: 30,
      position: 0,
    },
    {
      id: 'c-api',
      label: 'API and distributed systems design',
      description: 'HTTP semantics, versioning, idempotency, failure isolation.',
      weight: 20,
      position: 1,
    },
    {
      id: 'c-data',
      label: 'Relational data modelling',
      description: 'Schema design, indexing, transaction boundaries, migrations.',
      weight: 20,
      position: 2,
    },
    {
      id: 'c-test',
      label: 'Testing and code quality',
      description: 'Tests written alongside the code, failure paths covered.',
      weight: 15,
      position: 3,
    },
    {
      id: 'c-cloud',
      label: 'Cloud infrastructure and CI/CD',
      description: 'Containers, pipelines that gate a deploy, observability.',
      weight: 10,
      position: 4,
    },
    {
      id: 'c-comms',
      label: 'Collaboration and written communication',
      description: 'Design documents, mentoring, incident write-ups.',
      weight: 5,
      position: 5,
    },
  ],
  eliminationRules: [
    {
      id: 'r-years',
      label: 'At least 5 years of professional software engineering experience',
      type: 'min_years_experience',
      value: { years: 5 },
      onMissing: 'flag',
      position: 0,
    },
    {
      id: 'r-pg',
      label: 'Demonstrated production PostgreSQL experience',
      type: 'required_skill',
      value: { skill: 'PostgreSQL', matchMode: 'normalized', mustBeDemonstrated: true },
      onMissing: 'flag',
      position: 1,
    },
    {
      id: 'r-loc',
      label: 'Authorised to work in the UK, Ireland or Germany',
      type: 'location_allowlist',
      value: { countryCodes: ['GB', 'IE', 'DE'] },
      onMissing: 'eliminate',
      position: 2,
    },
  ],
});

/** The source text the profile below was extracted from. */
export const GOLDEN_CV_TEXT = [
  'PRIYA RAMANATHAN — Senior Software Engineer — Manchester, United Kingdom',
  '',
  'EXPERIENCE',
  'Northwind Logistics — Senior Backend Engineer — March 2021 to Present',
  'Rebuilt the shipment tracking service in Node.js, cutting p99 latency from 1.8s to 240ms.',
  'Designed the PostgreSQL schema behind it and wrote the partitioning migration that let us',
  'keep four years of events online without a maintenance window.',
  '',
  'Halcyon Payments — Backend Engineer — June 2018 to February 2021',
  'Built and owned the settlement API. Introduced contract tests between six services.',
  '',
  'EDUCATION',
  'BSc Computer Science, University of Leeds, 2014 - 2017',
].join('\n');

export const GOLDEN_PROFILE = deepFreeze({
  fullName: 'Priya Ramanathan',
  email: 'priya.ramanathan@example.com',
  phone: null,
  linkedinUrl: null,
  location: { raw: 'Manchester, United Kingdom', city: 'Manchester', region: null, countryCode: 'GB' },
  headline: 'Senior Software Engineer',
  summary: null,
  statedYearsExperience: 9,
  workHistory: [
    {
      employer: 'Northwind Logistics',
      title: 'Senior Backend Engineer',
      startDate: '2021-03',
      endDate: null,
      isCurrent: true,
      summary: 'Rebuilt the shipment tracking service in Node.js.',
    },
    {
      employer: 'Halcyon Payments',
      title: 'Backend Engineer',
      startDate: '2018-06',
      endDate: '2021-02',
      isCurrent: false,
      summary: 'Built and owned the settlement API.',
    },
  ],
  education: [
    {
      institution: 'University of Leeds',
      degree: 'BSc Computer Science',
      field: 'Computer Science',
      level: 'bachelors',
      startDate: '2014',
      endDate: '2017',
    },
  ],
  certifications: [],
  skills: [
    {
      name: 'Node.js',
      evidenceType: 'demonstrated',
      evidenceQuote: 'Rebuilt the shipment tracking service in Node.js',
    },
    {
      name: 'PostgreSQL',
      evidenceType: 'demonstrated',
      evidenceQuote: 'Designed the PostgreSQL schema behind it',
    },
    { name: 'Kubernetes', evidenceType: 'listed_only', evidenceQuote: null },
  ],
  // Set by compute-experience.js, not by the model. June 2018 to February 2021
  // is 33 months and March 2021 to March 2026 is 61 months, adjacent, so 94
  // months merged = 7.8 years.
  computedYearsExperience: 7.8,
});

export const GOLDEN_EVALUATION = deepFreeze({
  ratings: [
    {
      criterionId: 'c-node',
      rating: 8,
      reason: 'Rebuilt a production Node.js service and quotes the latency result.',
      evidence: 'cutting p99 latency from 1.8s to 240ms',
    },
    {
      criterionId: 'c-api',
      rating: 6,
      reason: 'Owned a settlement API, but the CV does not describe its interface decisions.',
      evidence: 'Built and owned the settlement API',
    },
    {
      criterionId: 'c-data',
      rating: 9,
      reason: 'Designed a PostgreSQL schema and shipped an online partitioning migration.',
      evidence: 'the partitioning migration that let us keep four years of events online',
    },
    {
      criterionId: 'c-test',
      rating: 7,
      reason: 'Introduced contract tests between six services.',
      evidence: 'Introduced contract tests between six services',
    },
    {
      criterionId: 'c-cloud',
      rating: 5,
      reason: 'Infrastructure is implied by the work but never described.',
      evidence: null,
    },
    {
      criterionId: 'c-comms',
      rating: 6,
      reason: 'Mentions owning a service end to end; no writing or mentoring is described.',
      evidence: null,
    },
  ],
  summary: 'Strong backend and data modelling depth; infrastructure evidence is thin.',
});

/**
 * Worked out by hand from the weights above, and the reason this fixture is
 * worth having: if the arithmetic ever changes, this number changes with it.
 */
export const GOLDEN_EXPECTED = deepFreeze({
  scoreRaw: 725,
  score: 72.5,
  fitCategory: 'potential_match',
  eliminated: false,
});
