# Family Asset Vault — Plan

Phase: **MVP** · Status: **approved by PM 2026-11-21** (`docs/slides/mvp-plan.html`, decisions in `docs/status.md`)
Source: `Family Asset Vault – Design Doc.md`, reviewed in `docs/design/00-design-doc-review.md`.

A box is ticked only when every gate (developer, tester, reviewer, QA) has passed, the PM approved the merge and it is on `main`.

## Decisions (PM)

Recorded word for word in `docs/status.md` (2026-11-21, PM said: "Approved go with recommendation"). Options: `docs/design/00-design-doc-review.md#decisions-for-the-pm`.

| # | Decision | Outcome | Blocks |
|---|---|---|---|
| D1 | Cloudflare sees traffic in transit | Accepted (risk recorded); goal reworded | — |
| D2 | Email contents | Link only, no values | — |
| D3 | Database and auth | Plain Postgres + auth library (ADR 0001) | — |
| D4 | File storage | Encrypted mounted volume | — |
| D5 | Liabilities | Yes, table now | — |
| D6 | MWK→USD rate | Store official and market. **Open: default rate for totals** | M3.2 |
| D7 | Automated property comparables | Later | — |
| D8 | Household exemption | **Open** — design to the practical rules meanwhile | M2 |
| D9 | MVP scope | Approved | — |
| D10 | Backend language | TypeScript only (ADR 0002) | — |
| D11 | Emergency access | One named person + printed sheet. **Open: who** | M1.5 |
| D12 | Privacy regions | Add Malawi; check what applies | M2 |
| D13 | Frontend | Next.js web app / PWA, API-first; native app Later (ADR 0003) | — |

## Milestones

Acceptance criteria are drafted for M1 now; later milestones get theirs (and their own deck if large) when they start, using what M1 teaches.

### M1 — Foundation (large: new data store, trust boundaries, auth)

- [x] **M1.1 Repo and stack skeleton** — app and worker run with one command; check command recorded in Team setup.
  - AC: `docker compose up` starts app, database and worker on a clean machine; health endpoint returns OK.
  - AC: check command (lint + type check + tests) passes in CI-equivalent local run.
- [x] **M1.2 Data model foundation** — people, users, roles, visibility, audit log; reversible migrations.
  - AC: every business table (records the family owns, e.g. people) has `owner`, `visibility` and timestamps; system tables (users, audit_log, _meta) have timestamps; migrations go up and down cleanly.
  - AC: every read/write goes through one server-side visibility check (tested).
- [x] **M1.3 Sign-in with mandatory 2FA** — two family accounts, admin and member roles.
  - AC: no page or API returns data without a signed-in user with 2FA enrolled.
  - AC: sign-in, sign-out, failed sign-in and 2FA enrolment are written to the audit log.
- [ ] **M1.4 Remote access** — Cloudflare Tunnel + Access for the app; Tailscale-only for admin.
  - AC: from outside the home network, only the web app is reachable, and only after Access sign-in.
  - AC: Proxmox, database and server admin are unreachable through the tunnel.
  - AC: `AUTH_TRUSTED_IP_HEADER=cf-connecting-ip` is set and only Cloudflare can reach the app, so sign-in rate limits are per client, not shared (from M1.3).
- [ ] **M1.5 Backups and restore test** — nightly encrypted backup of DB + files; monthly automated restore test. *(needs the D11 name)*
  - AC: a restore into a throwaway container passes a data check; failure raises an alert.
  - AC: the backup key is not stored only on the server.
- [ ] **M1.6 Health check and alert** — the PM is told when the app or nightly jobs are down.

### M2 — Core records (large: personal data)

- [ ] M2.1 People, assets and ownership shares, and liabilities
- [ ] M2.2 Properties (address, location, size, title status and price drivers)
- [ ] M2.3 Insurance register (insured people and beneficiaries linked to people)
- [ ] M2.4 Document upload linked to an asset or policy (size/type limits, EXIF location stripped)
- [ ] M2.5 Printable emergency summary (assets, policies, contacts)
- [ ] M2.6 Export a person and their records as JSON; household privacy note

### M3 — Dashboard

- [ ] M3.1 Manual, agent and professional valuations
- [ ] M3.2 Daily FX rates (official and market) with source and manual override *(needs D6 default)*
- [ ] M3.3 Nightly portfolio snapshots (per-asset rows, USD totals)
- [ ] M3.4 Net worth dashboard and history chart

### M4 — Trading 212 sync

- [ ] M4.1 Broker connections (one per account; key in secret store, read-only scope confirmed)
- [ ] M4.2 Nightly sync of positions, cash and dividends with timeouts and bounded retries
- [ ] M4.3 Failed-sync alert

### M5 — Reminders (emails carry a link only, no values)

- [ ] M5.1 Insurance renewal reminders
- [ ] M5.2 Stale-valuation reminders (e.g. no property update in 12 months)
- [ ] M5.3 Per-user email opt in / out

### M6 — Local LLM and document ingestion

- [ ] M6.1 Model benchmark spike on the mini PC, with a pass mark agreed with the PM
- [ ] M6.2 Text extraction (PDF parser, OCR fallback) in a network-isolated worker
- [ ] M6.3 LLM field extraction + review form; nothing saved without confirmation

## Later

- Chatbot with read-only tool calls — small CPU models are slow and unreliable at tool calls — trigger: M6.1 benchmark answers ≥ 8 of 10 test questions correctly in < 30 s — noted 2026-11-21 by lead
- Forecasting (CAGR scenarios) — short histories give misleading growth rates — trigger: ≥ 24 months of snapshots for at least one asset class — noted 2026-11-21 by lead
- LLM-written monthly summary — risk of invented numbers; needs a number-check — trigger: M6.1 benchmark passes and reminders (M5) have run for ≥ 3 months — noted 2026-11-21 by lead
- Automated property comparables (SearXNG search + LLM extraction) — legal/terms questions and poor Malawi data — trigger: PM decision D7 = yes and ≥ 30 manual comparables entered per area — noted 2026-11-21 by lead
- UK House Price Index adjustment for UK properties — useful but not needed for first totals — trigger: any UK property without a valuation in the last 12 months — noted 2026-11-21 by lead
- Per-record permissions UI — everyone sees everything at launch — trigger: a third family account is added, or the PM asks to hide any record — noted 2026-11-21 by lead
- PWA install — the responsive site works in the phone browser — trigger: ≥ 2 family members use the app on a phone weekly for a month — noted 2026-11-21 by lead
- Native mobile app (Flutter or React Native, as a client of the same API) — the web app/PWA covers camera upload, home-screen install and reminders — trigger: a family member reports something the web app can't do on their phone twice in one month — noted 2026-11-21 by lead
- Python extraction worker (pdfplumber / PaddleOCR) — TypeScript + Tesseract may be enough — trigger: in M6.1, Tesseract + LLM read fewer than 8 of 10 sample statements correctly — noted 2026-11-21 by lead
- Postgres row-level security as a second layer — defence in depth — trigger: a third user is added, or a reviewer finds a query that bypassed the data-access layer — noted 2026-11-21 by lead
- Passkeys (WebAuthn) — easier, phishing-resistant sign-in — trigger: a family member fails 2FA sign-in 3 times in a month, or the PM asks — noted 2026-11-21 by lead
- Password reset by email — needs email (M5) — trigger: M5 reminders are live and a user needs a reset — noted 2026-11-21 by lead
- Admin user-management screen — the server command is enough for 2 users — trigger: a third user is added — noted 2026-11-21 by lead
- Git-history secret scan (e.g. gitleaks) — secretlint scans only the working tree — trigger: the repository is pushed to any remote — noted 2026-11-21 by developer
- Per-service memory limits in Compose — trigger: idle total in `docker stats` > 1.5 GB — noted 2026-11-21 by developer
- Upgrade @playwright/test to latest — needs a newer Chromium download — trigger: PM approves `pnpm exec playwright install chromium` under Approved tools — noted 2026-11-21 by developer
- Upgrade to TypeScript 7 — trigger: a typescript-eslint release whose peer range includes TypeScript 7 — noted 2026-11-21 by developer
- Writable Next.js cache folder in the web image (tmpfs or a chown of `.next/cache` only) — the app files are read-only by design and nothing uses the cache yet — trigger: the first route that uses revalidate/ISR or next/image — noted 2026-11-21 by reviewer
- Index on owner_person_id for each business table — FK restrict checks and owner lookups scan the table — trigger: > 10,000 rows in any business table — noted 2026-11-21 by developer
- Pagination for the people list — returns every visible person — trigger: > 200 rows in people — noted 2026-11-21 by developer
- Scripted upgrade of a database volume created before the M1.2 roles (create vault_migrator/vault_app, hand tables to vault_migrator, recreate the pgboss schema) — no volume holds real data yet, so README says to recreate it — trigger: people rows > 0 on any volume created before migration 0004 — noted 2026-11-21 by developer
- Index on audit_log(at) — retention scans by time — trigger: a retention run takes > 1 s or audit_log > 1,000,000 rows — noted 2026-11-21 by reviewer
- Dedicated least-privilege database role for `pnpm user:*` commands — today they run with vault_app's full rights, more than they need; acceptable while the CLI is Tailscale-only and there are 2 users — trigger: a third user is added — noted 2026-11-21 by developer
- One shared database pool per web process instead of one per Next bundle — three small pools are fine for < 10 users — trigger: Postgres connections from web > 30, or p95 > 500 ms on /api/v1/me — noted 2026-11-21 by developer
- Audit refused sign-in attempts (429) as a summarised row — today only the failures before a lockout are audited, and auditing every refusal would let anyone fill the log — trigger: M1.6 alerts land, or a lockout the PM can't explain — noted 2026-11-22 by lead

