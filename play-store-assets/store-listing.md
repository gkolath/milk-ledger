# Play Store listing — ready to paste

## App details
- **App name** (max 30 chars): `Milk Ledger`
- **Package name**: `org.truship.milkledger`
- **Category**: Finance (Lifestyle or Productivity are reasonable alternates)
- **Contact email**: hello@truship.org
- **Website**: https://gkolath.github.io/milk-ledger/
- **Privacy policy URL**: https://gkolath.github.io/milk-ledger/privacy.html

## Short description (max 80 chars — currently 68)
```
Track daily milk deliveries, see the month's bill, and pay by UPI.
```

## Full description (max 4000 chars)
```
Milk Ledger is for households that get milk delivered every day.

Tap the days your milk arrives — once for received, again for not received.
The month's bill adds itself up automatically, split by 1 litre and ½ litre
rates, so there's never a dispute with the milkman about how many days he
delivered.

HOW IT WORKS
• Tap a day on the calendar to mark it received or not received
• Set your own per-litre rates for 1 litre and ½ litre deliveries
• The app totals the month's bill as you go
• Pay your milk seller directly by UPI, right from the app
• Or mark a payment as made in cash and keep a running balance
• Share the month's bill as a message before you pay
• No sign-in — open the app and start using it right away

WHO IT'S FOR
Anyone with a daily milk delivery (or any daily delivery, really) who wants
a simple, honest record of what came and what's owed — no spreadsheets,
no notebook, no guessing at month end.

PRIVACY
Milk Ledger stores your delivery records, rates and payment history only
on your own device. Nothing is sent to a server, and there's no account.
See the privacy policy for details: https://gkolath.github.io/milk-ledger/privacy.html
```

## Assets in this folder
- `icon-512.png` — hi-res app icon (512×512, required)
- `screenshot-1-calendar.jpg` — main calendar view with sample data
- `screenshot-2-pay.jpg` — pay/bill card with UPI button
- `screenshot-3-settings.jpg` — settings (seller name, UPI ID, rates)

Play Store needs at least 2 phone screenshots (320–3840px per side); these three
qualify. More can be added later — real screenshots from actual use are fine too.

## Content rating questionnaire — likely answers
No violence, no user-generated content shown to others, no gambling, no ads,
no in-app purchases (UPI payment happens in the user's own UPI app, not inside
Milk Ledger). This should land in the "Everyone" rating after the questionnaire.
Answer the questionnaire yourself in Play Console to get the official rating —
this is guidance, not a substitute for it.

## Data safety form — what the app actually does
Based on reading the source code (`app/src/store.js`, `app/src/main.js`,
`BACKEND.md`). There is no sign-in and no server: delivery records, household
settings (seller name, UPI ID, rates) and payment history are stored only in
the device's `localStorage` and never transmitted anywhere.
- **Collects**: nothing that leaves the device. The live Data Safety form
  still declares "Other financial info" (payment/rate records) as collected,
  for app functionality only, because Google Play's form won't let an app
  that once answered "Yes" flip back to a clean "No data collected" through
  the normal UI — see `BACKEND.md` for the full explanation.
- **Shared with third parties**: no
- **User can request deletion**: "Clear all data" in Settings wipes
  everything immediately, on-device (not a server-side deletion, since there
  is no server)

Double-check these against the live Data Safety form questions yourself, since
Google updates the question wording periodically and this isn't legal advice.
