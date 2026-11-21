# Status log

Newest entry first. Plans and designs live in their own files; this log records events.

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
