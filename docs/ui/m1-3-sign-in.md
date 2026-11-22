# M1.3 Sign-in with 2FA — UI spec

Date: 2026-11-21 — Design note: `docs/design/m1-3-sign-in.md` — Status: written while PM away; PM reviews on return

## User and task
- User: a family member on a phone or computer (any tech confidence).
- Task: get in safely; first time, set a password and turn on 2FA.
- Success: first-time setup in < 5 minutes without help; daily sign-in in < 30 s; no lockouts that need the admin.

## Flow

```mermaid
flowchart LR
  L[Sign in] -->|email + password ok| T[Enter 6-digit code]
  L -->|wrong| LE[Error: email or password not right]
  L -->|too many tries| RL[Wait N minutes]
  T -->|ok| H[Home]
  T -->|use backup code| B[Enter backup code] --> H
  T -->|wrong| TE[Error: code not right]
  S[Setup link] -->|valid| P[Choose password] --> Q[Set up authenticator: QR + key] --> C[Confirm a code] --> K[Save backup codes] --> H
  S -->|expired/used| SX[Link expired: ask your admin for a new one]
  H --> O[Sign out] --> L
```

## States matrix

| Screen / component | Default | Hover | Focus | Disabled | Loading | Empty | Error | Success | Long content | Offline | Permission denied |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Sign in (email, password, "Sign in") | Two labelled fields, primary button | Button darker | 2 px focus ring on field/button | Button disabled only while submitting | Button shows "Signing in…", fields read-only | Submitting empty: field errors "Enter your email" / "Enter your password" | Banner "Email or password is not right." + focus moves to banner; 429: "Too many tries. Try again in N minutes." | Goes to code screen | Long email wraps in field (scrolls inside input) | Banner "You're offline. Check your connection and try again." | n/a — public screen |
| Code (6-digit, "Verify", "Use a backup code") | One numeric field (`inputmode=numeric`, `autocomplete=one-time-code`), paste allowed | Link underline thicker | Focus ring | Verify disabled while submitting | "Checking…" | "Enter the 6-digit code from your authenticator app" | "That code is not right. Codes change every 30 seconds — try the newest one." After 5: back to sign in with "Please sign in again." | Home | n/a | Offline banner | n/a |
| Backup code | One text field, paste allowed | as above | Focus ring | while submitting | "Checking…" | "Enter one of your backup codes" | "That backup code is not right or was already used." | Home + notice "You have N backup codes left." | n/a | Offline banner | n/a |
| Setup: choose password | Password + confirm, show/hide toggle, rule "At least 12 characters" | — | Focus ring | while submitting | "Saving…" | Field errors | "Passwords don't match" / "Use at least 12 characters" / "This password is too common — choose another" | Next step | Long password fine | Offline banner | Link invalid → "This link has expired or was already used. Ask your admin for a new one." |
| Setup: authenticator | QR code (alt text: "QR code for your authenticator app"), the key as text with "Copy key", code field | — | Focus ring | while submitting | "Checking…" | "Enter the code your app shows" | "That code is not right. Check your phone's time is set automatically." | Next step | Key wraps, monospace | Offline banner | as above |
| Setup: backup codes | 10 codes in a list, "Copy all", "Download as text", checkbox "I've saved these codes", "Continue" | — | Focus ring | Continue disabled until checkbox ticked | — | n/a | n/a | Home | n/a | Copy/download still work | n/a |
| Home shell (header with name, "Sign out", "Sign out of all devices") | "Welcome, <name>" placeholder | — | Focus ring | — | Skeleton for name | n/a | "Something went wrong. Reload the page." | Sign out → sign-in screen with "You're signed out." | Long name truncated with full name in title attribute | Offline banner | Session expired → sign-in screen with "Your session ended. Please sign in again." |

## Breakpoints
- 320 px: single column, full-width fields and buttons, no sideways scrolling; QR code max 240 px wide.
- ≥ 600 px: centred card, max width 420 px.
- ≥ 1024 px: same card, centred vertically.

## Accessibility notes
- Headings and landmarks: one `h1` per screen ("Sign in", "Enter your code", "Use a backup code", "Set up your account", "This link has expired"); `main` landmark; setup steps announce "Step N of 3" (three steps, as in Copy).
- Focus order: top to bottom; on error, focus moves to the error summary, which links to the fields; nothing covers the focused element (no sticky footers).
- Accessible names: every field has a visible `label`; the show/hide toggle has `aria-pressed` and label "Show password".
- Errors: `aria-describedby` from field to its error text; error summary uses `role="alert"`.
- WCAG 3.3.8: paste allowed in every field; `autocomplete` set (`email`, `current-password`, `new-password`, `one-time-code`) so password managers work.
- Targets: ≥ 44×44 px on touch.
- Motion: no animation beyond the focus ring; respects `prefers-reduced-motion`.
- Contrast: ≥ 4.5:1 text, ≥ 3:1 for focus ring and field borders, in light and dark themes.

## Copy
- Sign in: title "Sign in"; labels "Email", "Password"; button "Sign in".
- Code: title "Enter your code"; help "Open your authenticator app and enter the 6-digit code for Family Asset Vault."; button "Verify"; link "Use a backup code".
- Setup: "Set up your account" · "Step 1 of 3: Choose a password" · "Step 2 of 3: Set up your authenticator app" · "Step 3 of 3: Save your backup codes"; backup help "Each code works once. Keep them somewhere safe, like a password manager or printed with your important papers."
- Errors: as in the states matrix — every one says how to recover.
- Sign out: "Sign out", "Sign out of all devices"; confirmation "You're signed out."
- No "Create account" link anywhere.

### Added 2026-11-21 (developer questions during build; lead decisions)
- Code screen: field label "6-digit code".
- Backup code screen: h1 "Use a backup code"; help "Enter one of the backup codes you saved when you set up your account. Each code works once."; field label "Backup code"; button "Verify"; link "Use your authenticator app instead" (back to the code screen).
- Setup step 1: labels "New password" and "Confirm new password"; rule text under the first field "At least 12 characters"; show/hide toggle label "Show password"; button "Continue".
- Setup step 2: help above the QR code "Open your authenticator app (for example Google Authenticator, Microsoft Authenticator or 1Password), add an account and scan this code. If you can't scan it, enter the key below instead."; key label "Key"; button "Copy key"; field label "6-digit code"; button "Verify and continue".
- Setup step 3: buttons "Copy all" and "Download as text" (file name `family-asset-vault-backup-codes.txt`); checkbox "I've saved these codes"; button "Continue".
- Copy confirmation: after "Copy key" or "Copy all", the button text changes to "Copied" for 3 seconds and a polite live region announces "Copied to clipboard". If copying fails: "Couldn't copy. Select the text and copy it yourself."
- Error summary: heading "There is a problem", followed by a list of links to each field's error; focus moves to the heading.
- Expired or used setup link: h1 "This link has expired"; text "This setup link has expired or was already used. Ask your admin for a new one."; no buttons or links (there is no public sign-up).
- Backup codes left: after signing in with a backup code, the home page shows a notice under the h1: "You have N backup codes left. When you run low, ask your admin to reset your two-step sign-in." (N = 1: "You have 1 backup code left."). With 0 left: "You have no backup codes left. Ask your admin to reset your two-step sign-in."
- Password-only session (2FA not yet passed, e.g. the page was reloaded mid-sign-in): send the person to the sign-in screen with "Please sign in again."
- Setup not finished (changed 2026-11-22, lead decision 5): signing in with the password alone does **not** resume setup. The sign-in screen shows "Your account setup isn't finished. Open your setup link again, or ask your admin for a new one." The setup link stays valid until the authenticator step is confirmed (24 h from issue); opening it again resumes at step 2 with the password kept.
- Setup password fields: no `maxLength` that silently cuts a pasted password. A password over the limit shows "Use no more than 128 characters" (128 code points, our rule; the auth library's own limit is raised so it never refuses a password our rule accepts) — never "Use at least 12 characters".
- Sign out fails (network or server error): stay on the page and show "We couldn't sign you out. Check your connection and try again." Never go to the sign-in screen while the session is still alive.
- Setup link check fails because of the connection: keep the link usable — show the offline banner with a "Try again" button; the token leaves the address bar only after the check succeeds.
- Rate-limit message: "Too many tries. Try again in 1 minute." / "… in N minutes." (singular for 1, rounded up to whole minutes).

## Tokens used
Semantic tokens defined once in `apps/web` as CSS variables, light + dark: `color.bg`, `color.surface`, `color.text`, `color.text.muted`, `color.border`, `color.accent`, `color.text.danger`, `color.bg.danger`, `color.focus`, `space.1–6`, `radius.2`, `font.body`, `font.mono`. No hard-coded colours in components.
