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

export interface MediaPayload {
  kind: 'image' | 'video' | 'voice';
  path: string;
  key: string;
  iv: string;
  mime: string;
  size: number;
  w?: number;
  h?: number;
  duration?: number;
  thumb?: string;
  wave?: number[];
  caption?: string;
  viewOnce?: boolean;
  /** Part of the Vlog your Day of this day (YYYY-MM-DD). */
  vlog?: string;
}

export type Payload =
  | { type: 'text'; text: string; reply?: { id: string; senderId: string; text: string } }
  | { type: 'reaction'; target: string; emoji: string }
  | { type: 'media'; media: MediaPayload; reply?: { id: string; senderId: string; text: string } }
  | { type: 'location'; lat: number; lng: number; acc?: number }
  | { type: 'contact'; name: string; phone: string }
  | { type: 'poll'; question: string; options: string[]; multi: boolean }
  | { type: 'vote'; target: string; choices: number[] }
  | { type: 'opened'; target: string }
  | { type: 'edit'; target: string; text: string }
  | { type: 'delete'; target: string };

const ID = /^[A-Za-z0-9_-]{16,40}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const num = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

function cleanReply(r: unknown) {
  const o = r as Record<string, unknown> | undefined;
  if (o && typeof o.id === 'string' && ID.test(o.id) && typeof o.senderId === 'string' && ID.test(o.senderId) && typeof o.text === 'string') {
    return { id: o.id, senderId: o.senderId, text: o.text.slice(0, 200) };
  }
  return undefined;
}

function cleanMedia(m: unknown): MediaPayload | null {
  const o = m as Record<string, unknown> | undefined;
  if (!o || !['image', 'video', 'voice'].includes(o.kind as string)) return null;
  if (!str(o.path, 90) || !/^[A-Za-z0-9_-]{16,40}\/[A-Za-z0-9_-]{16,40}$/.test(o.path as string)) return null;
  if (!str(o.key, 64) || !B64.test(o.key as string) || !str(o.iv, 24) || !B64.test(o.iv as string)) return null;
  // Only plain media types; never anything a browser could run.
  if (!str(o.mime, 60) || !/^(image\/(jpeg|png|webp|gif)|video\/(mp4|quicktime|webm)|audio\/(mp4|webm|ogg|mpeg|aac)(;.*)?)$/.test(o.mime as string)) return null;
  if (!num(o.size, 0, 50 * 1024 * 1024)) return null;
  const out: MediaPayload = { kind: o.kind as MediaPayload['kind'], path: o.path as string, key: o.key as string, iv: o.iv as string, mime: o.mime as string, size: o.size as number };
  if (num(o.w, 1, 20000)) out.w = o.w as number;
  if (num(o.h, 1, 20000)) out.h = o.h as number;
  if (num(o.duration, 0, 36000)) out.duration = o.duration as number;
  if (str(o.thumb, 6000) && (o.thumb as string).startsWith('data:image/jpeg;base64,')) out.thumb = o.thumb as string;
  if (Array.isArray(o.wave) && o.wave.length <= 64 && o.wave.every((v) => num(v, 0, 1))) out.wave = o.wave as number[];
  if (str(o.caption, 2000) && o.caption) out.caption = o.caption as string;
  if (o.viewOnce === true && o.kind === 'image') out.viewOnce = true;
  if (typeof o.vlog === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.vlog) && o.kind !== 'voice') out.vlog = o.vlog;
  return out;
}

/** Accept only well-formed payloads; anything else is treated as corrupt. */
function cleanPayload(p: unknown): Payload | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  switch (o.type) {
    case 'text': {
      if (typeof o.text !== 'string') return null;
      const reply = cleanReply(o.reply);
      return reply ? { type: 'text', text: o.text.slice(0, 8000), reply } : { type: 'text', text: o.text.slice(0, 8000) };
    }
    case 'reaction':
      return typeof o.target === 'string' && ID.test(o.target) && str(o.emoji, 16) ? { type: 'reaction', target: o.target, emoji: o.emoji as string } : null;
    case 'media': {
      const media = cleanMedia(o.media);
      if (!media) return null;
      const reply = cleanReply(o.reply);
      return reply ? { type: 'media', media, reply } : { type: 'media', media };
    }
    case 'location':
      return num(o.lat, -90, 90) && num(o.lng, -180, 180)
        ? { type: 'location', lat: o.lat as number, lng: o.lng as number, ...(num(o.acc, 0, 1e6) ? { acc: o.acc as number } : {}) }
        : null;
    case 'contact':
      return str(o.name, 80) && str(o.phone, 32) && /^\+[1-9]\d{6,15}$/.test(o.phone as string) ? { type: 'contact', name: (o.name as string) || (o.phone as string), phone: o.phone as string } : null;
    case 'poll':
      return str(o.question, 300) && o.question && Array.isArray(o.options) && o.options.length >= 2 && o.options.length <= 12 && o.options.every((x) => str(x, 100) && x)
        ? { type: 'poll', question: o.question as string, options: o.options as string[], multi: o.multi === true }
        : null;
    case 'vote':
      return typeof o.target === 'string' && ID.test(o.target) && Array.isArray(o.choices) && o.choices.length <= 12 && o.choices.every((c) => Number.isInteger(c) && c >= 0 && c < 12)
        ? { type: 'vote', target: o.target, choices: o.choices as number[] }
        : null;
    case 'opened':
      return typeof o.target === 'string' && ID.test(o.target) ? { type: 'opened', target: o.target } : null;
    case 'edit':
      return typeof o.target === 'string' && ID.test(o.target) && typeof o.text === 'string' && o.text.trim()
        ? { type: 'edit', target: o.target, text: o.text.slice(0, 8000) } : null;
    case 'delete':
      return typeof o.target === 'string' && ID.test(o.target) ? { type: 'delete', target: o.target } : null;
    default:
      return null;
  }
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
    const payload = cleanPayload(JSON.parse(dec.decode(plain)));
    if (!payload) return { ok: false, reason: 'corrupt' };
    return { ok: true, payload, ts: envelope.ts };
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

type KeyOwner = { id: string; devices: { id: string; sigPub: string; encPub: string }[] };

/** 60 digits in 12 groups, covering every device of both people. Both people see the same number. */
export async function safetyNumber(a: KeyOwner, b: KeyOwner) {
  const part = (o: KeyOwner) => {
    const ds = [...o.devices].sort((x, y) => (x.sigPub < y.sigPub ? -1 : 1));
    return fingerprint(o.id, ds.map((d) => d.sigPub).join(','), ds.map((d) => d.encPub).join(','));
  };
  const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
  const digits = (await part(first)) + (await part(second));
  return digits.match(/.{5}/g) as string[];
}

// ------------------------------------------------------------------ sealed boxes (device-to-device hand-over)

/**
 * Encrypt bytes so that only the holder of `recipientEncPub` can open them:
 * a fresh AES-256-GCM key encrypts the data, and an ephemeral ECDH key + HKDF
 * wraps that key. Returns the ciphertext and a small JSON key blob.
 */
export async function seal(data: Uint8Array<ArrayBuffer>, recipientEncPub: string) {
  const keyRaw = random(32);
  const key = await subtle.importKey('raw', keyRaw, 'AES-GCM', false, ['encrypt']);
  const iv = random(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const ephPub = toB64u(await subtle.exportKey('raw', eph.publicKey));
  const shared = await subtle.deriveBits({ name: 'ECDH', public: await ecdhPub(recipientEncPub) }, eph.privateKey, 256);
  const wk = await sealKey(shared, ephPub, 'encrypt');
  const wiv = random(12);
  const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv: wiv }, wk, keyRaw);
  keyRaw.fill(0);
  return { ciphertext: new Uint8Array(ct), key: JSON.stringify({ v: 1, eph: ephPub, iv: toB64u(iv), wiv: toB64u(wiv), k: toB64u(wrapped) }) };
}

export async function unseal(identity: Identity, ciphertext: ArrayBuffer, keyJson: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = JSON.parse(keyJson) as { v: number; eph: string; iv: string; wiv: string; k: string };
  const shared = await subtle.deriveBits({ name: 'ECDH', public: await ecdhPub(k.eph) }, identity.encPriv, 256);
  const wk = await sealKey(shared, k.eph, 'decrypt');
  const keyRaw = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(k.wiv) }, wk, fromB64u(k.k));
  const key = await subtle.importKey('raw', keyRaw, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(k.iv) }, key, ciphertext));
}

async function sealKey(shared: ArrayBuffer, eph: string, usage: KeyUsage) {
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(eph), info: enc.encode('haven/v1/history-transfer') }, ikm, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
