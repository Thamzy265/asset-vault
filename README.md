# Family Asset Vault

Self-hosted web app for a family's assets, insurance policies and their documents. This is the M1.1 skeleton: a Next.js web app, a background worker and Postgres, run with Docker Compose.

## Needs

- Docker with Compose v2+ (to run the app)
- Node 26 and pnpm 11 (only to run checks and tests)

## Start

```sh
cp .env.example .env          # then fill in POSTGRES_PASSWORD (empty in the example)
docker compose up -d --wait   # builds and starts web, worker and postgres
```

Pick a long random password, letters and digits only (it goes into a URL), for example the output of `openssl rand -hex 24`. Compose refuses to start while `POSTGRES_PASSWORD` is empty.

- Home page: http://127.0.0.1:3000
- Health: http://127.0.0.1:3000/api/v1/health → `{"status":"ok","db":"ok","version":"0.1.0","workerHeartbeat":"…"}`

The web app listens on 127.0.0.1 only (`WEB_PORT` in `.env`, default 3000). Postgres is not published to the host. The worker applies pending migrations when it starts.

## Stop

```sh
docker compose down           # stops the stack, keeps the database volume
docker compose down -v        # also deletes the database volume (all data)
```

## Checks

```sh
pnpm install
pnpm check      # ESLint + TypeScript + Vitest unit/integration tests + secret scan
pnpm test:e2e   # Playwright against the running stack (start it first)
pnpm deps:audit # known vulnerabilities in production dependencies (needs the network)
```

`pnpm check` needs Docker running: database tests start a throwaway Postgres container. Set `TEST_DATABASE_URL` to use an existing throwaway server instead.

## Migrations

```sh
pnpm db:migrate    # apply pending migrations (runs inside the worker image)
pnpm db:rollback   # revert the most recent migration
```

Migrations live in `packages/db/src/migrations/`, each with an explicit `up` and `down`, and are listed in `packages/db/src/migrations/index.ts`.

## Layout

- `apps/web` — Next.js App Router app and JSON API under `/api/v1`
- `apps/worker` — background jobs (pg-boss); a heartbeat job runs every minute
- `packages/db` — Kysely client, migrations, config validation
- `e2e` — Playwright tests
