# M1 Foundation — design note

Date: 2026-11-21 — Size: large — new data store, new trust boundaries (internet via Cloudflare, admin via Tailscale), auth — Phase: MVP — Status: **M1.1 section approved via the MVP deck (PM, 2026-11-21); M1.2–M1.6 sections drafted before each is briefed**

## Context
Nothing exists yet. M1 builds the base every later milestone stands on: the app and worker skeleton, the data-model foundation, sign-in with 2FA, remote access, backups and health checks. Plan: `docs/PLAN.md#m1--foundation`. Stack decided in ADRs 0001–0003.

## Requirements and non-goals
- Functional (M1.1): one command starts the web app, the worker and Postgres; a health endpoint reports app and database status; the worker runs a scheduled heartbeat job; migrations go up and down.
- Non-functional: runs in ≤ 2 GB RAM for app + worker + DB at idle; config only from environment variables; stateless app and worker processes; check command runs in < 2 minutes.
- Non-goals (M1.1): any business tables, sign-in, UI beyond a placeholder page, Cloudflare/Tailscale, backups.

## Top 3 qualities
| Quality | Target | How we check it |
|---|---|---|
| Security | No data endpoint answers without auth (from M1.3); no secrets in the repo | Tests per endpoint; secret scan in the check command |
| Data integrity | Every migration reversible; money in `numeric` | Migration up → down → up test; schema lint |
| Recoverability | Restore from last night's backup works | Monthly automated restore test (M1.5) |

## Estimate
Trivially small: 2–5 users, < 1 request/second, < 10 GB documents in the first years, a few thousand rows per year.

## Data
M1.1 creates only the migration table and the job-queue tables. Migrations are written with explicit `up` and `down` (expand → migrate → contract for later changes). Business tables start in M1.2 (people, users, roles, visibility, audit log) — designed in this note before M1.2 is briefed.

## Options
### A: Next.js app + separate TypeScript worker + Postgres (Compose, 3 services)
Simple, the worker can be restarted alone, Postgres-backed queue (pg-boss). Effort: low.
### B: Next.js only, jobs run inside the web process
One service fewer, but long OCR/sync jobs would slow the web app and die with it. Effort: lowest now, rework later.

## Decision
A. Within A, the developer uses: pnpm workspace (`apps/web`, `apps/worker`, `packages/db`), Next.js App Router with TypeScript strict, Kysely for queries and up/down migrations, pg-boss for jobs, Vitest for unit tests, ESLint, Playwright for end-to-end. The developer may propose a swap in the hand-off if a library blocks a requirement (e.g. reversible migrations).

## Failure plan
- Database unreachable at start: app and worker retry with backoff for 60 s, then exit non-zero so Compose restarts them; health returns 503 meanwhile.
- No outbound calls in M1.1. From M1.4 on, every outbound call has a timeout and bounded retries with jitter.

## Observability
`GET /api/v1/health` → `{ status, db, version }` (200 or 503). Structured JSON logs with no personal data. Worker logs each heartbeat. The one number to watch: last successful worker heartbeat time.

## Trust boundaries and abuse cases
- Boundaries in M1.1: none exposed — Compose binds the app to localhost only; Postgres is not published to the host.
- Abuse cases (for M1.3–M1.4): "As an attacker I reach Postgres or the worker from the network" — mitigation: no published ports except the app; Tunnel targets only the app. "As an attacker I read secrets from the repo" — mitigation: `.env` git-ignored, `.env.example` names only, secret scan in the check command.

## Privacy
n/a for M1.1 — no personal data. M1.2–M1.3 (people, users, audit log) get a Privacy section here before they are briefed.

## Rollout and rollback
M1.1 is a new repo; rollback is reverting the merge commit. From M1.2 on: migrations run forward on deploy; rollback runs the `down` migration and redeploys the previous image.

## Later lines
None new from M1.1.
