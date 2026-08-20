/**
 * Seed roles.
 *
 * Two roles that a reviewer would recognise as real jobs, and which are
 * genuinely different from each other rather than two flavours of the same one.
 * That difference is the point: it is what shows that the elimination-rule model
 * carries more than "years of experience".
 *
 * Role ids are fixed constants so the seed is re-runnable: a second run finds the
 * same rows and replaces their criteria and rules instead of creating a second
 * copy of everything.
 *
 * Criterion weights sum to exactly 100 in both roles - the database enforces this
 * at COMMIT and will reject this file if an edit breaks it.
 *
 * @typedef {import('../repositories/roleCriteriaRepository.js').RoleCriterionInput} RoleCriterionInput
 * @typedef {import('../repositories/roleEliminationRulesRepository.js').EliminationRuleInput} EliminationRuleInput
 *
 * @typedef {object} SeedRole
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {RoleCriterionInput[]} criteria
 * @property {EliminationRuleInput[]} eliminationRules
 */

/** @type {SeedRole} */
const seniorBackendEngineer = {
  id: '3f8c2b1e-9d4a-4c6f-8a71-2e5b7c9d0a11',
  title: 'Senior Backend Engineer (Node.js)',
  description:
    'Owns the services behind our public API: HTTP surface, data modelling, background ' +
    'processing and the integrations that hang off them. Works in Node.js and PostgreSQL, ' +
    'on a team that deploys several times a day and carries its own pager.',
  criteria: [
    {
      label: 'Backend engineering depth (Node.js)',
      description:
        'Production Node.js: asynchronous control flow, streams, memory and CPU behaviour ' +
        'under load, and the reasons behind the choices - not framework familiarity.',
      weight: 30,
      position: 0,
    },
    {
      label: 'API and distributed systems design',
      description:
        'HTTP semantics, versioning, idempotency, retries and failure isolation between ' +
        'services. Evidence of having designed an interface others had to live with.',
      weight: 20,
      position: 1,
    },
    {
      label: 'Relational data modelling',
      description:
        'Schema design, indexing against real query patterns, transaction boundaries and ' +
        'migration discipline on a database that could not be taken offline.',
      weight: 20,
      position: 2,
    },
    {
      label: 'Testing and code quality',
      description:
        'Automated tests written alongside the code, meaningful coverage of failure paths, ' +
        'and code review habits that show up in how the candidate describes their work.',
      weight: 15,
      position: 3,
    },
    {
      label: 'Cloud infrastructure and CI/CD',
      description:
        'Containers, a managed cloud, pipelines that gate a deploy, and observability the ' +
        'candidate personally relied on during an incident.',
      weight: 10,
      position: 4,
    },
    {
      label: 'Collaboration and written communication',
      description:
        'Design documents, RFCs, mentoring, incident write-ups - evidence that the ' +
        'candidate can move a decision through other people.',
      weight: 5,
      position: 5,
    },
  ],
  eliminationRules: [
    {
      label: 'At least 5 years of professional software engineering experience',
      type: 'min_years_experience',
      value: { years: 5 },
      // 'flag': a CV with unparseable or absent dates gets reviewed by a human
      // rather than dropped. Decision 7-C - unknown facts do not eliminate. Stated
      // rather than left to the column default, because `parseRole` requires it
      // explicitly and a role assembled from this literal has no column to fall
      // back on.
      onMissing: 'flag',
      position: 0,
    },
    {
      label: 'Demonstrated production PostgreSQL experience',
      type: 'required_skill',
      value: { skill: 'PostgreSQL', matchMode: 'normalized', mustBeDemonstrated: true },
      // mustBeDemonstrated: listing "PostgreSQL" in a skills block is a claim, not
      // a demonstration; this rule only passes on evidence of the skill being used.
      // 'flag' because an extraction that found no skills at all must not reject
      // the candidate on this rule's account.
      onMissing: 'flag',
      position: 1,
    },
    {
      label: 'Authorised to work in the UK, Ireland or Germany',
      type: 'location_allowlist',
      value: { countryCodes: ['GB', 'IE', 'DE'] },
      // 'eliminate' on purpose: this is a hard legal requirement, and a CV with no
      // location cannot satisfy it. This is the opt-in the plan describes for
      // requirements where "we could not tell" has to mean no.
      onMissing: 'eliminate',
      position: 2,
    },
  ],
};

/** @type {SeedRole} */
const icuNurse = {
  id: '5a2d6e4c-71b3-4f89-9c02-6d8e1f3a4b22',
  title: 'Registered Nurse - Intensive Care Unit',
  description:
    'Delivers direct nursing care to critically ill adults in a 24-bed mixed medical and ' +
    'surgical ICU. Rotating shifts including nights and weekends, in a unit where the ' +
    'nurse-to-patient ratio is 1:2 and escalation decisions are made at the bedside.',
  criteria: [
    {
      label: 'Critical care nursing experience',
      description:
        'Time spent in an ICU, HDU or equivalent acute setting, with the case mix and ' +
        'acuity described rather than only the job title.',
      weight: 30,
      position: 0,
    },
    {
      label: 'Ventilator and haemodynamic monitoring competence',
      description:
        'Mechanical ventilation, arterial and central lines, vasoactive infusions, and ' +
        'interpretation of the numbers rather than only their recording.',
      weight: 25,
      position: 1,
    },
    {
      label: 'Emergency response and triage',
      description:
        'Participation in cardiac arrest and rapid response teams, and evidence of ' +
        'prioritising under simultaneous competing demands.',
      weight: 15,
      position: 2,
    },
    {
      label: 'Patient and family communication',
      description:
        'Breaking difficult news, end-of-life conversations, and working with families ' +
        'through decisions they did not expect to be making.',
      weight: 15,
      position: 3,
    },
    {
      label: 'Clinical documentation and compliance',
      description:
        'Accurate charting, medication reconciliation, infection control and incident ' +
        'reporting, in a regulated environment that audits all of it.',
      weight: 10,
      position: 4,
    },
    {
      label: 'Preceptorship and team leadership',
      description:
        'Mentoring newly qualified nurses, acting as shift lead, or contributing to unit ' +
        'practice and training.',
      weight: 5,
      position: 5,
    },
  ],
  eliminationRules: [
    {
      label: 'Current Registered Nurse (RN) licence',
      type: 'required_certification',
      value: { name: 'Registered Nurse (RN) License', matchMode: 'normalized' },
      // 'eliminate': practising without a licence is not a judgement call. This is
      // exactly the case decision 7-C keeps configurable per rule.
      onMissing: 'eliminate',
      position: 0,
    },
    {
      label: 'Advanced Cardiovascular Life Support (ACLS) certification',
      type: 'required_certification',
      value: { name: 'Advanced Cardiovascular Life Support', matchMode: 'normalized' },
      // 'flag': ACLS is routinely obtainable after hire and is frequently omitted
      // from a CV that lists a dozen other certificates.
      onMissing: 'flag',
      position: 1,
    },
    {
      label: 'Associate degree in nursing or higher',
      type: 'required_education_level',
      value: { level: 'associate' },
      // 'flag': an education section this extraction could not read is a parsing
      // failure far more often than it is a candidate without a degree.
      onMissing: 'flag',
      position: 2,
    },
    {
      label: 'At least 2 years of post-qualification nursing experience',
      type: 'min_years_experience',
      value: { years: 2 },
      // 'flag', for the same reason as the backend role's years rule.
      onMissing: 'flag',
      position: 3,
    },
  ],
};

/** @type {readonly SeedRole[]} */
export const SEED_ROLES = Object.freeze([seniorBackendEngineer, icuNurse]);
