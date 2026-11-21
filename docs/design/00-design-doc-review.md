# Design doc review — Family Asset Vault

Date: 2026-11-19 — Reviewer: lead — Source: `Family Asset Vault – Design Doc.md` — Status: PM approved the recommendations 2026-11-21 (see `docs/status.md`); D6 default, D8 and the D11 name still open

Verdict: **good direction, not ready to plan from yet.** The goals are clear and the safety instincts are right (review-before-save, no auto-trades, admin on Tailscale only, printed summary). Before a milestone plan, five things need fixing: one goal the design contradicts, a RAM budget that doesn't fit, data-model gaps that are expensive to change later, milestones that miss half the features, and an MVP scope that is too wide for one mini PC and one family.

Severity: **High** = blocks planning or is costly to reverse · **Medium** = fix in the design before that milestone · **Low** = tidy-up.

---

## 1. Contradictions

| # | Sev | Finding | Recommendation |
|---|---|---|---|
| C1 | High | Goal: "no financial data leaves the network except broker API calls". But: (a) Cloudflare Tunnel terminates TLS at Cloudflare, so Cloudflare can see every page and upload; (b) the monthly report emails values through a third-party SMTP provider (Resend / Brevo / Gmail); (c) SearXNG forwards property-area queries to Google/Bing etc.; (d) the offsite backup bucket. | Rewrite the goal as what is true: "no financial data is **stored** outside the home lab, except encrypted backups; Cloudflare and the email provider see data in transit." Then the PM decides if that is acceptable (see D1, D2). |
| C2 | Medium | 2FA is "recommended" in §5 but required in §8. | Make 2FA mandatory for every account. It holds deeds and policy numbers. |
| C3 | Medium | `valuations.source` is `manual / broker_api / document / estimate`, but §7.9 stores `professional` and agent opinions. | Add `professional` and `agent` to the source list now. |
| C4 | Low | "Permissions can be switched on later without migrations" — adding the `permissions` table is itself a migration. | Reword: "without changing existing tables". The real promise is that every query already goes through a visibility check. |
| C5 | Low | Both MinIO and self-hosted Supabase are listed. Supabase already ships a Storage service. | Pick one file store, not both (see D4). |

## 2. Hosting fit (16 GB mini PC, no GPU)

| # | Sev | Finding | Recommendation |
|---|---|---|---|
| H1 | High | The app container gets 3–4 GB, but has to hold: self-hosted Supabase (about 10 containers: Postgres, auth, REST, realtime, storage, gateway, studio, analytics…), Next.js, a job worker, OCR (PaddleOCR is heavy), MinIO and SearXNG (not budgeted at all). This will not fit; check Supabase's current self-host minimum before deciding. | Option A (recommended): plain Postgres + an auth library in the Next.js app (Auth.js / Better Auth with TOTP), visibility enforced in one server-side data layer, files on an encrypted mounted volume. Roughly 1.5–2 GB. Option B: keep Supabase, trim unused services, give the app VM 6 GB and accept a smaller LLM. This reopens a decision the doc marks as "Decided" — PM call (D3). |
| H2 | Medium | CPU-only 3–8B models are slow: a few tokens a second on a typical mini PC, and a chatbot answer with 2–3 tool calls can take 30 s to minutes. Tool calling on small models is also unreliable. | Fine for background jobs (extraction, monthly report). For the chatbot, set expectations, stream answers and test with real questions before building it. Benchmark is already an open question — make it an early spike with a pass mark (e.g. "8/10 test questions answered correctly in < 30 s"). |
| H3 | Medium | Backups: no restore test, no note on keeping Postgres and files consistent, and encryption keys live on the same box. | Monthly automated restore test into a throwaway container; snapshot DB and files in the same job; keep the backup key off the server (password manager + printed copy with the originals). |
| H4 | Low | Not covered: domain name, health check / alert when the box is down, how updates are applied (Ollama, Postgres, OS), power (UPS). | Add a short "operations" section. Basic health check + alert is MVP; the rest can be Later lines. |

## 3. Data model (expensive to change later)

| # | Sev | Finding | Recommendation |
|---|---|---|---|
| M1 | High | **Owners are users.** `owner_id` points to a login, but assets and policies are owned by family members who may never log in (parents, children), are often joint, and sometimes split by share. `insured_people` and `beneficiaries` are free text. | Add a `people` table (family members, login optional) and an `asset_owners` link with a share %. Users link to a person. Policies link insured people and beneficiaries to `people`. |
| M2 | High | **No liabilities.** "Net worth" needs mortgages and loans; without them the dashboard shows gross assets. | PM decides (D5). If yes, add a `liabilities` table now even if the UI comes later. |
| M3 | Medium | **Cash and dividends have nowhere to go.** Trading 212 sync pulls account summary (cash) and dividends, but there is no cash asset type or dividends table. Also one API key per account, so several family accounts = several keys. | Add asset types `cash` / `brokerage_account`, a `dividends` table and a `broker_connections` table (one row per account, key reference not key). |
| M4 | Medium | **Documents link to "asset / policy" polymorphically**, so the database can't enforce the link. | Use two nullable foreign keys with a check that exactly one is set, or a link table. |
| M5 | Medium | **Missing tables the features need:** `audit_log` (§8), `comparables` and `agent_opinions` (§7.9), `notification_prefs` and `reminders` (§7.8), `sync_runs` (failed-sync emails), `chat_messages` (if kept). | Add to the initial model so later milestones extend rather than reshape it. |
| M6 | Medium | **Which MWK rate?** Official and market rates can differ a lot; the choice changes every USD total. | PM decides the default (D6). Store both, snapshot records which rate source it used. |
| M7 | Low | Money must be `numeric`, never float (MWK amounts are large). Store FX as one direction only (e.g. `1 <quote> = rate USD`). Per-asset rows in each snapshot, not only totals, so charts can be re-cut later. | Write into the schema rules. |

## 4. Features

| # | Sev | Finding | Recommendation |
|---|---|---|---|
| F1 | High | **Property estimates (§7.9) are the riskiest, least certain feature.** Scraping listing sites raises terms-of-use and legal questions, small CPU models misread prices from search snippets, and Malawi has little data to scrape. | MVP: manual valuations, the "add a comparable" form, agent opinions and professional valuations — all user-entered. For UK, apply the open UK House Price Index to the last valuation. Defer automated search/scrape to Later with a trigger. Scraping is a PM decision (D7). |
| F2 | High | **Monthly report written by a small LLM may invent numbers.** | Compute every number in code; the LLM only writes sentences around them, and a check fails the report if a number in the text doesn't match. Or ship a plain template first. |
| F3 | Medium | **Chatbot security.** Tools must run as the asking user (so future per-record permissions still apply), be read-only, and treat document text as untrusted (an uploaded PDF can carry instructions). | Write these three as rules in the chatbot design note. |
| F4 | Medium | **Uploads are untrusted input** (PDFs, phone photos) going into parsers and OCR. | Size/type limits, run extraction in the worker with no network access, strip EXIF location from photos unless the user keeps it. |
| F5 | Medium | **Cloudflare Access with email codes** means an attacker who gets into a family email account gets past the first gate. | Prefer Google sign-in with 2FA for Access, short Access sessions, and app 2FA as the real gate. |
| F6 | Low | Forecasting on short histories (and MWK devaluation) will give wild CAGRs. | Need a minimum history (e.g. 24 months) or user-set rates; show the assumption next to every forecast. |
| F7 | Low | Trading 212 key: confirm it can be created with read-only scopes (and IP restriction if offered) before relying on "read-only". | Check at the start of that milestone. |

## 5. Milestones vs features

Features in the doc with **no milestone**: Cloudflare Tunnel + Access, FX rates, insurance renewal reminders, monthly summary email, property valuation estimates, comparables database, printable emergency export, audit log, PWA.

- FX rates must be in the Dashboard milestone: there is no USD total without them.
- The printable emergency export and audit log are cheap and protect the family — put them early (Core records / Foundation).
- Restore test belongs in Foundation.

## 6. Proposed MVP shape (for the PM to approve or change)

Phase: **MVP**. Build only what the family uses in the first months; everything else is a Later line with a trigger.

1. **Foundation** — repo, Compose, Postgres, auth with mandatory 2FA, Cloudflare Tunnel + Access, Tailscale admin, encrypted backups with a restore test, audit log, health check.
2. **Core records** — people, assets with owners, properties, insurance register, document upload, printable emergency summary.
3. **Dashboard** — manual valuations, FX rates (with override), nightly snapshots, USD net worth and chart.
4. **Trading 212 sync** — positions, cash, dividends; failed-sync alert.
5. **Reminders** — renewal and stale-valuation emails (no values, no policy numbers in the email).
6. **LLM spike, then document ingestion** — model benchmark with a pass mark, then OCR + extraction + review form.

Later (each needs a measurable trigger before it goes into the plan): chatbot, forecasting, monthly LLM report, automated property comparables, per-record permissions, PWA install.

## 7. Privacy screen (short)

Not legal advice. This is a family's own records, so the UK GDPR "purely personal or household activity" exemption may apply — **PM decides** whether to rely on it (D8). Either way, design as if the rules apply: it holds data about people who aren't users (beneficiaries, children, insured people), and health/life policies can reveal health information (special category). Practical rules for the design: minimal fields, private defaults for anything later shared outside the core family, export and delete per person, retention for deleted documents and backups, no personal data in logs or emails.

---

## Decisions for the PM

| # | Decision | Options | Lead recommendation |
|---|---|---|---|
| D1 | Is it OK that Cloudflare sees traffic in transit? | Accept / Tailscale-only for family too (every device needs the Tailscale app) | Accept, and rewrite the goal (C1). Tailscale-only is safer but harder for family. |
| D2 | What may the monthly / reminder emails contain? | Values and changes / only "your report is ready" + link | Link only for MVP; values stay home. |
| D3 | Revisit "self-hosted Supabase"? | Keep Supabase (bigger app VM, smaller LLM) / plain Postgres + auth library | Plain Postgres + auth library (H1). |
| D4 | File storage | Encrypted mounted volume / MinIO / Supabase Storage | Encrypted volume. |
| D5 | Track liabilities (mortgages, loans)? | Yes, now / Later / never ("total assets", not "net worth") | Yes, table now. |
| D6 | Default MWK→USD rate | Official / market / both, user picks | Store both, default to the one you'd use to sell an asset — your call. |
| D7 | Automated property comparables (search / scrape) | MVP / Later / never | Later; manual comparables first. |
| D8 | Rely on the household exemption? | Yes / design to full UK GDPR anyway | Your call; we design to the practical rules either way. |
| D9 | MVP scope | §6 as proposed / change | §6. |
| D10 | Backend language | TypeScript only (Next.js + worker) / Next.js + Python service | TypeScript only; call Tesseract from the worker. Add Python only if extraction quality needs it. |
| D11 | Who besides you can get in if you're unavailable, and how? | Named person + printed access sheet / other | Named person; part of Foundation. |
| D12 | Add Malawi to the privacy regions? Assets, people and documents are in Malawi, which has its own data protection law. | Add Malawi / keep UK + EU only | Add Malawi and check what applies to a family's own records. |
| D13 | Frontend: Next.js web app / PWA, or Flutter for web + mobile | Next.js, API-first, native app later / Flutter now | Next.js, API-first (ADR 0003). |
