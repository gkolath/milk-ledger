# Milk Ledger

An Android app for households that get milk delivered every day: tap the days it came, see the
month's bill, and pay the milk seller by UPI.

- `app/` — the Android app (Vite + Capacitor 8, Supabase for sign-in and storage)
- `docs/` — public home page, privacy policy and terms, served by GitHub Pages at
  https://gkolath.github.io/milk-ledger/
- `index.html` — the original single-page tracker published on claude.ai
- `BACKEND.md` — Supabase, Google sign-in and hosting details (public values only)

## Building the app

Needs Node.js, Java 21 and the Android SDK (installed with Android Studio). On this project's Mac
they live in `tools/` (not committed); `tools/env.sh` puts them on `PATH`.

```bash
source tools/env.sh
cd app
npm install
npm run sync                         # builds the web bundle and copies it into android/
cd android && ./gradlew assembleDebug
```

Try the screens in a desktop browser with sample data: `npm run dev`, then open
http://localhost:5173/?demo
