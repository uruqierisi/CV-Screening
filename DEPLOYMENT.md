# Deployment runbook

Five services. Do them in this order — each step produces a value the next one needs, and two
of the dependencies run backwards (the API needs the frontend's URL, the frontend needs the
API's), which is why the CORS value is set last rather than with the rest.

Nothing here spends Anthropic credit until **step 9**. Everything before it — migrations, the
health check, the config endpoint, the bucket check — is free. See
[Where the money starts](#where-the-money-starts).

---

## The two that fail silently

Read these before you start. Neither produces an error message that points at the cause, and
both are cheap to get right and expensive to debug.

### 1. Migrations must use Neon's DIRECT host, not the pooled one

`node-pg-migrate` opens its run by taking a **session-level advisory lock** so two migrators
cannot race. The pooled endpoint is a transaction-mode pooler: consecutive statements from one
client can land on different backend sessions, so a session-level lock is taken on a session
you do not keep. The lock silently stops meaning anything while every statement still appears
to succeed. **There is no error to read.**

In Neon's dashboard the pooled connection string is the one whose hostname contains `-pooler`;
the direct host is the same name without it:

```
pooled    ep-example-12345678-pooler.us-east-2.aws.neon.tech     ← DATABASE_URL on Render
direct    ep-example-12345678.us-east-2.aws.neon.tech            ← migrations only, from your machine
```

Use the pooled host for the running service, where many short-lived connections are the point.
Use the direct host **only** for `npm run migrate`.

### 2. `CORS_ALLOWED_ORIGINS` must match the Vercel URL exactly

When an origin does not match, `@fastify/cors` does not reject the request — it simply omits
the `Access-Control-Allow-Origin` header, and the request is logged server-side as an ordinary
`200`. The failure exists only in the browser console. **Nothing in the API's logs says "I
refused an origin."**

It must be a **bare origin**: scheme, host, optional port. No path, no trailing slash.

```
correct    https://cv-screening.vercel.app
wrong      https://cv-screening.vercel.app/          ← trailing slash
wrong      https://cv-screening.vercel.app/roles     ← path
wrong      cv-screening.vercel.app                   ← no scheme
```

`server.js` prints the allowlist it actually parsed at boot, next to the storage driver and the
worker mode — that log line is the fastest way to see what the running process believes:

```json
{"corsAllowedOrigins":["https://cv-screening.vercel.app"],"storageDriver":"s3",
 "workerInProcess":true,"uploadTokenRequired":true,"msg":"api configuration"}
```

---

## Before you start

Accounts needed: **Neon**, **Upstash**, **Render**, **Vercel**. Backblaze B2 is already done.

Already in hand:

| Value | This deployment |
|---|---|
| `S3_BUCKET` | `cv-screening-uploads` |
| `S3_REGION` | `us-west-004` |
| `S3_ENDPOINT` | `https://s3.us-west-004.backblazeb2.com` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | from the B2 application key |

Decide one value now, because two services need it identically:

**`UPLOAD_ACCESS_TOKEN`** — any long random string. It goes on Render as `UPLOAD_ACCESS_TOKEN`
and on Vercel as `VITE_UPLOAD_TOKEN`, and the two must be byte-identical. It is a spend guard,
not a secret: it ships inside the JavaScript bundle and anyone can read it out of devtools.

```sh
# one way to make one
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

---

## Step 1 — Verify the bucket

Free of Anthropic credit; costs a handful of B2 transactions, well inside the free daily
allowance. Do it first, because a wrong key here surfaces much later as a failed upload.

```sh
cd server
STORAGE_DRIVER=s3 \
S3_BUCKET=cv-screening-uploads \
S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com \
S3_REGION=us-west-004 \
S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
  npx vitest run --project unit test/unit/storage.s3.test.js
```

Expect **10 passed**. It runs the same contract local disk is held to — PUT, GET, HEAD, DELETE
and both shapes of 404 — writes under fresh UUIDs and deletes what it wrote. If it skips
instead of running, one of the four credentials is missing from the command.

## Step 2 — Neon

Create a project. From its dashboard, copy **both** connection strings — pooled and direct (see
[the callout](#1-migrations-must-use-neons-direct-host-not-the-pooled-one)). Keep
`?sslmode=require` on the end of both.

- **Pooled** → becomes `DATABASE_URL` on Render, in step 5.
- **Direct** → used only in step 3, from your machine, and never stored anywhere.

## Step 3 — Migrate, from your machine

Nothing on the platform runs migrations, and the API refuses to start against an empty or
behind database. So this happens before the first deploy, not after.

```sh
cd server
DATABASE_URL='postgresql://USER:PASSWORD@ep-example-12345678.us-east-2.aws.neon.tech/neondb?sslmode=require' \
  npm run migrate
```

An inline `DATABASE_URL` takes precedence over the one in your local `.env`, so this does not
touch your development database. Expect eight migrations, `0001` through `0008`.

Optionally seed the two example roles — free, no model calls:

```sh
DATABASE_URL='...direct URL...' npm run seed
```

## Step 4 — Upstash

Create a Redis database. Copy the `rediss://` URL — TLS is required and the env schema already
accepts it. This becomes `REDIS_URL` on Render.

The free tier is metered at 500,000 commands per month, which is what `SCREENING_DRAIN_DELAY_S=30`
in `render.yaml` exists to protect: at BullMQ's default of 5 an idle worker burns roughly 6,400
commands per awake hour.

## Step 5 — Render

New → **Blueprint**, pointed at this repository. It reads [`render.yaml`](render.yaml), which
already sets `NODE_ENV`, `NODE_VERSION`, `RUN_WORKER_IN_PROCESS=true`, `STORAGE_DRIVER=s3`,
`SCREENING_CONCURRENCY=1`, `SCREENING_JOB_ATTEMPTS=2`, `MAX_BATCH_FILES=5` and
`SCREENING_DRAIN_DELAY_S=30`.

Set these ten in the dashboard (everything marked `sync: false`):

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** URL from step 2 |
| `REDIS_URL` | Upstash `rediss://` URL from step 4 |
| `ANTHROPIC_API_KEY` | your key |
| `S3_BUCKET` | `cv-screening-uploads` |
| `S3_ENDPOINT` | `https://s3.us-west-004.backblazeb2.com` |
| `S3_REGION` | `us-west-004` |
| `S3_ACCESS_KEY_ID` | from B2 |
| `S3_SECRET_ACCESS_KEY` | from B2 |
| `UPLOAD_ACCESS_TOKEN` | the value you generated above |
| `CORS_ALLOWED_ORIGINS` | **leave unset for now** — set in step 8 |

Leaving CORS unset is safe: it defaults to `http://localhost:5173`, which is wrong for
production but harmless until a browser is pointed at the API, and you do not have the Vercel
URL yet.

Do **not** put `ANTHROPIC_API_KEY` on Vercel. Nothing in the browser needs it, and a
`VITE_`-prefixed key would be compiled into the public bundle.

## Step 6 — First deploy, and what a good one looks like

Render builds with `npm ci` and starts with `npm start`. Watch the logs for three lines in this
order:

```
{"applied":8,"expected":8,"msg":"schema check passed"}
{"corsAllowedOrigins":[...],"storageDriver":"s3","workerInProcess":true,
 "uploadTokenRequired":true,"msg":"api configuration"}
{"queue":"candidate-screening","concurrency":1,...,"msg":"screening worker started"}
```

If instead you see `api failed to start: the database has no schema...`, step 3 did not happen
or pointed at a different database. That refusal is deliberate: `/health` cannot catch an
unmigrated database, because its probe is `SELECT 1` and that succeeds against a database with
no tables — so without the guard the deploy would go green and fail every real request.

The health check at `/api/v1/health` reports Postgres and Redis separately and answers 503 if
either is unreachable, so a bad `REDIS_URL` presents as a **failed deploy** rather than as a
live API with a dead queue.

Note the service URL, e.g. `https://cv-screening-api.onrender.com`. That is
`VITE_API_BASE_URL` in the next step.

## Step 7 — Vercel

Import the repository. **Root directory: `web`** — that is where [`web/vercel.json`](web/vercel.json)
lives, and it is what makes a deep link to a role survive a refresh instead of 404ing.

| Variable | Value |
|---|---|
| `VITE_API_BASE_URL` | the Render URL from step 6, bare: `https://cv-screening-api.onrender.com` — no trailing slash, no `/api/v1` |
| `VITE_UPLOAD_TOKEN` | the same string you put in `UPLOAD_ACCESS_TOKEN` |

Both are inlined into the bundle at build time, so **changing either one requires a rebuild**,
not just a redeploy of the same artifact.

Deploy, and note the production URL.

## Step 8 — Close the loop: CORS

Back on Render, set `CORS_ALLOWED_ORIGINS` to the Vercel production URL as a bare origin, and
let it redeploy. Confirm from the boot log that the parsed allowlist is what you intended — see
[the callout](#2-cors_allowed_origins-must-match-the-vercel-url-exactly).

If you later add a custom domain, this is a comma-separated list: both origins go in it.

## Step 9 — Smoke test, in cost order

Free, in this order:

1. Open the Vercel URL. The roles list loads → `VITE_API_BASE_URL` and CORS are both right.
   A "server answered 404 with no message" means `VITE_API_BASE_URL` is unset or wrong; a
   CORS error in the console means step 8 is wrong.
2. `curl https://cv-screening-api.onrender.com/api/v1/health` → `200` with both dependencies
   `true`.
3. Create a role in the UI. Free — no model calls.

**Then, and only then, upload one CV.** That is the first Anthropic credit this deployment
spends.

---

## Where the money starts

| Action | Anthropic credit |
|---|---|
| Migrations, seed, health, config, creating roles | none |
| The S3 contract check (step 1) | none — B2 transactions only |
| Loading the dashboard, polling, viewing results | none |
| **Uploading a CV** | **one screening per candidate** — two model calls, roughly $0.12 |
| `POST /candidates/:id/retry` | **another full screening** — it re-runs both calls from scratch |
| A batch upload | one screening per file, up to `MAX_BATCH_FILES=5` |

With roughly seven screenings of credit left:

- Smoke-test with **one** CV, not a batch. A five-file batch is most of the budget in one click.
- `SCREENING_JOB_ATTEMPTS=2` means a transient failure can cost a candidate **twice**. Budget
  for that before assuming seven uploads is seven screenings.
- The retry button costs exactly what an upload costs. It is guarded by the upload token for
  that reason.

---

## Every variable, where it lives, and what breaks

### On Render

| Variable | Set by | If it is wrong |
|---|---|---|
| `DATABASE_URL` | you | Startup refusal if the schema is missing, or connection errors. Use the **pooled** host here. |
| `REDIS_URL` | you | `/health` returns 503 → the deploy is marked unhealthy and does not go live. Visible, not silent. |
| `ANTHROPIC_API_KEY` | you | The API **will not start at all**, because the co-located worker builds its client at boot: `api failed to start: ANTHROPIC_API_KEY is not set; the screening worker cannot start without it`, exit 1. Verified. |
| `S3_BUCKET` `S3_ENDPOINT` `S3_ACCESS_KEY_ID` `S3_SECRET_ACCESS_KEY` | you | Absent: startup fails naming the missing variable. Present but wrong: uploads fail at the PUT with a 403 from B2, and the candidate fails. Step 1 is what stops this. |
| `S3_REGION` | you | Signature mismatch on every request to B2. |
| `CORS_ALLOWED_ORIGINS` | you (step 8) | **Silent.** Browser blocks every call; API logs show ordinary 200s. |
| `UPLOAD_ACCESS_TOKEN` | you | Mismatch with Vercel → every upload and retry answers `403 UPLOAD_TOKEN_INVALID` while the dashboard keeps working, because the poll is not guarded. Looks like "uploads are broken", not "a token is wrong". |
| `STORAGE_DRIVER=s3` | `render.yaml` | If it were `local`, uploads would go to a disk Render wipes on restart and retries would answer `SOURCE_FILE_MISSING`. |
| `RUN_WORKER_IN_PROCESS=true` | `render.yaml` | If false, nothing screens: candidates sit in `pending` forever with no error anywhere. |
| `SCREENING_DRAIN_DELAY_S=30` | `render.yaml` | Too low burns the Upstash free tier while idle. Costs nothing in pickup latency — a job added mid-block wakes the worker immediately. |
| `SCREENING_CONCURRENCY` `SCREENING_JOB_ATTEMPTS` `MAX_BATCH_FILES` | `render.yaml` | Spend dials. Raising any of them multiplies what one click can cost. |
| `PORT` | Render, automatically | Do not set it. |

### On Vercel

| Variable | If it is wrong |
|---|---|
| `VITE_API_BASE_URL` | The browser asks **Vercel** for `/api/v1/config`, Vercel answers with its own 404 page, and the client reports "the server answered 404 with no message". No CORS setting fixes this — the request never left the frontend's origin. |
| `VITE_UPLOAD_TOKEN` | Uploads and retry answer 403; everything else works. |

Both require a **rebuild** to take effect, not a redeploy.

### Nowhere

`ANTHROPIC_API_KEY`, `DATABASE_URL`, `REDIS_URL` and the B2 secret key must never appear in
anything `VITE_`-prefixed. Vite inlines those into the public bundle.

---

## When something is wrong

| Symptom | Look at |
|---|---|
| "The server answered 404 with no message" | `VITE_API_BASE_URL` on Vercel — and remember it needs a rebuild |
| CORS error in the browser console, 200s in the API log | `CORS_ALLOWED_ORIGINS`; compare against the boot log's `corsAllowedOrigins` |
| Dashboard works, uploads answer 403 | `UPLOAD_ACCESS_TOKEN` vs `VITE_UPLOAD_TOKEN` — byte-identical, and the frontend needs a rebuild |
| `api failed to start: the database has no schema…` | Step 3 did not run, or ran against a different database |
| `api failed to start: the database is behind this build…` | A new migration shipped; re-run step 3 |
| Deploy marked unhealthy | `/api/v1/health` says which dependency — usually `REDIS_URL` |
| Candidates stay `pending` forever | `RUN_WORKER_IN_PROCESS` is not `true`, or the worker never started — check for `screening worker started` in the boot log |
| Candidate fails with `SOURCE_FILE_MISSING` | `STORAGE_DRIVER` is not `s3`, so the file went to a disk that was wiped |
| First page load takes ~50 seconds | Expected. The free tier sleeps after 15 minutes of inactivity; the UI names the wait rather than showing a bare spinner |
| A candidate fails with `AGENT_TIMEOUT` for no visible reason | A spin-down landed mid-screening. It is a clean shutdown and the candidate is re-queued, but it costs one of the two attempts |
| Stuck in `evaluating` after a hard kill | `npm run reconcile`, pointed at the same database |
