# Haven

A private messenger that installs like an app (PWA). You register with your phone number and an SMS code, write to anyone by their number, and create groups. If someone isn't on Haven yet, you can invite them. Every message is end-to-end encrypted on the device.

- **End-to-end encrypted** with WebCrypto only (ECDH P-256, HKDF-SHA-256, AES-256-GCM, ECDSA signatures). Private keys are non-extractable and never leave the device.
- **Delete after delivery.** The server keeps an encrypted message only until every recipient has synced it, and never longer than 30 days.
- **Safety numbers.** You can compare a 60-digit number with a contact. Haven warns you in the chat when a contact's keys change, and pauses sending to contacts you verified.
- **Registration lock.** An optional PIN stops SIM-swap takeovers.
- **Native feel.** The app has screen transitions, an edge swipe to go back, bottom sheets, action sheets and haptics. It handles safe areas and the keyboard, supports dark mode, works offline, and sends push notifications that contain nothing.
- **Self-hosted.** A single Node.js process with an SQLite file. No Supabase, Firebase or other database service.

See [SECURITY.md](SECURITY.md) for the threat model and the exact design.

## Run it locally

You need Node.js 22.12 or newer.

```bash
npm install
npm run dev
```

Open http://localhost:5173. In development no SMS is sent: the verification code is printed in the terminal.

To try the production build locally:

```bash
npm run build
npm start
```

Then open http://localhost:8080.

## Deploy

1. **Create a Twilio Verify service.** In the Twilio Console, go to Verify, then Services, and create one. You need the Account SID, the Auth Token and the Verify Service SID. Twilio generates, sends and checks the codes, so codes never touch your server.
2. **Configure.** Copy `.env.example` to `.env` and fill it in. The server refuses to start in production without HTTPS, without Twilio, or with the development SMS mode.
3. **Run behind HTTPS.** A PWA, service workers, push and WebCrypto all need a secure origin. For example, with [Caddy](https://caddyserver.com/) (which gets certificates automatically):

   ```
   chat.example.com {
       reverse_proxy localhost:8080
   }
   ```

   Set `TRUST_PROXY=true` so rate limits see real client IPs.

4. **Start it**, either with Docker:

   ```bash
   docker build -t haven .
   docker run -d --name haven --env-file .env -v haven-data:/data -p 127.0.0.1:8080:8080 haven
   ```

   or directly:

   ```bash
   npm ci && npm run build && NODE_ENV=production npm start
   ```

The SQLite database lives in `DATA_DIR`. Back it up, and keep it readable only by the service user. Haven is designed to run as one process; the rate limiter and live connections are in memory.

## Installing on a phone

- **iPhone:** open the site in Safari, tap Share, then *Add to Home Screen*. Notifications work once Haven is opened from the Home Screen (iOS 16.4 or newer).
- **Android:** Chrome offers *Install app*, or use the menu and tap *Add to Home screen*.

## Tests

```bash
npm test
```

This runs the server security tests: CSRF and origin checks, rate limits, membership authorization, delete-after-delivery, blocking, key rotation, the registration lock, upload checks, the push endpoint allowlist and static file isolation.

`test/e2e.cjs` drives the real app in Chromium with simulated phones. It covers registration, sending and receiving encrypted messages, matching safety numbers, invites, groups, a contact moving to a new device, and the registration lock. Start a server with `SMS_PROVIDER=console`, write its log to a file, and run `node test/e2e.cjs <logfile> <screenshot-dir>`.

## Project layout

```
server/            Fastify API, WebSocket hub, SQLite, Twilio Verify, Web Push
  app.js           hardening (CSP, headers, CSRF origin check, error handling)
  auth.js          phone + SMS code sign-in, registration lock
  api.js           profile, people, conversations, messages, sync, blocks, push
client/src/
  lib/crypto.ts    end-to-end encryption and safety numbers
  lib/engine.ts    sign-in, key pinning, sync, outbox, realtime
  ui/nav.tsx       native-style navigation stack, edge swipe, sheets
  screens/         onboarding, chats, chat, new chat/group, info, settings
test/              server tests and the browser end-to-end test
```
