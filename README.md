# Motoro

A 24×7 roadside assistance & mechanic dispatch platform: drivers post a breakdown, the platform finds and assigns the nearest verified mechanic, the mechanic diagnoses → quotes → repairs → gets paid, and operations staff can always see and intervene.

The API is a Cloudflare Worker (Hono) backed by D1 (relational data), KV (sessions/config/limits), R2 (private files), Queues (async side-effects), a Durable Object (live rooms), and a cron sweep that guarantees a request is **never stranded** — offers time out, retries expand the search radius, and unresolved requests escalate to operations.

The web app is Next.js 15 (App Router) with a small design-system package, bilingual (EN/HI) copy, and separate experiences for drivers, mechanics/workshops, operations, and admins.

---

## Repository layout

```
apps/
  worker/         Cloudflare Worker API (Hono), dispatch engine, DO, migrations
  web/            Next.js 15 app (driver, mechanic, operations, admin consoles)
packages/
  config/         Brand + DEFAULT_CONFIG (dispatch, pricing, uploads) + catalogs
  types/          Shared DTOs and status unions
  validation/     Zod schemas for every request body/query
  ui/             Design-system components (Button, Card, Badge, Modal, ...)
scripts/
  seed.mjs        Reset + seed demo data through the API
  demo.mjs        Full end-to-end happy path over real HTTP
```

## Requirements

- Node.js ≥ 20 (tested on 24)
- npm ≥ 10
- No Cloudflare account is needed for local development (Miniflare runs everything locally).

## Quick start

```bash
npm install

# 1. Create/apply the local D1 schema
npm run db:migrate:local

# 2. API on http://127.0.0.1:8787
npm run dev:worker

# 3. Seed demo data (separate terminal)
npm run seed

# 4. Web app on http://localhost:3000
npm run dev:web
```

`npm run dev` runs the worker and the web app together.

Open <http://localhost:3000> and sign in with a demo account:

| Role | Email | Password |
| --- | --- | --- |
| Driver | `driver1@motoro.test` … `driver10@motoro.test` | `Demo@1234` |
| Mechanic | `mechanic1@motoro.test` … `mechanic15@motoro.test` | `Demo@1234` |
| Workshop | `workshop1..3@motoro.test` | `Demo@1234` |
| Towing partner | `towing1..2@motoro.test` | `Demo@1234` |
| Operations | `ops1@motoro.test`, `ops2@motoro.test` | `Demo@1234` |
| Admin | `admin@motoro.test` | `Demo@1234` |

> If port 3000 is taken by another project, run `npx next dev -p 3005` from `apps/web` — any `http://localhost:300x` origin is already allowed by the worker's dev `ALLOWED_ORIGINS`.

## One-command demo

```bash
npm run demo
```

Registers a fresh driver, creates a vehicle and an emergency request, waits for a dispatch offer, accepts it as a mechanic, then walks the whole job: en-route → arrived → OTP verification → diagnosis → quote → driver approval → repair → completion → payment (PAID) → review. Every step is a real API call.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Worker (:8787) + web (:3000) together |
| `npm run dev:worker` / `npm run dev:web` | One side only |
| `npm run lint` | ESLint (flat config) across the monorepo |
| `npm run typecheck` | `tsc --noEmit` for all six workspaces |
| `npm test` | Unit tests + Workers integration tests |
| `npm run build` | Typecheck + production Next build |
| `npm run seed` | Reset and seed demo data via `/api/dev/seed` |
| `npm run demo` | End-to-end happy-path script |
| `npm run db:migrate:local` | Apply D1 migrations locally |
| `npm run db:migrate:remote` | Apply D1 migrations to the remote database |
| `npm run deploy:worker` | Deploy the API to Cloudflare |

## Architecture

| Concern | Service | Notes |
| --- | --- | --- |
| System of record | **D1** (SQLite) | Users, vehicles, requests, dispatch attempts, jobs, quotes, payments, reviews, audit log, config |
| Session cache / rate limits / config cache | **KV** | Sessions are cached with a 30-day TTL; DB is the fallback |
| Files | **R2** | Private bucket; access only through signed relay URLs (or presigned S3 URLs when credentials are configured) |
| Async work | **Queues** | Notifications, analytics, file processing, dispatch retries; failures go to a DLQ |
| Live state | **Durable Object** `EmergencyRoom` | Rooms `request:{id}`, `user:{id}`, `mechanic:{id}`, `ops`; WebSocket fan-out |
| Background safety | **Cron** `* * * * *` | Dispatch sweeps: offer timeouts, stall detection, radius expansion, escalation |

### Never-stranded dispatch

1. A request starts `CREATED → SEARCHING → DISPATCHING`.
2. Candidates are **filtered** (verified, available, inside both the request radius and the mechanic's own service radius, under the concurrency cap) then **fit** into strict (skills + equipment) and relaxed (skills only) pools, then **scored** (distance, skills, equipment, reliability, acceptance/cancellation rates, workload, rating) and ranked.
3. Up to `parallelOffers` mechanics receive an offer simultaneously; first accept wins, the rest are declined.
4. Offers expire after `attemptTimeoutSeconds`; the cron sweep times them out and retries with the next radius step (`radiusStepsKm`, expanded by `radiusExpansionFactor`).
5. After `maxAttempts` / `maxEscalationRetries` the request becomes `ESCALATED`, which puts it in front of the operations console where staff can assign a mechanic manually.

### API conventions

- Base path `/api`; every response uses one envelope:
  `{ success, data, error: { code, message, details? }, requestId }`.
- Money is integer **paise** (`amountCents`, `totalCents`).
- Auth is an httpOnly `rr_session` cookie (PBKDF2-SHA256 password hashes, 100k iterations). The browser talks to the API same-origin — `next.config.js` rewrites `/api/*` to the worker — so no CORS is needed in dev.
- Realtime uses a short-lived ticket (`GET /api/realtime/ticket`) to open a WebSocket; the session cookie never travels over the socket. Messages: `subscribe`, `ping`/`pong`, `request.state`, `request.location`, `mechanic.location`, `presence`.

### Roles & main screens

| Role | Screens |
| --- | --- |
| Driver | Dashboard, new request, live session (map + timeline + quote approval + payment), history, vehicles, notifications, profile |
| Mechanic / workshop | Dispatch board with countdown offers, job workbench (en-route, OTP, diagnosis, quote, photos), earnings, settings/verification |
| Operations | Live queue, map, mechanics, failed jobs, manual assignment override |
| Admin | Platform stats, users, pricing rules, audit log |

## Testing

```bash
npm test
```

- **Unit tests** (Node): dispatch engine ranking/filtering, request/job/mechanic state machines, pricing (service fee, quote totals, payout), geodesy, password/token crypto, and every Zod schema.
- **Integration tests** (Workers runtime via `@cloudflare/vitest-pool-workers`): the real worker boots in Miniflare with real D1/KV/R2/DO/Queue bindings and real migrations; tests cover health, register/login/session guard, vehicle creation, emergency creation, and permission boundaries.
- **`npm run demo`**: the full business process over live HTTP against `wrangler dev`.

## Deployment

```bash
# one-time
npm run db:create              # paste the returned D1 id into wrangler.jsonc / .env
npm run db:migrate:remote

# secrets (never commit these)
npx wrangler secret put SESSION_SECRET -c apps/worker/wrangler.jsonc
npx wrangler secret put R2_ACCESS_KEY_ID ...   # optional, enables browser-direct uploads
npx wrangler secret put R2_SECRET_ACCESS_KEY ...

npm run deploy:worker
```

Checklist for production:

- Set `ENVIRONMENT=production` (already set in the `production` env block) — this disables `/api/dev/*` seed routes and requires a real `SESSION_SECRET`.
- Set `ALLOWED_ORIGINS` to your real web origin(s); it is enforced as a CSRF origin check.
- Point `apps/web` at the deployed API (remove or update the `/api/*` rewrite in `next.config.js`, or put both behind one domain).
- `SESSION_SECRET` must be set in staging/production — the worker fails fast with `CONFIG_ERROR` instead of silently using a dev fallback.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `EADDRINUSE :::3000` | Another project owns the port: `npx next dev -p 3005` and keep using a `localhost:300x` origin. |
| Seed returns `NOT_FOUND` / `FORBIDDEN` | Dev routes require `ENABLE_SEED_ROUTES=true` and a non-production `ENVIRONMENT`. |
| `403 CSRF/origin` on login | Your origin is missing from `ALLOWED_ORIGINS` in `wrangler.jsonc`. |
| Web app returns 500 on `/` with a React Client Manifest error | A `next build` overwrote the `.next` cache of a running dev server — restart `npm run dev:web`. |
| Empty database after restart | Local D1 lives under `.wrangler/state`; re-run `npm run db:migrate:local` + `npm run seed`. |
| Uploads fail | R2 is local by default; only `image/jpeg`, `image/png`, `image/webp`, `application/pdf` under the configured size cap are accepted. |
| Webhook/provider errors | Payments default to `PAYMENT_PROVIDER=test` (sandbox); real keys are optional. |

## Configuration

Runtime configuration lives in `platform_config` (D1) with a KV/memory cache and falls back to `DEFAULT_CONFIG` in `packages/config`: dispatch radii/timeouts, pricing (base fee, per-km fee, night/emergency/towing surcharges, platform fee %), cancellation policy, and upload limits. Admins can edit pricing rules from the admin console.
