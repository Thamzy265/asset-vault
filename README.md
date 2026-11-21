# Family Asset Vault

Self-hosted web app for a family's assets, insurance policies and their documents. A Next.js web app, a background worker and Postgres, run with Docker Compose. Sign-in needs a password and a code from an authenticator app (two-step sign-in); there is no public sign-up.

## Needs

- Docker with Compose v2+ (to run the app)
- Node 26 and pnpm 11 (only to run checks and tests)

## Start

```sh
cp .env.example .env          # then fill in the three passwords and the sign-in key (empty in the example)
docker compose up -d --wait   # builds, migrates, then starts web and worker
```

Fill in `POSTGRES_PASSWORD`, `VAULT_MIGRATOR_PASSWORD` and `VAULT_APP_PASSWORD` with three different long random passwords, letters and digits only (they go into URLs), for example the output of `openssl rand -hex 24` run three times, and `AUTH_ENCRYPTION_KEY` with `openssl rand -hex 32`. Compose refuses to start while any of them is empty. Keep the key as safely as the database backups: it encrypts the authenticator secrets, so changing or losing it signs everyone out and every person needs a new setup link.

- App: http://127.0.0.1:3000 (it sends you to the sign-in page)
- Health: http://127.0.0.1:3000/api/v1/health → `{"status":"ok","db":"ok","version":"0.1.0","schema":{"expected":"0007_auth","applied":"0007_auth"},"workerHeartbeat":"…"}`

The web app listens on 127.0.0.1 only (`WEB_PORT` in `.env`, default 3000). Postgres is not published to the host. `APP_URL` is the address people open the app at (default `http://127.0.0.1:WEB_PORT`): sign-in cookies, the cross-site check on sign-in requests and setup links use it, so set it when the app moves behind a domain.

A one-shot `migrate` service applies pending migrations first; `web` and `worker` start only after it exits successfully. If a migration fails, `docker compose up` stops with an error, the old schema stays, and the new web and worker do not start: `docker compose logs migrate` shows why. Health answers 503 whenever the applied schema differs from the one the code expects (`schema.expected` vs `schema.applied`).

## Database roles

The app never connects as a superuser (design note M1.2, decision 3):

| Login | Used by | May do |
|---|---|---|
| `vault` (`POSTGRES_USER`) | the Postgres image, and an admin at the console | everything (bootstrap superuser) |
| `vault_migrator` | the one-shot `migrate` service only | owns the database and its tables; runs migrations |
| `vault_app` | `web` and `worker` | read and write the business tables; read the audit log and add to it (it can't set `id` or `at`); run the audit retention function; use the `pgboss` job schema; sign-in tables as needed (it can't delete `users`: logins are deactivated, not deleted). It owns nothing outside the `pgboss` job-queue schema (pg-boss creates its own tables there), so it can't switch the audit log's protections off. |

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

## Users and sign-in

Nobody can sign up. The admin creates each login on the server, and the person finishes setting it up from a one-time link:

```sh
pnpm user:create --email ada@example.org --name "Ada Lovelace" --role admin   # or --role member
pnpm user:create --email ada@example.org --name "Ada Lovelace" --role admin --person-id <uuid>   # link an existing person
```

It prints a setup link valid for 24 hours, usable once (`http://…/setup#…`). Pass it to the person privately; they choose a password (at least 12 characters, not a common one), set up an authenticator app (QR code or key) and save 10 backup codes. The link is printed only in your terminal, never logged; the token is in the part after `#`, which browsers never send to a server.

- **Lost phone or forgotten password:** run `pnpm user:create` again with the same email and role. It issues a new link and the old one stops working. Using it sets a new password and a new authenticator, and signs the person out everywhere.
- **Removing someone:** `pnpm user:deactivate --email ada@example.org`. It deletes their password, authenticator secret, backup codes, sessions, setup links, email and name, and unlinks their person record. The bare login row (id and role) stays while the audit log names it and is deleted by the nightly retention after that. Their person record and its data stay.

Both commands run in the worker image as `vault_app` (the worker's own login: no migrator or superuser rights) through `docker compose run`, so the stack's `.env` must be the one in this folder.

Signing in: email and password, then a 6-digit code from the authenticator app (or one backup code). Sessions end after 24 hours without use and after 7 days at most; "Sign out of all devices" ends every session. After 5 wrong passwords for one email, or 20 from one network, sign-in pauses for up to 15 minutes; after 5 wrong codes the person signs in again.

Every `/api/v1` endpoint except `/api/v1/health` needs a signed-in session with two-step sign-in done (401 without a session, 403 `2fa_required` with the password only). `GET /api/v1/me` returns the signed-in user's id, name, role and person id.

The client IP is never taken from `X-Forwarded-For` (anyone can send it). Behind a proxy that sets the client IP in one header and overwrites any value a client sends (Cloudflare: `cf-connecting-ip`), set `AUTH_TRUSTED_IP_HEADER` to that header; the audit log then keeps the network prefix (IPv4 /24, IPv6 /48) of sign-in attempts, and the per-network limit applies per prefix. Without it the IP is unknown and every client shares one per-network limit.

## Logs and personal data

Web and worker log one JSON object per line. `/api/v1` requests are logged as request id, route pattern, method, status and duration; errors as a code, the route and the request id. Logs never hold emails, names, passwords, codes, tokens, row values or a Postgres `detail`.

Postgres's own server log is different: when it refuses a write (for example a failed constraint) it can log the row values it refused. Treat the Postgres container log as personal data: it is not shipped anywhere and is rotated with the container (`docker compose logs postgres` reads it).

## Stop

```sh
docker compose down           # stops the stack, keeps the database volume
docker compose down -v        # also deletes the database volume (all data)
```

## Checks

```sh
pnpm install
pnpm check      # ESLint + TypeScript + Vitest unit/integration tests + secret scan
pnpm test:e2e   # Playwright against the running stack (start it first), including axe accessibility checks
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
2. Roll back the new release's migrations: `pnpm db:rollback`, once per migration the release added. A `down` can drop data the release added (rolling back `0007_auth` drops every login's password, authenticator and session; people and the audit log stay). Health then shows `schema.applied` one migration behind `schema.expected`, except after rolling back `0004_database_roles`: that takes away the app's right to read the schema version, so health shows `"applied": null`.
   Rolling back `0003_audit_log` is refused while the audit log has rows: a routine rollback never drops audit history. Export the log first, for example `docker compose exec -T postgres pg_dump -U vault -d vault --data-only --table=audit_log > audit_log-export.sql`, and keep the file as safely as the database (it names who did what). Removing the log after that is a deliberate admin decision, not a migration.
3. Deploy the previous image (check out the previous release, then `docker compose up -d --build --wait`). Its `migrate` service finds nothing to apply, and health shows `schema.applied` equal to `schema.expected`.

## Layout

- `apps/web` — Next.js App Router app, the sign-in screens, `/api/auth/*` (sign-in steps) and the JSON API under `/api/v1`. `src/proxy.ts` is the one gate for `/api/v1` and sets the security headers (CSP with a per-request nonce, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: same-origin`) on every response
- `apps/worker` — background jobs (pg-boss): a heartbeat every minute, audit log retention nightly at 03:15 UTC, and every 15 minutes the removal of expired sessions, setup links and failed sign-in attempts
- `packages/db` — the only way to the database: migrations, config validation, the sign-in service (Better Auth, pinned, wrapped in `src/auth/`), and repositories that apply the visibility rule and write the audit log. Apps hold an opaque handle. A `Viewer` (who is asking) is created only by the session check, for a signed-in user with two-step sign-in done; apps can't build one (a type error, an ESLint error and a run-time refusal). In `apps/*`, ESLint forbids `kysely`, `pg`, any path into `packages/` or `node_modules` (app tests may use `packages/db/test/support/`), `require`/`createRequire`, and non-literal `import()`; inline `eslint-disable` comments have no effect there, so an exception goes in `eslint.config.mjs`. The database roles are the real limit: web and worker log in as `vault_app`
- `e2e` — Playwright tests
