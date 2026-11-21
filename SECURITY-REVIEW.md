# Security review — 2026-11-21

Scope: the app's own source (not third-party dependencies), covering the current
local-only architecture — no server, no sign-in — plus the UPI payment deep link,
the optional on-device AI feature, and the Android build/manifest configuration.

Files reviewed: `app/src/store.js`, `main.js`, `ai.js`, `smart.js`, `reminders.js`,
`config.js`; `app/index.html`; `app/capacitor.config.json`;
`app/android/app/src/main/AndroidManifest.xml`, `MainActivity.java`,
`res/xml/file_paths.xml`; `app/android/app/build.gradle`,
`app/android/variables.gradle`; `app/package.json`.

Method: traced every user-input-to-sink path (settings form → UPI link / AI
prompts / DOM; quick-add text → parser / AI; AI output → DOM / payment flow),
checked the Android manifest for exposed components, checked the build config
and git history for committed signing secrets.

## Result

No high- or medium-confidence findings. Specifically ruled out:

- **XSS** — no `innerHTML`/`insertAdjacentHTML`/`document.write`/`outerHTML`
  anywhere in the app. Every render path, including AI-generated text, goes
  through `textContent` or plain DOM APIs, never parsed as HTML.
- **UPI deep-link injection** — the `upi://` link is built with
  `URLSearchParams`, which percent-encodes every value, so `seller_name` or
  `upi_id` can't inject extra parameters. `upi_id` is additionally constrained
  by a regex that excludes `&`/`=`/space. The payment amount always comes from
  the app's own computed bill total, never from free-text input.
- **AI integration** — `understandNote()`'s model output is strictly validated
  (day numbers, status enum, kind enum) before it touches the store, and
  requires explicit user confirmation. `friendlierBill()`'s number-preservation
  check only gates the shared *message* text — the actual UPI payment amount is
  computed independently and can't be altered by a bypass of that check. No
  externally-controlled input reaches the model; notes/questions are the
  device owner's own text.
- **Manifest exposure** — `MainActivity` is exported but is the standard
  launcher activity with no extra intent filters to abuse. The `FileProvider`
  is not exported, and nothing in the app's code ever shares a file URI with
  another app, so its broad path config isn't reachable today.
- **Local data exposure** — `android:allowBackup="false"` blocks `adb backup`
  extraction on non-rooted devices. No debuggable flag, no custom WebView
  code, no cleartext network override.
- **Build/signing** — `keystore.properties` is gitignored and was never
  committed (checked full git history); `build.gradle` has no hardcoded
  fallback signing password.
- **Leftover backend secrets** — no committed Supabase/Google credentials;
  `BACKEND.md`'s project ref and API URL are explicitly public/publishable
  values, documented as such.

No code was changed as part of this review.
