/**
 * Real API payloads, captured from the running server on 2026-08-20.
 *
 * Hand-written fixtures drift from the contract the moment somebody guesses a
 * field name. These were taken from actual responses - `GET /config`,
 * `GET /roles`, `GET /candidates` and `GET /candidates/:id` - and trimmed only
 * where a value is long prose. Every key is a key the API really sends.
 */

export const CONFIG = {
  upload: {
    maxFileBytes: 5242880,
    maxBatchFiles: 50,
    acceptedMimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ],
  },
  scoring: {
    requiredWeightSum: 100,
    weightMin: 1,
    weightMax: 100,
    ratingMin: 0,
    ratingMax: 10,
    scoreMin: 0,
    scoreMax: 100,
    tierThresholds: { STRONG_MATCH_MIN: 85, POTENTIAL_MATCH_MIN: 65 },
    fitCategories: ['strong_match', 'potential_match', 'unmatched'],
  },
  eliminationRules: {
    types: [
      'min_years_experience',
      'required_skill',
      'required_education_level',
      'required_certification',
      'location_allowlist',
    ],
    onMissingModes: ['flag', 'eliminate'],
    descriptors: {
      min_years_experience: {
        label: 'Minimum years of experience',
        fields: [{ name: 'years', type: 'integer', min: 0, max: 60 }],
      },
      required_skill: {
        label: 'Required skill',
        fields: [
          { name: 'skill', type: 'string' },
          { name: 'matchMode', type: 'enum', options: ['exact', 'normalized'] },
          { name: 'mustBeDemonstrated', type: 'boolean' },
        ],
      },
      required_education_level: {
        label: 'Required education level',
        fields: [
          {
            name: 'level',
            type: 'enum',
            options: ['none', 'high_school', 'associate', 'bachelors', 'masters', 'doctorate'],
          },
        ],
      },
      required_certification: {
        label: 'Required certification',
        fields: [
          { name: 'name', type: 'string' },
          { name: 'matchMode', type: 'enum', options: ['exact', 'normalized'] },
        ],
      },
      location_allowlist: {
        label: 'Allowed locations',
        fields: [
          { name: 'countryCodes', type: 'string[]', pattern: 'ISO-3166-1 alpha-2, upper case' },
        ],
      },
    },
  },
  candidates: {
    statuses: ['pending', 'parsing', 'evaluating', 'done', 'failed'],
    maxStatusIds: 200,
  },
  jobs: { statuses: ['queued', 'in_progress', 'completed', 'completed_with_failures'] },
  pagination: { defaultPageSize: 25, maxPageSize: 100 },
};

export const ROLE = {
  id: '3f8c2b1e-9d4a-4c6f-8a71-2e5b7c9d0a11',
  title: 'Senior Backend Engineer',
  description: 'Payments platform.',
  version: 1,
  archived: false,
  archivedAt: null,
  criteria: [
    {
      id: '570db4b4-b125-4254-9490-290dbe8288ed',
      label: 'Backend engineering depth (Node.js)',
      description: 'Runtime behaviour, async control flow, performance.',
      weight: 30,
      position: 0,
    },
    {
      id: '924dd912-204a-41f9-a48f-29eec27e1d0b',
      label: 'API and distributed systems design',
      description: 'Interfaces others have to live with.',
      weight: 20,
      position: 1,
    },
    {
      id: '52a50da7-3784-4d0c-8476-3454b1f98161',
      label: 'Relational data modelling',
      description: 'Schema design and transaction boundaries.',
      weight: 20,
      position: 2,
    },
    {
      id: '217ed0b8-b57d-414f-9cc6-ecf64615fd9d',
      label: 'Testing and code quality',
      description: 'Failure-path coverage.',
      weight: 15,
      position: 3,
    },
    {
      id: 'fdf57e02-1e6f-4328-9610-2342ea3e6e9a',
      label: 'Cloud infrastructure and CI/CD',
      description: 'Pipelines and deployment gates.',
      weight: 10,
      position: 4,
    },
    {
      id: '0eba2827-09b3-4de7-a7d6-49aa73f0c7f5',
      label: 'Collaboration and written communication',
      description: 'Design documents and incident write-ups.',
      weight: 5,
      position: 5,
    },
  ],
  eliminationRules: [
    {
      id: 'fc842cf1-97a7-495d-a845-32f8b3370479',
      label: 'At least 5 years of professional software engineering experience',
      type: 'min_years_experience',
      value: { years: 5 },
      onMissing: 'flag',
      position: 0,
    },
    {
      id: 'c5720406-cc95-4a47-93f0-ef0972200f4d',
      label: 'Demonstrated production PostgreSQL experience',
      type: 'required_skill',
      value: { skill: 'PostgreSQL', matchMode: 'normalized', mustBeDemonstrated: true },
      onMissing: 'flag',
      position: 1,
    },
    {
      id: '5ae932bd-277c-434f-8396-33ed9e9eed29',
      label: 'Authorised to work in the UK, Ireland or Germany',
      type: 'location_allowlist',
      value: { countryCodes: ['GB', 'IE', 'DE'] },
      onMissing: 'eliminate',
      position: 2,
    },
  ],
  createdAt: '2026-08-19T08:47:01.022Z',
  updatedAt: '2026-08-19T08:47:01.022Z',
};

export const CANDIDATE_LIST_ROW = {
  id: 'bffde37e-4c4f-4071-9c57-e8b6593c0d0a',
  roleId: ROLE.id,
  jobId: '264aeb41-5a4d-4b5f-b250-724568d374c7',
  candidateName: 'Priya Ramanathan',
  originalFilename: 'clean.pdf',
  status: 'done',
  matchScore: 50,
  fitCategory: 'unmatched',
  eliminated: false,
  eliminatedBy: null,
  errorCode: null,
  createdAt: '2026-08-20T11:37:29.566Z',
  completedAt: '2026-08-20T11:52:16.574Z',
};

export const CANDIDATE_DETAIL = {
  ...CANDIDATE_LIST_ROW,
  parsedProfile: {
    email: 'priya.ramanathan@example.com',
    phone: '+44 20 7946 0102',
    skills: [
      {
        name: 'Node.js',
        evidenceType: 'listed_only',
        evidenceQuote: null,
        evidenceVerified: null,
      },
      {
        name: 'PostgreSQL',
        evidenceType: 'demonstrated',
        evidenceQuote: 'Led the migration of the ledger service to PostgreSQL 14,',
        evidenceVerified: true,
      },
    ],
    fullName: 'Priya Ramanathan',
    location: { city: 'London', region: null, countryCode: 'GB' },
    education: [
      {
        field: 'Computer Science',
        level: 'bachelors',
        degree: 'BSc',
        endDate: '2015',
        institution: 'University of Manchester',
      },
    ],
    linkedinUrl: null,
    workHistory: [
      {
        title: 'Senior Backend Engineer',
        endDate: 'present',
        summary: 'Led the migration of the ledger service to PostgreSQL 14.',
        employer: 'Northwind Payments',
        startDate: 'January 2019',
      },
    ],
    certifications: [
      {
        name: 'AWS Certified Solutions Architect - Associate',
        issuer: null,
        expiryDate: null,
        issuedDate: '2021',
      },
    ],
    statedYearsExperience: 9,
    computedYearsExperience: 10.5,
  },
  evaluationMatrix: {
    scoreRaw: 500,
    computedAt: '2026-08-20T11:51:46.733Z',
    criteria: [
      {
        label: 'Backend engineering depth (Node.js)',
        rating: 3,
        reason: 'Node.js appears only as a listed skill with no supporting quote.',
        weight: 30,
        evidence: "Skills: 'Node.js' evidenceType: listed_only",
        criterionId: '570db4b4-b125-4254-9490-290dbe8288ed',
        weightedPoints: 90,
      },
      {
        label: 'API and distributed systems design',
        rating: 7,
        reason: 'Designed the idempotency layer behind a public payments API.',
        weight: 20,
        evidence: "'Designed the idempotency layer behind the public payments API.'",
        criterionId: '924dd912-204a-41f9-a48f-29eec27e1d0b',
        weightedPoints: 140,
      },
      {
        label: 'Relational data modelling',
        rating: 7,
        reason: 'Led a PostgreSQL 14 migration with a measured outcome.',
        weight: 20,
        evidence: "'Led the migration of the ledger service to PostgreSQL 14'",
        criterionId: '52a50da7-3784-4d0c-8476-3454b1f98161',
        weightedPoints: 140,
      },
      {
        label: 'Testing and code quality',
        rating: 6,
        reason: 'Contract testing across six services.',
        weight: 15,
        evidence: "'Introduced contract testing across six internal services.'",
        criterionId: '217ed0b8-b57d-414f-9cc6-ecf64615fd9d',
        weightedPoints: 90,
      },
      {
        label: 'Cloud infrastructure and CI/CD',
        rating: 3,
        reason: 'Cloud skills are listed only.',
        weight: 10,
        evidence: "skills 'Docker', 'Terraform' all evidenceType: listed_only",
        criterionId: 'fdf57e02-1e6f-4328-9610-2342ea3e6e9a',
        weightedPoints: 30,
      },
      {
        label: 'Collaboration and written communication',
        rating: 2,
        reason: 'No design documents or write-ups appear.',
        weight: 5,
        evidence: null,
        criterionId: '0eba2827-09b3-4de7-a7d6-49aa73f0c7f5',
        weightedPoints: 10,
      },
    ],
  },
  eliminationDetails: {
    results: [
      {
        type: 'min_years_experience',
        label: 'At least 5 years of professional software engineering experience',
        detail: '10.5 years computed from dates, minimum 5',
        ruleId: 'fc842cf1-97a7-495d-a845-32f8b3370479',
        outcome: 'pass',
        onMissing: 'flag',
        eliminates: false,
      },
      {
        type: 'required_skill',
        label: 'Demonstrated production PostgreSQL experience',
        detail: 'skill "PostgreSQL" is demonstrated in the CV',
        ruleId: 'c5720406-cc95-4a47-93f0-ef0972200f4d',
        outcome: 'pass',
        onMissing: 'flag',
        eliminates: false,
      },
      {
        type: 'location_allowlist',
        label: 'Authorised to work in the UK, Ireland or Germany',
        detail: 'location GB is allowed',
        ruleId: '5ae932bd-277c-434f-8396-33ed9e9eed29',
        outcome: 'pass',
        onMissing: 'eliminate',
        eliminates: false,
      },
    ],
    failures: [],
    eliminated: false,
    evaluatedAt: '2026-08-20T11:51:46.733Z',
    eliminatedBy: null,
    indeterminate: [],
    hasIndeterminate: false,
  },
  aiJustification: 'A payments-and-healthcare backend engineer with roughly ten years of experience.',
  errorMessage: null,
  scoredRoleVersion: 1,
  mimeType: 'application/pdf',
  byteSize: 2659,
  attempts: 3,
  updatedAt: '2026-08-20T11:52:16.574Z',
};

/**
 * A failed candidate. Constructed rather than captured - the live database has
 * no failure in it - but every field is one the DTO declares, and the code and
 * message are a real pair from the worker-side namespace.
 */
export const FAILED_CANDIDATE = {
  ...CANDIDATE_DETAIL,
  id: 'f0000000-0000-4000-8000-000000000001',
  candidateName: null,
  originalFilename: 'scanned.pdf',
  status: 'failed',
  matchScore: null,
  fitCategory: null,
  parsedProfile: null,
  evaluationMatrix: null,
  eliminationDetails: null,
  aiJustification: null,
  scoredRoleVersion: null,
  errorCode: 'EMPTY_DOCUMENT',
  errorMessage:
    'This PDF appears to be a scanned image; no extractable text layer was found. Re-upload a text-based PDF or a DOCX.',
  attempts: 1,
};

/** An eliminated candidate that kept a score high enough to have been top of the list. */
export const ELIMINATED_CANDIDATE = {
  ...CANDIDATE_DETAIL,
  id: 'e0000000-0000-4000-8000-000000000001',
  candidateName: 'Marcus Bell',
  matchScore: 88,
  fitCategory: 'unmatched',
  eliminated: true,
  eliminatedBy: 'Authorised to work in the UK, Ireland or Germany',
  eliminationDetails: {
    ...CANDIDATE_DETAIL.eliminationDetails,
    eliminated: true,
    eliminatedBy: 'Authorised to work in the UK, Ireland or Germany',
    results: [
      {
        type: 'min_years_experience',
        label: 'At least 5 years of professional software engineering experience',
        detail:
          'years of experience could not be determined from the CV: "Staff Engineer" at "Acme" (started 2016-01) has no end date, and a later role starts after it, so its end is unknown (rule asks for 5 years)',
        ruleId: 'fc842cf1-97a7-495d-a845-32f8b3370479',
        outcome: 'indeterminate',
        onMissing: 'flag',
        eliminates: false,
      },
      {
        type: 'location_allowlist',
        label: 'Authorised to work in the UK, Ireland or Germany',
        detail: 'location US is not in the allowed list',
        ruleId: '5ae932bd-277c-434f-8396-33ed9e9eed29',
        outcome: 'fail',
        onMissing: 'eliminate',
        eliminates: true,
      },
    ],
    indeterminate: [
      {
        type: 'min_years_experience',
        label: 'At least 5 years of professional software engineering experience',
        detail:
          'years of experience could not be determined from the CV: "Staff Engineer" at "Acme" (started 2016-01) has no end date, and a later role starts after it, so its end is unknown (rule asks for 5 years)',
        ruleId: 'fc842cf1-97a7-495d-a845-32f8b3370479',
        outcome: 'indeterminate',
        onMissing: 'flag',
        eliminates: false,
      },
    ],
    hasIndeterminate: true,
  },
};
