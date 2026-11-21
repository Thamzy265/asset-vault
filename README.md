# Family Asset Vault

Self-hosted web app for a family's assets, insurance policies and their documents. This is the M1.1 skeleton: a Next.js web app, a background worker and Postgres, run with Docker Compose.

## Needs

- Docker with Compose v2+ (to run the app)
- Node 26 and pnpm 11 (only to run checks and tests)

## Start

```sh
cp .env.example .env          # then fill in the three passwords (empty in the example)
docker compose up -d --wait   # builds, migrates, then starts web and worker
```

Fill in `POSTGRES_PASSWORD`, `VAULT_MIGRATOR_PASSWORD` and `VAULT_APP_PASSWORD` with three different long random passwords, letters and digits only (they go into URLs), for example the output of `openssl rand -hex 24` run three times. Compose refuses to start while any of them is empty.

- Home page: http://127.0.0.1:3000
- Health: http://127.0.0.1:3000/api/v1/health → `{"status":"ok","db":"ok","version":"0.1.0","schema":{"expected":"0004_database_roles","applied":"0004_database_roles"},"workerHeartbeat":"…"}`

The web app listens on 127.0.0.1 only (`WEB_PORT` in `.env`, default 3000). Postgres is not published to the host.

A one-shot `migrate` service applies pending migrations first; `web` and `worker` start only after it exits successfully. If a migration fails, `docker compose up` stops with an error, the old schema stays, and the new web and worker do not start: `docker compose logs migrate` shows why. Health answers 503 whenever the applied schema differs from the one the code expects (`schema.expected` vs `schema.applied`).

## Database roles

The app never connects as a superuser (design note M1.2, decision 3):

| Login | Used by | May do |
|---|---|---|
| `vault` (`POSTGRES_USER`) | the Postgres image, and an admin at the console | everything (bootstrap superuser) |
| `vault_migrator` | the one-shot `migrate` service only | owns the database and its tables; runs migrations |
| `vault_app` | `web` and `worker` | read and write the business tables; read the audit log and add to it (it can't set `id` or `at`); run the audit retention function; use the `pgboss` job schema. It owns nothing, so it can't switch the audit log's protections off. |

Postgres creates `vault_migrator` and `vault_app` from `.env` the first time it starts on an empty volume (`packages/db/initdb/10-vault-roles.sh`). Migration `0004_database_roles` grants what `vault_app` may do. A new business table grants its rights in its own migration (`grantAppAccess` in `packages/db/src/migrations/record-columns.ts`); a test fails until it does.

### Changing a password

The init script runs only on an empty volume, so after that a password is changed in Postgres and in `.env`, then the services that use it are recreated:

1. Open a console as the superuser: `docker compose exec postgres psql -U vault -d vault`
2. Type `\password vault_app`, enter the new password twice, then `\q`.
3. Put the same password in `.env` as `VAULT_APP_PASSWORD`.
4. `docker compose up -d --wait` recreates the containers whose settings changed: web and worker, and Postgres too (its environment holds the role passwords for the init script); the data volume stays.

For `vault_migrator` use `\password vault_migrator` and `VAULT_MIGRATOR_PASSWORD` (only `migrate` uses it). For the superuser use `\password vault` and `POSTGRES_PASSWORD`. `\password` sends the new password hashed and keeps it out of shell history.

### A stack created before the roles existed

A database volume created before this change has no `vault_migrator` or `vault_app`, so `migrate` can't log in and web and worker don't start. Until M2 the database holds no real data, so the simplest fix is a new volume: `docker compose down -v` (this deletes all data), then `docker compose up -d --wait`. To keep the data instead, ask for the manual steps (create the roles with the init script, hand the tables to `vault_migrator`, drop the old `pgboss` job schema); they are not automated.

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
pnpm db:migrate    # apply pending migrations (the one-shot migrate service)
pnpm db:rollback   # revert the most recent migration (run once per migration to revert)
```

Migrations live in `packages/db/src/migrations/`, each with an explicit `up` and `down`, and are listed in `packages/db/src/migrations/index.ts`. New business tables use the shared helper in `packages/db/src/migrations/record-columns.ts` (owner, visibility, timestamps, created/updated-by, `updated_at` trigger).

The migration connection allows statements up to 5 minutes and waits at most 10 seconds for a lock, so a migration stuck behind a lock fails fast instead of blocking the app. Normal app queries are cancelled by Postgres after 4 seconds.

### Rolling back a release

In this order, so no code runs against a schema it doesn't know:

1. Stop the worker (and the web app): `docker compose stop worker web`
2. Roll back the new release's migrations: `pnpm db:rollback`, once per migration the release added. A `down` can drop data the release added.
   Rolling back `0003_audit_log` is refused while the audit log has rows: a routine rollback never drops audit history. Export the log first, for example `docker compose exec -T postgres pg_dump -U vault -d vault --data-only --table=audit_log > audit_log-export.sql`, and keep the file as safely as the database (it names who did what). Removing the log after that is a deliberate admin decision, not a migration.
3. Deploy the previous image (check out the previous release, then `docker compose up -d --build --wait`). Its `migrate` service finds nothing to apply, and health shows `schema.applied` equal to `schema.expected`.

## Layout

- `apps/web` — Next.js App Router app and JSON API under `/api/v1`
- `apps/worker` — background jobs (pg-boss): a heartbeat every minute, audit log retention nightly at 03:15 UTC
- `packages/db` — the only way to the database: migrations, config validation, and repositories that apply the visibility rule and write the audit log. Apps hold an opaque handle. In `apps/*`, ESLint forbids `kysely`, `pg`, any path into `packages/` or `node_modules` (app tests may use `packages/db/test/support/`), `require`/`createRequire`, and non-literal `import()`; inline `eslint-disable` comments have no effect there, so an exception goes in `eslint.config.mjs`. The database roles are the real limit: web and worker log in as `vault_app`
- `e2e` — Playwright tests
