# Status log

Newest entry first. Plans and designs live in their own files; this log records events.

## 2026-11-21 — M1.1 Repo and stack skeleton — QA pass, merged to main

- Changed: QA passed 2/2 plan criteria (13/13 rows, all automated) on a `--no-cache` build in a throwaway project: `pnpm check` 181 pass, `pnpm test:e2e` 35 pass, health 200 / 503 in 5.03 s with Postgres paused, migrations down/up/up, idle RAM ≈ 135 MiB, Postgres not reachable from the host, web on 127.0.0.1 only, read-only app files. Evidence: `docs/qa/M1.md#m11`, `docs/qa/M1/screens/` (7 files), video `qa-artifacts/m1/M1.1-home-then-health.webm` (not committed). Accessibility: pass, limited — no axe scan (axe not in the project). Privacy: pass — no personal data, no secrets in bodies or logs.
- Merged: `git merge --no-ff feat/m1-skeleton` into `main` as d346d26, under the PM's standing approval of 2026-11-21. Plan box M1.1 ticked.
- Lead check on main after merge: `pnpm check` run 6 times — 5 × 181 pass, 1 × "1 failed | 180 passed" (the failing test's name was not captured). Treated as a flaky test: finding F-M1.1-1 (Low), assigned to the M1.2 developer brief (run the check repeatedly, find and fix the flake).
- Lead decisions: add `@axe-core/playwright` as a project dev dependency in M1.3 (sign-in screens) so QA can run axe; a project dependency, not a machine install.
- Gates: developer pass · tester pass · reviewer approve with notes · QA pass · merge done (standing approval; PM to review on return)
- Open findings: F-M1.1-1 flaky test (Low); N1, L6, L7 (Low, in M1.2/M1.3 designs); C1, C2, C5, C6 (cleanup)
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none

## 2026-11-21 — M1.1 Repo and stack skeleton — reviewer re-check: approve with notes, to QA

- Changed: reviewer re-checked the 7 fix commits: L1, L2, L3, L4, L5, L8, C3, C4 fixed. `pnpm check` 181 pass; `pnpm deps:audit` clean. Live: containers have no capabilities, no-new-privileges, read-only app files; health 503 in ~5 s with Postgres paused.
- New: N1 (Low) — client `query_timeout` (5 s) is below server `statement_timeout` (10 s), so a slow query keeps a pooled connection busy after the client gives up. Lead: into the M1.2 design note (migration gate / timeouts). C6 (cleanup) — Next cache folder not writable — Later line with trigger.
- Still open by lead decision: L6 (M1.3), L7 (M1.2), C1, C2, C5.
- Gates: developer pass · tester pass · reviewer approve with notes · QA open · merge waiting (standing approval)
- Open findings: N1, L6, L7 (Low, scheduled in M1.2/M1.3 designs); C1, C2, C5, C6 (cleanup)
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none

## 2026-11-21 — M1.1 Repo and stack skeleton — review fixes done, to reviewer re-check

- Changed: L1, L2, L3+C3, L4, L5, L8 fixed in 7 commits (e098ed0..1f10a76), each with a regression test shown failing on the old code. `pnpm check`: 181 pass. `pnpm test:e2e`: 35/35 on an isolated stack (removed). `pnpm deps:audit`: no known vulnerabilities. Live check: health returns 503 in ~5 s with Postgres paused.
- Developer notes: commit 97319fc alone fails `pnpm secrets` (fixed in ffb7da2; history not rewritten). A timed-out connection returns to the pool and recovers when Postgres answers again.
- Gates: developer pass · tester pass · reviewer re-check open · QA open · merge waiting (standing approval)
- Open findings: none open on this branch (L6, L7 in M1.2/M1.3 designs)
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none

## 2026-11-21 — M1.1 Repo and stack skeleton — reviewer verdict: approve with notes

- Changed: reviewer (Opus, high) reviewed 16 commits. `pnpm check` pass (150 tests). No Critical/High/Medium. 8 Low (L1–L8), 5 cleanup (C1–C5). `pnpm audit --prod`: no known vulnerabilities; 2 moderate dev-only (glob, minimatch via testcontainers).
- Lead decisions on the notes:
  - Fix on this branch before merge: L1 (nested `.env` can reach the web image), L2 (health hangs if Postgres freezes — no client query timeout), L3 (retry logs don't say why: log error code only) with C3 (fold the copied retry block into one helper), L4 (`.env.example` password empty, per project rule), L5 (root-owned app files, `init`, `no-new-privileges`, `cap_drop`, pinned image tags), L8 (`pnpm deps:audit` script).
  - Into later briefs: L6 security headers → M1.3 design note; L7 migration gate (one-shot migrate service, health reports schema version, migration timeouts) → M1.2 design note; C4 design note updated now (health includes `workerHeartbeat`); "schema lint" for money columns → M2 brief.
  - Can wait: C1 (deprecated secretlint preset), C2 (worker shutdown clean-up; with OCR jobs), C5 (known commit history).
- Gates: developer open (fix round) · tester pass · reviewer approve with notes (re-review of fixes pending) · QA open · merge waiting (standing approval)
- Open findings: 6 Low being fixed; 2 Low moved to M1.2/M1.3 briefs
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none

## 2026-11-21 — M1.1 Repo and stack skeleton — fixes done, to reviewer

- Changed: T1–T4 fixed, one commit each with its test (2ef1025, 903d1b1, ab198f2, 0ed5708). `pnpm check`: 150 pass, 0 expected-fail markers. `pnpm test:e2e`: 31/31 on an isolated stack (removed afterwards). Developer adjusted two tester tests to match the explicit 405 handlers (stricter, not weaker).
- Developer notes: `e2e/` and the root config files are still outside `pnpm typecheck` (no type errors today); `/api/health` outside `/api/v1` keeps Next's HTML 404 (out of scope of the T3 decision).
- Gates: developer pass · tester pass (findings fixed) · reviewer open · QA open · merge waiting (standing approval)
- Open findings: none
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none

## 2026-11-21 — M1.1 Repo and stack skeleton — tester report, back to developer

- Changed: tester added 101 tests (78 Vitest, 23 Playwright) in 4 commits (ec646d7..237b913); no production code changed. `pnpm check`: 115 pass, 2 expected-fail. `pnpm test:e2e` (isolated stack): 25 pass incl. 1 expected-fail. Mutation checks done for each new test group.
- Findings:
  - T1 (medium): `DATABASE_URL` with a bad port or no host passes config validation, then fails later and retries for 60 s instead of failing fast.
  - T2 (low): 405 on `/api/v1/health` has no `Allow` header.
  - T3 (low, lead decision): unknown `/api/v1/*` paths return an HTML 404. Lead decides: every `/api/v1/*` response, errors included, is JSON (ADR 0003, API-first).
  - T4 (low): the root `test/` folder isn't covered by `pnpm typecheck`.
- Lead decision on expected-fail markers: allowed only as bug repros until the fix lands; the fix removes them. None may remain at merge.
- Escalation: the item failed a test round, so the developer is dispatched again one effort level higher (Opus, high).
- Gates: developer open (fixes) · tester pass with findings · reviewer open · QA open · merge waiting (standing approval)
- Open findings: 1 medium, 3 low
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none

## 2026-11-21 — M1.1 Repo and stack skeleton — developer hand-off

- Changed: branch `feat/m1-skeleton`, 8 commits. pnpm workspace (`apps/web` Next.js 16, `apps/worker` pg-boss heartbeat, `packages/db` Kysely up/down migrations), Compose with postgres 18 (no host port), web on 127.0.0.1 only. `GET /api/v1/health` 200/503. `pnpm check` = eslint + tsc + vitest + secretlint: 39 tests pass. `pnpm test:e2e`: 2 pass. Idle RAM ≈ 130–150 MiB (budget 2 GB).
- Check command set: `pnpm check` (needs Docker running for DB tests).
- Developer notes: commits 1–5 don't pass `pnpm check` on their own (fixed from 66c117b; history not rewritten, to avoid touching the lead's uncommitted docs); TypeScript 6.0.3 and Playwright 1.64.0 pinned for compatibility (no browser installed); `.env` must be created from `.env.example` before `docker compose up`.
- Gates: developer pass · tester open · reviewer open · QA open · merge waiting (standing approval)
- Open findings: none
- Decisions: none
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead none

## 2026-11-21 — M1.2 + M1.3 — designed under standing approval

- Changed: design notes `docs/design/m1-2-data-model.md` and `docs/design/m1-3-sign-in.md`, UI spec `docs/ui/m1-3-sign-in.md`, deck `docs/slides/m1-data-and-sign-in.html` (9 slides). Plan: added M2.6 (export + household privacy note) and 4 Later lines (row-level security, passkeys, password reset by email, admin user screen).
- Size: both large — data model + personal data (M1.2); auth + new trust boundary (M1.3).
- Gates: not started — M1.2 is briefed after M1.1 merges (it builds on `packages/db`).
- Decisions: deck not PM-approved; proceeding under the standing approval logged above. For PM on return: lawful basis (with D8); audit log retention 2 years and IP prefix 90 days (lead proposal); Better Auth (recommendation).
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead: developer shares this working tree — told not to stage docs/ (lead-owned).

## 2026-11-21 — Standing approval while PM is away

- PM said: "I am away from my laptop, you can start the work without any of my approvals" (2026-11-21).
- Lead applies it as: the lead may approve **local** merges (`git merge --no-ff` into `main`) of items that pass every gate (developer, tester, reviewer, QA), and may brief developers for large items after writing the design note and deck, without waiting for the PM. Each such merge and deck is logged here for the PM to review on return.
- Not covered, and not done while the PM is away: skipping or weakening any gate; accepting any risk or `skipped` finding (a Block stays a Block); deciding D6 (default MWK rate), D8 (household exemption), D11 (who has emergency access) or any lawful basis; pushing, creating remote repos, tagging, publishing, emailing; anything needing the PM's accounts or hands (Cloudflare, domain, Tailscale, backup drive or bucket, real email); host changes on the "ask first" list (global installs, sudo, deleting outside the project, killing processes the team didn't start).
- Expiry/review: until the PM's next message in this session.
- Work order while away: M1.1 → M1.2 data model → M1.3 sign-in with 2FA. M1.4 (remote access) and M1.5 (backups) only as far as the parts that don't need the PM's accounts or hardware.

## 2026-11-21 — M1.1 Repo and stack skeleton — developer briefed

- Changed: initial commit on `main` (ae3f8e3, docs only). M1 design note `docs/design/m1-foundation.md` written; its M1.1 section rests on the PM-approved MVP deck (Option A). Developer briefed on branch `feat/m1-skeleton`.
- Size: large — new data store (Postgres), spans web app, worker and db package. Developer started on Opus: spans several modules and sets the public API shape.
- Gates: developer open · tester open · reviewer open · QA open · PM merge waiting
- Open findings: none
- Decisions: none new
- Blockers: Developer none yet · Tester none · Reviewer none · QA none · Marketer none · Lead: D8 (before M2), D11 name (before M1.5), D6 default rate (before M3.2) still with PM.

## 2026-11-21 — MVP plan — PM approval and decisions

- Changed: PM approved the MVP deck (`docs/slides/mvp-plan.html`) and the lead's recommendations. Added D13 (frontend) to the plan and deck. ADRs 0001–0003 written. Plan decisions table updated.
- PM said: "Approved go with recommendation" (2026-11-21). Applied as follows — only where the lead gave a concrete recommendation:
  - D1 Cloudflare sees traffic in transit: **accepted**; goal reworded to "no financial data is stored outside the home lab, except encrypted backups".
  - D2 Emails: **link only, no values**.
  - D3 Database/auth: **plain Postgres + auth library** (not self-hosted Supabase). ADR 0001.
  - D4 File storage: **encrypted mounted volume**.
  - D5 Liabilities: **yes, table now**.
  - D6 MWK rate: **store both official and market rates**. The default rate for totals is **still open** (the recommendation left it to the PM). Blocks M3.2 only.
  - D7 Automated property comparables: **Later**.
  - D8 Household exemption: **still open** (the recommendation was "your call"). Team designs to the practical privacy rules either way. Needed before M2.
  - D9 MVP scope: **approved as in the deck**.
  - D10 Backend: **TypeScript only**. ADR 0002.
  - D11 Emergency access: **one named person + printed access sheet**. The person's name is **still needed** before M1.5.
  - D12 Privacy regions: **add Malawi**, check what applies. Needed before M2.
  - D13 Frontend: **Next.js web app / PWA, API-first; native mobile app Later**. ADR 0003.
- Risk accepted by PM (2026-11-21): accepted: Cloudflare can see app traffic in transit (TLS ends at Cloudflare) — scope: remote access for the whole app (M1.4 onwards) — expiry/review: none — PM said: "Approved go with recommendation"
- Gates: n/a — planning. M1.1 briefing next.
- Open findings: none new.
- Decisions: as above.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead: D6 default rate (M3.2), D8 (M2), D11 name (M1.5) still needed from PM — none block M1.1.

## 2026-11-21 — MVP plan — project setup, deck waiting for PM

- Changed: git repo started on `main` (nothing committed yet). Added `CLAUDE.md` with Team setup (phase MVP, check command not set), `.gitignore` (ignores `qa-artifacts/` and `.env*`), `docs/PLAN.md` (6 milestones, M1 acceptance criteria, 12 open decisions, 7 Later lines with triggers), deck `docs/slides/mvp-plan.html` (9 slides). Added D12 (Malawi privacy region) to `docs/design/00-design-doc-review.md`.
- Gates: n/a — planning only, no code yet. Developer, tester, reviewer and QA start at M1.1 after deck approval.
- Open findings: design review — 6 High, 11 Medium, 6 Low (`docs/design/00-design-doc-review.md`).
- Decisions: PM said "Yes, set it up" (to repo, plan and deck setup). No D1–D12 answered yet.
- Blockers: Developer none (not started) · Tester none · Reviewer none · QA none · Marketer none · Lead: waiting for PM deck approval and D1, D3, D5, D9, D10, D11 before briefing M1; check command waits on D3/D10.

## 2026-11-19 — Design doc — review

- Changed: reviewed `Family Asset Vault – Design Doc.md`; findings and decisions D1–D11 in `docs/design/00-design-doc-review.md`.
- Gates: n/a — review of a design doc, no code.
- Open findings: see the review.
- Decisions: none yet.
- Blockers: Developer none · Tester none · Reviewer none · QA none · Marketer none · Lead: waiting for PM decisions.
