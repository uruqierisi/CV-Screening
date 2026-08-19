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
| `min_years_experience` | `{ years: int 0..60 }` | `computedYearsExperience` | `>=` |
| `required_skill` | `{ skill, matchMode: 'exact'\|'normalized', mustBeDemonstrated: bool }` | `skills[]` | token match; `mustBeDemonstrated` requires `evidenceType === 'demonstrated'` **after** quote verification |
| `required_education_level` | `{ level }` | `education[]` | ordered ladder `none < high_school < associate < bachelors < masters < doctorate` |
| `required_certification` | `{ name, matchMode }` | `certifications[]` | normalized name match, **and not stated-expired** — see below |
| `location_allowlist` | `{ countryCodes: [ISO-3166-1 alpha-2] }` | `location` | membership |

The union is **closed**: a rule type with no code evaluator cannot be stored, and an unknown
type at evaluation time **throws** — it never silently passes. A unit test asserts the stored
enum and the evaluator registry are the same set.

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

- **`.nullable()` everywhere, `.optional()` nowhere.** A nullable-but-required field forces an
  explicit per-field decision and distinguishes "the CV doesn't say" from "the model stopped
  generating". That distinction *is* the anti-fabrication story.
- **`email` is a plain string, not `z.string().email()`.** Strict validation is all-or-nothing
  at the API boundary — one mangled OCR email would null the entire extraction and burn a
  retry over a field nobody scores on. Format checks live in `normalize-profile.js`, which
  nulls the bad field and keeps the other forty.
- **`skills[].evidenceType: 'demonstrated' | 'listed_only'`** alongside a nullable `evidence`.
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
overlap merging and an injected `now`. Elimination rules read the computed value only. The
stated value is kept as a discrepancy signal ("CV claims 10 years; dates support 6.5").

### 5.2 Prompts

Exported template functions returning `{ system, user }`. No branching beyond interpolation.
Both go through `messages.parse` with `output_config: { format: zodOutputFormat(Schema), effort }`.
No prefill (400 on Opus 5); thinking stays adaptive.

**Extraction** sees the CV only — no role, no criteria — or the profile becomes role-flattering.
CV text goes last, in `<cv>…</cv>` tags. Effort `low`: this is transcription, and thinking on a
transcription task is billed output tokens spent on nothing. Load-bearing lines:

> "Every field may be `null`. `null` is a correct answer, not a failure."
> "Use `demonstrated` only when the CV describes the skill being *used*… When `evidenceType` is
> `demonstrated`, copy `evidenceQuote` verbatim — character for character."

The wording names the honest option first and makes the dishonest one *more work*.

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
Non-streaming: outputs are schema-bounded and small. Two retry layers:

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
missing a criterion. So the obvious question — what happens when the summary is wrong *and* a
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
`AGENT_INCOMPLETE_EVAL`, `AGENT_INPUT_TOO_LARGE`, `AGENT_INVALID_ROLE`, `AGENT_UNKNOWN_RULE`,
`SOURCE_FILE_MISSING`.

`AGENT_INPUT_TOO_LARGE` was added during phase 2b and is not in the original list: a CV that
overflows the context window is neither bad output nor an empty document, and collapsing it
into either would tell a recruiter to fix the wrong thing.
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
- **Extraction is a single point of failure.** Every rating, elimination and score depends on
  one non-deterministic call, and evaluation cannot see past it.
- **Local disk means the API and worker must share a filesystem.** This does not scale
  horizontally as written; S3 the day it needs two nodes. The sharpest architectural limit here.
- **No rescore path after a role edit.** Old scores persist, stamped with `scored_role_version`,
  and the dashboard will show candidates scored under different rubrics side by side.
- **Non-English and non-Western-format CVs** will extract poorly. No adequate mitigation; it
  belongs on the risk register, not in a mitigation column.
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

Per candidate, `claude-opus-5` at $5/$25 per MTok: ~4,500 input + ~2,600 output ≈ **$0.088**,
realistically $0.07–$0.15. 1,000 CVs ≈ **$90**.

Biggest lever already applied: extraction at `effort: low` (thinking is ~60% of extraction's
output tokens at high effort and buys nothing on a transcription task). Available later: the
Batch API at 50% off for bulk uploads; Haiku 4.5 for extraction (~$0.045 total) — but not
without measuring fabrication rate first, since extraction is precisely the fabrication-sensitive
step. Prompt caching probably will **not** pay: the stable prefix is ~900 tokens, under the
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
