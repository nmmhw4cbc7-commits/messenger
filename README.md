# Haven

A private messenger that installs like an app (PWA). You register with your phone number (confirmed through Telegram, free), write to anyone by their number, invite people who aren't on Haven yet, and create groups. Every message is end-to-end encrypted on the device.

- **End-to-end encrypted** with WebCrypto (ECDH P-256, HKDF-SHA-256, AES-256-GCM, ECDSA signatures). Private keys are non-extractable and never leave the device.
- **Delete after delivery.** The server keeps an encrypted message only until every recipient has synced it, at most 30 days.
- **Safety numbers** and key-change warnings; sending pauses for verified contacts whose keys change.
- **Registration lock:** an optional PIN against number takeovers.
- **Native feel:** screen transitions, edge swipe back, sheets, dark mode, offline start, content-free push notifications.

See [SECURITY.md](SECURITY.md) for the design.

## How it runs

| Part | Where |
| --- | --- |
| App (static PWA) | Vercel, built from `main` |
| API | Supabase Edge Function `api` (`supabase/functions/api`) |
| Data | Supabase Postgres, private schema `haven` (not exposed to the Data API) |
| Live updates | Supabase Realtime broadcast, per-user secret channel, hints only |
| Phone confirmation | Telegram bot (`TELEGRAM_BOT_TOKEN` secret of the Edge Function) |

Vercel forwards `/api/*` to the Edge Function, so the session cookie stays first-party.

## Develop

```bash
npm install
npm run dev
```

The dev server proxies `/api` to the deployed function.

## Tests

`test/e2e.cjs` drives the real app in Chromium with simulated phones.
