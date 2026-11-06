# Haven security design

This document says what Haven protects, how, and where its limits are.

## What the server can and cannot see

| The server sees | The server never sees |
| --- | --- |
| Your phone number, name, "about" text and profile photo | Message content |
| Who is in which conversation, and group names | Your private keys |
| When an encrypted message was sent, its size and its recipients | Your chat history after delivery |
| Your IP address while you are connected | Verification codes (with Twilio, they never reach the server) |

## Keys

Each device creates two P-256 key pairs with WebCrypto when you sign in:

- **enc** (ECDH), used to receive messages
- **sig** (ECDSA), used to sign messages you send

The private keys are created with `extractable: false`, so the browser does not let any script read or export the key material. They are stored as `CryptoKey` objects in IndexedDB. Only the public keys are sent to the server.

One account has one active device. Signing in on a new device creates new keys, ends every other session, and tells your contacts that your safety number changed.

## Sending a message

1. A random 256-bit content key encrypts the message with AES-256-GCM. The additional authenticated data is `haven/v1|conversation|sender|messageId|timestamp`, so the server cannot move a message to another chat, change who sent it, or replay it under another id.
2. A fresh ephemeral ECDH key pair is generated for this message only. For each recipient, `ECDH(ephemeral, recipient.enc)` is fed through HKDF-SHA-256 (salt: the ephemeral public key; info: version, conversation, message, recipient and key version) to make a wrapping key. That key encrypts the content key with AES-256-GCM. The ephemeral private key is discarded.
3. The sender signs the whole envelope (header, ephemeral key, ciphertext and every wrapped key) with ECDSA-SHA-256.

The receiver checks the signature against the sender's pinned key before decrypting anything. The server only checks that the envelope has the right shape, and that it contains a wrapped key for exactly the current members on their current key versions. If not, the client refreshes and encrypts again.

## Trust on first use, and safety numbers

The first public key Haven sees for a person is pinned on the device. If the server ever presents a different key, which happens legitimately when someone gets a new phone and would also happen if the server tried to impersonate them:

- every chat with that person shows a "safety number changed" notice
- if you had verified that person, sending to them pauses until you accept the change

A safety number is 60 digits. It is derived from both people's user ids and public keys, with 2048 iterations of SHA-512 per side, and both people see the same number. If they compare it in person or on a call and it matches, no one is in the middle.

## Delivery and storage

- The server stores each encrypted message with an explicit recipient list. A recipient fetches it with `/api/sync`, stores it on the device, and confirms with `/api/sync/ack`. The server then deletes that recipient's copy, and deletes the message once no recipient is left.
- Anything still undelivered after `MESSAGE_RETENTION_DAYS` (default 30) is deleted.
- SQLite runs with `secure_delete=ON`, so deleted rows are overwritten on disk.
- On the device, decrypted messages live in IndexedDB, protected by the operating system's storage encryption. Signing out or deleting your account erases the whole local database, including the keys.

## Account security

- **Sign-in:** an SMS code sent by Twilio Verify. In development mode codes are stored only as SHA-256 hashes, expire after 10 minutes, and allow at most 5 attempts.
- **Rate limits:** codes per number (one per 30 seconds, 3 per 10 minutes, 8 per day) and per IP; verification attempts; PIN attempts; number lookups (60 per hour); sending; and an overall API budget.
- **Registration lock:** an optional 4 to 12 digit PIN, hashed with scrypt (N=2^15). Signing in on a new device then needs the SMS code and the PIN. Five wrong PINs lock sign-in for 24 hours. The lock lapses after 7 days without account activity, so a forgotten PIN cannot lock you out forever.
- **Sessions:** a random 256-bit token in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie with the `__Host-` prefix. The database stores only its SHA-256 hash. Sessions slide for 60 days.

## Web hardening

- A strict Content Security Policy: `script-src 'self'`, no inline scripts or styles, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.
- HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy`, and a restrictive `Permissions-Policy`.
- CSRF protection: SameSite=Strict cookies plus a strict `Origin` check on every state-changing request and on WebSocket upgrades.
- Every request body is validated against a JSON schema that rejects unknown fields. All SQL uses prepared statements.
- Display names and group names have control characters and bidirectional-override characters removed, so they cannot be used to spoof text.
- Profile photos are re-encoded on the device, which removes EXIF data such as location. The server accepts only JPEG (checked by magic bytes, at most 300 KB) and serves them with `nosniff` and a sandbox CSP.
- Push endpoints are restricted to the real browser push services, so the server cannot be used to make requests to internal addresses. Push payloads contain no sender and no content.
- The service worker never caches API responses.
- Static files are served from an in-memory table with exact path matching, so path traversal is impossible.
- There are few dependencies, and `npm audit` reports 0 known vulnerabilities at the time of writing.

## Known limits

- **No forward secrecy for the recipient.** The ephemeral sender keys protect against a later leak of the sender's keys. But if a recipient's long-term `enc` private key were extracted from their device, messages to them that an attacker recorded could be decrypted. A double-ratchet protocol (as in Signal) would add this, at a large cost in complexity. Since the keys are non-extractable and messages are deleted after delivery, the practical exposure is small.
- **Metadata** (who talks to whom, and when) is visible to the server operator, as described above.
- **The web delivery model:** a compromised server could serve modified JavaScript. That is true of every web app. Running your own server, and verifying safety numbers, limits the risk.
- **One device per account.** History does not move to a new device.
