# Haven security

This document says what Haven protects, how, and where its limits are.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private reporting instead: **Security → Report a vulnerability** in this repository. You will get an answer, and a fix before anything is made public.

## What the server can and cannot see

| The server sees | The server never sees |
| --- | --- |
| Your name, @username, "about" text and profile photo | Message content, photos, videos, voice messages, stickers |
| Who is in which chat, group names and group photos | Call audio |
| When an encrypted message was sent, its size and its recipients | Your private keys |
| Who vlogs on which day in a friend group | Your chat history after delivery |
| Your IP address while you are connected | Your face or fingerprint (passkeys stay on your phone) |
| How a call went: outcome, connection type, length (no people, no content) | Voice-message transcripts and photo cut-outs (made on the phone) |

Accounts made before passkeys may also have a phone number on file.

## Accounts and sign-in

- **Passkeys (WebAuthn).** An account is protected by a passkey stored in the phone's password manager (iCloud Keychain, Google Password Manager). Signing in needs Face ID, Touch ID or the device code. The server stores only the passkey's public key and checks a fresh signed challenge each time (5-minute, one-time challenges). There are no passwords and no SMS codes to steal or intercept.
- **Sessions:** a random 256-bit token in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie with the `__Host-` prefix. The database stores only its SHA-256 hash. Sessions slide for 60 days.
- **Rate limits** in the database (shared by all server instances): sign-up and sign-in per IP, lookups, sending, uploads, call setup, invite previews, and an overall API budget per IP.

## Keys

Each device creates two P-256 key pairs with WebCrypto:

- **enc** (ECDH), to receive messages
- **sig** (ECDSA), to sign what it sends

The private keys are created with `extractable: false`, so no script can read or export the key material. They are stored as `CryptoKey` objects in IndexedDB. Only the public keys go to the server.

An account can have several devices: a new device is linked by scanning a QR code on a signed-in device, and the chat history can be handed over end-to-end encrypted. Signing in with a passkey on a new phone instead creates new keys and signs out the other devices; contacts then see that the safety number changed.

## Sending a message

1. A random 256-bit content key encrypts the message with AES-256-GCM. The additional authenticated data is `haven/v1|conversation|sender|messageId|timestamp`, so the server cannot move a message to another chat, change who sent it, or replay it under another id.
2. A fresh ephemeral ECDH key pair is made for this message only. For each recipient device, `ECDH(ephemeral, recipient.enc)` goes through HKDF-SHA-256 (salt: the ephemeral public key; info: version, conversation, message, recipient and key version) to make a wrapping key, which encrypts the content key with AES-256-GCM. The ephemeral private key is discarded.
3. The sender signs the whole envelope (header, ephemeral key, ciphertext and every wrapped key) with ECDSA-SHA-256.

The receiver checks the signature against the sender's pinned key before decrypting anything. The server only checks the envelope's shape and that it has a wrapped key for exactly the current devices of the chat's members.

**Attachments** (photos, videos, voice messages, custom stickers) are encrypted on the phone with their own random AES-256-GCM key before upload. That key travels only inside the end-to-end encrypted message.

## Trust on first use, and safety numbers

The first public key Haven sees for a person is pinned on the device. If the server ever presents a different key – which happens legitimately when someone gets a new phone, and would also happen if the server tried to impersonate them – every chat with that person shows a "safety number changed" notice, and sending to a person you verified pauses until you accept the change.

A safety number is 60 digits, derived from both people's user ids and public keys with 2048 rounds of SHA-512 per side. If two people compare it in person and it matches, no one is in the middle.

## Calls

Voice calls are WebRTC, directly between the two phones. The server only relays the call setup, and every setup message (offer, answer, network candidates, hang-up) is signed by the sending device and checked against its known key. That signature covers the DTLS fingerprint, so the audio (DTLS-SRTP) is end-to-end encrypted and the server cannot put itself in the middle. When a network blocks direct connections, the encrypted audio is relayed through Cloudflare's TURN service, which cannot decrypt it. TURN credentials are short-lived.

## Delivery and storage

- Each encrypted message is stored with an explicit list of recipient devices. A device fetches it, stores it, and confirms; the server then deletes that copy, and the message once no recipient is left. Anything undelivered after 30 days is deleted. Vlog media is kept encrypted for 7 days.
- All data lives in a private Postgres schema that the Supabase Data API does not expose; only the server function can reach it.
- On the phone, decrypted messages live in IndexedDB, protected by the operating system's storage encryption. Signing out or deleting the account erases the local database, including the keys.
- **Disappearing messages** are deleted on every device after the chosen time. **View-once photos** are deleted after opening; their caption is shown only in the viewer.

## Chat backup

Optional. The phone encrypts its chats with a random backup key before uploading. That key is stored on the server only wrapped with a key derived from the user's backup PIN (PBKDF2-SHA-256, 600,000 rounds, on the phone). To get the wrapped key back, the phone proves it knows the PIN with a second derived value, which the server checks with scrypt (N=2^15). Five wrong PINs lock the backup for 24 hours.

## On-device AI

Voice-message transcription (Whisper) and sticker cut-outs (ormbg) run in the browser with WebAssembly. The library is served from Haven's own domain; the models are downloaded once from Hugging Face and cached. Audio and photos are never uploaded for this.

## Forwarding

Forwarded copies are re-encrypted for the new chat and marked "Forwarded". People can turn forwarding of their messages off; this is enforced by the apps (view-once photos, vlog posts and other people's disappearing messages can never be forwarded). It cannot stop screenshots or a modified app.

## Web hardening

- Content Security Policy: `script-src 'self' 'wasm-unsafe-eval'`, no inline scripts or styles, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, and network access only to Haven's server and the model downloads.
- HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, and a restrictive `Permissions-Policy`.
- CSRF protection: SameSite=Strict cookies plus an `Origin` check on every state-changing request.
- Every request body is validated against a schema that rejects unknown fields. All SQL is parameterised.
- Names have control and bidirectional-override characters removed, so they cannot spoof text.
- Profile photos are re-encoded on the phone (removing EXIF data such as location); the server accepts only JPEG and serves it with `nosniff` and a sandbox CSP.
- Push endpoints are restricted to the real browser push services. Pushes for messages carry no sender and no content; the phone decrypts the preview itself.
- The service worker never caches API responses.

## Known limits

- **No forward secrecy for the recipient.** Ephemeral sender keys protect against a later leak of the sender's keys, but if a recipient's long-term `enc` key were extracted from their device, recorded messages to them could be decrypted. A double ratchet (as in Signal) would add this. Keys are non-extractable and messages are deleted after delivery, which limits the practical exposure.
- **Metadata** (who talks to whom, and when) is visible to the server operator.
- **Calls reveal IP addresses** to the other person when the connection is direct, as with most calling apps.
- **The web delivery model:** a compromised server could serve modified JavaScript. That is true of every web app. Verifying safety numbers limits the risk.
- Enforcement of "no forwarding" and view-once is done by the apps, not by cryptography.
