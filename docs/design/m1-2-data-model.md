# M1.2 Data model foundation — design note

Date: 2026-11-21 — Size: large — changes the data model, adds personal data (people, users), adds the audit log — Phase: MVP — Status: written while PM away; briefed under the PM's standing approval (`docs/status.md`, 2026-11-21) — PM reviews on return

## Context
Every later record (assets, policies, documents) hangs off people and is checked for visibility. The design review found that owners were logins (M1); this item separates **people** (family members, login optional) from **users** (logins). Plan: `docs/PLAN.md` M1.2. Builds on M1.1 (`packages/db`, Kysely up/down migrations).

## Requirements and non-goals
- Functional:
  - `people` table: family members who own things, are insured, or are beneficiaries.
  - Common record columns on every business table, via one shared migration helper: `id` (uuid), `owner_person_id`, `visibility`, `created_at`, `updated_at`, `created_by_user_id`, `updated_by_user_id`.
  - `visibility` enum: `family` (default; everyone signed in sees it), `private` (owner's linked user and admins only). `restricted` is reserved for the Later per-record permissions.
  - One data-access layer: every read/write takes a `viewer` (user id, role, person id) and applies the visibility rule. No module queries business tables except through it.
  - `audit_log`: append-only record of who viewed or changed what.
- Non-functional: reversible migrations; database constraints (FKs, NOT NULL, CHECKs) for integrity, not only app code.
- Non-goals: sign-in itself (M1.3), assets/policies (M2), permission sharing UI (Later).

## Top 3 qualities
| Quality | Target | How we check it |
|---|---|---|
| Authorisation | No query path bypasses the visibility check | Test per repository function: `private` record invisible to another member; lint rule or test that forbids importing the raw Kysely client outside `packages/db` |
| Data integrity | Constraints enforced by Postgres | Tests that bad inserts fail at the DB (bad FK, bad enum, missing owner) |
| Auditability | Every change and every record view is in the audit log; the log can't be edited | Tests: write → audit row exists; UPDATE/DELETE on `audit_log` fails |

## Estimate
Trivially small: < 20 people, < 10 users, audit log ~ 10–50k rows/year.

## Data
```
people
  id uuid pk, display_name text not null (1–100 chars), relationship text null (≤ 50),
  + common columns (owner_person_id nullable for people themselves; visibility default 'family')

users  (M1.3 adds auth tables; M1.2 creates the link only)
  id uuid pk, person_id uuid null fk people unique, role text check in ('admin','member') default 'member',
  created_at, updated_at

audit_log
  id bigint identity pk, at timestamptz default now(), actor_user_id uuid null fk users,
  action text check in ('view','create','update','delete','sign_in','sign_in_failed','sign_out',
                        '2fa_enrolled','2fa_failed','password_changed','backup_code_used'),
  entity_type text null, entity_id uuid null, ip_prefix text null, details jsonb null
```
- `audit_log` is append-only: a trigger raises on UPDATE and DELETE, except a retention function run by the worker (below).
- `details` never holds field values of personal or financial data — only which fields changed (names, not values).
- `ip_prefix`: IPv4 /24 or IPv6 /48, only on sign-in events. Not the full address (minimisation).
- Schema changes follow expand → migrate → contract; every migration has a tested `down`.

## Options
### A: Visibility enforced in a TypeScript data-access layer (repositories take a viewer)
Simple, testable, one place. Risk: someone bypasses it with a raw query — mitigated by the import rule and tests.
### B: Postgres row-level security with a per-request `SET app.viewer_id`
Enforced even for raw queries; harder with connection pooling, harder to test and debug, easy to misconfigure.

## Decision
A now (ADR 0001 already chose an in-app layer). B is a Later line, see below.

## Failure plan
n/a — no outbound calls. Audit write failure fails the whole transaction (no change without its audit row). View-audit writes are best-effort in a separate statement and log an error if they fail, so a read never fails because of auditing.

## Observability
Error logs without personal data (ids only). Watch: count of audit write failures (should be 0).

## Trust boundaries and abuse cases
- Boundaries: the API (from M1.3) is the only way in; the data-access layer is the last line before Postgres.
- Abuse: "As a signed-in member I request a `private` record by id" — mitigation: repository returns not-found (not forbidden) for invisible records, so ids can't be probed. "As an admin I edit the audit log to hide a change" — mitigation: trigger blocks UPDATE/DELETE; DB credentials only on the server, admin DB access only via Tailscale.

## Privacy
Not legal advice. Lawful basis is the PM's decision; D8 (household exemption) is still open — the team applies the practical rules either way.

| Field | Purpose | Lawful basis (PM decides) | Retention | Shared with | Notes |
|---|---|---|---|---|---|
| people.display_name | Name owners, insured people, beneficiaries | PM decides — options: household exemption (D8), legitimate interests | Until the person is deleted; out of backups within the backup cycle (≤ 35 days) | none | Required; can be a nickname |
| people.relationship | Help family find the right person | PM decides — as above | As above | none | Optional |
| users.role, users.person_id | Access control | PM decides — as above | Until the account is removed | none | — |
| audit_log rows | Security: who viewed or changed what | PM decides — likely legitimate interests | 2 years, deleted by a nightly worker job | none | Field names only, never values |
| audit_log.ip_prefix | Spot sign-ins from unexpected networks | PM decides — as above | 90 days, then set to null by the same job | none | Truncated, sign-in events only |

- Fields removed: date of birth, email on `people`, full IP address — no documented use.
- DPIA screening: no trigger from this item alone (no special category data yet; health-related policies arrive in M2). Re-screen at M2.
- Children likely: as data subjects yes (family members, beneficiaries); as users no. Keep only name and relationship.
- Automated decisions or profiling: none.
- Special category data: none in this item.
- New vendors / SDKs / transfers: none.
- Private defaults: `family` is the default by PM goal ("everyone sees everything at launch"). `private` is available per record.
- Export, delete, rectify: delete person → blocked while they own records (FK restrict); admin reassigns first. Rectify via edit. Export: JSON export of a person and their records is a plan item in M2 (`M2.6`, added below).
- Record of processing / privacy notice: a one-page household privacy note is needed before family members other than the PM are added (M2).
- Escalated to PM: lawful basis (with D8); audit log retention of 2 years and IP prefix 90 days (lead's proposal, PM may change).

## Migration gate (from M1.1 review, L7)
- A one-shot `migrate` Compose service runs migrations; `web` and `worker` depend on it with `service_completed_successfully`, and the worker no longer migrates at start.
- Health reports the applied schema version against the version the code expects; a mismatch returns 503.
- The migration connection uses a longer `statement_timeout` (e.g. 5 min) and a `lock_timeout` (e.g. 10 s).
- README rollback order: stop worker → roll back → deploy the previous image.
- Timeouts (from M1.1 re-review, N1): on every connection, `statement_timeout` stays below the client `query_timeout` (e.g. 4 s / 5 s) so Postgres cancels first and frees the connection; test: a query longer than `statement_timeout`, then the next query on a 1-connection pool answers at once. The migration connection raises both limits together.

## Rollout and rollback
Migrations run on deploy; rollback = `pnpm db:rollback` for this item's migrations (drops the three tables — no real data yet) and revert the merge.

## Later lines
- Postgres row-level security as a second layer — defence in depth if a raw query slips through — trigger: a third user is added, or any reviewer finding of a query that bypassed the data-access layer — noted 2026-11-21 by lead
