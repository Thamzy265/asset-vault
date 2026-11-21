# M1.3 Sign-in with mandatory 2FA — design note

Date: 2026-11-21 — Size: large — auth, new trust boundary (every API request), personal data (email, password hash, 2FA secret) — Phase: MVP — Status: written while PM away; briefed under the PM's standing approval (`docs/status.md`, 2026-11-21) — PM reviews on return

## Context
Nothing in the app may be reachable without a signed-in user who has 2FA enrolled (review finding C2: 2FA mandatory). Cloudflare Access (M1.4) is an outer gate; this is the real gate. Builds on M1.2 (`users`, `people`, `audit_log`, data-access layer). UI spec: `docs/ui/m1-3-sign-in.md`.

## Requirements and non-goals
- Functional:
  - Email + password sign-in, then a TOTP code (or a single-use backup code).
  - **No public sign-up.** Accounts are created by an admin with a CLI command on the server: `pnpm user:create --email … --name … --role admin|member` prints a one-time setup link valid for 24 h. (No email yet — admin passes the link to the person.)
  - The setup link leads to: set password → enrol TOTP (QR + manual key, confirm one code) → save 10 backup codes → signed in.
  - A user without 2FA enrolled can't reach anything but the enrolment screens.
  - Sign out; sign out of all devices.
  - `GET /api/v1/me` → user id, name, role, person id.
  - The data layer's `Viewer` is built only from a verified session with 2FA passed (M1.2 decision 7); no other code path constructs one.
  - Every `/api/v1/*` route except `/health` requires a session with 2FA passed; enforced by one middleware plus a per-route test.
  - Auth events written to `audit_log` (sign_in, sign_in_failed, sign_out, 2fa_enrolled, 2fa_failed, password_changed, backup_code_used). `ip_prefix` is recorded on sign_in, sign_in_failed, 2fa_failed and backup_code_used (the events that show where a sign-in attempt came from); M1.2 already allows these four (lead decision after the M1.2 tester round).
  - Server command `pnpm user:deactivate --email …` (see Privacy).
  - Structured request logs for `/api/v1` (request id, route, status, duration; no personal data) — the Later trigger "first /api/v1 endpoint other than health" fires with `/me`.
- Non-functional: passwords hashed with a memory-hard algorithm (scrypt or argon2id, via the library); WCAG 2.2 AA screens; works at 320 px.
- Non-goals: passkeys, password reset by email (no email yet — admin issues a new setup link), admin user-management screen, Cloudflare Access.

## Top 3 qualities
| Quality | Target | How we check it |
|---|---|---|
| Security | No data without session + 2FA; brute force impractical | Test: every `/api/v1` route returns 401 without session and 403 `2fa_required` without 2FA; rate-limit tests |
| Accessibility | Sign-in usable with keyboard, screen reader and password managers (WCAG 3.3.8: paste allowed) | Playwright + axe (`@axe-core/playwright` added as a dev dependency in this item); manual keyboard path |
| Recoverability | A user who loses their phone can still get in | Backup-code test; admin can re-issue a setup link that resets 2FA |

## Estimate
Trivially small: < 10 users, a few sign-ins a day.

## Data
Auth tables owned by the auth library (Better Auth: `user`, `session`, `account`, `verification`, `two_factor`), created by **our own Kysely up/down migrations** matching the library's schema, not by the library's CLI (keeps migrations reversible). `users` from M1.2 becomes the library's `user` table (or a 1:1 extension of it — developer picks the cleaner fit and explains in the hand-off). Setup tokens: hashed, single-use, 24 h expiry. Backup codes stored hashed. TOTP secret encrypted at rest with a key from env (`AUTH_ENCRYPTION_KEY`).

## Carried from the M1.2 review (must be in the M1.3 build)
- (a) `Viewer` becomes a branded type that only the session module can create; app code can't build `{ role: "admin" }` by hand. Test it.
- (b) Every request rejects a deactivated user (not only sign-in): the session check reads `users.deactivated_at`.
- (c) Deactivation clears `users.person_id`, so an erasure request for the linked person isn't blocked for 2 years.
- (d) Any new table that references `users` uses ON DELETE CASCADE or SET NULL (auth tables cascade), so the nightly retention never fails on a deactivated user; test retention with every auth table populated.
- (f) Fail safe in `packages/db/src/handle.ts`: use the `globalThis` client map only when NODE_ENV is "development" or "test" (anything else, including unset, keeps it module-private). Optional reviewer suggestion, taken.
- (g) From M1.2 QA: revoke DELETE on `users` from `vault_app` (decision 8: users are deactivated, not deleted; only the SECURITY DEFINER retention function deletes them). Auth tables get grants decided the same way, recorded in the grant-matrix test.
- (h) From M1.2 QA: README fixes — `vault_app` "owns nothing outside the `pgboss` job-queue schema"; the rollback step shows `applied: null` after rolling back 0004 (grants removed), not "one step behind"; a note that Postgres's own server log can keep row values from refused inserts, so it is treated as personal data (not shipped anywhere, rotated with the container).
- (e) The API error handler never logs a Postgres `detail`, row values, emails, codes or tokens; errors are logged as code + route + request id only.

## Options
### A: Better Auth (email/password + two-factor plugin), Kysely adapter
Mature 2FA (TOTP, backup codes), uses Kysely internally (same as our DB layer), session cookies, origin checks for CSRF. Risk: library schema must be mirrored in our migrations.
### B: Hand-rolled (argon2 + otplib + our own sessions)
Full control, fewer dependencies; we own every security detail (session fixation, timing, CSRF) — more to get wrong.

## Decision
A. Developer may swap to Auth.js only if Better Auth blocks a requirement, and must say why.

## Failure plan
No outbound calls (no email, no breached-password API). Rate limits: 5 failed passwords per account per 15 min and 20 per IP prefix per 15 min → 429 with retry time; 5 failed TOTP codes → session challenge discarded, start again. Clock drift: accept ±1 TOTP step.

## Observability
Auth events in `audit_log`; error logs never include emails, passwords, codes or tokens. Watch: failed sign-ins per day.

## Trust boundaries and abuse cases
- Boundaries: browser → `/api/auth/*` and `/api/v1/*`; the setup link (anyone holding it can claim the account for 24 h); the server CLI (Tailscale-only admin).
- Abuse cases:
  - "As an attacker I guess passwords" — rate limits + 2FA + 12-char minimum + local common-password list.
  - "As an attacker with a stolen password I sign in" — TOTP required.
  - "As an attacker I reuse an intercepted setup link" — single-use, 24 h, hashed; re-issuing revokes the old one.
  - "As an attacker I steal a session cookie" — HttpOnly, Secure, SameSite=Lax; 24 h idle and 7 day absolute expiry; sign out of all devices.
  - "As an attacker I hit an API route someone forgot to protect" — default-deny middleware + a test that lists every route and checks it.
  - "As an attacker I frame the sign-in page (clickjacking) or inject script" — security headers on every response (from M1.1 review, L6): Content-Security-Policy (no inline script; `frame-ancestors 'none'`), X-Content-Type-Options `nosniff`, Referrer-Policy `same-origin`, with an e2e test.
  - "As an attacker I enumerate emails" — same error and similar timing for unknown email and wrong password.

## Privacy
Not legal advice. Lawful basis: PM decides (with D8).

| Field | Purpose | Lawful basis (PM decides) | Retention | Shared with | Notes |
|---|---|---|---|---|---|
| user.email | Sign-in identifier; later reminders | PM decides | Until account removed | none | Required |
| user.name | Shown in the app | PM decides | Until account removed | none | Copied from person |
| password hash | Sign-in | PM decides | Until changed or account removed | none | Memory-hard hash |
| TOTP secret, backup codes | 2FA | PM decides | Until re-enrolled or account removed | none | Encrypted / hashed |
| sessions (IP, user agent) | Keep users signed in; sign out everywhere | PM decides | Deleted at expiry (≤ 7 days) by the worker | none | Library stores these; we keep them only for session life |

- Fields removed: profile image (library field left null), full IP in audit log (prefix only, M1.2).
- DPIA screening: none from this item.
- Children likely: not as users.
- Automated decisions: none. Special category: none. New vendors: none (Better Auth is a local library, no service).
- Private defaults: n/a — no sharing.
- Export, delete, rectify: removing a user **deactivates** it rather than hard-deleting the row, because the append-only audit log references the user for up to 2 years (raised in the M1.2 hand-off). Deactivation deletes the password hash, the TOTP secret, backup codes, sessions and setup tokens; replaces the email with a non-identifying placeholder; sets `deactivated_at`; and blocks sign-in. The user row (id, role) stays until its last audit row expires; the nightly retention job then deletes it. The linked person and audit rows stay (actor shown as "removed user").
- Escalated to PM: lawful basis (with D8).

## Rollout and rollback
Migrations then code. Rollback: `down` migrations for auth tables (no real users yet) and revert the merge. First real admin account is created by the PM on the server after merge.

## Later lines
- Passkeys (WebAuthn) — easier and phishing-resistant — trigger: any family member fails 2FA sign-in 3 times in a month, or the PM asks — noted 2026-11-21 by lead
- Password reset by email — needs email (M5) — trigger: M5 reminders are live and a user needs a reset — noted 2026-11-21 by lead
- Admin user-management screen — CLI is enough for 2 users — trigger: a third user is added — noted 2026-11-21 by lead
