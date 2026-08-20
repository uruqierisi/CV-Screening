# AI CV Screening & Applicant Ranking System

Upload a batch of CVs against a job role. Each one is parsed, transcribed into a structured
profile, judged criterion by criterion against that role's rubric, scored, and ranked — with
every rating shown next to the evidence it was based on.

The system is built around one rule: **the language model never produces the score.** It rates
each criterion 0–10 and gives a one-sentence reason citing evidence from the CV. A pure
function applies the role's weights and produces the number. Elimination rules are evaluated in
code against extracted facts. Everything a recruiter acts on is either arithmetic they can
check or a quote they can read.

---

## A note on AI assistance

> This project was built with AI assistance under my direction. The architectural decisions are
> mine — the data model, the split between what the model judges and what code computes, the
> phase structure, and every trade-off recorded in [`docs/PHASE-0-PLAN.md`](docs/PHASE-0-PLAN.md).

---

## Setup

### Prerequisites

- **Node.js ≥ 22** (developed and verified on 24.14.0)
- **Docker**, for PostgreSQL 16 and Redis 7
- An **Anthropic API key** — needed only to screen a CV. Everything else (migrations, the seed,
  the API, the entire test suite) runs without one.

### The sequence

Run these in order from the repository root. **The API and the worker are two separate
processes** and both must be running for a CV to be screened — steps 6 and 7 are two terminals,
not one.

```bash
# 1. Configuration. Every value in .env.example is a working default; the only
#    blank is the API key.
cp .env.example .env

# 2. Put your key in .env:  ANTHROPIC_API_KEY=sk-ant-...
#    Without it the API, migrations, seed and tests all still run. The worker
#    refuses to start, and says so by name.

# 3. Backing services. `--wait` blocks until both containers report healthy,
#    which stops the next step racing Postgres. Host ports are 5442 and 6389 —
#    deliberately not 5432/6379, which are usually already taken.
docker compose up -d --wait

# 4. Server dependencies, schema, and two example roles.
cd server
npm install
npm run migrate          # 8 forward-only migrations, from an empty database
npm run seed             # Senior Backend Engineer (Node.js) + ICU Nurse

# 5. Optional, and the fastest way to see the system is intact.
npm test                 # 1320 tests. Creates its own database; needs step 3.
npm run test:unit        # or 1020 of them in ~4s, with Docker stopped — the
                         # agent, extraction and decision layers touch no socket

# 6. Terminal one — the HTTP API on :3000
npm start

# 7. Terminal two — the screening worker (from server/ as well)
npm run worker

# 8. Terminal three — the UI on :5173
cd ../web
npm install
npm run dev
```

Open **http://localhost:5173**, pick the seeded backend role, and upload something from
[`samples/`](samples/).

### Verifying it worked

| Check | Expect |
|---|---|
| `curl localhost:3000/api/v1/health` | `{"data":{"status":"ok","dependencies":{"database":true,"redis":true}}}` |
| `curl localhost:3000/api/v1/roles` | two seeded roles |
| Worker terminal | `screening worker started`, with `concurrency: 4` |
| http://localhost:5173 | the roles list |

### This was verified from a cold clone

The sequence above was run start to finish in an empty directory with no `.env`, on
2026-08-20: fresh `git clone`, fresh Docker volumes, fresh `npm install`. All 8 migrations
applied to an empty database, the seed produced both roles, **1320 server tests and 126 web
tests passed**, both processes started, and the UI served and proxied to the API.

That run found one real defect, now fixed: `cv.txt` — a fixture that deliberately carries CRLF
line endings, because it exists to test newline normalisation — was being stripped to LF by
Git's end-of-line conversion on commit. A fresh clone got a file the generator could not have
produced, and two tests failed on a machine where nobody had done anything wrong. The fix is
[`.gitattributes`](.gitattributes), which marks the fixture and sample directories `-text` so
their bytes are stored and checked out verbatim.

### Common problems

| Symptom | Cause |
|---|---|
| `EADDRINUSE :3000` | Something else on port 3000. Change `PORT` in `.env`. |
| Port 5442 or 6389 in use | Change `POSTGRES_HOST_PORT` / `REDIS_HOST_PORT` in `.env`, and the matching `DATABASE_URL` / `REDIS_URL`. |
| `worker failed to start: ANTHROPIC_API_KEY is not set` | Working as intended. Step 2. |
| Migrations hang or refuse to connect | Step 3 without `--wait`, or Docker not running. |
| Candidates stay `pending` | The worker is not running, or crashed. Step 7. |

---

## Architecture

```
web/ ── React + Vite, six routes, plain CSS
  │       polls for status; never recomputes a score
  ▼  HTTP  /api/v1
server/
  routes ──▶ controllers ──▶ services ──▶ repositories ──▶ PostgreSQL
                                │
                                ├──▶ queue (BullMQ / Redis)
                                │         │
  ─────────────────────────────────────── │ ─── process boundary ───
                                          ▼
                                    worker.js
                                          │
                          extraction/ ── file bytes → text
                                          │
                             agents/ ── extract → verify → evaluate → score
                                          │
                                          ▼  Anthropic (claude-opus-5)
```

**Layering.** `routes` map a path to a schema and a controller. `controllers` parse input,
call a service, shape a DTO. `services` hold every business rule and know nothing about HTTP.
`repositories` contain parameterised SQL and nothing else. Every request body, path param and
query string is parsed by zod at the controller, with unknown keys stripped.

**`src/agents/` is framework-agnostic.** It imports no web framework and no database driver.
Every function that touches the network takes `{ client, now, logger }` as an explicit
argument, and only `agents/client/anthropic-client.js` imports the Anthropic SDK — and only to
construct it. Three things follow from that, and they are the reason for the constraint:

- The scoring core is **pure functions with hand-written inputs and exact expected outputs.**
  A reviewer can verify that the arithmetic is right without knowing an LLM is involved.
- The test suite is **network-free without module mocking** — a fake client is passed in. A
  tripwire (`test/setup/no-network.js`) fails any test that reaches for `fetch`, and
  `test/agents/network-tripwire.test.js` proves it fires: a tripwire nobody has seen fail is
  not a tripwire.
- The layer could be lifted into a different application unchanged.

**The worker is a separate process**, and the reason is not tidiness. Screening one CV is text
extraction plus two sequential model calls — seconds each, with a tail into tens of seconds. A
batch of twenty is minutes. That does not fit in an HTTP request: the browser or a proxy times
out, the recruiter cannot navigate away, and a dropped connection destroys work already paid
for in API spend. So the upload endpoint durably records intent and returns `202`; the work
happens elsewhere.

Once work is deferred, five problems appear, and they are what the queue is actually for:
handover that survives a restart (the candidate row is committed **before** anything is
enqueued, so a worker can never see a row that is not there); exactly-one-worker-at-a-time (the
candidate UUID is the queue job id, so a duplicate enqueue is a no-op rather than a doubled
bill); retry with backoff and a place for the dead; **a concurrency dial** that bounds in-flight
model calls system-wide — `SCREENING_CONCURRENCY`, one number, turned down to 1 during an
incident with no deploy; and failure isolation, so one malformed PDF fails one candidate.

Postgres is authoritative and Redis is rebuildable. Flushing Redis loses no business data, and
`npm run reconcile` re-enqueues anything stranded.

### API surface

Base `/api/v1`. Success is `{ data, meta? }`; errors are
`{ error: { code, message, details, requestId } }`.

```
GET    /config                             upload limits, tier thresholds, status vocabulary
GET    /health                             liveness + database/redis reachability
POST   /roles                               create role + criteria + rules in one transaction
GET    /roles                               paginated list
GET    /roles/:roleId                       full definition
PUT    /roles/:roleId                       full replacement
DELETE /roles/:roleId                       soft archive; idempotent; never a hard delete
POST   /roles/:roleId/candidates            single upload  → 202
POST   /roles/:roleId/candidates/batch      batch upload   → 202
GET    /jobs/:jobId                         derived job status + counts
GET    /candidates                          ranked, filtered, paginated
GET    /candidates/statuses?ids=a,b,c       lightweight poll payload
GET    /candidates/:candidateId             full detail
POST   /candidates/:candidateId/retry       re-enqueue a failed candidate → 202
```

Rate limiting is applied to the two upload endpoints only — they are the ones that spend real
money. With no auth the only principal is the client IP, so it is a cost guard, not a security
control.

---

## Design decisions, and what each one cost

Every one of these is a trade. The cost column is the point.

### The model rates; code scores

The model returns an integer 0–10 per criterion plus a one-sentence reason. Then:

```
score = Σ(rating × weight) / 10        weights are integers summing to 100
```

One decimal falls out of integer arithmetic exactly — no rounding step, no floating-point
reasoning, byte-identical across runs. Tier bands are half-open: `[85,100]` Strong,
`[65,85)` Potential, `[0,65)` Unmatched. 84.9 is Potential; 85.0 is Strong. Elimination
forces Unmatched regardless of score.

**What it cost.** The determinism guarantee covers the *scoring function*, not the pipeline.
The same CV run twice can produce different ratings and therefore a different score. The honest
claim is: *the score is a reproducible function of the ratings, and every rating is shown with
its evidence.* And a displayed 84.7 asserts a resolution the underlying measurement — 0–10
judgements from a stochastic model that move ±1 between runs — does not have. The decimal
reflects exact arithmetic over the ratings, not confidence in the ratings.

### Weights and elimination rules are withheld from the judge

The evaluation call sees the profile and the criteria. It does not see the weights, the
elimination rules, or the raw CV.

A model that knows a criterion carries 40% rates it strategically — the ratings stop being
independent observations and become an attempt at the final answer. A model told "no degree
means rejection" drags every rating down for such a candidate, corrupting the score displayed
*next to* the Unmatched badge. And passing the raw CV again doubles input cost while
reintroducing fabrication at exactly the point a claim becomes a number.

**What it cost.** Anything the extraction step drops is invisible to evaluation forever. There
is no second look at the source document.

### Identity is redacted before evaluation only

Name, email, phone and LinkedIn are stripped from the profile before the evaluation call. No
criterion can legitimately reference them, so it costs no signal. Storage, the dashboard and
the candidate detail view are untouched — the recruiter still sees the whole person; the judge
does not.

**What it cost.** Institution names are **not** redacted, and that is a deliberate half-measure.
Removing them would strip signal recruiters legitimately weight; keeping them leaves a known
bias channel open. It should be a role-level toggle, not a unilateral default in either
direction.

### Structured output: kept for evaluation, dropped for extraction

This one was decided by measurement, and the measurement is the interesting part. The
extraction schema was bisected against the live API:

| Schema sent | Result |
|---|---|
| 8 optional scalars, no arrays | accepted |
| 8 scalars + one **3**-property array | **accepted, 3.4s** |
| 8 scalars + one **8**-property array | timeout > 60s |
| 8 scalars + two arrays (the second only 2 properties) | timeout > 60s |
| the real extraction schema | timeout > 120s; earlier, a fast `400 "Schema is too complex."` |

A control answering in 3.4 seconds in the same run rules out a network fault. The binding
constraint is **grammar-compilation complexity** — it sits far below the documented limits, it
is unmeasurable from outside, and it surfaces inconsistently, sometimes as a fast 400 and
sometimes as a two-minute hang that reads as a network problem to everyone who sees it first.

So extraction sends no schema and evaluation keeps its grammar. The reasoning, beyond "it was
blocking the pipeline": the guarantee was always zod's anyway — the SDK's JSON-Schema transform
demotes `enum` into the field `description`, so an invented value was always caught by
post-parse validation rather than prevented by decoding. And extraction is *transcription*,
where a grammar constrains punctuation rather than judgement. Evaluation is structured
reasoning, which is where a grammar earns its compilation cost.

**What it cost.** The API no longer guarantees the extraction response is shaped like the
schema, so a malformed body is now possible where it previously was not. It costs one retry
when it happens, bounded by the same single semantic retry as everything else. The prompt now
carries a hand-written JSON skeleton in place of the grammar — about 450 extra input tokens per
CV, and a drift risk paid off by a test that walks the zod schema and fails if the skeleton
names a field the schema does not define, or omits one it does.

### Uploads are idempotent on content hash

A UNIQUE constraint on `(role_id, content_sha256)`. Re-uploading the same file against the same
role returns the existing candidate rather than creating a second one or erroring — so a
double-click, a retried request or a re-run batch cannot produce two candidates and two bills.

**What it cost.** Idempotency is on the bytes, not on the person. The same CV re-exported from
Word — one byte different — is a new candidate and a second bill. Nothing deduplicates by name
or email, deliberately: two people can share a name, and one person can have two CVs worth
screening separately.

### Unknown facts flag rather than eliminate

An elimination rule whose fact is absent from the profile returns `indeterminate`, and the
candidate is badged as unchecked rather than rejected. Elimination requires positive evidence
of failure. Per-rule `on_missing: 'flag' | 'eliminate'` lets a recruiter opt into hard
rejection for a genuinely hard requirement — a licence, work authorisation.

The alternative silently drops every image-only, two-column and non-English CV into the bottom
tier, where no human ever looks. That is a discrimination pattern with a purely technical
cause.

This extends to facts the code *derives*. `min_years_experience` reads a computed years figure,
and computing it from an incomplete work history had been treated as always possible. It is
not: an entry whose end date extraction lost has no end date to compute from, and closing it at
*now* produced **10.7 years** out of a twelve-month job — passing a five-year gate on a number
nothing measured. The computed value is now `null` when the dates do not determine it, and
`null` is never read as `0`. An unknown fact is indeterminate whether it is absent from the
profile or underdetermined by it; inventing a defensible-looking number is worse than any
failure this rule was written to prevent, because a gap is visible and a plausible number is
not.

**What it cost.** Unqualified candidates reach the middle tier and recruiters filter more. And
an *empty* fact list is treated as unknown rather than as absence — so a `required_skill` rule
will not screen out a CV that lists no skills at all. That runs against a recruiter's intuition
and is stated rather than hidden.

### Scanned PDFs: detect and fail clearly; no OCR

A PDF whose text layer yields too little text for its page count is never sent to the model.
The candidate fails with `EMPTY_DOCUMENT` and the message *"This PDF appears to be a scanned
image; no extractable text layer was found. Re-upload a text-based PDF or a DOCX."* A second,
cheaper guard in the agent layer catches text that survives extraction but is not worth
spending a token on.

OCR was declined on the merits, not for time. `tesseract.js` is a large dependency, needs page
rasterisation, and runs in seconds-to-minutes per page — but decisively, OCR'd CV text extracts
badly, which degrades the profile, which degrades the ratings, which degrades the scores the
whole system is judged on. **A clear failure a recruiter can act on beats a confidently wrong
score.**

**What it cost.** Image-only CVs cannot be screened at all. The extension point is documented
and narrow: extraction dispatches on sniffed MIME type behind one interface, so an OCR fallback
slots in exactly where `EMPTY_DOCUMENT` is raised, with no change above it.

---

## Cost

**Measured, not estimated.** One candidate screened end to end against `claude-opus-5` — a
1,757-character CV, a six-criterion role, one attempt per call, no retries:

| Stage | Input | Output |
|---|---|---|
| extraction (`effort: low`) | 3,183 | 1,330 |
| evaluation (`effort: high`) | 5,006 | 1,826 |
| **total** | **8,189** | **3,156** |

At $5/$25 per MTok that is **$0.12 per candidate** — 1,000 CVs ≈ **$120**. The original estimate
was $0.088; the total landed inside the predicted range, but **input ran 1.8× the estimate**,
and that is the number to plan against.

Biggest lever already applied: extraction at `effort: low`. Thinking is roughly 60% of
extraction's output tokens at high effort and buys nothing on a transcription task.

**The largest lever not yet pulled: run extraction on a cheaper model.** Extraction is 39% of
input and 42% of output, so moving it to Haiku 4.5 takes the per-candidate cost from $0.12 to
roughly $0.086. It is documented and **not implemented**, because extraction is precisely the
fabrication-sensitive step — evidence verification can falsify a quote, but nothing catches a
plausible invented employer. Pulling that lever needs a measured fabrication rate on a labelled
set first, not an assumption that a cheaper model transcribes as faithfully.

Prompt caching probably will not pay here: the stable prefix is ~900 tokens, under the
1,024-token minimum, and input is only ~26% of the bill.

---

## Known limitations

Stated as they are. Several of these are the direct cost of a decision above.

- **The determinism guarantee covers the scoring function, not the pipeline.** The same CV run
  twice can produce different ratings and a different score.

- **The 85 and 65 thresholds are asserted, not validated.** Nobody has checked that 85
  corresponds to "strong" for a real recruiter. There are two datapoints, and they disagree in
  an informative way:

  **81.5 — Potential Match.** A strong synthetic backend CV: nine-plus years, demonstrated
  evidence on every core criterion, all three elimination rules passed. It landed 3.5 points
  under the threshold. This is not evidence the threshold is wrong — the model's reasoning for
  each 7 was specific and defensible, marking down API contract mechanics and testing practice
  because the CV genuinely does not mention them. A rubric that awards 85+ to a candidate with
  two named gaps may be behaving exactly as intended.

  **50 — Unmatched**, and this one is more interesting. The CV is `samples/clean.pdf`, a plain
  single-column document describing a senior backend engineer at a payments company. One
  criterion drives almost the whole gap: *Backend engineering depth (Node.js)* was rated
  **3/10** because Node.js appears only as a skills-list entry, never tied to a piece of work.
  That criterion carries 30%, so on its own it costs 21 of the 50 points lost.

  This is the evidence-discipline trade-off, measured rather than predicted. The
  `demonstrated` / `listed_only` distinction exists precisely so a keyword list cannot buy a
  rating, and here it did exactly that. The consequence is that **the system is stricter than a
  human recruiter**, who reads "Senior Backend Engineer at a payments company" and infers
  Node.js. That may be right for a screener whose whole purpose is not to be fooled by a skills
  section — but it is a design decision, recorded as one rather than left for a reviewer to
  discover and reasonably conclude the scoring is broken.

  Settling it needs 30–50 labelled CVs with a recruiter's own tier label per CV, and agreement
  measured against the computed tier. That harness distinguishes the two possible faults, which
  no amount of reasoning can: **the bands are wrong**, or **the evidence rule is too strict**.
  They need opposite fixes, and moving either on two datapoints would substitute our intuition
  for a recruiter's.

- **Table-based two-column CVs interleave.** Measured against a real fixture, not predicted. A
  CV laid out as a two-column *table* extracts with the columns welded together line by line —
  a job title against a technology, a date range against a skill. Column *sections* (Word
  columns, LaTeX `multicol`) extract perfectly, because the producer emits one column's content
  before the next. It is the producer's content-stream order that decides this, so "two-column
  CV" is not the predictor; "two-column table" is. Upload `samples/two-column.pdf` to see it.

  The interleaved text still reaches the model, so the candidate is scored — with lower ratings
  whose reasons cite the mangled evidence. That is the intended failure mode: a degraded rating
  a human can see is wrong beats a silent disappearance into the bottom tier. Column
  reconstruction was declined because clustering text by x-position would also fire on the
  right-aligned date gutter most *single*-column CVs have — corrupting the common case to
  rescue the rare one.

- **A CV with a single work entry and no end date computes confidently as current**, because
  there is no later role to supersede it. That is the correct reading of the CV convention, and
  also the exact shape someone would use to game a `min_years_experience` requirement.

- **No authentication.** The specification has none, so the system has none. There is no
  principal, no tenancy and no access control on any endpoint; upload rate limiting is by IP
  and is a cost guard, not a security control. This is not deployable on a public network as
  it stands.

- **A single worker process.** One process, `SCREENING_CONCURRENCY` candidates at a time.
  Running a second one works — the queue provides the locking — but only if it shares a
  filesystem with the API, which is the next item.

- **Local disk means the API and the worker must share a filesystem.** This does not scale
  horizontally as written. The sharpest architectural limit in the system.

- **Non-English and non-Western-format CVs** extract poorly. No adequate mitigation; it belongs
  on the risk register rather than in a mitigation column. Distinct from the two-column item:
  that is a layout-producer problem with a known cause, this is a language and date-convention
  problem with no cause we can address.

- **CVs are personal data with no delete endpoint, no TTL and no retention policy.** The
  specification omits it; a real deployment cannot.

- **Regulatory exposure.** Automated candidate screening touches the EU AI Act, NYC Local
  Law 144 and GDPR Art. 22. The architecture does the right things — every rating, reason,
  evidence quote and elimination reason is retained and attributable, and code makes the
  decision, so it is explainable. The product assumption that the bottom tier never means
  auto-reject without a human is stated here explicitly because the code cannot enforce it.

- **No rescore path after a role edit.** Old scores persist, stamped with the role version they
  were scored under, and the dashboard will show candidates scored against different rubrics
  side by side.

---

## What I would build next

In this order, and the ordering is the argument.

1. **The labelled-CV agreement harness.** 30–50 real CVs, a recruiter's own Strong / Potential
   / Unmatched label for each, agreement measured offline against the computed tier. This is
   first because almost every other improvement is blocked behind it: it is the only thing that
   distinguishes "the bands are wrong" from "the evidence rule is too strict", and it is the
   prerequisite for measuring a cheaper extraction model's fabrication rate. It is worth more
   than any sampling or re-run machinery, which is why re-evaluating candidates near a
   threshold is *not* on this list above it — that reduces variance around a line nobody has
   shown is in the right place.

2. **Retention and deletion.** A delete endpoint, a TTL, and a stated policy. This is second
   rather than fifth because it is a legal exposure rather than a missing feature, and it gets
   harder the more data exists.

3. **Object storage for uploads.** Replaces the shared-filesystem constraint and unblocks
   running the API and the worker on separate machines. One interface already isolates it.

4. **Authentication and tenancy.** Necessary before this is deployed anywhere real, and cheap
   to add at this size — but it changes no screening behaviour, which is why it sits below the
   three that do.

5. **Extraction on a cheaper model**, gated on (1) producing a fabrication rate. Roughly 30% off
   the per-candidate cost, and not worth taking on faith.

Deliberately **not** on the list, with reasons already given above: OCR for scanned PDFs,
column reconstruction for two-column tables, and a data-fetching library for the six endpoints
the client calls.

---

## Reference

### Where the full reasoning lives

**[`docs/PHASE-0-PLAN.md`](docs/PHASE-0-PLAN.md)** is the plan of record — the document this
README summarises. It carries the data model, the API contract, the schema-budget measurements,
the prompt design and its version history, the failure taxonomy, and every decision above
argued at length with the alternatives that were rejected. Where this README and that file
disagree, that file is the more careful one.

### Sample CVs

[`samples/`](samples/) — six files covering all three formats, one known limitation, and one
deliberate failure. [`samples/README.md`](samples/README.md) says what each one demonstrates;
the pair worth uploading together is `clean.pdf` and `demonstrated-evidence.txt`.

### Configuration

[`.env.example`](.env.example) documents every variable the system reads, with the reasoning
for the non-obvious ones. Every value in it is a working default; the only blank is
`ANTHROPIC_API_KEY`.

### The seed

`npm run seed` (from `server/`) loads two roles with genuinely different rubrics and
elimination rules:

- **Senior Backend Engineer (Node.js)** — six criteria weighted 30/20/20/15/10/5, and three
  elimination rules: 5 years' experience (`flag` if undeterminable), demonstrated PostgreSQL
  (`flag`, and `demonstrated` means the CV shows it being used, not listed), and UK/IE/DE work
  authorisation (`eliminate` on missing, because a hard legal requirement is where "we could
  not tell" has to mean no).
- **Registered Nurse — Intensive Care Unit** — six criteria and four elimination rules,
  including two required certifications with different `on_missing` policies.

It is re-runnable: role ids are fixed, so a second run replaces criteria and rules rather than
creating duplicates, and it deliberately does not bump a version number that existing
candidates are stamped with.

### Commands

| From | Command | Does |
|---|---|---|
| `server/` | `npm start` | the HTTP API |
| `server/` | `npm run worker` | the screening worker |
| `server/` | `npm run dev` / `dev:worker` | the same two, with `--watch` |
| `server/` | `npm run migrate` / `migrate:down` | schema up / down |
| `server/` | `npm run seed` | the two example roles |
| `server/` | `npm test` | 1320 tests; needs Docker running |
| `server/` | `npm run test:unit` | 1020 of those, in ~4s, with **Docker stopped** |
| `server/` | `npm run reconcile` | re-enqueue candidates stranded by a crash |
| `web/` | `npm run dev` | the UI on :5173 |
| `web/` | `npm test` | 126 tests |
| `web/` | `npm run build` | production bundle |
