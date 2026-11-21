# Family Asset Vault – Design Doc

## 1. Overview

A self-hosted, mobile-friendly web app for tracking a family's investment portfolio and important records: land plots, houses, shares and insurance policies. It stores supporting documents (title deeds, certificates, statements, policies), calculates total portfolio value, charts net worth over time, forecasts future growth, and includes a chatbot powered by a local LLM that can answer questions, give feedback and help ingest documents.

## 2. Goals

- One place for all family assets, documents and insurance details.
- Accessible from phone and computer via the web.
- Fully self-hosted on a home lab; no financial data leaves the network except broker API calls.
- Total portfolio value, historical progress and forecasts.
- Automatic share sync from Trading 212; document ingestion for providers without an API.
- Two family logins at launch, adding individuals as needed: everyone sees everything at launch, with per-record permissions built in for later.

## 3. Non-goals (v1)

- Placing trades or moving money.
- Tax filing or accounting.
- Exposing services directly to the internet (only the web app, via Cloudflare Tunnel).

## 4. Hosting environment

- Mini PC, 16 GB RAM, Proxmox, no dedicated GPU.
- Suggested split:
  - **LLM container/VM:** \~8–10 GB RAM, most CPU cores. Runs Ollama with a small quantised model (3–8B, e.g. Qwen or Llama) with good tool-calling support.
  - **App container:** \~3–4 GB RAM. Runs the web app, Postgres, file storage, OCR and background jobs via Docker Compose.
  - Leave \~2 GB for Proxmox itself.
- Family access via Cloudflare Tunnel behind Cloudflare Access (email code or Google sign-in; needs a domain), then Supabase login with 2FA. Admin access (Proxmox, servers, database) via **Tailscale** only, never exposed through the tunnel. No open ports on the router.
- Nightly backups of Postgres and document storage (Proxmox Backup or restic to an external drive / offsite encrypted bucket).

## 5. Architecture

- **Frontend:** Next.js (App Router), responsive / PWA so it can be installed on phones.
- **Backend:** Next.js API routes or a separate service (e.g. FastAPI if Python is preferred for OCR/LLM work).
- **Database:** PostgreSQL (plain, or self-hosted Supabase for auth + row-level security).
- **File storage:** MinIO (S3-compatible) or a mounted volume.
- **Auth:** Per-person accounts (Supabase Auth, Auth.js or Authentik). 2FA recommended.
- **LLM:** Ollama HTTP API; the app exposes tools the model can call.
- **OCR:** Tesseract or PaddleOCR, plus PDF text extraction (e.g. pdfplumber) for digital PDFs.
- **Jobs/scheduler:** cron or a job queue for nightly Trading 212 sync, valuation snapshots and OCR processing.

## 6. Data model (initial)

Every record carries `owner_id`, `visibility` (default `family`) and timestamps, so permissions can be switched on later without migrations.

- **users** – id, name, email, role (admin/member).
- **assets** – id, type (`plot`, `house`, `share_holding`, `other`), name, description, owner\_id, visibility, currency.
- **properties** (plots & houses) – asset\_id, address, latitude, longitude, plot/title number, size, purchase\_date, purchase\_price.
- **valuations** – id, asset\_id, date, value, source (`manual`, `broker_api`, `document`, `estimate`). Drives history and charts.
- **share\_holdings** – asset\_id, provider (Trading 212, other broker), ticker/company, quantity, average\_price.
- **insurance\_policies** – id, type (life, home, health, car…), provider, policy\_number, insured\_people, beneficiaries, sum\_assured, premium, renewal\_date, contact details, notes.
- **documents** – id, linked record (asset / policy), category (title deed, certificate, statement, policy), file path, uploaded\_by, extracted\_text, extraction\_status.
- **portfolio\_snapshots** – date, total\_value, breakdown by asset type. Written nightly.
- **permissions** (future) – record\_id, user\_id, access level.

### Currencies

Assets are held in Malawian kwacha (MWK), British pounds (GBP) and US dollars (USD). Family totals, charts and forecasts are reported in **USD**.

- Every asset, valuation and policy amount is stored in its original currency.
- **fx\_rates** – date, base\_currency, quote\_currency, rate, source. Fetched daily from an exchange-rate API and kept forever.
- Totals convert with the rate for each snapshot's date, so historical totals stay accurate.
- MWK rates can differ between official and market sources; record the source and allow a manual override.

## 7. Key features

### 7.1 Assets & documents

Add and edit plots, houses and holdings; attach deeds, certificates and photos; store location with a map view.

### 7.2 Insurance register

All policies in one list: who's covered, where it's held, policy numbers and claim contacts, so any family member can find them in an emergency. Renewal reminders.

### 7.3 Portfolio dashboard

Total family net worth, breakdown by asset type, and a line chart of value over time from `portfolio_snapshots` and `valuations`.

### 7.4 Forecasting

Project future value per asset class using historical growth rates (CAGR), with cautious, expected and optimistic scenarios. Users can override assumptions.

### 7.5 Trading 212 integration

- Use the official public API (Invest and ISA accounts only).
- Read-only API key, stored encrypted / in secrets.
- Nightly sync of positions, account summary and dividends; respect rate limits.
- Each sync writes valuations and feeds the snapshot.

### 7.6 Document ingestion (non-API providers)

1. Upload PDF or phone photo.
2. Extract text (PDF parser, falling back to OCR).
3. Local LLM extracts structured fields (company, quantity, value, date) as JSON.
4. User reviews and confirms in a form before saving. Never auto-save, as small models can misread numbers.

### 7.7 Chatbot

- Runs on the local Ollama model.
- Tool calls into the app (e.g. `get_portfolio_total`, `list_assets`, `get_valuation_history`, `find_policy`, `search_documents`) rather than dumping the whole database into the prompt.
- Answers questions like "What's our total property value?" or "Where is Dad's life insurance held?"
- Gives feedback, e.g. concentration in one asset type or upcoming renewals. Informational only, not financial advice.

### 7.8 Monthly summary & reminders

- On the 1st of each month, a scheduled job gathers the latest snapshot, month-on-month and year-on-year change (in USD), and upcoming events.
- The local LLM writes a short plain-English report: what grew, what fell, concentration warnings, and what needs attention.
- Emailed to chosen family members via an SMTP provider (e.g. Resend, Brevo or Gmail SMTP); each user can opt in or out.
- Separate reminder emails for insurance renewals, missing valuations (e.g. no property update in 12 months) and failed Trading 212 syncs.
- Reports cover investment performance only (values, growth, forecasts) plus a link to the app. They never include title deeds, certificates, other documents, addresses or policy numbers.

### 7.9 Property valuation estimates

- For each plot or house, a job searches for comparable listings and sales near its location (same area, similar size and type), using only listings and sales from the last 6–12 months so the estimate reflects the current month's market. Each estimate is stamped with its month and year.
- Search runs through a self-hosted SearXNG instance; the local LLM pulls price, size and location from results into a comparables table.
- Estimate = median price per square metre (or per acre for plots) of comparables × the property's size, shown with a low–high range and the listings used.
- Data sources vary by country: UK can use open HM Land Registry Price Paid data and the UK House Price Index; Malawi relies mostly on listing sites and agents, so estimates there are rougher.
- Estimates are saved as `valuations` with source `estimate` only after the user reviews and accepts them. A professional valuation always overrides.
- Run on demand and on a schedule (e.g. every 6 or 12 months).

#### Malawi valuation inputs

Malawi has little open price data, so estimates combine several sources:

1. **Own comparables database:** a quick mobile "add a comparable" form (area, size, type, asking or sold price, date, source, photo/link) for listings from property sites, agents and Facebook groups. Grows into the main data source.
2. **Agent opinions:** market quotes from local agents per area, stored with date and agent name.
3. **Professional valuation every few years** from a registered valuer; stored as source `professional` and used to anchor and sanity-check estimates.
4. **Currency and inflation adjustment:** convert MWK values to USD with the dated `fx_rates`, so growth reflects real value, not kwacha devaluation.
5. **Price-driving attributes** on each plot/house: title status (leasehold, freehold, customary), road access, water, electricity, distance to town centre. Used to pick and weight comparables.

## Record-keeping practices

- The vault holds copies. Original deeds, certificates and policies stay somewhere safe (fire-proof safe or bank deposit).
- At least one other trusted family member knows how to get in. Keep an up-to-date printed summary (assets, policies, contacts) for when the server is down; the app should offer a one-click printable export.
- Never store passwords or full banking logins in the vault; those belong in a password manager.

## 8. Security

- Only the web app is published, via Cloudflare Tunnel + Access; admin tools reachable over Tailscale only; no open router ports.
- Strong auth with 2FA; HTTPS end to end.
- Encryption at rest for the documents volume and database backups.
- Secrets (API keys) in environment/secret store, never in the repo.
- Audit log of who viewed or changed records.
- Row-level security / visibility checks enforced server-side, ready for permissions.

## 9. Milestones

1. **Foundation:** Docker Compose, Postgres, auth, Tailscale, backups.
2. **Core records:** assets, properties, insurance, document upload.
3. **Dashboard:** valuations, snapshots, net worth chart.
4. **Trading 212 sync.**
5. **Document ingestion:** OCR + LLM extraction + review form.
6. **Chatbot** with tool calling.
7. **Forecasting.**
8. **Permissions** per record.

## 10. Open questions

- Decided: assets are held in MWK, GBP and USD; family totals are reported in USD (see Currencies).
- Decided: self-hosted Supabase for auth and row-level security.
- Which model performs best on the mini PC for tool calling and extraction?
- How often to revalue property (manual yearly estimates, or a source)?
