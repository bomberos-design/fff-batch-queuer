# FFF Batch Queuer

If you need to call an endpoint multiple times, following a given policy, able to automatically stop at some point, this software might be useful for you.

A Cloudflare-based Worker+App that accepts HTTP job definitions, stores them in D1, and
keeps re-calling the target URL with two independent limits:

- an **error attempt limit** (for non-2xx/fetch failures/payloads with `error`),
- a **success iteration limit** (for successful calls),

plus a payload-level override where `{ "stop": true }` immediately marks the
job `done`. 

![](cover.png)

## Architecture

One Worker, two roles:

- **HTTP API (producer)** - `POST /jobs` writes a row to D1 and pushes a
  `{ jobId }` message to the `fff-bq-queue`.
- **Queue consumer** - same Worker. For each message it loads the job, calls
  the target URL, and either marks the job `done` or calls
  `msg.retry({ delaySeconds })` with exponential backoff. The `fff-bq-dlq`
  dead letter queue catches anything that exceeds the platform retry cap and
  flips the job to `failed`.

State lives in D1 across two tables (`customers`, `jobs`). A daily cron trigger
runs a job consistency health check. No Durable Objects, no Workflows.

## Behaviour summary

| Outcome of the call | What happens |
| --- | --- |
| Body has `{stop:true}` | Job marked `done` immediately, message acked. |
| HTTP 2xx and body without `error` | `success_count` increments. If `successLimit` reached, job is `done`; else retried with fixed `successRetryDelaySeconds`. |
| Non-2xx HTTP response | `error_attempts` increments and job retries with exponential backoff. |
| Network / fetch error | `error_attempts` increments and job retries with exponential backoff. |
| HTTP 2xx with body containing `error` key | `error_attempts` increments and job retries with exponential backoff. |
| Per-job `errorAttemptLimit` reached | Job marked `failed`, message acked. |
| Queues' `max_retries=100` reached | Message routed to `fff-bq-dlq`, consumer marks `failed`. |
| Job already `done`/`failed`/cancelled | Message acked immediately, no fetch. |

Exponential backoff schedule (for errors only, no jitter): `5s, 10s, 20s, 40s,
80s, 160s, 300s, 300s, ...` plus a small random jitter (~0-1s).

## Project layout

```
.
├── db/
│   └── init.sql             # full current schema bootstrap
├── src/
│   ├── api.ts               # Hono routes (POST /jobs, GET /jobs, ...)
│   ├── backoff.ts           # exponential backoff + jitter
│   ├── consumer.ts          # processJobMessage / processDlqMessage
│   ├── db.ts                # D1 helpers
│   ├── emailAlerts.ts       # job failure + health check email digests
│   ├── healthCheck.ts       # daily cron consistency scan
│   ├── index.ts             # entry: fetch + queue + scheduled handlers
│   ├── recovery.ts          # passive stale-job recovery
│   ├── schedule.ts          # expected next-run / overdue heuristics
│   └── types.ts             # shared types & constants
├── package.json
├── tsconfig.json
├── wrangler.example.jsonc   # committed template config
└── wrangler.jsonc           # local config (gitignored)
```

## Setup

```bash
npm install
```

Create the Cloudflare resources (one-time per environment):

```bash
# D1 database - copy the printed database_id into wrangler.jsonc
npx wrangler d1 create fff-batch-queuer

# Both queues
npx wrangler queues create fff-bq-queue
npx wrangler queues create fff-bq-dlq
```

Open [`wrangler.jsonc`](wrangler.jsonc) and replace
`REPLACE_WITH_D1_DATABASE_ID` with the id printed above.

Before that, copy the example config:

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Initialize schema locally and remotely:

```bash
npm run db:init:local
npm run db:init:remote
```

## Run locally

```bash
npm run dev
```

`wrangler dev` provides a local D1 + Queues simulator (Miniflare). The
consumer runs in the same process as the API.

## Customers and tokens

`x-client-token` is the credential. The service hashes it with SHA-256 and
looks up an active row in `customers(token_hash)`.

Use `TOKEN` as `x-client-token` in API calls.

## Admin UI authentication (optional)

The React admin app talks to `/observability/*` on the Worker. By default those
routes are **open** (same as before). To require sign-in, set **both** Worker
variables:

| Variable | Purpose |
| --- | --- |
| `ADMIN_USERNAME` | Username checked at login. |
| `ADMIN_PASSWORD` | Password checked at login. |

Set them in `wrangler.jsonc` → `vars`, in the Worker dashboard under
**Settings → Variables and Secrets**, or locally in `packages/backend/.dev.vars`.
If either variable is missing or empty, admin login is disabled and the UI
behaves as it does today.

When both are set:

1. The frontend calls `GET /auth/status` and, if auth is required, shows a
   login screen.
2. `POST /auth/login` validates the username and password against those env
   vars and returns a session token.
3. The browser stores the token in `sessionStorage` and sends it on admin API
   calls as the `x-admin-session` header.

Use **Sign out** in the admin header to clear the session.

This is shared-credential gatekeeping for a small admin UI, not per-user
accounts. For stronger protection (SSO, MFA, audit logs), use **Cloudflare
Zero Trust (Access)** in front of Pages and/or the Worker.

### Alternative: observability token header

You can still protect `/observability/*` with a static token instead of (or in
addition to) username/password login:

| Variable | Where | Purpose |
| --- | --- | --- |
| `OBSERVABILITY_TOKEN` | Worker | When set, requests must include matching `x-observability-token`. |
| `VITE_OBSERVABILITY_TOKEN` | Pages (build-time) | If set at build time, the frontend sends that header on every admin API call. |

If **both** `OBSERVABILITY_TOKEN` and `ADMIN_USERNAME`/`ADMIN_PASSWORD` are
configured, either a valid observability token **or** a valid admin session
grants access. The login UI is for the username/password path; scripts and
automation can keep using `x-observability-token`.

### Local example

```bash
# packages/backend/.dev.vars
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me
```

Restart `wrangler dev`, reload the frontend, and you should be redirected to
`/login`.

## Deploy

Connecting the Git repository in the Cloudflare dashboard gives you **two**
separate setups: one **Worker** (backend) and one **Pages** project (frontend).

### Deploy via Cloudflare dashboard (Git-connected repo)

#### Backend (Workers Builds)

Use **Workers** with **Workers Builds** / Git integration for the API Worker.

| Setting | Value |
| --- | --- |
| **Root directory** | Repository root (`.`) so npm workspaces install correctly |
| **Deploy command** | `npm run backend:deploy` (runs `wrangler deploy` under `packages/backend`) |

If your build environment does not install dependencies automatically, use a command that installs from the repo root first, e.g. `npm ci && npm run backend:deploy`.

Before the first successful deploy:

1. **Wrangler config** — Copy [`packages/backend/wrangler.example.jsonc`](packages/backend/wrangler.example.jsonc) to `packages/backend/wrangler.jsonc` and set bindings to match your account (see below). The Worker needs this file present when `wrangler deploy` runs (commit it in a private fork, or generate it in your build step if the file is gitignored).
2. **D1** — Create a D1 database in the dashboard, copy its **database ID** into `wrangler.jsonc` under `d1_databases[].database_id` (and align `database_name` if you rename the DB).
3. **Schema** — Run the SQL in [`packages/backend/db/init.sql`](packages/backend/db/init.sql) against that database using the D1 **Console** tab in the dashboard (or `wrangler d1 execute … --remote --file=…` locally).
4. **Queues** — Create **two** queues whose names match [`packages/backend/wrangler.example.jsonc`](packages/backend/wrangler.example.jsonc): `fff-bq-queue` (main) and `fff-bq-dlq` (dead-letter). The DLQ is a normal queue with that exact name; linking happens via `dead_letter_queue` in Wrangler, not in the UI.
5. **CORS** — Set `CORS_ORIGIN` under Worker **Variables** (or in `wrangler.jsonc` → `vars`) to the browser origin(s) allowed to call the API (e.g. your Pages URL), not `"*"` in production if you can avoid it.
6. **Admin auth (optional)** — Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` on the Worker to require login for the admin UI. See [Admin UI authentication](#admin-ui-authentication-optional).

#### Frontend (Cloudflare Pages)

Create a **Pages** project linked to the **same** repo.

| Setting | Value |
| --- | --- |
| **Root directory** | `packages/frontend` |
| **Build command** | `npm run build` |
| **Build output directory** | `dist` |

In **Settings → Environment variables**, set at least:

- **`VITE_API_BASE_URL`** — Base URL of the deployed Worker (required), e.g. `https://<worker-name>.<subdomain>.workers.dev`

Optional:

- **`VITE_OBSERVABILITY_TOKEN`** — Build-time static token for `x-observability-token` when the Worker has `OBSERVABILITY_TOKEN` set. Not needed if you use [admin username/password login](#admin-ui-authentication-optional) instead.

Without `VITE_API_BASE_URL`, the frontend falls back to `http://127.0.0.1:8999` and will fail in production.

#### Security

Default Worker and Pages URLs are **public on the internet**. Customer job API
calls use `x-client-token`, but the admin UI and Worker HTTP surface are still
reachable without an extra gate unless you configure one.

Built-in options in this repo:

- **`ADMIN_USERNAME` + `ADMIN_PASSWORD`** on the Worker — username/password
  login in the admin UI (see [Admin UI authentication](#admin-ui-authentication-optional)).
- **`OBSERVABILITY_TOKEN`** on the Worker — static header for `/observability/*`.

For production, also consider **Cloudflare Zero Trust (Access)** in front of
Pages and/or the Worker for SSO, MFA, and policy-based access.

---

### Backend (Worker) — CLI

```bash
cd packages/backend
npm run deploy
```

### Frontend app (Cloudflare Pages) — CLI

Build the frontend:

```bash
cd packages/frontend
npm run build
```

Create a Pages project once (pick your own project name):

```bash
npx wrangler pages project create fff-batch-queuer-frontend
```

Deploy the built app:

```bash
npx wrangler pages deploy dist --project-name fff-batch-queuer-frontend
```

Set frontend env vars in Cloudflare Pages (**Settings → Environment variables**)
before deploying:

- `VITE_API_BASE_URL` (required in production), e.g.
  `https://fff-batch-queuer-backend.<your-subdomain>.workers.dev`
- `VITE_OBSERVABILITY_TOKEN` (optional) — only if the Worker uses
  `OBSERVABILITY_TOKEN`; see [Admin UI authentication](#admin-ui-authentication-optional)

Admin login uses **`ADMIN_USERNAME` / `ADMIN_PASSWORD` on the Worker only** —
no frontend env vars are required for that path.


Without `VITE_API_BASE_URL`, the frontend falls back to
`http://127.0.0.1:8999` (local dev backend), which will fail in production.

## HTTP API

All API calls require the `x-client-token` header. The raw token is never
stored in jobs; only a SHA-256 hash is matched against `customers.token_hash`.
This acts as:

- **authentication key** (request is rejected if missing), and
- **owner key** (you only see/cancel jobs created with the same token).

### `POST /jobs`

Create a job and immediately enqueue the first attempt.

```bash
curl -X POST https://<your-worker>.workers.dev/jobs \
  -H 'x-client-token: client_abc_123' \
  -H 'content-type: application/json' \
  -d '{
    "name": "ping-internal-api",
    "url": "https://api.example.com/work",
    "method": "POST",
    "headers": { "authorization": "Bearer abc" },
    "payload": { "tenant": 42 },
    "errorAttemptLimit": 1000,
    "successLimit": 1,
    "successRetryDelaySeconds": 30
  }'
```

Response (`201 Created`):

```json
{
  "id": "9c3f...",
  "job": { "id": "9c3f...", "status": "pending", "attempts": 0, ... }
}
```

Field reference for the request body:

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `name` | string | yes |  | Human label, indexed for filtering. |
| `url` | string (URL) | yes |  | Target endpoint to call. |
| `method` | `GET`/`POST`/`PUT`/`PATCH`/`DELETE` | no | `POST` | Uppercase only. |
| `payload` | any JSON value | no | none | Sent as JSON body when `method` allows a body. |
| `headers` | `Record<string, string>` | no | none | `content-type: application/json` is auto-added if a JSON body is sent and you didn't override it. |
| `errorAttemptLimit` | integer (>=1, <=100000) | no | `1000` | Error retry cap. Counts non-2xx, fetch failures, and payloads containing `error`. |
| `maxAttempts` | integer (>=1, <=100000) | no | `1000` | Backward-compatible alias for `errorAttemptLimit`. |
| `successLimit` | integer (`-1` or >=1) | no | `1` | Number of successful responses required before marking `done`. `-1` means unlimited success iterations. |
| `successRetryDelaySeconds` | integer (>=1, <=86400) | no | `30` | Fixed delay used between successful iterations when the job is not yet done. |

Token behavior:

- The job is stored with `customer_id` (owner FK), not the raw token.
- The queue message includes `{ jobId, customerId }`.
- Consumer processing and state updates are scoped to that same customer.

### `GET /jobs/:id`

Returns the current state of a job.

### `GET /jobs?status=&name=&limit=&offset=`

Lists jobs, newest first. `limit` defaults to 50 (max 200).

### `POST /jobs/:id/cancel`

Marks a non-terminal job as `failed` with `last_error="cancelled"`. The next
queue delivery for that job will short-circuit and ack.

## How the target URL controls the loop

The Worker fetches your URL with the configured method/headers/payload. The
target should:

- Return JSON body `{"stop": true}` when the work is finally complete. This is
  an override that immediately marks the job `done`.
- Return HTTP 2xx without `error` to count as a successful iteration. The job
  keeps running until it reaches `successLimit` (or forever if `successLimit=-1`),
  with fixed delay `successRetryDelaySeconds` between successful calls.
- Return non-2xx, trigger network/fetch errors, or include `error` in payload
  to count as an error attempt and schedule exponential backoff retries up to
  `errorAttemptLimit`.

Example target handler:

```js
app.post("/work", async (req, res) => {
  const more = await processNextChunk(req.body);
  res.json({ stop: !more });
});
```

## Operational notes

- **Idempotency / duplicate delivery safety:** each attempt is claimed with an
  atomic `pending -> running` transition before fetching, so duplicate Queue
  deliveries for the same job id do not execute concurrently. Terminal
  (`done`/`failed`) jobs are also short-circuited and acked.
- **Customer partitioning:** all read/write/cancel operations are scoped by
  `customer_id` resolved from the token, so one customer token cannot fetch or
  mutate another customer's jobs.
- **Body snapshots:** the last response body is truncated to 4 KB and stored
  on the row for debugging via `GET /jobs/:id`.
- **DLQ as safety net:** Queues will give up after `max_retries=100` (set in
  [`wrangler.jsonc`](wrangler.jsonc)) and route the message to `fff-bq-dlq`.
  The same Worker consumes that queue and flips the job to `failed`. This
  protects against pathological cases where backoff would otherwise grow
  unbounded against the platform's retry budget.
- **Auth:** implemented via `x-client-token` -> SHA-256 lookup in
  `customers.token_hash`; deactivate customers with `is_active = 0`.

## Job failure email alerts (optional)

The queue consumer can send one outbound email when a job becomes `failed`, in
two cases:

1. **Error attempts exhausted** — the job hit `errorAttemptLimit` after repeated
   non-2xx responses, fetch errors, or JSON bodies containing an `error` key.
2. **Dead-letter path** — the main queue exceeded Cloudflare’s retry budget and
   the DLQ consumer marked the job `failed`.

`POST /jobs/:id/cancel` also marks a job `failed`, but **does not** send this
email (only the queue-driven paths above do).

Implementation: [`packages/backend/src/emailAlerts.ts`](packages/backend/src/emailAlerts.ts)
is invoked from [`packages/backend/src/consumer.ts`](packages/backend/src/consumer.ts)
after the job row is updated.

### Prerequisites (Cloudflare)

1. [Email Routing](https://developers.cloudflare.com/email-routing/get-started/)
   enabled on the zone that owns your sender domain.
2. A **`send_email`** binding on the Worker (see
   [`wrangler.example.jsonc`](packages/backend/wrangler.example.jsonc)). Name
   it `SEND_EMAIL` to match the code.
3. Outbound mail follows Cloudflare’s **Send Email** rules: the envelope
   **`from`** must be an address on that zone (for example `alerts@example.com`),
   and **`to`** must be an Email Routing **verified destination address** (the
   mailbox listed under **Email Routing → Destination addresses** after you
   clicked the verification link). A **custom route alias** like
   `hello@yourdomain.com` is not sufficient for `to` — send to the verified
   external inbox (or add that address as a verified destination). See
   [Send emails from Workers](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/)
   and [Destination addresses](https://developers.cloudflare.com/email-routing/setup/email-routing-addresses/#destination-addresses).

### Worker variables

Set these under `vars` in `wrangler.jsonc` (they deploy with the Worker and appear
in the dashboard), or override locally with `.dev.vars`:

| Variable | Purpose |
| --- | --- |
| `JOB_FAILURE_ALERT_FROM` | Envelope **From** (must be on the zone where Email Routing runs). |
| `JOB_FAILURE_ALERT_TO` | Envelope **To** — use a **verified destination** as above. |

If either variable is missing or empty, no email is sent (the failure path still
completes normally). Logs include a skip line starting with `[email]`.

### Binding restrictions (`destination_address`)

If you set `destination_address` on the `send_email` entry in Wrangler, the
Worker may only send **to** that exact address, so it must match
`JOB_FAILURE_ALERT_TO`. Omit `destination_address` to allow any verified
destination allowed for your account binding.

### Local development

By default, `wrangler dev` **simulates** the Send Email binding: nothing is
delivered to a real inbox; Wrangler logs the message and may write body text to
temp files. See
[Email sending — local development](https://developers.cloudflare.com/email-service/local-development/sending/).
To send real mail while still running the script locally, add **`"remote": true`**
on that `send_email` object in `wrangler.jsonc`.

### Debugging production

Failure alerts run in the **`queue` handler**, not in `fetch`. Use
`cd packages/backend && npm run tail` (or `wrangler tail`) and trigger a failed
job; look for `[email]` lines (`sending`, `send finished`, `failed`, or
`skipped`).

## Daily health check (optional)

The Worker runs a **daily cron** (default **08:00 UTC**, configured in
[`packages/backend/wrangler.example.jsonc`](packages/backend/wrangler.example.jsonc)
under `triggers.crons`) that scans active jobs (`pending` / `running`) for
inconsistencies:

- **Stuck running** — `running` longer than `RECOVERY_STALE_RUNNING_MS` (default 5 minutes)
- **Overdue pending** — same heuristics as passive recovery (never started, success retry overdue, error retry overdue)
- **Duplicate active names** — more than one active job with the same `(customer, name)`

Implementation: [`packages/backend/src/healthCheck.ts`](packages/backend/src/healthCheck.ts),
invoked from the `scheduled` handler in
[`packages/backend/src/index.ts`](packages/backend/src/index.ts).

Passive recovery in [`packages/backend/src/recovery.ts`](packages/backend/src/recovery.ts)
runs on HTTP and queue traffic, and on a **5-minute cron** so jobs are not
stuck until someone opens the admin UI. The daily 08:00 UTC cron adds guaranteed
consistency reporting during quiet periods.

The main queue consumer sets **`max_concurrency: 1`** so only one target HTTP
call runs at a time (Cloudflare Queues otherwise scales out multiple concurrent
consumer invocations by default).

Success-iteration retries record a **`next_run_at`** timestamp in D1. Queue
messages that arrive before that time (duplicate deliveries, recovery races, or
at-least-once redelivery) are deferred instead of calling the target immediately.
Apply the migration after upgrading:

```bash
cd packages/backend && npm run db:migrate:remote
```

### Email digest (optional)

Health check digests reuse the same **`send_email`** binding and Cloudflare
Email Routing prerequisites as [job failure alerts](#job-failure-email-alerts-optional).
By default, recipients fall back to `JOB_FAILURE_ALERT_FROM` / `JOB_FAILURE_ALERT_TO`.

Set these in `wrangler.jsonc` → `vars`, in the Worker dashboard under
**Settings → Variables and Secrets**, or locally in `.dev.vars`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HEALTH_CHECK_ENABLED` | enabled | Set to `"false"` to skip the daily scan. |
| `HEALTH_AUTO_HEAL` | `"false"` | Set to `"true"` to also run stale-job recovery on cron. |
| `HEALTH_ALERT_ONLY_ON_ISSUES` | `"true"` | Email only when anomalies are found. Set to `"false"` for a daily all-clear digest too. |
| `HEALTH_ALERT_FROM` | falls back to `JOB_FAILURE_ALERT_FROM` | Envelope **From** for health digests. |
| `HEALTH_ALERT_TO` | falls back to `JOB_FAILURE_ALERT_TO` | Envelope **To** for health digests. |
| `HEALTH_PENDING_GRACE_MS` | 15 minutes | Extra wait after expected queue delivery before flagging overdue pending jobs. |
| `HEALTH_INITIAL_PENDING_MS` | 10 minutes | Grace before flagging never-started pending jobs. |
| `RECOVERY_STALE_RUNNING_MS` | 5 minutes | Threshold for stuck `running` jobs (shared with passive recovery). |
| `RECOVERY_SCAN_LIMIT` | 100 | Max active jobs scanned per run (max 500). |

If email is not configured, the check still runs and logs to `wrangler tail`
(`[health]` lines). Look for `[email] health check alert skipped` when from/to
addresses are missing.

### Debugging the health check

The cron runs in the **`scheduled` handler**, not in `fetch`. Use
`cd packages/backend && npm run tail` and look for `[health] daily check complete`
after the cron fires. To test locally, run `wrangler dev` and trigger the
scheduled handler using the URL shown in the dev server output.

## Useful commands

```bash
npm run typecheck        # tsc --noEmit
npm run dev              # local Worker + D1 + Queues simulator
npm run tail             # stream logs from the deployed Worker
npx wrangler d1 execute fff-batch-queuer --remote --command "SELECT id, name, status, attempts FROM jobs ORDER BY created_at DESC LIMIT 20;"
```
