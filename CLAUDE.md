# Family Asset Vault

Self-hosted web app for a family's assets (plots, houses, shares), insurance policies and their documents, with USD net worth, history and later forecasts. Runs on a home-lab mini PC (Proxmox, 16 GB RAM, no GPU).

- Original design doc: `Family Asset Vault – Design Doc.md` (source input, not edited by the team)
- Design review and open decisions: `docs/design/00-design-doc-review.md`
- Plan: `docs/PLAN.md` · Status log: `docs/status.md`

## Team setup

- Team: my-tech-team (lead, developer, tester, reviewer, QA, marketer). The PM is the project owner.
- Project phase: `MVP`
- Plan: `docs/PLAN.md` (with a "Later" section)
- Status log: `docs/status.md` (newest entry first)
- QA evidence: `docs/qa/<milestone>.md`, screenshots `docs/qa/<milestone>/screens/`
- Videos and traces: `qa-artifacts/` (git-ignored, never committed)
- Design notes `docs/design/` · ADRs `docs/adr/` · UI specs `docs/ui/` · Slides `docs/slides/` · Marketing `docs/marketing/`
- End-to-end tools: Playwright (web). Maestro n/a — no native mobile app; the phone experience is the responsive web app.
- Stack: TypeScript only — Next.js (App Router) web app + JSON API `/api/v1`, TypeScript worker, PostgreSQL, Docker Compose (ADRs 0001–0003).
- Check command: `pnpm check` (lint + type check + unit tests) — set by M1.1; the developer confirms the exact script in the M1.1 hand-off.
- Privacy regions: UK + EU + Malawi (D12, 2026-11-21).
- Approved tools: none
- Agent models: defaults (no overrides)

## Project rules

- Money is stored as `numeric` in its original currency; totals are converted to USD with the dated FX rate.
- No secrets in the repo. Keys live in env / secret store; `.env.example` holds names only.
- Every read and write goes through a server-side visibility check, even while everyone sees everything.
- The LLM never saves data on its own: every extracted value is confirmed by a person.
- Emails never contain documents, addresses or policy numbers.
- Admin tools (Proxmox, database, servers) are reachable over Tailscale only.
