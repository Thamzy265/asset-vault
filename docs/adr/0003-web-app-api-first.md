# 0003. Next.js web app / PWA, API-first; native mobile app later

Date: 2026-11-21

## Status
Accepted (PM, 2026-11-21 — decision D13)

## Context
The PM may want a mobile app. Options were a Next.js web app (responsive, installable as a PWA) or Flutter for web and mobile. Flutter on the web renders to a canvas (weaker autofill, printing and accessibility), still needs a separate backend, and a native app behind Cloudflare Access needs extra client setup. The web app covers camera upload, home-screen install and push reminders.

## Decision
We will build a responsive Next.js web app. All data goes through a versioned JSON API (`/api/v1/...`) with session or token auth, not through page-only server code, so that a native client (Flutter or React Native) can be added later without changing the backend.

## Consequences
- Easier: one codebase, works on any phone by opening a link, printing and accessibility come from plain HTML.
- Harder: we keep the API contract clean even though only the web app uses it today.
- Revisit: native mobile app is a Later line with a trigger in `docs/PLAN.md`.
