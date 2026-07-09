# Neto QA E2E — autonomous authenticated harness

Drives a real Chromium session against **app.neto.pe** as the QA test user, with
**no email / magic link** involved. It logs in via the Supabase password grant,
forges the `@supabase/ssr` session cookie, and runs the authenticated dashboard
checks end to end.

## Why this exists

Magic-link verification is unreliable for automation: Gmail's link scanner
consumes the single-use `verify?token` link before it can be used (every fresh
link arrives `otp_expired`), and Supabase rate-limits OTP email (~3-4/hour on the
built-in SMTP). This harness sidesteps all of that.

## Setup (one time)

```bash
cd app/qa-e2e
npm install
npx playwright install chromium
```

Credentials are read from `~/.config/neto/qa.env` (see the
`reference_neto_qa_test_user` memory). Nothing secret is printed.

## Run

```bash
npm run dashboard      # or: node qa-login.mjs
```

Prints a JSON report and exits 0 when all critical checks pass, 1 otherwise.

## What it verifies

- Authenticated dashboard renders user data with **no `/onboarding` bounce**
  (regression guard for the `isRestoring`/`isPending` fix).
- **W4 persistence**: `localStorage['neto-rq']` is written and its `buster`
  equals the current auth user id (per-user cache isolation).
- **Logout privacy**: signing out fully removes `neto-rq` from localStorage
  (non-vacuous — it must have been present first) and clears the session cookie.
- Warm navigation timing (TTFB / domInteractive / load) for the static shell.
- Console error count.

## Known limitation

The forged-cookie session hydrates the client's data queries only partially
(the `@supabase/ssr` client's token-refresh timing differs from a real login),
so the number of persisted queries varies (1–11) and the score KPI may not render
in every run. Full-data rendering (e.g. the score value) is verified separately
against a real magic-link session. The auth / persistence / logout-purge checks
above are reliable.
