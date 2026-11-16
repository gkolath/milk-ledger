# Milk Ledger: backend and accounts

None of the values below are secret: they ship inside the app. The Google client secret and
the Supabase service-role key must never be added to this file or the app.

## App
- Name: Milk Ledger
- Package name: `org.truship.milkledger` (permanent once uploaded to Google Play)
- Data storage: **local only**. The app has no sign-in and no server. All household settings,
  deliveries and payments live in the device's `localStorage` (`store.js` → `localStore()`),
  and never leave the device.

## Supabase and Google Sign-In — unused, kept for reference
The app originally required Google Sign-In with a Supabase backend. That flow was removed in
favor of the local-only storage above (no more login step). The project/credentials below are
not deleted and still exist, but nothing in the shipped app talks to them anymore.

- Supabase project: Milk Ledger (`bljvdvunbsooxyiqnvlj`), organization "truship", region
  ap-southeast-1 (Singapore) — API URL `https://bljvdvunbsooxyiqnvlj.supabase.co`,
  publishable key `sb_publishable_MMwvNa2ljtD5kt77P_TLxg_KLe2o2Hs`. Still running (left running
  on request, in case cloud sync is revisited later).
- Tables (no longer written to): `households`, `deliveries`, `payments`, with an RPC
  `delete_my_account()` and row-level security per signed-in user
- Google Cloud project "Milk Ledger": the three Android OAuth clients (debug keystore, release
  upload keystore, Google Play App Signing's certificate) and the one web client have been
  **deleted** (2026-11-15) from APIs & Services → Credentials, since Google Sign-In is no longer
  used. They're recoverable from Google Cloud's "Restore deleted credentials" for 30 days, after
  which they're gone for good. Supabase's Google provider still lists these client IDs under
  Authentication → Providers → Google, but that provider is unused now anyway.

## Data Safety form quirk
Play Console → App content → Data safety has a top-level question, "Does your app collect or
share any of the required user data types?" Once an app has answered "Yes" there, the form only
ever renders the "Yes" radio again — there is no "No" option to click back to, even after every
data type checkbox underneath is cleared (confirmed by inspecting the page's DOM: the "No" radio
for that specific question simply isn't in the page for an app with a "Yes" history). With zero
data types selected, the wizard also refuses to advance ("Next" stays disabled), since "Yes" with
nothing declared is an inconsistent state.
The workaround in place: the declaration keeps "Yes", with only "Other financial info" (the
payment/rate records) checked as "Collected" (not "Shared") for app-functionality purposes, with
the rest of the honest answers (no sharing, optional, not ephemeral). This is the closest
available approximation — no data actually leaves the device — not a fully accurate "no data
collected" declaration. A true "No" would require Google Play support to reset it, or exporting
the declaration to CSV, editing the top-level field there, and re-importing (not attempted here).

## Public pages (GitHub Pages, repo gkolath/milk-ledger, source in `docs/`)
- Home: https://gkolath.github.io/milk-ledger/
- Privacy policy: https://gkolath.github.io/milk-ledger/privacy.html
- Terms: https://gkolath.github.io/milk-ledger/terms.html
- Contact email: hello@truship.org

## Tools
- GitHub CLI: `tools/bin/gh` (signed in as gkolath)
