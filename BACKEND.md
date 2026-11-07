# Milk Ledger: backend and accounts

None of the values below are secret: they ship inside the app. The Google client secret and
the Supabase service-role key must never be added to this file or the app.

## App
- Name: Milk Ledger
- Package name: `org.truship.milkledger` (permanent once uploaded to Google Play)

## Supabase
- Project: Milk Ledger (`bljvdvunbsooxyiqnvlj`), organization "truship", region ap-southeast-1 (Singapore)
- API URL: `https://bljvdvunbsooxyiqnvlj.supabase.co`
- Publishable key: `sb_publishable_MMwvNa2ljtD5kt77P_TLxg_KLe2o2Hs`
- Tables: `households` (seller_name, upi_id, rate_one default 70, rate_half default 35; one row per user),
  `deliveries` (user_id, day, kind 'one'|'half', status 'y'|'n', rate at time of marking),
  `payments` (month, amount, method, note)
- Row-level security: each signed-in user reads and writes only their own rows
- RPC: `delete_my_account()` deletes the caller and, by cascade, all their rows (Google Play requirement)
- Auth: Google provider enabled

## Google Cloud (project "Milk Ledger")
- Web client ID (also the app's `serverClientId`):
  `965597234939-kncc05ve0do3uoijikjenci0tpjbkbv4.apps.googleusercontent.com`
- Redirect URI: `https://bljvdvunbsooxyiqnvlj.supabase.co/auth/v1/callback`
- Still to do: Android client ID (needs package name + signing-key SHA-1), then add it to
  Supabase → Authentication → Providers → Google → Client IDs, comma-separated after the web one

## Public pages (GitHub Pages, repo gkolath/milk-ledger, source in `site/`)
- Home: https://gkolath.github.io/milk-ledger/
- Privacy policy: https://gkolath.github.io/milk-ledger/privacy.html
- Terms: https://gkolath.github.io/milk-ledger/terms.html
- Contact email: hello@truship.org

## Tools
- GitHub CLI: `tools/bin/gh` (signed in as gkolath)
