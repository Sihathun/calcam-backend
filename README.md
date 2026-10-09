# CalorieScan AI backend (`calcam-backend`)

REST API and analysis worker for **CalorieScan AI**, a mobile calorie tracker. A user snaps a photo of their food,
an AI model estimates calories and macros, and the home screen shows what is left of a personalised daily goal.

The mock-ups call the app "Cal AI". The name is configuration (`APP_NAME`), not code.

This repository is the backend only. The mobile client is separate.

- **Stack:** Node.js + Express 5, TypeScript (strict), PostgreSQL with Prisma, Redis + BullMQ, S3-compatible storage,
  Zod for validation, OpenAPI 3.1 generated from the same schemas.
- **Two processes, one codebase:** the **API** (`dist/server.js`) answers requests, and the **worker**
  (`dist/worker.js`) analyses meals. Only the worker ever calls the AI provider.
- **Docs:** [`docs/ui-coverage.md`](docs/ui-coverage.md) maps every screen to its endpoint and lists open design
  questions. Interactive API docs run at `/docs` once the server is up.

---

## Quick start

You need Node.js 22 LTS. (The code only uses features from Node 20.11 and later, but it has only been run on 22.) Pick one of the two paths.

### A. Docker (the whole stack)

```bash
docker compose up --build
```

This starts PostgreSQL, Redis, MinIO (S3), applies the migrations, and runs the API and the worker.
It uses the **fake AI provider** by default, so it works without any key.

| What | Where |
|---|---|
| API | http://localhost:3000 (set `API_PORT=3300` if 3000 is taken) |
| Swagger UI | http://localhost:3000/docs |
| Readiness | http://localhost:3000/ready |
| MinIO console | http://localhost:9001 (`minioadmin` / `minioadmin`) |

To use a real model: `AI_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-ant-... docker compose up --build`.

### B. No Docker (everything in one process)

```bash
npm install
cp .env.example .env
npm run db:embedded        # leave running: a local PostgreSQL on port 54329
```

Edit these lines in `.env` (they already exist, so change them rather than adding duplicates):

```dotenv
DATABASE_URL=postgresql://calcam:calcam@localhost:54329/calcam
QUEUE_DRIVER=memory        # the API runs the worker logic itself (development only)
STORAGE_DRIVER=fs          # images go to .local/storage
AI_PROVIDER=fake
REDIS_URL=
```

Then, in another terminal:

```bash
npm run migrate
npm run seed               # optional: demo@example.com / Password123! with a week of meals
npm run dev
```

---

## Your first analysis loop

`POST /meals/analyze` -> `GET /meals/:id` -> `GET /dashboard/daily`. About two minutes with the commands below
(they need `curl` and [`jq`](https://jqlang.org)). You can also do every step in Swagger UI at `/docs`, or import
[`postman/CalorieScan-AI.postman_collection.json`](postman/CalorieScan-AI.postman_collection.json) into Postman
or Bruno (run "Auth > Register" first, it stores your tokens).

```bash
API=http://localhost:3000

# 1. Sign up. The whole onboarding funnel goes in this single call.
TOKEN=$(curl -s $API/api/v1/auth/register -H 'content-type: application/json' -d '{
  "email": "me@example.com", "password": "correct horse battery",
  "onboarding": {
    "sex": "female", "workoutsPerWeek": "0-2", "heightCm": 167.6, "weightKg": 54.0,
    "birthDate": "2001-01-01", "goal": "maintain", "diet": "balanced",
    "timezone": "Asia/Phnom_Penh"
  }
}' | jq -r .tokens.accessToken)

# 2. Upload a photo. You get 202 straight away with status "queued".
MEAL=$(curl -s $API/api/v1/meals/analyze -H "Authorization: Bearer $TOKEN" \
  -F image=@food.jpg -F source=camera | jq -r .meal.id)

# 3. Poll the meal. status goes queued -> analyzing -> completed (a few seconds with the fake provider).
curl -s $API/api/v1/meals/$MEAL -H "Authorization: Bearer $TOKEN" | jq '.meal | {status, progress, name, totals, healthScore}'

# 4. The home screen: goal, consumed and remaining, in the user's timezone.
curl -s "$API/api/v1/dashboard/daily?date=today" -H "Authorization: Bearer $TOKEN" | jq '{goal, consumed, remaining}'
```

With `AI_PROVIDER=fake` every photo comes back as "Turkey Sandwich With Potato Chips" (460 kcal, 25 / 45 / 20 g,
health score 7), which is the dish in the mock-ups.

---

## What the API does

All paths below are under `/api/v1` unless noted. Everything except the rows marked **public** needs
`Authorization: Bearer <access token>`.

| Area | Endpoints |
|---|---|
| **Auth** | `POST /auth/register` (public), `/auth/login`, `/auth/oauth/apple`, `/auth/oauth/google`, `/auth/refresh`, `/auth/logout`, `/auth/password/forgot`, `/auth/password/reset` (all public) |
| **Onboarding** | `GET /onboarding/options` (public), `POST /onboarding/plan-preview` (public, nothing saved), `POST /onboarding/complete` (idempotent) |
| **Account** | `GET /me`, `PATCH /me/profile`, `PATCH /me/preferences`, `DELETE /me` (async hard delete) |
| **Goals** | `GET /me/goals`, `PUT /me/goals` (pencil edits), `POST /me/goals/recalculate` |
| **Weight** | `POST /me/weight-logs`, `GET /me/weight-logs?from=&to=`, `DELETE /me/weight-logs/:id` |
| **Devices** | `POST /me/devices` (FCM token), `DELETE /me/devices/:token` |
| **Meals** | `POST /meals/analyze` (photo), `POST /meals/barcode`, `POST /meals` (manual, or `description` for an AI estimate), `GET /meals/:id`, `GET /meals?date=&limit=&cursor=`, `PATCH /meals/:id`, `POST /meals/:id/fix`, `DELETE /meals/:id` |
| **Dashboard** | `GET /dashboard/daily?date=today\|yesterday\|YYYY-MM-DD` |
| **Analytics** | `GET /analytics/summary?range=7d\|30d\|90d` |
| **Ops** (server root) | `GET /health`, `GET /ready`, `GET /docs`, `GET /openapi.json`, `GET /metrics` (when `METRICS_ENABLED=true`) |

The committed spec is [`openapi/openapi.json`](openapi/openapi.json). A test fails if it is out of date, so run
`npm run openapi` after changing a route or schema.

### Conventions

- **Errors** always look like `{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [{ "path": "heightCm", "issue": "..." }] } }`.
  Messages follow `Accept-Language` (English by default). Codes never change.
- **Units:** metric on the wire (kg, cm). The client converts lbs and ft/in. Unit preferences are display-only.
- **Time:** timestamps are ISO-8601 UTC. "Today" and "Yesterday" are decided in the user's stored timezone, or the
  `X-Timezone` header when the client sends one (useful when travelling).
- **Unknown fields** in a request are ignored. **Other users' resources** answer `404`, never `403`.

### How a meal is analysed

```text
phone ──POST /meals/analyze──> API ──> checks magic bytes, resizes to 1280 px, strips EXIF, stores image + thumbnail
                                  └──> creates Meal(status=queued) ──> enqueues job ──> returns 202 {meal}
                                                                                   │
worker <───────────────────────────── BullMQ (Redis) ───────────────────────────────┘
  loads image -> calls the AI provider -> validates the JSON -> saves values -> push "Your meal is ready"
```

| `status` | `progress` | Meaning |
|---|---|---|
| `queued` | 5 | Saved, waiting for the worker |
| `analyzing` | 20 / 50 / 90 | Image loaded / model answered / result validated |
| `completed` | 100 | Values are final and count towards the day |
| `failed` | 0 | See `errorCode`: `NOT_FOOD`, `LOW_CONFIDENCE`, `PROVIDER_ERROR` |

Progress is stage-based on purpose; it is never a fake smooth percentage.

- **Retries:** network errors, `429` and `5xx` from the provider are retried 3 times with exponential backoff. A
  response that does not match the JSON schema is re-asked once. Implausible values are clamped (for example 5000 kcal
  per serving at most).
- **Totals** are `per-serving value x quantity`. Calories are whole numbers, macros have one decimal.
- **Meals that are still analyzing** appear in lists and on the dashboard but are **not counted** in the totals.
- **Fix Results** (`POST /meals/:id/fix {instruction}`) saves the correction and re-analyses with the original image
  plus every correction so far. The old values stay visible and keep counting (`reanalyzing: true`) until the new
  result lands. If the re-analysis fails, the meal goes back to `completed` with the old values and `errorCode` set.
- A meal that failed can be rescued by sending all four values to `PATCH /meals/:id`.
- **Idempotency:** send an `Idempotency-Key` header with `POST /meals/analyze` so a retried upload does not create a
  second meal.
- **Images** are private. Responses carry signed URLs that expire after 15 minutes.

### The nutrition plan

`src/lib/plan-engine` is a set of pure functions, unit-tested with 12 profiles whose expected values were derived independently with plain arithmetic (including both
calorie floors and the age edge cases), plus every combination of sex, goal, diet and activity.

1. **BMR** (Mifflin-St Jeor): `10*kg + 6.25*cm - 5*age + 5` (male), `- 161` (female), `- 78` for "other" (the midpoint).
2. **Activity multiplier** from workouts per week: `0-2` -> light 1.375, `3-5` -> moderate 1.55, `6+` -> active 1.725.
3. **Goal:** lose -15%, maintain 0, gain +10% of TDEE.
4. **Safety:** a "lose" plan never goes below 1500 kcal (male) or 1200 (female, other), and is refused with
   `422 GOAL_NOT_SUPPORTED` when BMI is under 18.5. Under-13s get `422 UNDER_MINIMUM_AGE`. User edits are clamped to
   800-6000 kcal and non-negative macros.
5. **Macros:** a share of calories per diet at 4 / 4 / 9 kcal per gram, for example balanced 22 / 53 / 25 and keto
   20 / 5 / 75. The grams add back up to the calorie target within rounding.

The survey answers (referral source, other apps, trainer, accomplishment) are stored for personalisation only and never
change the numbers. Every tunable lives in `src/config/plan.ts` or an environment variable.

Goals are **versioned**: editing or recalculating adds a new row and never rewrites the old one. The dashboard and
analytics use the goal that was active on the day being shown.

---

## Configuration

Everything comes from environment variables, validated at startup (the app refuses to boot on a bad value).
[`.env.example`](.env.example) lists every variable with a comment. The ones you will touch first:

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | PostgreSQL and Redis |
| `JWT_ACCESS_SECRET` | Signs access tokens. 32+ characters in production |
| `APP_NAME` | The product name (OpenAPI title, e-mail and push copy) |
| `AI_PROVIDER`, `AI_MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Which model analyses meals |
| `STORAGE_DRIVER`, `CLOUDINARY_*`, `S3_*` | Where meal images go (`cloudinary`, `s3`, `fs` for development) |
| `QUEUE_DRIVER` | `bullmq` (production) or `memory` (single-process development) |
| `PUSH_DRIVER`, `FIREBASE_SERVICE_ACCOUNT_JSON` | Push notifications |
| `GOOGLE_OAUTH_CLIENT_IDS`, `APPLE_CLIENT_IDS` | Allowed audiences for sign-in tokens |
| `RATE_LIMIT_*`, `PLAN_*` | Rate limits and plan tunables |

In production the app refuses to start with development-only drivers (`QUEUE_DRIVER=memory`, `STORAGE_DRIVER=fs|memory`,
`AI_PROVIDER=fake`).

### Storing photos in Cloudinary

```dotenv
STORAGE_DRIVER=cloudinary
CLOUDINARY_URL=cloudinary://API_KEY:API_SECRET@CLOUD_NAME   # dashboard > Settings > API keys
# or CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET (these win over the URL)
CLOUDINARY_FOLDER=calcam/prod                               # optional: keeps environments apart in one account
CLOUDINARY_AUTH_TOKEN_KEY=                                  # optional, see below
```

* Photos and thumbnails are uploaded as `authenticated` assets, so they are **private**: the original cannot be fetched
  without a link issued by this backend, and re-uploading the same key replaces the old file.
* **Link expiry.** Responses carry signed links (`imageUrl`, `thumbnailUrl`). Without `CLOUDINARY_AUTH_TOKEN_KEY` a link
  is signed but does not expire. If your Cloudinary account has *token-based authentication* enabled, put its key in
  `CLOUDINARY_AUTH_TOKEN_KEY` and links expire after `SIGNED_URL_TTL_SECONDS` (15 minutes), as they do with S3.
* The worker downloads the photo through a short-lived signed link, so it needs outbound HTTPS to `res.cloudinary.com`.
* `/ready` calls the Cloudinary Admin API (`ping`) at most once every 30 seconds.
* Deleting an account removes every file under `users/<id>/` (with `CLOUDINARY_FOLDER` in front).

**Moving existing photos.** Object keys are identical across drivers, so the database does not change. With the new
driver configured as above:

```bash
npm run storage:migrate -- --from fs --dry-run   # lists what would be copied and what is missing in the source
npm run storage:migrate -- --from fs             # or --from s3; safe to run again
```

then restart the API and the worker. The S3 and filesystem drivers stay available, so switching back is a one-line change.

### Swapping the AI provider

Set `AI_PROVIDER` to `anthropic` (default), `openai` (also works with any OpenAI-compatible server through
`OPENAI_BASE_URL`) or `fake`. `AI_MODEL` picks the model; the default for Anthropic is `claude-opus-5-5`. Setting a
smaller model there is the first thing to try if per-photo cost matters.

To add another provider, implement the one-method `MealAnalyzer` interface in `src/lib/analyzer/types.ts`, add it to
`createAnalyzer` in `src/lib/analyzer/index.ts`, and add the name to `AI_PROVIDER` in `src/config/env.ts`. The worker
validates every answer against `aiMealSchema`, so a provider only has to return the JSON from the spec. The prompt lives
in a versioned file, `src/lib/analyzer/prompts/meal-analysis.v1.ts`; change the wording by adding a `v2` file, and each
meal's `aiRaw` records which version produced it.

The fake provider can be steered by the upload's `hint` text, which makes failure paths easy to try by hand:
`notfood`, `lowconf`, `transient`, `permanent`, `badjson`, `huge`.

---

## Security and privacy

- **Passwords** use argon2id. **Access tokens** live 15 minutes. **Refresh tokens** live 30 days, are random, are stored
  only as SHA-256 hashes, and rotate on every use. Presenting a token that was already rotated revokes the whole
  session family (`REFRESH_TOKEN_REUSED`).
- **Apple and Google** identity tokens are verified against the providers' public keys. An existing account is linked
  only when the provider says the e-mail is verified.
- **Uploads** are checked by magic bytes (not the Content-Type), limited to 10 MB, re-encoded as JPEG and stripped of
  EXIF and GPS data. Stored images are private and only readable through short-lived signed URLs.
- **Logs** are structured JSON with a request id. The app does not log request bodies, tokens or e-mail addresses. The development-only `MAIL_DRIVER=log` prints password-reset e-mails (with the link), which is why production refuses it when password reset is on.
- **Rate limits** (per minute unless noted): auth 10 per IP, plan-preview 30 per IP, general 300 per user, uploads
  20 per hour per user. They use Redis when `REDIS_URL` is set, so they hold across API instances.
- **Account deletion** disables the account immediately and a background job hard-deletes every row and image.
- **"Your goals are private and saved securely"** (the pledge screen) is made true by TLS in transit plus encryption at
  rest. At rest is infrastructure you must switch on: encrypted RDS storage, an S3 bucket with default encryption,
  `S3_SSE=AES256` (or a KMS key), and an encrypted Redis. The app sets the S3 header per upload when `S3_SSE` is set.

---

## Testing

```bash
npm test                 # everything
npm run test:unit        # pure functions, under a second
npm run test:integration # HTTP tests against a real PostgreSQL
npm run typecheck
```

No Docker is needed. The integration tests start a throwaway PostgreSQL (`embedded-postgres`), apply the committed
migrations, and use in-memory fakes for the queue, storage, push, e-mail, sign-in and AI. To use your own database,
set `TEST_DATABASE_URL`.

What is covered: the plan engine (hand-derived fixtures, guardrails, projection), auth including refresh rotation and
reuse detection, the whole onboarding flow and its all-or-nothing transaction, goals and weight, the meal pipeline
(stages, retries, failures, Fix Results, idempotency, uploads), barcode and manual entry, timezone boundaries around
midnight in `Asia/Phnom_Penh` and `America/Los_Angeles` (including the 25-hour daylight-saving day), isolation between
users, rate limits, and that the OpenAPI document matches the routes.

What is not covered by automated tests:

- **Real BullMQ, Redis, MinIO and S3.** They were exercised by hand through `docker compose` (retry timing, signed URLs,
  readiness), not in CI.
- **Real Anthropic and OpenAI calls.** The request shape and error handling are tested against a stubbed HTTP layer, but
  no live call is made without a key.
- **FCM delivery**, **real Apple/Google token verification** and **the Open Food Facts network call.** Their parsing and
  logic are tested; the network edges are not.

---

## Deploying to AWS

(With `STORAGE_DRIVER=cloudinary` skip the S3 bucket and the S3 steps below, and keep the Cloudinary credentials in
Secrets Manager with the other secrets.)

The image is built for ECS Fargate (or any container platform). It is not a serverless function: the worker is a
long-running process.

1. Build one image from the `Dockerfile` and push it to ECR.
2. Run **three** things from that image: the API service (default command, port 3000, behind an ALB with health check
   `/health`), the worker service (`node dist/worker.js`, no inbound port), and a one-off task
   `npx prisma migrate deploy` before each release.
3. Use RDS PostgreSQL (encrypted), ElastiCache Redis, and an S3 bucket with default encryption and public access blocked.
4. Give the task role S3 access and leave `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` unset. Set `S3_SSE=AES256`.
   Leave `S3_ENDPOINT` unset on AWS.
5. Put secrets (`JWT_ACCESS_SECRET`, `ANTHROPIC_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON`, `DATABASE_URL`) in Secrets Manager.
6. Set `NODE_ENV=production` and `TRUST_PROXY=1` behind the ALB, so per-IP rate limits see the real client address.
7. Scale the worker on queue depth and `QUEUE_CONCURRENCY`; scale the API on CPU or request count. On shutdown both
   processes stop accepting work and let running jobs finish.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `dev:worker` | API / worker with reload |
| `npm run build` / `start` / `start:worker` | Compile to `dist/` and run it |
| `npm test`, `test:unit`, `test:integration`, `typecheck` | Checks |
| `npm run migrate` | Apply migrations (`prisma migrate deploy`) |
| `npm run migrate:dev` | Create a new migration after editing `prisma/schema.prisma` |
| `npm run seed` | Demo account `demo@example.com` / `Password123!` |
| `npm run storage:migrate -- --from fs\|s3` | Copy stored photos to the configured `STORAGE_DRIVER` (add `--dry-run` first) |
| `npm run openapi` | Regenerate `openapi/openapi.json` |
| `npm run postman` | Regenerate the Postman collection |
| `npm run db:embedded` | Local PostgreSQL without Docker |

## Project layout

```text
src/
  server.ts  worker.ts  app.ts  deps.ts     entry points and wiring
  config/        environment (Zod-validated) and plan tunables
  modules/       auth, onboarding, profile, goals, weight, devices, meals, dashboard, analytics, ops
                 each: *.routes.ts (route + handler), *.service.ts, *.schemas.ts, *.test.ts
  lib/           plan-engine, analyzer (interface + Anthropic, OpenAI, fake), storage, queue, push, mail,
                 oauth, product-lookup, image, http (route registry + OpenAPI builder)
  middleware/    authenticate, rate limits, upload, error handler
prisma/          schema.prisma, migrations, seed.ts
tests/           integration tests, helpers (fakes, fixtures)
openapi/         generated OpenAPI 3.1 spec
postman/         generated collection
docs/            ui-coverage.md
```

A route is declared once, with its Zod schemas (`src/lib/http/route.ts`). The same declaration validates requests,
validates responses, and produces the OpenAPI document, so the spec cannot drift from the code. There is no separate
controller layer: each `*.routes.ts` file is the thin controller and calls a service.
