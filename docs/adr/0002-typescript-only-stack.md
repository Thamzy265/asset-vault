# 0002. TypeScript for the whole stack

Date: 2026-11-21

## Status
Accepted (PM, 2026-11-21 — decision D10)

## Context
The frontend is Next.js (TypeScript). Options for the backend and jobs were TypeScript, Python (FastAPI, strong OCR/PDF libraries) or Rust. The workload is a two-user web app with nightly jobs; heavy compute (LLM, OCR) runs in Ollama and Tesseract, not in our code. RAM is shared with the LLM.

## Decision
We will write the web app, API and background worker in TypeScript, with a Postgres-backed job queue (no Redis). Tesseract is called from the worker as an external program. Money is handled as Postgres `numeric` and a decimal library in code, never JavaScript floats.

## Consequences
- Easier: one language, one dependency tree, one check command, shared types between API and UI.
- Harder: PDF table extraction and advanced OCR are weaker than in Python.
- Revisit: a Python extraction worker is a Later line, triggered if the M6.1 extraction test reads fewer than 8 of 10 sample statements correctly.
