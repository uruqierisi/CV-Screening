# Phase 0 — Plan of Record

AI CV Screening & Applicant Ranking System. This document is the contract between the
three build lanes. Where a lane's own plan disagrees with this file, this file wins.

Status: **awaiting approval.** No implementation code exists yet.

---

## 0. Settled decisions

Carried from the brief, not open for relitigation:

1. **The LLM never produces the final score.** It rates each criterion 0–10 with a
   one-sentence reason citing evidence. A pure function applies the role's weights.
2. **Elimination rules are evaluated in code** against extracted profile facts.
3. **Tiers:** Strong Match / Potential Match / Unmatched. Elimination forces Unmatched
   regardless of score.
4. **Processing is asynchronous.** Upload returns a job id immediately; every candidate
   carries `pending | parsing | evaluating | done | failed`. The dashboard polls.
5. **Layering:** routes → controllers → services → repositories. `src/agents/` is
   framework-agnostic and imports no web framework and no DB driver.
6. **Failure is per-candidate.** One bad CV never takes down a batch.

Stack: Node.js ESM, plain JavaScript with JSDoc on exports, **Fastify**, PostgreSQL 16 via
docker-compose with `node-pg-migrate`, **BullMQ + Redis** with a separate worker process,
`zod` everywhere, `vitest`, React + Vite. No auth (the spec has none). Uploads to local
disk. Model: `claude-opus-5`.

---

## 1. Repository layout

```
AI-TASK/
├── docker-compose.yml          postgres:16 + redis:7 only; app and worker run on the host
├── .env.example
├── README.md                   Phase 6
├── docs/PHASE-0-PLAN.md        this file
├── samples/                    sample CVs for a reviewer to try immediately
├── server/
│   ├── migrations/             numbered, forward-only, up/down SQL
│   ├── uploads/                gitignored
│   └── src/
│       ├── app.js              builds a Fastify instance; does not listen (tests import this)
│       ├── server.js           API entrypoint
│       ├── worker.js           SEPARATE process: BullMQ Worker + graceful drain
│       ├── config/env.js       zod over process.env, parsed at import, exits on failure
│       ├── db/                 pool.js, withTransaction.js
│       ├── errors/             AppError.js, codes.js (the central map)
│       ├── http/               errorHandler.js, plugins/
│       ├── routes/             thin: path → schema → controller
│       ├── controllers/        parse → service → DTO → status
│       ├── services/           all business rules; no HTTP knowledge
│       ├── repositories/       parameterized SQL only
│       ├── extraction/         file bytes → raw text (PDF/DOCX/TXT) + scanned detection
│       ├── storage/localDisk.js
│       ├── queue/              connection, screeningQueue, processors/
│       ├── agents/             THE AGENT LAYER — see §5
│       └── scripts/reconcileStuck.js
└── web/
    └── src/
        ├── api/                the only place fetch() is called
        ├── hooks/              useResource, usePolledResource, usePageVisibility
        ├── pages/              one per route
        ├── features/           roles/, upload/, candidates/, detail/
        ├── components/         generic primitives
        └── lib/                constants, tiers, format
```

---

## 2. Data model

### `roles`
`id uuid PK` · `title text NOT NULL` (1–200) · `description text NOT NULL DEFAULT ''` ·
`version integer NOT NULL DEFAULT 1` · `archived_at timestamptz NULL` ·
`created_at` / `updated_at timestamptz NOT NULL DEFAULT now()`.

No `is_active` column — see §7-A.

### `role_criteria`
`id uuid PK` · `role_id uuid NOT NULL FK→roles ON DELETE CASCADE` ·
`label text NOT NULL` (1–120, unique per role) · `description text NOT NULL DEFAULT ''` ·
`weight integer NOT NULL CHECK (weight BETWEEN 1 AND 100)` ·
`position integer NOT NULL` (unique per role, `DEFERRABLE INITIALLY DEFERRED`).

Integer weights, not numeric: `Σ(rating × weight)` is then exact with no floating-point
reasoning. Cost: no fractional weights.

**Weights sum to 100 — enforced in three layers.** The brief requires it and the role form
shows it, so it is an invariant, not a preference.
1. `zod .superRefine` at the boundary → `WEIGHTS_MUST_SUM_TO_100` (422).
2. A `CONSTRAINT TRIGGER` on `role_criteria`, `DEFERRABLE INITIALLY DEFERRED`, re-checking
   `SUM(weight) = 100` per role **at COMMIT** — criteria are written as delete-then-insert
   inside one transaction, so the intermediate state is invalid by design.
3. An assertion in `computeWeightedScore`, which throws rather than emit an out-of-range score.

A trigger never fires for a role with zero criteria, so zod additionally requires
`criteria.length >= 1`, and uploads to a criteria-less role are rejected `409 ROLE_NOT_SCOREABLE`.

### `role_elimination_rules`
`id uuid PK` · `role_id uuid NOT NULL FK→roles ON DELETE CASCADE` · `label text NOT NULL` ·
`type text NOT NULL CHECK (type IN (...))` · `value jsonb NOT NULL` ·
`on_missing text NOT NULL DEFAULT 'flag' CHECK (on_missing IN ('flag','eliminate'))` ·
`position integer NOT NULL` (unique per role, `DEFERRABLE INITIALLY DEFERRED`).

`position` matches `role_criteria.position` exactly, deferral included. Both tables are
ordered lists owned by a role, both are rewritten delete-then-insert inside one transaction,
and both are read back `ORDER BY position` — so a shared position means a display order that
can differ between two reads of the same role, and a non-deferred constraint would reject the
reordering path the repository actually uses.

| `type` | `value` | Profile fact | Predicate |
|---|---|---|---|
| `min_years_experience` | `{ years: int 0..60 }` | `computedYearsExperience` | `>=`, and **`indeterminate` when the value is `null`** — see below |
| `required_skill` | `{ skill, matchMode: 'exact'\|'normalized', mustBeDemonstrated: bool }` | `skills[]` | token match; `mustBeDemonstrated` requires `evidenceType === 'demonstrated'` **after** quote verification |
| `required_education_level` | `{ level }` | `education[]` | ordered ladder `none < high_school < associate < bachelors < masters < doctorate` |
| `required_certification` | `{ name, matchMode }` | `certifications[]` | normalized name match, **and not stated-expired** — see below |
| `location_allowlist` | `{ countryCodes: [ISO-3166-1 alpha-2] }` | `location` | membership |

The union is **closed**: a rule type with no code evaluator cannot be stored, and an unknown
type at evaluation time **throws** — it never silently passes. A unit test asserts the stored
enum and the evaluator registry are the same set.

**`min_years_experience` compares a number the dates support, or admits it has none.**
`computedYearsExperience` is `null` whenever the work history does not determine an answer, and
a null reads as **`indeterminate`** — never as zero, and never as a figure closed at `now` out
of an entry the CV left open. The rule that decides which absent end dates are "still there" is
in §5.1 and in the header of `compute-experience.js`; what §2 needs to record is the predicate's
third branch and the fact that the recruiter-facing detail *names the entry that caused it*:

> years of experience could not be determined from the CV: `"Staff Nurse" at "Mercy General"
> (started 2016-01) has no end date, and a later role starts after it, so its end is unknown`
> (rule asks for 5 years)

`on_missing` then decides, exactly as it does for every other unknown fact. The detail it
replaced — *"10.7 years computed from dates, minimum 5"* — was the worst possible output: a
number nothing measured, phrased as a measurement, on a rule that had just passed a candidate
whose CV showed one twelve-month job.

**`required_certification` reads expiry, and this is why `{ now }` exists.** A name match
alone would let a lapsed licence satisfy a rule that says "current". The seed's own rule —
*"Current Registered Nurse (RN) licence"* — asks a question a name match cannot answer, so a
certification whose **stated** `expiryDate` has passed relative to the injected `now` counts
as **not held**. The asymmetry is deliberate and runs one way only: an absent, null or
unparseable expiry is **never** treated as expiry, because that would turn an extraction gap
into a rejection, which is exactly the failure §7-C exists to prevent. `now` is injected
rather than read from the clock so the evaluation is reproducible; without this predicate it
would be an unused parameter, since every other time-dependent fact is computed upstream in
`compute-experience.js`.

`required_language` (proposed by the backend lane) is **dropped** — not in the spec.
`required_certification` is **in**, because the spec names mandatory certifications explicitly.

Each rule yields `pass` / `fail` / `indeterminate`. See §7-C for what `indeterminate` does.

### `screening_jobs`
`id uuid PK` · `role_id uuid NOT NULL FK→roles ON DELETE RESTRICT` ·
`file_count integer NOT NULL` · `created_at timestamptz NOT NULL DEFAULT now()`.

**No status column.** Job status is derived by aggregating `candidates.status`. A stored
status is a second copy of truth that drifts the moment a worker dies mid-update.

Naming discipline: one **screening job** fans out to N **queue jobs**. Both are called "job"
in casual speech; code and logs always disambiguate.

### `candidates`
`id uuid PK` · `role_id uuid FK→roles ON DELETE RESTRICT` ·
`job_id uuid FK→screening_jobs ON DELETE CASCADE` · `original_filename text` ·
`candidate_name text NULL` (from the parsed profile — the dashboard shows people, not filenames) ·
`storage_path text` (relative to `UPLOAD_ROOT`, never absolute) · `content_sha256 char(64)` ·
`mime_type text` (allowlist CHECK) · `byte_size integer` ·
`status text NOT NULL DEFAULT 'pending'` (CHECK over the five values) · `raw_text text NULL` ·
`parsed_profile jsonb NULL` · `evaluation_matrix jsonb NULL` · `elimination_details jsonb NULL` ·
`eliminated boolean NOT NULL DEFAULT false` · `eliminated_by text NULL` (failing rule label) ·
`match_score numeric(4,1) NULL CHECK (0..100)` · `fit_category text NULL` (CHECK over three) ·
`ai_justification text NULL` · `scored_role_version integer NULL` ·
`error_code text NULL` · `error_message text NULL` · `attempts smallint NOT NULL DEFAULT 0` ·
`created_at` / `updated_at` / `completed_at timestamptz`.

Integrity constraints:
- `status <> 'done' OR (match_score IS NOT NULL AND fit_category IS NOT NULL AND parsed_profile IS NOT NULL AND evaluation_matrix IS NOT NULL)`
- `status <> 'failed' OR error_code IS NOT NULL`
- `(error_code IS NULL) = (error_message IS NULL)`
- `status NOT IN ('done','failed') OR completed_at IS NOT NULL`

**Status transitions are guarded**, never blind:
`UPDATE candidates SET status = $new WHERE id = $1 AND status = $expected`, with `rowCount`
checked. This stops a late or duplicated queue job clobbering a retried candidate.

**Eliminated candidates keep their score.** Only `fit_category` is forced to `unmatched`.
A recruiter must be able to see "eliminated, but would have scored 88" — that is the whole
point of showing the work.

### Indexes

| Index | Serves |
|---|---|
| `(role_id, match_score DESC NULLS LAST, id DESC)` | dashboard default ranking |
| `(role_id, fit_category, match_score DESC NULLS LAST, id DESC)` | ranking with a tier filter (no index skip-scan in PG) |
| `(job_id, status)` | `GET /jobs/:id` aggregate — the hot polling query |
| `(role_id, content_sha256)` | duplicate-CV lookup; **non-unique on purpose** |
| `(status) WHERE status IN ('pending','parsing','evaluating')` | stuck-candidate sweep |
| `screening_jobs(role_id)` | the `ON DELETE RESTRICT` check PG runs on every role delete |

**`role_criteria(role_id)` and `role_elimination_rules(role_id)` are deliberately absent.**
Each is a strict prefix of a unique constraint already on its own table — `(role_id, label)`
and `(role_id, position)` on `role_criteria`, `(role_id, position)` on
`role_elimination_rules` — any of which already serves a lookup, a cascade or an FK check on
`role_id` alone. They read nothing the wider indexes could not, and cost a write on every
change to a list that is rewritten delete-then-insert on every role edit. The argument is the
same one twice, so neither is a candidate for re-adding: a schema test asserts catalogue-wide
that no non-unique btree index is a strict prefix of another.

**One ordering rule, defined once:** `ORDER BY match_score DESC NULLS LAST, id DESC`, in SQL.
The agent layer's proposed `compareCandidates` comparator is **cut** — a second ranking
definition that could disagree with the first is a bug waiting to happen.

### `updated_at`

Maintained by a `BEFORE UPDATE` row trigger on every table that has the column — `roles` and
`candidates`, and nothing else. Correctness that depends on every future `UPDATE` remembering
to set a column is a convention, not a design, and the stuck-candidate sweep reads
`updated_at` to decide what to re-enqueue. The repositories keep their explicit
`updated_at = now()`: redundant agreement is cheaper to read than a hidden mechanism.

`now()` (transaction start), not `clock_timestamp()`: rows changed by one transaction became
visible atomically and should carry one timestamp, and it matches the column default and the
repositories exactly. Cost, accepted: inside a long transaction the value records when the
transaction began. Two guards — an `UPDATE` that changes nothing leaves the timestamp alone,
so the idempotent archive stays a true no-op, and an `UPDATE` that sets `updated_at` itself is
not overruled, so backdating a row remains possible.

### Redis vs Postgres

| Redis (BullMQ) | Postgres |
|---|---|
| queue order, concurrency, in-flight locks | durable candidate status |
| attempt counters, backoff, retry scheduling | terminal `error_code` / `error_message` |
| completed/failed job records | all results: profile, matrix, score, tier, justification |

Redis is **rebuildable, not authoritative**. Flushing it loses nothing of business value;
`scripts/reconcileStuck.js` re-enqueues anything stranded. The BullMQ `jobId` **is the
candidate UUID**, which gives deduplication for free.

---

## 3. API contract

Base `/api/v1`. Success `{ data, meta? }`. Error `{ error: { code, message, details, requestId } }`.
Every param, query and body is zod-parsed in the controller; unknown keys stripped.

```
GET    /api/v1/config              upload limits, elimination-rule-type descriptors, tier thresholds
POST   /api/v1/roles               create role + criteria + rules in one transaction
GET    /api/v1/roles               list (paginated)
GET    /api/v1/roles/:roleId       full definition
PUT    /api/v1/roles/:roleId       FULL replacement (partial weight edits make sum-100 a merge problem)
DELETE /api/v1/roles/:roleId       soft archive; idempotent; never a hard delete
POST   /api/v1/roles/:roleId/candidates        single upload  → 202
POST   /api/v1/roles/:roleId/candidates/batch  batch upload   → 202
GET    /api/v1/jobs/:jobId                     derived job status + counts
GET    /api/v1/candidates                      ranked list, filtered, paginated
GET    /api/v1/candidates/statuses?ids=a,b,c   lightweight poll payload
GET    /api/v1/candidates/:candidateId         full detail
POST   /api/v1/candidates/:candidateId/retry   re-enqueue a terminally failed candidate → 202
GET    /api/v1/health                          liveness + db/redis reachability
```

**Rate limiting** (`@fastify/rate-limit`) is applied to the two upload endpoints only — they
are the ones that spend real API money. With no auth the only principal is the client IP,
which bounds how much this actually buys; it is a cost guard, not a security control.

**Retry** clears `error_code` / `error_message` / `completed_at`, sets `status` back to
`pending`, bumps `attempts`, and re-enqueues under a fresh queue-job id (`candidateId:attempts`,
since the original id is consumed). `409 CANDIDATE_NOT_RETRYABLE` if the status is not `failed`;
`410 SOURCE_FILE_MISSING` if the stored file is gone from disk.

**Not built:** `Idempotency-Key` on upload. A double-clicked upload button therefore creates
duplicate candidates and spends the LLM budget twice. The `(role_id, content_sha256)` index
makes duplicates detectable after the fact, and the README will name this as a known
limitation rather than pretend it is handled.

`GET /api/v1/config` exists so upload limits, rule-type descriptors and tier thresholds are
defined **once, server-side**, instead of being duplicated as client constants that drift.

**Upload** (`202`): `{ jobId, roleId, candidates: [{ id, originalFilename, status: "pending" }] }`.
A single upload still creates a screening job of size 1, so the dashboard has exactly one
polling shape. Batch is all-or-nothing at the HTTP layer (`details.rejected` names the bad
files); once accepted, failure is strictly per-candidate.

**Job status** is derived: all pending → `queued`; any non-terminal → `in_progress`;
all terminal with ≥1 failed → `completed_with_failures`; else `completed`.

**Candidate list row:** `{ id, roleId, jobId, candidateName, originalFilename, status,
matchScore, fitCategory, eliminated, eliminatedBy, errorCode, createdAt, completedAt }`,
with `meta: { page, pageSize, total, totalPages, counts: { strong_match, potential_match,
unmatched } }`. The counts cannot be derived from a 25-row page.

Not-yet-scored candidates sort **last** in both directions, so an in-progress batch never
pushes real results off page 1.

**Candidate detail** adds `parsedProfile`, `eliminationDetails`, `errorMessage`,
`scoredRoleVersion`, and:

```
evaluationMatrix: {
  scoreRaw: int 0..1000,
  criteria: [{ criterionId, label, weight, rating: int 0..10, weightedPoints: int, reason, evidence }],
  computedAt
}
```

**Open contract gap, recorded so Phase 4 does not rediscover it.** `ai_justification` is stored
(§2) and its source is defined (§5.1 — the model's `summary`, prose only), but no response shape
in this section carries it: it is absent from the candidate list row and from the detail fields
above. The detail response is where it belongs — it is per-candidate prose a recruiter reads
once, not something to ship in a 25-row page. Phase 4 must add it as `aiJustification` to the
candidate detail payload, or decide deliberately that the field is written and never read.

`weightedPoints = rating × weight`, and `Σ weightedPoints === scoreRaw`. This is what lets the
detail screen show a **Contribution** column that reconciles exactly to the final score —
turning the matrix from a list of opinions into an audit trail. `rawText` is excluded unless
`?includeRawText=true`.

### Error codes → HTTP

| Code | HTTP |
|---|---|
| `VALIDATION_FAILED`, `EMPTY_UPLOAD` | 400 |
| `ROLE_NOT_FOUND`, `CANDIDATE_NOT_FOUND`, `JOB_NOT_FOUND` | 404 |
| `ROLE_ARCHIVED`, `ROLE_NOT_SCOREABLE`, `CANDIDATE_NOT_RETRYABLE` | 409 |
| `SOURCE_FILE_MISSING` | 410 |
| `FILE_TOO_LARGE`, `TOO_MANY_FILES` | 413 |
| `UNSUPPORTED_FILE_TYPE` | 415 |
| `WEIGHTS_MUST_SUM_TO_100`, `DUPLICATE_CRITERION_LABEL` | 422 |
| `RATE_LIMITED` | 429 |
| `STORAGE_WRITE_FAILED`, `INTERNAL_ERROR` | 500 |
| `DEPENDENCY_UNAVAILABLE` | 503 |

Any unrecognized throw is logged in full and becomes `INTERNAL_ERROR` plus a `requestId`.
No unknown `error.message` ever reaches a response body.

**A separate namespace: worker-side candidate error codes.** Stored in `candidates.error_code`,
returned *inside a 200*, never mapped to an HTTP status. Kept in a different frozen object so
the two can't be confused. §5.4 defines them.

---

## 4. Async pipeline

`POST upload` → write files to disk → insert `screening_jobs` + `candidates` in one
transaction → **commit** → enqueue one BullMQ job per candidate → `202`.

Enqueue happens strictly **after** commit, so the worker can never pick up a row that isn't
visible yet. Cost: a crash between commit and enqueue leaves candidates in `pending` until
`reconcileStuck.js` runs, and that script is manual.

Files are written **before** the DB insert, under a path derived from the UUID that becomes
the candidate id; a failed insert unlinks best-effort. A crash in that window leaves an orphan
file, which is harmless. The reverse order would leave a broken candidate row, which is not.

Worker per candidate: `parsing` → extract text → `evaluating` → `screenCandidate()` →
score → `done`, or `failed` with a code and message. **The BullMQ job timeout must exceed
240s** — the agent layer's hard per-candidate deadline (§5.3).

### Why a queue at all — the argument, not the library

This is the reasoning the README must carry. "BullMQ handles it" is not an answer; what
follows is *what* has to be handled and *why* it does not belong in a request.

**The work does not fit in an HTTP request.** Screening one CV is text extraction plus two
sequential LLM calls — seconds each, with a tail into tens of seconds. A batch of twenty is
minutes. Holding an HTTP connection open for that means the browser or any proxy in between
times out, the recruiter cannot navigate away, and a dropped connection destroys work that has
already been paid for in API spend. So the upload endpoint's job is to durably record intent
and return; the actual work happens elsewhere. Everything below follows from that one split.

**Once work is deferred, five problems appear, and they are the queue's actual job:**

1. **Handover without loss.** Between "the API accepted this CV" and "a worker starts on it",
   the intent has to survive a process restart. This is why the candidate row is committed
   *before* anything is enqueued, and why Postgres — not Redis — is the durable record.
2. **Exactly-one-worker-at-a-time.** Two workers picking up the same candidate means two sets
   of LLM calls, double spend, and a race to write contradictory scores. The queue provides
   the in-flight lock; we reinforce it by using the candidate UUID as the queue-job id, which
   makes a duplicate enqueue a no-op rather than a second job.
3. **Retry with backoff, and a place for the dead.** LLM calls fail transiently — rate limits,
   timeouts, 5xx. Retrying immediately makes a rate limit worse. Retrying forever hides a
   permanent failure. The queue gives bounded attempts with exponential backoff and a
   dead-letter set; the agent layer decides *which* failures are even worth retrying by
   labelling each error `retryable` or not.
4. **Concurrency you can turn down.** The rate limit that matters is Anthropic's, not ours. A
   worker concurrency setting is a single number that bounds in-flight LLM calls across the
   whole system. Without it, a 50-CV batch is 50 simultaneous API calls and a wall of 429s.
5. **Failure isolation.** One malformed PDF must fail one candidate. Per-job execution gives
   that for free; a loop over an array does not.

**Why BullMQ and Redis specifically, rather than a Postgres-backed queue.** A
`SELECT … FOR UPDATE SKIP LOCKED` table in Postgres would provide the same five properties
without a second service, and is the lighter choice on infrastructure grounds. Redis was chosen
because it is the production-standard answer, brings the retry/backoff/dead-letter machinery
and a separate worker process without hand-rolling them, and — since it sits in the same
`docker-compose.yml` as Postgres — costs a reviewer nothing: it is still one command to start.

**What we gave up:** a second stateful service to run and reason about, and a split between
where queue state lives and where business state lives. That split is managed explicitly —
Redis is treated as rebuildable, Postgres as authoritative (§2), so flushing Redis loses no
business data and `reconcileStuck.js` can re-enqueue anything stranded. The honest cost is
that this is more moving parts than a two-page spec strictly requires.

---

## 5. Agent layer (`server/src/agents/`)

Dependency injection is the boundary discipline: every network function takes
`{ client, now, logger }` explicitly. Only `client/anthropic-client.js` imports
`@anthropic-ai/sdk`, and it only constructs. That is what makes the test suite network-free
without module mocking.

```
agents/
  index.js  constants.js
  client/    anthropic-client.js  call-structured.js  errors.js
  schemas/   profile.schema.js  evaluation.schema.js  role.schema.js
  prompts/   shared-rules.js  extraction.prompt.js  evaluation.prompt.js
  extraction/ extract-profile.js  verify-evidence.js  normalize-profile.js  compute-experience.js
  evaluation/ evaluate-candidate.js  redact-identity.js
  scoring/   reconcile-ratings.js  compute-score.js  elimination.js  tiers.js  score-candidate.js
  pipeline/  screen-candidate.js
  util/      text.js  logger.js
```

### 5.1 Schemas — shaped for the model, not the type checker

- **Two profile shapes: `.optional()` on the wire, `.nullable()` in storage — and a field set
  cut to fit two independent API budgets.** This reverses the original rule — *".nullable()
  everywhere, .optional() nowhere"* — and the reversal was forced, not preferred.

  Two live requests during phase 2b were rejected before they reached the model, one after the
  other. Both messages are quoted verbatim, because a paraphrase of an API limit is how the
  next one gets missed:

  > `400 invalid_request_error` — "Schemas contains too many parameters with union types (32
  > parameters with type arrays or anyOf). This causes exponential compilation cost. Reduce
  > the number of nullable or union-typed parameters (limit: 16 parameters with unions)."

  > `400 invalid_request_error` — "Schemas contains too many optional parameters (31), which
  > would make grammar compilation inefficient. Reduce the number of optional parameters in
  > your tool schemas (limit: 24)."

  The API compiles the output JSON Schema into a decoding grammar. A union costs it
  exponentially; an optional parameter costs it a branch. **They are two separate caps —
  unions ≤ 16, optionals ≤ 24 — and a field can only ever be one of three things:**

  | Marking | Union budget | Optional budget |
  |---|---|---|
  | `.nullable()` | 1 | 0 |
  | `.optional()` | 0 | 1 |
  | required | 0 | 0 |

  The first 400 was fixed by trading every `.nullable()` for `.optional()` and flattening
  `location` (nested, it cost five unions on its own). That took unions from 32 to **0** and
  walked straight into the second cap at **31 optionals**. Only *required* is free, and that
  is what shaped everything below.

  **The rule that decided which fields moved**, and it is the load-bearing sentence of this
  whole section:

  > Required costs neither budget, but a required scalar forces the model to produce something
  > even when the CV does not have it — and invention is what this design exists to prevent.
  > So **`required` is for fields where absence has a safe representation**, and **deletion is
  > for fields nothing scores.**

  Applied, 31 → 22:

  | Step | Change | Optionals |
  |---|---|---|
  | 0 | after the union fix | 31 |
  | 1 | `workHistory`, `education`, `certifications`, `skills` **required** — `[]` is a legitimate "I looked and found none" | 27 |
  | 2 | `workHistory[].isCurrent` **deleted** — an absent `endDate` already means ongoing | 26 |
  | 3 | `headline` **deleted** — nothing scores it | 25 |
  | 4 | `locationRaw` **deleted** — `location_allowlist` reads `countryCode` only | 24 |
  | 5 | profile-level `summary` and `education[].startDate` **deleted** — nothing reads either | **22** |

  Step 5 exists because 24 is the cliff edge and a schema sitting exactly on a limit fails on
  the next field somebody adds — which is precisely how the second 400 happened. Two spare is
  cheap when the price is only fields nothing reads.

  **What was deliberately not touched.** `employer` and `title` stay optional: they are what a
  badly-parsed CV loses first, and requiring a string for one is requiring an invented
  employer. `workHistory[].summary` and `skills[].evidenceQuote` stay optional for the
  opposite reason — they carry the evidence the whole evaluation rests on.

  **The five deleted fields left the stored schema too**, rather than surviving there as
  permanently-null keys. A field that can never be anything but null is dead weight in
  `parsed_profile`, an empty column on the dashboard, and a trap for the next reader who
  assumes something fills it. `parsed_profile` is jsonb, so no migration is involved either
  way. The one that came closest to staying was `location.raw`: a recruiter-facing "Remote"
  string has display value even though no rule reads it — but with the wire field gone there
  is no longer any way to populate it, which makes keeping it exactly the dead weight above.

  **Two encodings of one fact became one.** `isCurrent` was tri-state beside `endDate`, and an
  entry with neither used to be discarded as unusable — throwing away the ordinary "March 2021
  –" current role. `isCurrent` was deleted and **an absent `endDate` became the only way to say
  "this has not ended"**, which the extraction prompt states in those words.

  **And the first version of that reading was wrong, in a way worth writing down.** Every
  absent `endDate` was closed at `now`. Probed with an injected clock at `2026-08-20`:

  | Work history | computed | `min_years_experience ≥ 5` |
  |---|---|---|
  | current role, 2021-03 → `null` | 5.5 | pass — correct |
  | **finished role, 2016-01 → `null`, with a later role after it** | **10.7** | **pass — wrong** |
  | the same role with its end date, 2016-01 → 2017-01 | 1.1 | fail — correct |
  | **one summer internship, 2015-06 → `null`, with a later role after it** | **11.3** | **pass — wrong** |

  The same twelve-month job read 1.1 years and failed the gate with its end date present, and
  10.7 years and passed with the end date missing — and the elimination detail said *"10.7 years
  computed from dates, minimum 5"*, which reads as verified fact with nothing marking it as
  manufactured. A confident wrong number is worse than an admitted gap.

  **The rule now, and it is the whole of it:** an entry with `endDate === null` is **current,
  and closes at `now`, if and only if no other entry in the work history starts strictly
  later.** A CV lists roles as a sequence; if another role starts after this one, this one
  ended, whatever the CV forgot to say. Entries **tied** at the latest start are concurrent
  current roles, not an ambiguity, and all of them close at `now`.

  Otherwise the absent end is an extraction gap and **`computedYearsExperience` is `null` — the
  whole value, not just that entry.** Dropping the entry and totalling the rest would
  undercount, which is the same crime in the other direction. An unknown fact then takes the
  7-C path it takes everywhere else: `indeterminate`, a reason naming the offending entry, and
  `on_missing` deciding (§2).

  **One exception, because it costs nothing to be right.** If the intervals that *are*
  resolvable already cover the span from the unresolvable entry's start through `now`, then
  whatever its true end date the merged union is unchanged, so the answer stays determinate and
  is returned. Without it, a CV with contiguous or overlapping roles would go indeterminate over
  a gap that provably cannot change the total — a false alarm, and false alarms train a
  recruiter to ignore the badge.

  Everything else about `endDate` is unchanged: an explicit "Present"/"Current" is still
  current whatever its position in the list, a future end still clamps to `now`, and an
  unparseable end is still its own `unusable` reason.

  The honest cost, recorded rather than hidden: a CV listing a genuine current role *before* a
  later short contract — or listing a role that starts in the future — now yields `null` where
  the old code yielded a number. Nobody is eliminated by that on the default `on_missing`, and
  the recruiter is told which entry to look at. That is the direction 7-C asks for.

  **An explicit `null` on the wire is accepted, not rejected.** Every optional field is wrapped
  in a `z.preprocess` that reads `null` as an absent key. This is not silent repair of an
  error: on this contract `null` and absent are the same claim, and `normalize-profile.js`
  fills absent with `null` a line later anyway — failing validation and burning a retry over an
  equivalent encoding would be brittle for no benefit. It costs **nothing on either budget**
  (`zod-to-json-schema` emits the input side of a preprocess, so the bytes on the wire are
  unchanged), and the budget test measures the generated schema rather than the source, so
  that claim is checked rather than asserted. The four required lists are **not** wrapped:
  there is no "absent" for a `null` to be equivalent to, so one there is a real mismatch and
  takes the ordinary semantic retry.

  **The property this section was written to protect is unchanged.** The point was never
  `null` specifically; it was that the model must have a legal, cheap, explicitly-blessed way
  to say "the CV does not say this" instead of inventing something plausible. *A field the
  model omits says that exactly as well as an explicit null*, and an empty list says it for a
  section. The extraction prompt (now **2.0.0**) authorises both in the same words it used to
  authorise `null` — a major bump, because this is a different output document rather than the
  same one worded differently, and comparing two profiles by version is the reason the version
  is stored beside the extraction at all.

  The counter-argument, recorded rather than hidden: an omitted field is ambiguous between
  "not in the CV" and "the model stopped generating". It is weak — a truncated generation is
  already caught by `stop_reason: max_tokens` before the response is ever parsed — and it is
  moot, because the alternative design cannot make a request at all.

  **Downstream sees one shape.** `normalize-profile.js` is the seam: it fills every absent
  field with `null` and re-nests the location, so `profileSchema`, the `parsed_profile`
  column, `verify-evidence.js`, `compute-experience.js`, `elimination.js`, the evaluation
  prompt's profile rendering and every dashboard cell read one object. A test asserts that
  object key for key, in order, against a literal written out by hand — and it was **changed
  deliberately this round**, not allowed to drift: `headline` and `summary` left the top level,
  `isCurrent` left `workHistory[]`, `startDate` left `education[]`, and `raw` left `location`.

  Which fields kept `.nullable()` on the wire: **none.** The evaluation schema keeps its two
  (`evidence`, `summary`), which is where a null *is* an assertion, and at 2 unions and **0
  optionals** it is nowhere near either cap.

  **Postscript, added after the bisect in §5.2.1: the extraction schema is no longer sent.**
  Everything above is kept because it is the record of how this schema got its shape, and
  because `extractedProfileSchema` is still the thing every extraction is validated against —
  but the request that carried it no longer does. The API's grammar compiler could not compile
  it in a usable time *even at 0 unions and 22 optionals*, so the two caps below were never
  what stopped it.

  Three consequences, stated so nobody has to infer them:

  - **The budgets no longer bind extraction.** A field added to the wire contract costs
    nothing at the API now. What it still costs is everything else in this section — a
    required scalar the CV may not have is still an invitation to invent, and a field nothing
    reads is still a column nobody fills.
  - **The five deleted fields stay deleted**, and three of them were re-argued on their own
    merits rather than on the budget: `locationRaw` (nothing populates it), profile-level
    `summary` (a name-leak surface into the judge, which is a better reason than the budget
    ever was), and `workHistory[].isCurrent` (two encodings of one fact is a drift surface
    whatever the cap). `education[].startDate` and `headline` are open, and are the subject of
    a recommendation rather than a change.
  - **`.optional()` on the wire is now a choice, not a forced move.** It is kept, because the
    property it buys was never about the budget: the model must have a legal, cheap,
    explicitly-blessed way to say "the CV does not say this", and an omitted key says it.

  **The real gap both 400s exposed was a missing test, not a wrong schema.** 702 tests passed
  against a fake client that applies no compilation limit, and the first version of the test
  that followed guarded one cap because one 400 had revealed one cap — the wrong unit, since a
  test should own the *class* of failure rather than the instance.
  `test/agents/schema-budget.test.js` walks the generated JSON Schema for every schema this
  system sends and counts **both**: union-typed parameters (a `type` array, an `anyOf` or a
  `oneOf`, at any depth) and optional parameters (any property its own object's `required` does
  not name, recursively through array `items`). It reads the schema off the request the
  injected client actually received, so it cannot drift from the call sites, and it asserts the
  exact current counts as well as the ceilings — so a field pushing a schema *toward* a cap
  shows up in a diff on the day it lands.

  Since §5.2.1 that means **the evaluation schema**, which is the only one now sent. The
  extraction assertions were retired rather than weakened — a budget on a schema that never
  leaves the process is a fiction — and what replaced them is the assertion that the extraction
  request carries no `output_config.format` at all. That is the fact worth guarding, because
  reinstating one would not fail loudly; it would hang for two minutes per candidate and read
  as a network fault. And the honest scope of the file is now written into its header: it
  catches the two caps the API documents, not the compilation cost it does not.

  **`test/agents/schema-drift.test.js`** guards the surface the wire/stored split created: a
  field added to one schema and forgotten on the other never arrives, and nothing throws. It
  compares the two field sets in both directions, minus a literal list of the two fields the
  wire deliberately drops — `computedYearsExperience` and `skills[].evidenceVerified`, both
  written by code after the model has answered, and both left off the wire precisely so the
  model has nowhere to put a value for them.
- **`email` is a plain string, not `z.string().email()`.** Strict validation is all-or-nothing
  at the API boundary — one mangled OCR email would null the entire extraction and burn a
  retry over a field nobody scores on. Format checks live in `normalize-profile.js`, which
  nulls the bad field and keeps the other forty.
- **`skills[].evidenceType: 'demonstrated' | 'listed_only'`** alongside an optional `evidenceQuote`.
  Redundant on paper; in practice a model handed a nullable string *fills it*, and a model
  handed an honest option *picks it*. This is the single most important schema decision.
- **`skills[].evidenceQuote`** must be a **verbatim** span. `verify-evidence.js` normalizes
  whitespace/case/unicode dashes and substring-matches it against the source; a miss downgrades
  the skill to `listed_only`. It is the only claim in the system a machine can falsify.
- **`criterionId` is a dynamic `z.enum` of this role's actual ids.** An earlier draft of this
  section claimed constrained decoding made inventing a criterion *structurally impossible*.
  That is an overclaim and is corrected here: the SDK's JSON-Schema transform **demotes `enum`
  into the field's `description`**, and it does so on the official `zodOutputFormat` path too,
  so the enum reaches the model as a **decoding hint, not a decoding constraint**.

  What is actually guaranteed: an invented criterion id is **rejected by the zod enum** when the
  response is parsed, one retry follows with the error fed back, and if the second response is
  also wrong the candidate **fails**. No invented criterion can reach a score. That is a weaker
  claim than the original and it is still a good one — the guarantee that matters is that a
  fabricated criterion cannot be scored, and it holds.

  Recorded rather than quietly fixed because an overclaim in this document is worse than the
  weaker truth: a reviewer who catches one stops trusting the rest.
- **No completeness `.refine()`** on the ratings array — a refine failure yields
  `parsed_output === null` with no diagnostic. The same condition caught in
  `reconcile-ratings.js` names the exact missing ids. Put in the schema what the decoder can
  *enforce*; put in code what it can only *reject*.
- **No score, tier, or "overall" _number_ exists anywhere in the evaluation schema.** There is
  nowhere for the model to put a figure code didn't compute. Absence is the enforcement.
- **`summary` is prose, and prose only.** The stored `ai_justification` (§2, §3) is 2–3
  sentences of synthesis. Composing it in code from the per-criterion `reason` strings yields a
  mechanical concatenation that satisfies the shape and loses the substance, so the model
  writes it, as `summary: string | null`.

  That does not weaken the rule above, because the rule is about numbers, not about text. The
  failure it guards against is narrow and concrete: the model writing *"roughly an 80% match"*
  while `computeWeightedScore` returned 73.4, leaving a recruiter with two contradicting
  figures and no way to tell which is real. So the number is kept out of the prose at both ends:

  - The evaluation prompt **explicitly forbids** any numeric score, percentage, rating or
    *x*/10 in the summary.
  - Post-validation **rejects** a summary that puts a figure on the score itself: a percentage,
    an *x*/10 or *x*/100 pattern, or a number quantifying the match — *"score of 80"*,
    *"80% match"*, *"rated 8"*. It deliberately does **not** reject counts. *"matches 4 of the
    6 criteria"* and *"8 years of experience"* are legitimate sentences, and rejecting them
    would burn a retry, and real API spend, on a correct summary. A rejected summary is a
    schema validation failure and takes the normal retry path (§5.4). It is **not** silently
    stripped — silent repair hides a model that is drifting.
  - The check runs **after** parsing, in code, not as a `.refine()` — for the same reason the
    completeness refine is banned above. A refine failure yields `parsed_output === null` with
    no diagnostic; a post-parse check throws a typed error naming the pattern that matched,
    onto the identical retry path.
  - Tests cover each rejected pattern, a clean summary passing, and *"matches 4 of the 6
    criteria"* explicitly, so the line between a count and a score is documented in the suite
    rather than implied by a regex.

  Stated once: **prose from the model, numbers only from code, enforced at the boundary.**

  Cost, accepted: the narrow rule lets an oblique paraphrase through — *"about four-fifths of
  what we're looking for"* states a figure without matching any pattern. That is the deliberate
  trade. The prompt-level prohibition is the primary control; post-validation is the backstop
  for the literal forms a drifting model actually produces, and a false rejection is more
  expensive than a rare oblique one.

**Years of experience:** the model returns only `statedYearsExperience` (what the CV literally
claims). `compute-experience.js` derives `computedYearsExperience` from work-history dates with
overlap merging and an injected `now`, and returns **`null` whenever the dates do not determine
a value** — including the open-end case above. Elimination rules read the computed value only,
and read a `null` as `indeterminate`. The stated value is kept as a discrepancy signal ("CV
claims 10 years; dates support 6.5"). Beside the number the module reports its working:
`segments`, `unusable` entries with a reason each, and `undetermined` entries — the open-ended
ones that are not current, each naming its employer, title and start date, and each flagged
with whether the other roles already cover it.

### 5.2 Prompts

Exported template functions returning `{ system, user }`. No branching beyond interpolation.
No prefill (400 on Opus 5); thinking stays adaptive. **The two calls no longer ask for their
JSON the same way**, and that is the subject of the next subsection:

| Call | Request | Response read from | SDK method |
|---|---|---|---|
| Evaluation | `output_config: { format, effort: 'high' }` | `parsed_output` | `messages.parse` |
| Extraction | `output_config: { effort: 'low' }` — no format | the text block, parsed in `client/json-response.js` | `messages.create` |

#### 5.2.1 Structured output: kept for evaluation, dropped for extraction

The schema-budget work in §5.1 was correct and got both measurable caps green — **0 unions
against 16, 22 optionals against 24**. Extraction still failed. It was bisected against the
live API, and the result is the reason this subsection exists:

| Schema sent | Result |
|---|---|
| 8 optional scalars, no arrays | accepted |
| 8 scalars + one **3**-property array | **accepted, 3.4s** |
| 8 scalars + one **8**-property array | timeout > 60s |
| 8 scalars + two arrays (the second only 2 properties) | timeout > 60s |
| 8 scalars + `skills` + `workHistory` | timeout > 120s |
| the real `extractedProfileSchema` | timeout > 120s; earlier, a fast `400 "Schema is too complex."` |

A control answering in 3.4 seconds in the same run rules out a network fault. So the binding
constraint is **grammar-compilation complexity**, and it has three properties that make it
different in kind from the two caps in §5.1:

- **it sits far below the documented limits** — this schema is under both, comfortably;
- **it is unmeasurable from outside** — there is no counter to write a test against, which is
  why `schema-budget.test.js` would never have caught it and does not claim to;
- **it surfaces inconsistently** — sometimes as a fast 400, sometimes as a hang past the
  120s call timeout, which reads as a network problem to everyone who sees it first.

**Decision: extraction sends no schema; evaluation keeps its grammar.** Two reasons, recorded
because a reviewer will ask and *"we tried it, measured where it breaks, and changed course"*
is the answer.

**1. The guarantee was always zod's.** §5.1 originally claimed constrained decoding made
inventing a criterion structurally impossible, and that claim was already corrected there: the
SDK's JSON-Schema transform demotes `enum` into the field's `description`, so enforcement was
*always* post-parse validation. Extraction's structured output was therefore buying much less
than this section assumed — and it was the thing blocking the pipeline. What actually protects
the profile is unchanged and is all still in place: `extractedProfileSchema` validates every
response, `.strict()` rejects an invented key, a mismatch feeds the failing paths back on the
single semantic retry (§5.4), and a second bad response fails the candidate.

**2. The grammar stays where it pays.** Extraction is *transcription* — the model is copying
facts out of a document, and a grammar constrains the punctuation of that, not the judgement.
The task where a decoding grammar earns its compilation cost is *structured reasoning*, which
is evaluation: 2 unions, 0 optionals, no arrays of objects, and it compiles and answers today.
So the grammar goes where it does not pay and stays where it does.

What is given up, stated plainly: the API no longer guarantees extraction's response is shaped
like the schema, so a malformed body is now possible where it previously was not. It costs a
retry when it happens, it is bounded by the same `SEMANTIC_RETRIES = 1` as everything else, and
`invalid_json` was already a row in the §5.4 matrix — a grammar-decoded response that never
arrived looked exactly the same. **No second retry mechanism was added.**

What replaces the grammar is prompt text (below) and two lines of defensive parsing: a leading
markdown code fence is stripped before the body is parsed, because a model told not to emit one
occasionally does and three backticks are not worth a whole generation. A *preamble* is
deliberately **not** repaired — hunting for the first `{` would rescue today's response while
hiding a model that is drifting, so it fails as `invalid_json`, takes the retry with the
correction attached, and is visible in the logs.

Cost and latency: unchanged calls per document (2), plus roughly 250 output-schema-shaped tokens
of extra *input* on the extraction call for the shape block, minus whatever the API charged for
compiling a grammar. The material change is that extraction now completes at all.

`test/agents/schema-budget.test.js` keeps both counters and keeps owning the evaluation schema —
the caps are real and still shape it. Its extraction assertions were **retired rather than
weakened**, and replaced by the one fact now worth guarding: that this request carries no schema.
Reinstating one would not fail loudly; it would hang for two minutes per candidate.

**Extraction** sees the CV only — no role, no criteria — or the profile becomes role-flattering.
CV text goes last, in `<cv>…</cv>` tags. Effort `low`: this is transcription, and thinking on a
transcription task is billed output tokens spent on nothing. Load-bearing lines:

> "Omitting a field is a correct answer, not a failure."
> "`workHistory`, `education`, `certifications` and `skills` are always part of your answer.
> When the CV has no such section, send an empty list."
> "Leave `endDate` out of a work-history entry when the candidate is still in that role."
> "Use `demonstrated` only when the CV describes the skill being *used*… When `evidenceType` is
> `demonstrated`, copy `evidenceQuote` verbatim — character for character."

The first line said `null` until prompt version 1.1.0; the second and third arrived with 2.0.0.
All three changed with the schema, not independently of it. An instruction to send `null`
against a schema with no place for one, an instruction to omit a list the schema requires, or
silence about what a missing `endDate` now means, are all the same failure: the model being
told one thing and validated — or read — against another.

The wording names the honest option first and makes the dishonest one *more work*.

**Version 2.1.0 carries what the grammar used to.** With no schema on the request (§5.2.1),
two things the decoder did for free became prompt text, and they are the load-bearing addition:

- **the exact shape**, written out key by key as a JSON skeleton, with the four always-present
  lists and the three always-present entry fields named in prose underneath, because the model
  no longer sees a `required` array;
- **JSON and nothing else**: `"Return that object and nothing else. No preamble, no
  explanation, no commentary after it, and no markdown code fence around it. The first
  character you write is the opening brace and the last is the closing brace."`

The skeleton is hand-written rather than generated from the zod schema: a generated JSON Schema
is a document for a compiler, and pasting one in spends hundreds of tokens teaching the model to
read `additionalProperties: false` instead of showing it the answer. That costs a drift risk,
and the risk is paid off in `prompts.test.js`, which walks `extractedProfileSchema` and fails if
the block names a field the schema does not define or omits one it does, in either direction.
The two enums are interpolated from `constants.js` for the same reason.

Extraction stopped using the shared `outputContractRule()` at 2.1.0 — that fragment tells the
model its answer is checked against "the provided schema", which is now false on this call, and
an instruction the model can see is false invites the rest of the prompt to be read as
approximate. Evaluation still uses it.

**A minor bump, not a major one**, and the distinction is the one 2.0.0 set: a major says *this
is a different output document*. It is not. The field set, the absence convention, the `endDate`
encoding and the evidence rules are unchanged, so a profile extracted under 2.0.0 and one
extracted under 2.1.0 are comparable field for field — which is the entire reason the version is
stored beside the extraction. What changed is how the shape reaches the model, and that can move
outputs, which is why it is a bump at all.

**Evaluation** sees the verified profile and the criteria. Effort `high`. It **withholds**:

- **The weights.** A model that knows a criterion carries 40% rates it strategically — the
  ratings stop being independent observations and become an attempt at the final answer.
- **The elimination rules.** A model told "no degree means rejection" drags every rating down
  for such a candidate, corrupting the score shown *next to* the Unmatched badge.
- **The raw CV.** Passing it again doubles input cost and reintroduces fabrication at exactly
  the point a claim becomes a number. Cost, stated plainly: anything extraction drops is
  invisible to evaluation forever.

Anchored 0–10 bands are the highest-leverage section; unanchored scales collapse into 6–8 for
everybody. `"Do not use 5 as a default for 'unsure' — if the profile is silent, the rating is 0."`
And the line that makes the evidence work pay off:
`"A skill with evidenceType: listed_only is a claim, not a demonstration."`

### 5.3 Scoring — the deterministic core

```js
computeWeightedScore(criteria, ratings)
  → { score, scoreRaw, weightSum, breakdown: [{ criterionId, rating, weight, weightedPoints }] }
evaluateEliminationRules(profile, rules, { now })
  → { eliminated, failures[], indeterminate[] }
assignTier(score, isEliminated) → 'strong_match' | 'potential_match' | 'unmatched'
```

`scoreRaw = Σ(rating × weight)` ∈ `0..1000`; `score = scoreRaw / 10`. Integer arithmetic
throughout, so the result is exact and byte-identical on every run. `breakdown` is returned in
the **role's** criterion order, never the model's response order, so a shuffled response
produces identical output.

`assignTier` checks `isEliminated` **first and unconditionally**, before reading any threshold.

**Reconciliation policy:**
- *Rating for a criterion that no longer exists* → dropped, recorded in `unknownIds`, warned.
  An extra rating cannot corrupt a weighted sum over a fixed criterion set.
- *Criterion missing from the response* → **one retry, then hard failure**,
  `IncompleteEvaluationError` naming the ids. Substituting 0 silently depresses the score;
  renormalizing silently inflates it. Both are invisible to a recruiter reading the number. A
  visibly failed candidate is recoverable; a quietly mis-scored one is not.

  The retry is why this error is labelled `retryable`, which reverses an earlier decision here
  that made it terminal on the first response. The reasoning: **a missing criterion is a
  generation failure, so the one thing that can fix it is a different generation.** The earlier
  rule — re-running a pure function over the same input fails identically — is true of the
  *argument* and false of the *generation*, which is the same reasoning already applied to a
  summary that states a score. The costs are asymmetric: one extra call, against discarding a
  complete evaluation and showing a recruiter a failed candidate.

  The retry happens in the **evaluation call's validation hook**, where the model is still in
  the loop and can be told which ids it omitted. `reconcile-ratings.js` is unchanged and still
  refuses an incomplete evaluation on sight — the hook is the recovery, the scorer is the
  guarantee, and the guarantee still holds for any caller scoring an evaluation that hook never
  produced.
- *Duplicate criterionId* → hard failure. No defensible way to pick between two contradictory
  ratings of the same thing.

Boundary values under test: tiers at 64/64.9/65/84/84.9/85/86/0/100; eliminated at each;
all-zero and all-ten ratings; single criterion; rating 11 / −1 / 7.5 → throws; shuffled ratings
→ identical output; overlapping employment merged not summed; `null` dates → `null` not `0`;
one golden fixture run 100× asserting byte-identical JSON.

### 5.4 Client wrapper and failure taxonomy

`new Anthropic({ apiKey, timeout, maxRetries: 2 })` — **TS SDK timeouts are milliseconds**.
Non-streaming: both outputs are small — one is schema-bounded by the API and one is bounded by
`max_tokens` and a prompt (§5.2.1), and both are well inside the non-streaming ceiling even
after a truncation retry doubles the budget. Two retry layers:

**No `temperature`, and this is the answer to the variance question.** Checked against the
Anthropic documentation on **2026-08-19**: `temperature`, `top_p` and `top_k` are **removed on
this model family** — Opus 5, Opus 4.8, Opus 4.7, Sonnet 5 and Fable 5 — and sending any of
them returns **400**. Setting `temperature: 0` on the evaluation call is therefore not a tuning
decision that was skipped; it is a request that fails. Recorded here with the date because it
is the first thing anyone asks about a system that puts a model in front of a hiring decision,
and the answer should not live only in a code comment.

What the system does about variance instead, in descending order of how much it actually buys:

1. **The score is not the model's.** `computeWeightedScore` is integer arithmetic over ratings
   and weights (§5.3) — byte-identical on every run, and a pure function of its inputs. Nothing
   in the sampler could have made the *arithmetic* less variable, because the arithmetic was
   never variable.
2. **Every rating is shown with its evidence.** A recruiter is not asked to trust an 8; they are
   shown the criterion, the one-sentence reason, and the verbatim span it rests on. Variance
   that survives is visible rather than hidden inside a number.
3. **The stored result is not recomputed on read.** Score, tier, matrix and justification are
   written once when the candidate is screened and served from the row thereafter, so the same
   candidate does not move between two page loads. §8's caveat about re-running the *pipeline*
   is a different claim from the dashboard being stable.
4. **`output_config.effort`** replaces sampling parameters as the depth control: `low` for
   extraction, `high` for evaluation (§5.2).

Stated honestly: this reduces the blast radius of variance, it does not remove it. The same CV
screened twice can still produce different ratings and therefore a different score — that
limitation is §8's, and it is unchanged by anything in this section.

| Layer | Owner | Retries |
|---|---|---|
| Transport (408/409/429/5xx/connection) | SDK | 2, exponential, honours `retry-after` |
| Semantic (validation failure, truncation) | `call-structured.js` | 1 |

**`SEMANTIC_RETRIES = 1` is shared, not additive.** It is one budget for the whole response,
not one per condition, and every semantic condition draws on the same allowance: a schema
mismatch, a truncation, a non-JSON body, a summary that states a score, and an evaluation
missing a criterion.

**Dropping structured output on extraction (§5.2.1) added no mechanism here.** `invalid_json`
was already in this list — a grammar-decoded response that never arrived looked identical — so
a model that answers in prose lands on the row that already existed, spends the same single
retry, and gets the same correction appended. What changed is only *where the parse happens*:
`client/json-response.js` finds the text block, strips a leading code fence, and runs the same
zod schema, returning the same discriminated result the SDK's parser returns on the other path.
Truncation, refusal, `no_output`, `unsupported_stop_reason`, context overflow and every
transport row behave exactly as before, on both paths, and the suite asserts each of them
twice. So the obvious question — what happens when the summary is wrong *and* a
criterion is missing — has one answer: the response is rejected once, both faults are fed back
in the same correction, and if the second response is still wrong the candidate fails. It never
costs two retries.

Ordering matters when more than one condition fires. Completeness is checked **before** the
summary rule, because a response missing two of six ratings has a bigger problem than a
sentence with a percentage in it, and spending the single retry on the smaller fault would be
the wrong trade. The consequence, stated plainly: the worst case per model call is unchanged by
adding conditions, and only a candidate that would previously have failed outright now spends a
second call.

Worst case is 6 HTTP requests, and the SDK retries timeouts too — so an outer
`AbortController` enforces a **hard 240s deadline per candidate** regardless of what the retry
layers are doing. Extraction timeout 120s, evaluation 90s.

`stop_reason` is checked **before** `parsed_output`: a null caused by truncation
(→ retry with doubled `max_tokens`) and one caused by an unsatisfiable schema need opposite
responses. `stop_reason: 'refusal'` is **never** retried.

Worker-side codes stored on the candidate: `EXTRACTION_FAILED`, `EMPTY_DOCUMENT`,
`AGENT_TIMEOUT`, `AGENT_RATE_LIMIT`, `AGENT_UPSTREAM`, `AGENT_REFUSED`, `AGENT_BAD_OUTPUT`,
`AGENT_INCOMPLETE_EVAL`, `AGENT_INPUT_TOO_LARGE`, `AGENT_SCHEMA_REJECTED`,
`AGENT_INVALID_ROLE`, `AGENT_UNKNOWN_RULE`, `SOURCE_FILE_MISSING`.

**`UNSUPPORTED_FILE_TYPE` is deliberately not in this namespace, and phase 4 must map it as a
415 at upload.** It is an HTTP-layer rejection (§3), not a worker-side candidate error, because
a file whose bytes we cannot read **never becomes a candidate row** — so there is no
`candidates.error_code` to store it in. Phase 3 exports `sniffMimeType` for exactly this: the
upload endpoint sniffs the bytes, and a type outside §2's allowlist is refused before anything
is written. Recorded here so phase 4 maps it on purpose rather than rediscovering the gap and
inventing a worker code that nothing could ever set.

`AGENT_INPUT_TOO_LARGE` was added during phase 2b and is not in the original list: a CV that
overflows the context window is neither bad output nor an empty document, and collapsing it
into either would tell a recruiter to fix the wrong thing.

`AGENT_SCHEMA_REJECTED` was added after the smoke test in §5.1 and exists for the same reason
turned inside out: the API rejected **our own output schema**, before the model saw the
request. That is a permanent configuration fault in this repository — retrying never fixes it,
and it fails every candidate in every batch identically — whereas `AGENT_UPSTREAM` tells
whoever reads the log to look at the network, the rate limit or Anthropic's status page, all
of which are the wrong place. **Not retryable.**

Detection is the honest weak point and is documented as such in the code. Unlike context
overflow, this failure carries no machine-readable `type` of its own: it arrives as a generic
`invalid_request_error` distinguishable only by the prose in its message, and matching upstream
prose is exactly what the rest of the client refuses to do. Two things bound that. A miss is
not a regression — an unmatched 400 falls through to today's `AGENT_UPSTREAM` behaviour, so
the failure mode is losing an improvement rather than breaking a behaviour, and a test asserts
it. And the real defence sits before the network: the two-cap schema-budget test in §5.1 means
this code path should never run at all. Since §5.2.1 it is narrower still — only the evaluation
call sends a schema, so this is the only call that can be told its schema was rejected. It carries one signature id per known cap
(`too_many_union_parameters`, `too_many_optional_parameters`) rather than one for "schema
rejected", because the two send whoever reads the log to opposite edits — and trading one for
the other is exactly what produced the second 400.
Each carries a recruiter-safe `userMessage`; `detail` goes to logs and **never contains CV
text** (asserted by planting a sentinel string in a fixture CV and scanning serialized errors).

The agent layer *labels* retryability; the worker *decides* retry policy.

**No server-side refusal fallback in v1.** This deviates from the SDK default. A refusal here
signals something wrong with the input, and rescuing it with a different model would put
non-comparable ratings into the same batch — in a system whose entire premise is comparability,
that is worse than a visible failure.

### 5.5 Scanned PDFs

Chosen: **detect and fail clearly** (not OCR). Ownership is split deliberately:
`server/src/extraction/` owns "can I get text out of this file" (→ `EXTRACTION_FAILED` /
`EMPTY_DOCUMENT`); `agents/util/text.js` owns "is this text worth spending a token on"
(character count, alphabetic ratio, at least one CV-shaped signal → `AgentInputError` before
any API call). The redundancy is intentional — the second check is the cheapest possible
failure.

README wording will be explicit that OCR was declined, and why: OCR'd CV text degrades
extraction quality, which then degrades the scores the whole system is judged on.

---

## 6. Frontend

Routes: `/roles`, `/roles/new`, `/roles/:id/edit`, `/upload`, `/dashboard`, `/candidates/:id`.
Dashboard filters/sort/page live in the **URL**, so a recruiter can bookmark and share
"Strong Match candidates for Senior Backend Engineer". Filter changes use `replace`, navigation
uses `push`.

**Role form.** A sticky footer bar, always present, with three redundant signals: a
proportional bar, the literal text `Weights total 92 of 100 — 8 left to assign`, and a ⚠/✓
icon. The text is in an `aria-live="polite"` region, debounced ~400ms. **Save stays enabled**
when weights ≠ 100 — a disabled button with no adjacent reason makes users hunt for the cause.
Pressing Save runs zod, renders an `ErrorSummary` (`role="alert"`), moves focus to it, and
sends no request.

**Upload.** Two genuinely different phases, not blurred: the HTTP upload has real byte progress
(`XMLHttpRequest`, because `fetch` gives none), and the server pipeline gets a **4-step stepper**
— Upload → Parse → Evaluate → Done — with the active step shimmering and elapsed time beside it.
No fake percentage creeping to 90% on a timer: when the LLM takes 25s instead of 4, a fake bar
either stalls (reads as broken) or lies. The stepper says *which* stage, which is what a
recruiter actually wants.

**Dashboard.** Non-terminal and failed candidates live in a **Processing panel above** the
ranked table; the table below contains only `done` rows and is therefore stable under a score
sort. Polling fetches **statuses only** for on-screen ids and patches in place — it does not
reorder. When candidates finish, a bar appears: *"2 candidates finished scoring — Refresh
ranking"*. The recruiter chooses the moment the table moves.

An eliminated row shows its score, the Unmatched tier, a ⊘ glyph, and a sub-line naming the
failing rule. Without that line the table looks broken (78 points, Unmatched, no reason) and
the recruiter stops trusting the tool.

**Detail.** Elimination banner **above** the evaluation matrix, because elimination is
categorical rather than a contribution. The matrix is a real `<table>` — Criterion | Weight |
Rating | Contribution | Why — with reasons rendered in full, never truncated into a tooltip.
The reason *is* the product. The Contribution column footer sums to exactly the match score.

**Polling.** Upload and detail 3s, dashboard 5s. Chained `setTimeout` after each response
settles — never `setInterval`, which queues requests when the server is slow. One
`AbortController` per request; a monotonic request id guards against a slow earlier response
overwriting a fresh one. Backoff 3→8→20s capped at 30s after 60s with no change. Stops on: all
entities terminal, unmount, tab hidden, 4 consecutive failures, a 10-minute hard cap, or a 404.
Hidden tabs poll not at all; on return it polls immediately at the base interval. **Aborts are
not failures** and never increment the counter — that is the classic hand-rolled-polling bug,
and it has a dedicated test.

A failed *poll* never replaces rendered data with an error state. It shows a quiet inline
banner: *"Live updates paused — can't reach the server. Last updated 1:04pm."*

**State.** No data-fetching library and no global store. Two hooks (`useResource`,
`usePolledResource`) plus URL params and two `useReducer`s. TanStack Query would give
deduplication, caching and retry for ~13kb — but with six endpoints, almost no cross-screen
cache reuse, two mutations both followed by a navigation, and polling behaviour custom enough
to be configured *around* the library, hand-rolling ~150 lines is proportionate. This is
honestly the likeliest home of a real bug in the submission, which is why `usePolledResource`
gets the most thorough test in the suite.

**Tier is always the server's `fitCategory`.** The client never recomputes `score >= 85` —
elimination overrides score, and a client reimplementation would silently diverge the day a
threshold moves. Tier is conveyed by text + glyph + colour, never colour alone.

Plain CSS with custom properties and CSS Modules. No component library: this app needs eight
primitives, has no combobox, menu or modal, and a kit's cost (generated code to defend, or 90kb
and a marketing design language to fight) exceeds its benefit here. `react-router-dom` is the
one dependency that pays for itself, because URL-as-state is the highest-value interaction
decision available.

All model-generated text renders as text nodes. `dangerouslySetInnerHTML` appears nowhere.

---

## 7. Decisions taken on the open questions

**A. Role model — many roles, per-candidate.** Every candidate carries its own `role_id`; there
is no `is_active` flag. Several roles can be screened in parallel, each with its own dashboard.
The PDF's "active Job Role Criteria" is read as UI shorthand; the schema's explicit
`Target Job ID` is authoritative.

**B. Score precision — one decimal, half-open bands.** `numeric(4,1)`. `score = Σ(rating ×
weight) / 10`, so one decimal falls out of integer arithmetic exactly — no rounding step, no
floating-point reasoning, byte-identical across runs. Tier bands are `[85, 100]`,
`[65, 85)`, `[0, 65)`, which leaves no gap: 84.7 is Potential, 85.0 is Strong. This matches the
PDF's "Float" data type.

The counter-argument, recorded because it is a fair one: the atoms are 0–10 judgments from a
stochastic model that move ±1 between runs, so a displayed 84.7 asserts a resolution the
measurement does not have. The README will state that the decimal reflects exact arithmetic
over the ratings, not confidence in the rating itself.

**C. Unknown facts do not eliminate.** A rule whose fact is absent from the profile returns
`indeterminate`, and the candidate is badged as unchecked rather than rejected. Elimination
requires positive evidence of failure. Per-rule `on_missing: 'flag' | 'eliminate'` (default
`flag`) lets a recruiter opt into hard rejection for a genuinely hard requirement such as a
licence or work authorisation.

Rationale: the alternative silently drops every image-only, two-column and non-English CV into
Tier 3, where no human ever looks. That is a discrimination pattern with a purely technical
cause. Cost, accepted: unqualified candidates reach Tier 2 and recruiters filter more.

**A fact the code could *derive* is still a fact it can be missing, and this is where that was
got wrong.** `min_years_experience` reads `computedYearsExperience`, which code computes rather
than the model asserting — and computing it from an incomplete work history had been treated as
always possible. It is not: an entry whose `endDate` the extraction lost has no end date to
compute from, and closing it at `now` produced **10.7 years** out of a twelve-month job, passing
a five-year gate on a number nothing measured (the probe table is in §5.1). The rule for reading
an absent end date is in §5.1; what belongs *here* is the principle it was derived from:

> An unknown fact is `indeterminate` whether the fact is **absent from the profile** or
> **underdetermined by it**. A derived value that cannot be derived is missing in exactly the
> sense this decision is about, and inventing a defensible-looking number for it is worse than
> any of the failures 7-C was written to prevent — because a gap is visible and a plausible
> number is not.

Three consequences, all implemented:

- `computedYearsExperience` is `null` when the dates do not determine it, and `null` is never
  read as `0`. Zero would *fail* the rule; null makes it indeterminate.
- The indeterminate detail says **why**, naming the entry — employer, title and start date — so
  the recruiter can look at that line of the CV. "We could not tell" with no cause attached is a
  badge nobody can act on.
- The outcome reaches storage as its own thing. `elimination_details` carries every rule with
  its `outcome`, the `indeterminate` subset, and a `hasIndeterminate` flag, so an unchecked
  requirement renders differently from a satisfied one instead of collapsing into "not
  eliminated". An eliminated-by-`on_missing` rule stays in the `indeterminate` list too: the
  candidate was removed by a recruiter's policy, not shown to fail.

**D. Identity redaction — in.** `evaluation/redact-identity.js` strips name, email, phone and
linkedin from the profile before the *evaluation* call only. No criterion can legitimately
reference them, so it costs no signal. Storage, the dashboard and the candidate detail view are
unaffected — the recruiter still sees the whole person; the judge does not.

Institution names are **not** redacted. That would remove signal recruiters legitimately weight,
and should be a role-level toggle rather than a unilateral default.

**E. Also in:** `POST /candidates/:id/retry`, and rate limiting on the two upload endpoints.
**Not in:** `Idempotency-Key` on upload — see §3.

**F. Scanned PDFs — detect and fail clearly; no OCR.** A PDF whose text layer yields too little
extractable text for its page count is not sent to the model. The candidate fails with
`EMPTY_DOCUMENT` and the recruiter-facing message *"This PDF appears to be a scanned image; no
extractable text layer was found. Re-upload a text-based PDF or a DOCX."* Detection lives in
`server/src/extraction/`; a second cheap guard in `agents/util/text.js` catches text that
survives extraction but is not worth spending a token on. Mechanics in §5.5.

OCR was declined deliberately, and the README states the reason rather than omitting it:
`tesseract.js` is a large dependency, needs page rasterisation, runs in seconds-to-minutes per
page, and — decisively — OCR'd CV text extracts badly, which degrades the profile, which
degrades the ratings, which degrades the scores the whole system is judged on. A clear failure
a recruiter can act on beats a confidently wrong score. The README documents the extension
point: extraction is dispatched on sniffed MIME type behind one interface, so an OCR fallback
slots in at the point where `EMPTY_DOCUMENT` is currently raised, with no change above it.

**G. Queue — BullMQ + Redis, chosen by the project owner** over the recommended
Postgres-backed `SKIP LOCKED` alternative, on the grounds that Redis sits in the same
`docker-compose.yml` and so still costs a reviewer one command. Reasoning to carry into the
README is in §4.

---

## 8. Known limitations to carry into the README

- **The determinism guarantee covers the scoring function, not the pipeline.** The same CV run
  twice can produce different ratings and therefore a different score. The honest claim is:
  *the score is a reproducible function of the ratings, and every rating is shown with its
  evidence.* Mitigation the architecture is ready for but v1 does not do: re-evaluate only
  candidates landing within ±2 of a threshold.
- **The 85 and 65 thresholds are asserted, not validated.** Nobody has checked that 85
  corresponds to "strong" for a real recruiter. Validating it needs 30–50 labelled CVs and an
  offline agreement harness — worth more than any sampling machinery.

  **First datapoint, recorded 2026-08-20.** A live end-to-end screening of a strong synthetic
  backend CV — nine-plus years, demonstrated evidence on every core criterion, all three
  elimination rules passed — scored **81.5** and landed in **Potential Match**, 3.5 points under
  the threshold. Ratings were 9/7/9/7/8/8 across weights 30/20/20/15/10/5.

  This is **not** evidence the threshold is wrong. It is one CV, written by us, scored once, and
  the model's reasoning for each 7 was specific and defensible — it marked down API contract
  mechanics and testing practice because the CV genuinely does not mention them. A rubric that
  awards 85+ to a candidate with two named gaps may be behaving exactly as intended.

  What it is: the first concrete instance of the question, and a calibration of how far off 85
  a plainly strong candidate can land. What would settle it: the 30–50 labelled CVs above, with
  a recruiter's own Strong/Potential/Unmatched label per CV, and agreement measured against the
  computed tier. Until that exists, moving the threshold on one datapoint would be substituting
  our intuition for theirs — which is the failure the harness exists to prevent.
- **Extraction is a single point of failure.** Every rating, elimination and score depends on
  one non-deterministic call, and evaluation cannot see past it.
- **Local disk means the API and worker must share a filesystem.** This does not scale
  horizontally as written; S3 the day it needs two nodes. The sharpest architectural limit here.
- **No rescore path after a role edit.** Old scores persist, stamped with `scored_role_version`,
  and the dashboard will show candidates scored under different rubrics side by side.
- **A CV with a single work entry and no end date computes confidently as current**, because
  there is no later role to supersede it — the correct reading of the CV convention, and also
  the exact shape someone would use to game a `min_years_experience` requirement.
- **Table-based two-column CV templates interleave.** Measured in phase 3 against a real
  fixture, not predicted. A CV laid out as a two-column *table* extracts with the columns
  welded together line by line — `EXPERIENCE SKILLS`, then `Senior Backend Engineer Node.js`,
  a job title against a technology and a date range against a skill.

  The distinction is sharp and worth keeping sharp: **column-section layouts extract cleanly**
  — Word columns, InDesign text frames, LaTeX `multicol` — because the producer emits one
  column's content before the next. The same ink at the same coordinates, emitted column-major,
  comes out perfectly ordered. It is the *producer's* content-stream order that decides this,
  not the visual layout, so "two-column CV" is not the predictor; "two-column table" is.

  **What a recruiter sees when it happens:** the interleaved text still passes `assessCvText`
  and still reaches the model, so the candidate is scored — with lower ratings and reasons that
  cite the mangled evidence. That is the intended failure mode per §7-C: a degraded rating with
  its evidence visible beats a silent disappearance into Tier 3, because a human reading the
  detail view can see the extraction went wrong and re-upload.

  **Column reconstruction was declined.** Clustering text by x-position would also fire on the
  right-aligned date gutter that most *single*-column CVs have, so it would corrupt the common
  case to rescue the rare one. Breaking CVs that currently extract correctly, to partially fix
  CVs that never did, is the wrong trade.

- **Non-English and non-Western-format CVs** will extract poorly. No adequate mitigation; it
  belongs on the risk register, not in a mitigation column. Distinct from the item above: that
  one is a layout-producer problem with a known cause, this one is a language and
  date-convention problem with no cause we can address.
- **Regulatory exposure.** Automated candidate screening touches the EU AI Act, NYC Local Law
  144, and GDPR Art. 22. The architecture does the right things — every rating, reason, evidence
  quote and elimination reason is retained and attributable, and code decides so the decision is
  explainable. The product assumption that Tier 3 never means auto-reject without a human should
  be stated explicitly.
- **CVs are personal data with no delete endpoint, no TTL and no retention policy.** The spec
  omits it; a real deployment cannot.
- **Uploads are not idempotent.** A double-clicked upload button creates duplicate candidates
  and spends the LLM budget twice. Duplicates are detectable after the fact via
  `(role_id, content_sha256)` but are not prevented.
- **Ranking worst-first is a backwards scan of a `DESC NULLS LAST` index**, not an index-backed
  ascending order, and is fine at these row counts.
- **An empty fact list is treated as unknown, not as absence.** A rule whose profile fact is
  `[]` returns `indeterminate` exactly as `null` does — §7-C fixes the behaviour for a missing
  fact but not for an empty one, and the two are indistinguishable in practice, since an
  extraction that found nothing and a CV that lists nothing produce the same empty array.
  Cost, accepted and stated because it runs against the recruiter's intuition: a candidate who
  genuinely lists no skills at all is **flagged for review rather than eliminated**, so a
  `required_skill` rule will not screen out an empty CV on its own.

- **The criterion enum is a decoding hint, not a decoding constraint.** The SDK's JSON-Schema
  transform demotes `enum` into the field `description` — on the official `zodOutputFormat` path
  as well — so the model is *told* the valid criterion ids rather than *restricted* to them. An
  invented id is caught by the zod enum on parse, retried once, and then fails the candidate.
  No invented criterion can reach a score; the enforcement is validation, not decoding.

### A note the README must carry

Not a limitation — a disclosure, and it belongs above the setup instructions rather than
buried at the end, so a reviewer reads it before forming a theory:

> This project was built with AI assistance under my direction. The architectural decisions are
> mine — the data model, the split between what the model judges and what code computes, the
> phase structure, and every trade-off recorded in `docs/PHASE-0-PLAN.md`.

---

## 9. Cost

**Measured, not estimated.** One real candidate screened end to end against `claude-opus-5` on
2026-08-20 — a 1,757-character CV, a six-criterion role, one attempt per call, no retries:

| Stage | Input | Output |
|---|---|---|
| extraction (`effort: low`) | 3,183 | 1,330 |
| evaluation (`effort: high`) | 5,006 | 1,826 |
| **total** | **8,189** | **3,156** |

At $5/$25 per MTok that is **$0.12 per candidate** — $0.041 input, $0.079 output. 1,000 CVs
≈ **$120**.

The original estimate below was ~4,500 input + ~2,600 output ≈ $0.088, "realistically
$0.07–$0.15". The total landed inside that range, but **input ran 1.8× the estimate** and that
is the number to plan against: the extraction prompt carries a hand-written JSON skeleton since
§5.2.1 dropped the grammar (~+450 tokens), and the whole verified profile is serialized into the
evaluation call. Output was close. One measurement is not a distribution — a longer CV or a
ten-criterion role moves both numbers — but it beats an estimate, and re-measuring is one script.

Biggest lever already applied: extraction at `effort: low` (thinking is ~60% of extraction's
output tokens at high effort and buys nothing on a transcription task).

**The largest lever not yet pulled: run extraction on a cheaper model.** Extraction is
*transcription* — copy what the CV says into fields, and say nothing where it says nothing. It
is the same argument §5.2.1 used to drop constrained decoding for extraction while keeping it
for evaluation: the reasoning happens in the evaluation call, and that is the one that has to be
the strongest model available. On the measured split, extraction is 3,183 in / 1,330 out —
about 39% of input and 42% of output — so moving it to Haiku 4.5 ($1/$5) takes the per-candidate
cost from **$0.12 to roughly $0.086**, near 30%.

Documented as a lever, **not implemented**. Extraction is precisely the fabrication-sensitive
step, and the whole design rests on the profile being an honest transcript: `verify-evidence.js`
can falsify a quote but nothing catches a plausible invented employer. Pulling this lever needs
a measured fabrication rate on a labelled set first — the same harness §8 wants for the tier
thresholds — not an assumption that a cheaper model transcribes as faithfully. Also available:
the Batch API at 50% off for bulk uploads. Prompt caching probably will **not** pay: the stable prefix is ~900 tokens, under the
~1,024-token minimum, and input is only ~26% of the bill.

---

## 10. Build phases

Each phase stops for approval. Nothing in a later phase starts before the earlier one is
accepted.

**Phase 1 — Data layer.** Migrations (numbered, forward-only, up/down), repositories with
parameterized SQL, and seed data with at least two realistic job roles whose weights total 100
and which carry genuinely different elimination rules. Integration-tested against a real
Postgres from docker-compose. Exit: `npm run migrate` runs clean from an empty database, the
seed produces two usable roles, and repository tests pass.

**Phase 2a — Deterministic core.** *No LLM, no network, no SDK import anywhere in this phase.*

- `agents/schemas/` — `profile.schema.js`, `evaluation.schema.js` (including
  `makeEvaluationSchema(role)`), `role.schema.js`
- `agents/scoring/` — `reconcile-ratings.js`, `compute-score.js`, `elimination.js`,
  `tiers.js`, `score-candidate.js`
- `agents/extraction/compute-experience.js` and `verify-evidence.js` — both pure
- every boundary test named in §5.3, plus the golden fixture asserted byte-identical over 100 runs

Exit: `scoring/` at 100% coverage — anything less is a blocking failure, because this is the
only code in the system that produces the number. Reviewable on its own: a reader can verify
the scoring rules without knowing an LLM is involved.

**Phase 2b — Model-facing layer.** Everything that talks to Anthropic, built on top of a 2a
that is already proven.

- `agents/client/` — `anthropic-client.js` (the only SDK import), `call-structured.js`,
  `errors.js`
- `agents/prompts/` — `shared-rules.js`, `extraction.prompt.js`, `evaluation.prompt.js`
- `agents/extraction/extract-profile.js`, `normalize-profile.js`
- `agents/evaluation/evaluate-candidate.js`, `redact-identity.js`
- `agents/pipeline/screen-candidate.js`
- tests with an injected fake client, plus the `fetch` tripwire in `vitest.setup.js`

Exit: no test performs a network call, the tripwire is proven to fire, and the retry/refusal/
truncation matrix in §5.4 is covered.

*Why this split:* 2a is pure functions with hand-written inputs and exact expected outputs —
it needs no mocking strategy and no API knowledge, and it is where the correctness of the
product actually lives. 2b is orchestration, failure handling and prompt wording, and it is
far easier to write once the thing it orchestrates is known-correct. Splitting also means a
failure in 2b cannot silently be a scoring bug.

**Phase 3 — Document parsing.** PDF, DOCX and TXT to raw text; scanned-PDF detection per §7-F.

**Phase 4 — API and pipeline.** Role CRUD, uploads, the BullMQ worker, candidate list and
detail, the central error handler, rate limiting on uploads, the retry endpoint.

**Phase 5 — Frontend.** The five routes in §6.

**Phase 6 — Delivery.** README (setup, env vars, architecture, the design decisions in this
document and their reasoning — including §4 on the queue and §7-F on OCR — known limitations
per §8, and what comes next), `.env.example`, seed script, sample CVs.
