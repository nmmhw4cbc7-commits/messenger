// End-to-end encryption, built only on the browser's WebCrypto API.
//
// Every device has two P-256 key pairs, created on the device. Their private
// halves are non-extractable CryptoKeys: JavaScript (including ours) can use
// them, but can never read or export the key bytes.
//   - enc: ECDH, used to receive messages
//   - sig: ECDSA, used to sign the messages we send
//
// Sending a message:
//   1. a fresh random 256-bit content key encrypts the message (AES-256-GCM).
//      The conversation, sender, message id and time are bound in as
//      additional data, so the server cannot move or relabel a message.
//   2. a fresh ephemeral ECDH key pair is created for this message only.
//      For every recipient, ECDH(ephemeral, recipient) -> HKDF-SHA-256 gives a
//      key that wraps the content key (AES-256-GCM). The ephemeral private
//      key is thrown away afterwards.
//   3. the whole envelope is signed with the sender's ECDSA key. Recipients
//      check it against the key they pinned for that person.

const subtle = crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
const VERSION = 1;

// ------------------------------------------------------------------ encoding

export function toB64u(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomId(): string {
  return toB64u(crypto.getRandomValues(new Uint8Array(16)));
}

const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

// ------------------------------------------------------------------ identity

export interface Identity {
  encPriv: CryptoKey;
  encPub: string;
  sigPriv: CryptoKey;
  sigPub: string;
  /** Phone number this identity was created for. */
  phone: string;
}

export async function createIdentity(phone: string): Promise<Identity> {
  const encPair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const sigPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  return {
    encPriv: encPair.privateKey,
    encPub: toB64u(await subtle.exportKey('raw', encPair.publicKey)),
    sigPriv: sigPair.privateKey,
    sigPub: toB64u(await subtle.exportKey('raw', sigPair.publicKey)),
    phone,
  };
}

const ecdhPub = (b64: string) => subtle.importKey('raw', fromB64u(b64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
const ecdsaPub = (b64: string) => subtle.importKey('raw', fromB64u(b64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);

// ------------------------------------------------------------------ messages

export interface Recipient {
  id: string;
  encPub: string;
  keyVersion: number;
}

export interface Envelope {
  v: 1;
  ts: number;
  eph: string;
  iv: string;
  ct: string;
  sig: string;
  keys: Record<string, { kv: number; iv: string; k: string }>;
}

export interface Payload {
  type: 'text';
  text: string;
}

const header = (convId: string, senderId: string, msgId: string, ts: number) =>
  `haven/v${VERSION}|${convId}|${senderId}|${msgId}|${ts}`;

function signedBytes(h: string, e: Omit<Envelope, 'sig' | 'v' | 'ts'>) {
  const keys = Object.keys(e.keys)
    .sort()
    .map((id) => `${id}:${e.keys[id].kv}:${e.keys[id].iv}:${e.keys[id].k}`)
    .join(',');
  return enc.encode(`${h}|${e.eph}|${e.iv}|${e.ct}|${keys}`);
}

async function wrappingKey(shared: ArrayBuffer, eph: string, convId: string, msgId: string, recipientId: string, kv: number, usage: KeyUsage) {
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(eph), info: enc.encode(`haven/v${VERSION}/wrap|${convId}|${msgId}|${recipientId}|${kv}`) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function encryptMessage(
  identity: Identity,
  senderId: string,
  convId: string,
  msgId: string,
  payload: Payload,
  recipients: Recipient[],
): Promise<Envelope> {
  const ts = Date.now();
  const h = header(convId, senderId, msgId, ts);

  const contentKeyRaw = random(32);
  const contentKey = await subtle.importKey('raw', contentKeyRaw, 'AES-GCM', false, ['encrypt']);
  const iv = random(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(h) }, contentKey, enc.encode(JSON.stringify(payload)));

  const ephPair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const eph = toB64u(await subtle.exportKey('raw', ephPair.publicKey));

  const keys: Envelope['keys'] = {};
  for (const r of recipients) {
    const shared = await subtle.deriveBits({ name: 'ECDH', public: await ecdhPub(r.encPub) }, ephPair.privateKey, 256);
    const wk = await wrappingKey(shared, eph, convId, msgId, r.id, r.keyVersion, 'encrypt');
    const wiv = random(12);
    const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv: wiv }, wk, contentKeyRaw);
    keys[r.id] = { kv: r.keyVersion, iv: toB64u(wiv), k: toB64u(wrapped) };
  }
  contentKeyRaw.fill(0);

  const body = { eph, iv: toB64u(iv), ct: toB64u(ct), keys };
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.sigPriv, signedBytes(h, body));
  return { v: VERSION, ts, ...body, sig: toB64u(sig) };
}

export type DecryptResult =
  | { ok: true; payload: Payload; ts: number }
  | { ok: false; reason: 'bad_signature' | 'not_for_device' | 'corrupt' };

/**
 * Verify and decrypt. `senderSigPubs` are the sender's pinned signing keys
 * (current first, then earlier ones). Signature is checked before anything is decrypted.
 */
export async function decryptMessage(
  identity: Identity,
  myId: string,
  convId: string,
  senderId: string,
  msgId: string,
  envelope: Envelope,
  senderSigPubs: string[],
): Promise<DecryptResult> {
  try {
    if (envelope.v !== VERSION) return { ok: false, reason: 'corrupt' };
    const h = header(convId, senderId, msgId, envelope.ts);
    const signed = signedBytes(h, envelope);
    const sig = fromB64u(envelope.sig);
    let verified = false;
    for (const pub of senderSigPubs) {
      if (await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await ecdsaPub(pub), sig, signed)) {
        verified = true;
        break;
      }
    }
    if (!verified) return { ok: false, reason: 'bad_signature' };

    const mine = envelope.keys[myId];
    if (!mine) return { ok: false, reason: 'not_for_device' };
    const shared = await subtle.deriveBits({ name: 'ECDH', public: await ecdhPub(envelope.eph) }, identity.encPriv, 256);
    const wk = await wrappingKey(shared, envelope.eph, convId, msgId, myId, mine.kv, 'decrypt');
    let contentKeyRaw: ArrayBuffer;
    try {
      contentKeyRaw = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(mine.iv) }, wk, fromB64u(mine.k));
    } catch {
      return { ok: false, reason: 'not_for_device' };
    }
    const contentKey = await subtle.importKey('raw', contentKeyRaw, 'AES-GCM', false, ['decrypt']);
    new Uint8Array(contentKeyRaw).fill(0);
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(envelope.iv), additionalData: enc.encode(h) }, contentKey, fromB64u(envelope.ct));
    const payload = JSON.parse(dec.decode(plain));
    if (payload?.type !== 'text' || typeof payload.text !== 'string') return { ok: false, reason: 'corrupt' };
    return { ok: true, payload: { type: 'text', text: payload.text.slice(0, 8000) }, ts: envelope.ts };
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
}

// ------------------------------------------------------------------ safety numbers

async function fingerprint(userId: string, sigPub: string, encPub: string): Promise<string> {
  // Iterated hashing makes it expensive to search for keys with a similar-looking number.
  let data: Uint8Array<ArrayBuffer> = enc.encode(`haven-fingerprint-v1|${userId}|${sigPub}|${encPub}`);
  const seed = data;
  for (let i = 0; i < 2048; i++) {
    const next = new Uint8Array(data.length + seed.length);
    next.set(data);
    next.set(seed, data.length);
    data = new Uint8Array(await subtle.digest('SHA-512', next));
  }
  let digits = '';
  for (let i = 0; i < 30; i += 5) {
    const chunk = data[i] * 2 ** 32 + ((data[i + 1] << 24) >>> 0) + (data[i + 2] << 16) + (data[i + 3] << 8) + data[i + 4];
    digits += String(chunk % 100000).padStart(5, '0');
  }
  return digits;
}

/** 60 digits in 12 groups. Both people see the same number. */
export async function safetyNumber(a: { id: string; sigPub: string; encPub: string }, b: { id: string; sigPub: string; encPub: string }) {
  const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
  const digits = (await fingerprint(first.id, first.sigPub, first.encPub)) + (await fingerprint(second.id, second.sigPub, second.encPub));
  return digits.match(/.{5}/g) as string[];
}
