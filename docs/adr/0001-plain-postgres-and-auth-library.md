# 0001. Plain Postgres and an in-app auth library instead of self-hosted Supabase

Date: 2026-11-21

## Status
Accepted (PM, 2026-11-21 — decision D3)

## Context
The design doc chose self-hosted Supabase for auth and row-level security. The app runs on a 16 GB mini PC that also hosts a CPU-only LLM (8–10 GB). Self-hosted Supabase is about 10 containers and does not fit the 3–4 GB app slot alongside Next.js, a worker and OCR. Two users at launch.

## Decision
We will run a single PostgreSQL instance, and handle sign-in and mandatory TOTP 2FA with an auth library inside the Next.js app. Visibility is enforced in one server-side data-access layer that every query goes through; Postgres row-level security can be added later as a second layer.

## Consequences
- Easier: fits the RAM budget (about 1.5–2 GB for app, worker and DB); fewer services to upgrade and back up; one backup of one database.
- Harder: we own the visibility layer and must test it on every endpoint; no Supabase Studio or auto-generated REST API.
- Given up: Supabase Storage and Realtime (not needed; files go on an encrypted volume, decision D4).
