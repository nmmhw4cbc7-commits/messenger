# Haven

A private, end-to-end encrypted messenger with a twist: **Vlog your Day**. Every day, one person in your friend group is picked at random to vlog their day – everyone else watches along.

Haven runs as a web app (PWA): open it in the browser, add it to your Home Screen, done. No app store, no phone number.

## Features

- **End-to-end encryption** for messages, photos, videos, voice messages and stickers (AES-256-GCM, P-256 ECDH, every message signed with ECDSA). Keys never leave the device.
- **Passkey sign-in** with Face ID / Touch ID. No phone number, no password, no SMS.
- **Vlog your Day**: friend groups with a daily random pick, invite links, reminders.
- **Voice calls** in one-to-one chats over WebRTC, phone to phone. Call setup is signed by the device; audio is DTLS-SRTP encrypted.
- **On-device AI**, nothing is uploaded:
  - voice messages to text (Whisper)
  - stickers from photos with automatic cut-out (ormbg)
- Photo editor (draw, text, stickers), Haven stickers, polls with visible votes, forwarding with sender control, view-once photos, disappearing messages, reactions, replies, mentions, pinned messages, chat themes, encrypted chat backup, linked devices.
- English and German.

## Privacy

- The server only stores encrypted messages until they are delivered, then deletes them (at most 30 days).
- The server knows: name, @username, profile photo, and who is in which chat. It never sees message content, voice, photos or call audio.
- Speech-to-text and photo cut-out run in the browser. The models are downloaded once from Hugging Face; your data never leaves the device.

## How it is built

| Part | Tech |
|---|---|
| App | Preact + Vite, TypeScript, PWA with service worker, IndexedDB, WebCrypto |
| Server | One Supabase Edge Function (Deno) in `supabase/functions/api`, Postgres in a private schema |
| Realtime | Supabase Realtime broadcast (content-free "sync" hints) |
| Push | Web Push with VAPID (content-free; the phone decrypts the preview itself) |
| Calls | WebRTC, optional Cloudflare TURN relay |
| Hosting | Vercel (static app, `/api/*` forwarded to the Edge Function) |

## Run it yourself

```bash
npm ci
npm run dev        # local app on http://localhost:5173, uses the API configured in client/.env.*
npm run build      # production build into dist/client
npm run typecheck
```

For your own instance you need:

1. A **Supabase** project. Deploy `supabase/functions/api` with JWT verification off (the function checks sessions itself).
2. The app's public values in `client/.env.production` (see `.env.example`).
3. Optional: **Cloudflare TURN** secrets for calls on mobile networks (see `.env.example`).
4. **Vercel** (or any static host) with the rewrites from `vercel.json`.

Note: the database schema (tables in the `haven` schema) is not in this repository yet.

## Security

Found a security problem? Please don't open a public issue. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Bundled: [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0) in `client/public/vendor/transformers`.
