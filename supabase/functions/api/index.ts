// Haven API: one Supabase Edge Function behind the app's own domain.
//
// The browser talks to https://<app>/api/*, which Vercel forwards here, so
// cookies stay first-party. Data lives in the private "haven" schema, which
// the Supabase Data API does not expose; only this function can reach it.
//
// The server never sees message content: messages are end-to-end encrypted
// envelopes, deleted as soon as every recipient has synced them.

import postgres from 'npm:postgres@3.4.5';
import { parsePhoneNumberWithError } from 'npm:libphonenumber-js@1.11.20/max';
import webpush from 'npm:web-push@3.6.7';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from 'npm:@simplewebauthn/server@13.1.1';
import { scrypt as scryptCb, timingSafeEqual, randomBytes, randomInt, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 4, idle_timeout: 20 });
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SESSION_DAYS = 60;
const RETENTION_DAYS = 30;
const MAX_GROUP = 100;
const COOKIE = '__Host-haven';
const MAX_BODY = 100 * 1024;
const MAX_AVATAR = 300 * 1024;
const DEFAULT_REGION = 'DE';
const MAX_ATTACHMENT = 50 * 1024 * 1024;
const VLOG_RETENTION_DAYS = 7;

const now = () => Date.now();
const randomId = () => randomBytes(16).toString('base64url');
const newToken = () => randomBytes(32).toString('base64url');
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

// ------------------------------------------------------------------ errors & responses

class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra: Record<string, unknown> = {}) {
    super(message || code);
  }
}

const BASE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

class Reply {
  headers = new Headers(BASE_HEADERS);
  cookie(value: string) {
    this.headers.append('Set-Cookie', value);
  }
  json(data: unknown, status = 200) {
    this.headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(data), { status, headers: this.headers });
  }
}

// ------------------------------------------------------------------ config in kv

let configCache: { at: number; origins: string[] } | null = null;
async function allowedOrigins(): Promise<string[]> {
  if (configCache && now() - configCache.at < MIN) return configCache.origins;
  const [row] = await sql`select value from haven.kv where key = 'allowed_origins'`;
  const origins = row ? (JSON.parse(row.value) as string[]) : [];
  configCache = { at: now(), origins };
  return origins;
}

async function kvGet(key: string): Promise<string | null> {
  const [row] = await sql`select value from haven.kv where key = ${key}`;
  return row?.value ?? null;
}

// ------------------------------------------------------------------ validation

type Check = (v: unknown) => boolean;
const B64URL = /^[A-Za-z0-9_-]+$/;
const ID_RE = /^[A-Za-z0-9_-]{16,40}$/;
const str = (min: number, max: number, re?: RegExp): Check => (v) =>
  typeof v === 'string' && v.length >= min && v.length <= max && (!re || re.test(v));
const int = (min: number, max = Number.MAX_SAFE_INTEGER): Check => (v) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isId: Check = str(16, 40, ID_RE);
const idList = (min: number, max: number): Check => (v) =>
  Array.isArray(v) && v.length >= min && v.length <= max && v.every(isId) && new Set(v).size === v.length;
const PHONE_IN = str(3, 32);
const PUBKEY = str(87, 87, B64URL);
const USERNAME = /^[a-z0-9_.]{3,20}$/;
const isObject: Check = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Validate a JSON object against a spec. Unknown keys are rejected. */
function shape<T>(value: unknown, spec: Record<string, [Check, boolean]>): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_request', 'Something in this request was not valid.');
  for (const key of Object.keys(value)) if (!(key in spec)) throw new HttpError(400, 'invalid_request', 'Something in this request was not valid.');
  for (const [key, [check, required]] of Object.entries(spec)) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) {
      if (required) throw new HttpError(400, 'invalid_request', 'Something in this request was not valid.');
    } else if (!check(v)) {
      throw new HttpError(400, 'invalid_request', 'Something in this request was not valid.');
    }
  }
  return value as T;
}

// Bidirectional overrides and control characters can spoof how names look.
const SPOOF = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;
function cleanLine(value: string, maxLength: number) {
  return value.normalize('NFC').replace(SPOOF, '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, maxLength);
}

function normalizePhone(input: unknown, region = DEFAULT_REGION): string | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  try {
    // deno-lint-ignore no-explicit-any
    const parsed = parsePhoneNumberWithError(input, region as any);
    if (!parsed.isValid()) return null;
    const type = parsed.getType();
    if (type === 'FIXED_LINE' || type === 'PREMIUM_RATE' || type === 'SHARED_COST' || type === 'TOLL_FREE') return null;
    return parsed.number as string;
  } catch {
    return null;
  }
}

async function isValidP256Key(b64: string, algorithm: 'ECDH' | 'ECDSA') {
  try {
    const raw = Buffer.from(b64, 'base64url');
    if (raw.length !== 65 || raw[0] !== 0x04) return false;
    await crypto.subtle.importKey('raw', raw, { name: algorithm, namedCurve: 'P-256' }, true, algorithm === 'ECDSA' ? ['verify'] : []);
    return true;
  } catch {
    return false;
  }
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ------------------------------------------------------------------ PIN hashing

function scrypt(pin: string, salt: Buffer, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(pin, salt, len, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));
}
async function hashPin(pin: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${(await scrypt(pin, salt, 32)).toString('base64url')}`;
}
async function verifyPin(pin: string, stored: string) {
  const [scheme, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scrypt(pin, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

// ------------------------------------------------------------------ rate limits (in Postgres, shared by all instances)

async function enforce(key: string, limit: number, windowMs: number) {
  const [{ hit }] = await sql`select haven.hit(${key}, ${limit}, ${windowMs}) as hit`;
  if (hit > 0) throw new HttpError(429, 'rate_limited', 'Too many attempts. Please wait a moment.', { retryAfter: hit });
}

// ------------------------------------------------------------------ serializers

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

type DeviceKey = { id: string; encPub: string; sigPub: string };

async function devicesOf(userIds: string[]): Promise<Map<string, DeviceKey[]>> {
  const map = new Map<string, DeviceKey[]>();
  if (!userIds.length) return map;
  const rows = await sql`select id, user_id, enc_pub, sig_pub from haven.devices where user_id = any(${userIds}) order by created_at, id`;
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id)!.push({ id: r.id, encPub: r.enc_pub, sigPub: r.sig_pub });
  }
  return map;
}

const serializeMe = (u: Row, device: Row, devices: DeviceKey[]) => ({
  id: u.id,
  phone: u.phone ?? '',
  username: u.username ?? '',
  name: u.name,
  about: u.about,
  avatarVersion: Number(u.avatar_version),
  passkeys: Number(u.passkey_count ?? 0),
  readReceipts: u.read_receipts !== false,
  presence: u.presence !== false,
  deviceId: device.id,
  inbox: device.inbox_token,
  devices,
});

const publicProfile = (u: Row, devices: DeviceKey[] = []) => ({
  id: u.id,
  phone: u.phone ?? '',
  username: u.username ?? '',
  name: u.name,
  about: u.about,
  avatarVersion: Number(u.avatar_version),
  devices,
});

async function loadMe(userId: string, deviceId: string) {
  const [u] = await sql`select u.*, (select count(*) from haven.passkeys p where p.user_id = u.id)::int as passkey_count from haven.users u where u.id = ${userId}`;
  const [d] = await sql`select * from haven.devices where id = ${deviceId}`;
  return serializeMe(u, d, (await devicesOf([userId])).get(userId) ?? []);
}

// ------------------------------------------------------------------ sessions

function sessionCookie(token: string, maxAge: number) {
  return `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function readCookie(req: Request, name: string) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

async function createSession(reply: Reply, userId: string, deviceId: string) {
  const token = newToken();
  const t = now();
  await sql`insert into haven.sessions (token_hash, user_id, device_id, created_at, expires_at, last_used_at)
            values (${sha256(token)}, ${userId}, ${deviceId}, ${t}, ${t + SESSION_DAYS * DAY}, ${t})`;
  reply.cookie(sessionCookie(token, SESSION_DAYS * 86400));
}

async function currentUser(req: Request, reply: Reply): Promise<Row & { token_hash: string }> {
  const token = readCookie(req, COOKIE);
  if (!token || token.length < 40 || token.length > 64) throw new HttpError(401, 'unauthorized', 'Please sign in again.');
  const [row] = await sql`select s.token_hash, s.expires_at as s_expires, s.last_used_at, s.device_id, d.inbox_token, u.*
                          from haven.sessions s join haven.users u on u.id = s.user_id join haven.devices d on d.id = s.device_id
                          where s.token_hash = ${sha256(token)}`;
  const t = now();
  if (!row || Number(row.s_expires) < t) throw new HttpError(401, 'unauthorized', 'Please sign in again.');
  if (t - Number(row.last_used_at) > HOUR) {
    const extend = Number(row.s_expires) - t < (SESSION_DAYS * DAY) / 2;
    const expires = extend ? t + SESSION_DAYS * DAY : Number(row.s_expires);
    await sql`update haven.sessions set last_used_at = ${t}, expires_at = ${expires} where token_hash = ${row.token_hash}`;
    await sql`update haven.users set last_active_at = ${t} where id = ${row.id}`;
    await sql`update haven.devices set last_active_at = ${t} where id = ${row.device_id}`;
    if (extend) reply.cookie(sessionCookie(token, SESSION_DAYS * 86400));
  }
  return row as Row & { token_hash: string; device_id: string };
}

const meOf = (user: Row) => loadMe(user.id, user.device_id);

// ------------------------------------------------------------------ realtime & push

/** Tell users' apps to sync. The hint carries no data; the channel name is a per-user secret. */
async function broadcast(userIds: string[], event: 'sync' | 'conversations' | 'profiles' | 'signout' | 'read' | 'typing' | 'call', payload: Record<string, string> = {}) {
  if (!userIds.length) return;
  const rows = await sql`select inbox_token from haven.devices where user_id = any(${userIds})`;
  if (!rows.length) return;
  await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: rows.map((r) => ({ topic: `inbox:${r.inbox_token}`, event, payload })) }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

async function broadcastTopic(topic: string, event: string) {
  await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ topic, event, payload: {} }] }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

async function notifyMessages(userIds: string[]) {
  await broadcast(userIds, 'sync');
  await sendPush(userIds);
}

let vapid: { publicKey: string; privateKey: string } | null = null;
async function vapidKeys() {
  if (vapid) return vapid;
  const stored = await kvGet('vapid');
  if (stored) {
    vapid = JSON.parse(stored);
  } else {
    vapid = webpush.generateVAPIDKeys();
    await sql`insert into haven.kv (key, value) values ('vapid', ${JSON.stringify(vapid)}) on conflict (key) do nothing`;
    vapid = JSON.parse((await kvGet('vapid'))!);
  }
  return vapid!;
}

const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];
function isAllowedPushEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
}

/** Content-free push ("new message"), so nothing readable passes through push services. */
async function sendPush(userIds: string[]) {
  if (!userIds.length) return;
  try {
    const subs = await sql`select endpoint, p256dh, auth from haven.push_subscriptions where user_id = any(${userIds})`;
    if (!subs.length) return;
    const keys = await vapidKeys();
    const origin = (await allowedOrigins())[0] || 'https://haven.app';
    webpush.setVapidDetails(`mailto:push@${new URL(origin).hostname}`, keys.publicKey, keys.privateKey);
    await Promise.all(subs.map((s) =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ t: 'msg' }), {
        TTL: 86400, urgency: 'high', topic: 'new-messages', timeout: 8000,
      }).catch(async (err: { statusCode?: number }) => {
        if (err.statusCode === 404 || err.statusCode === 410) await sql`delete from haven.push_subscriptions where endpoint = ${s.endpoint}`;
      })));
  } catch (err) {
    console.error('push failed', String(err));
  }
}

/**
 * One-off announcement to every subscribed device. It is queued by inserting
 * {title, body, open} as 'announce' into haven.kv; the next request sends it
 * exactly once (the row is claimed by deleting it).
 */
async function sendPendingAnnouncement() {
  const [row] = await sql`delete from haven.kv where key = 'announce' returning value`;
  if (!row) return;
  let a: { title?: unknown; body?: unknown; open?: unknown; note?: unknown };
  try { a = JSON.parse(row.value); } catch { return; }
  // {note: 'passkey'}: everyone without a passkey yet, in their language.
  if (a.note === 'passkey') {
    const ids = (await sql`select u.id from haven.users u where not exists (select 1 from haven.passkeys p where p.user_id = u.id)`).map((r) => r.id as string);
    await notifyUsers(ids, 'passkey', '', 'passkey');
    return;
  }
  if (typeof a.title !== 'string' || typeof a.body !== 'string') return;
  // {to: [userId, ...]}: only these people (e.g. a test notification).
  const to = (a as { to?: unknown }).to;
  if (Array.isArray(to) && to.every((x) => typeof x === 'string' && ID_RE.test(x))) {
    const subs = await sql`select endpoint, p256dh, auth from haven.push_subscriptions where user_id = any(${to as string[]})`;
    await pushTo(subs, JSON.stringify({ t: 'announce', title: a.title.slice(0, 80), body: a.body.slice(0, 200), open: typeof a.open === 'string' ? a.open.slice(0, 40) : undefined }));
    return;
  }
  const payload = JSON.stringify({ t: 'announce', title: a.title.slice(0, 80), body: a.body.slice(0, 200), open: typeof a.open === 'string' ? a.open.slice(0, 40) : undefined });
  const subs = await sql`select endpoint, p256dh, auth from haven.push_subscriptions`;
  await pushTo(subs, payload);
}

type Lang = 'en' | 'de';
type Text = Record<Lang, string>;

/** Fixed notification texts in English and German; {name} is filled in. */
const NOTE: Record<string, { title: Text; body: Text }> = {
  yourTurn: {
    title: { en: 'It’s your turn today! 🎬', de: 'Heute bist du dran! 🎬' },
    body: { en: 'Vlog your day for your friends: 3 videos (6 min) or 6 photos.', de: 'Vlogge deinen Tag für deine Freunde: 3 Videos (6 Min.) oder 6 Fotos.' },
  },
  vlogsToday: {
    title: { en: '{name} vlogs today', de: '{name} vloggt heute' },
    body: { en: 'Follow their day in Vlog your Day.', de: 'Verfolge den Tag in Vlog your Day.' },
  },
  remind: {
    title: { en: 'Have you vlogged today? 🎬', de: 'Hast du heute schon gevloggt? 🎬' },
    body: { en: 'Your friends are waiting for your day. You can still post until midnight.', de: 'Deine Freunde warten auf deinen Tag. Du kannst noch bis Mitternacht posten.' },
  },
  joined: {
    title: { en: '{name} joined your friend group 👋', de: '{name} ist deiner Freundesgruppe beigetreten 👋' },
    body: { en: 'Say hi on the Today screen.', de: 'Sag Hallo auf der Heute-Seite.' },
  },
  passkey: {
    title: { en: 'Secure your Haven account 🔑', de: 'Sichere dein Haven-Konto 🔑' },
    body: { en: 'Set up a passkey with Face ID, so you can always sign in again. Tap to do it now.', de: 'Richte einen Passkey mit Face ID ein, damit du dich immer wieder anmelden kannst. Tippe, um es jetzt zu machen.' },
  },
  calling: {
    title: { en: '{name} is calling 📞', de: '{name} ruft an 📞' },
    body: { en: 'Tap to answer.', de: 'Tippe, um anzunehmen.' },
  },
  vlogged: {
    title: { en: '{name} just vlogged 🎬', de: '{name} hat gerade gevloggt 🎬' },
    body: { en: 'See their day in Vlog your Day.', de: 'Sieh dir den Tag in Vlog your Day an.' },
  },
};

/** A visible notification with a fixed text (no message content), in each user's language. */
async function notifyUsers(userIds: string[], key: keyof typeof NOTE, name = '', open?: string) {
  if (!userIds.length) return;
  const subs = await sql`select s.endpoint, s.p256dh, s.auth, u.lang from haven.push_subscriptions s join haven.users u on u.id = s.user_id
                         where s.user_id = any(${userIds})`;
  const note = NOTE[key];
  for (const lang of ['en', 'de'] as Lang[]) {
    const group = subs.filter((x) => (x.lang === 'de' ? 'de' : 'en') === lang);
    if (!group.length) continue;
    const fill = (t: string) => t.replace('{name}', name || (lang === 'de' ? 'Ein Freund' : 'A friend'));
    await pushTo(group, JSON.stringify({ t: 'announce', title: fill(note.title[lang]), body: fill(note.body[lang]), open }));
  }
}

async function pushTo(subs: Row[], payload: string) {
  if (!subs.length) return;
  const keys = await vapidKeys();
  const origin = (await allowedOrigins())[0] || 'https://haven.app';
  webpush.setVapidDetails(`mailto:push@${new URL(origin).hostname}`, keys.publicKey, keys.privateKey);
  const results = await Promise.all(subs.map((s) =>
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 7 * 86400, urgency: 'normal', timeout: 8000 })
      .then(() => true, async (err: { statusCode?: number }) => {
        if (err.statusCode === 404 || err.statusCode === 410) await sql`delete from haven.push_subscriptions where endpoint = ${s.endpoint}`;
        return false;
      })));
  console.log(`notification sent to ${results.filter(Boolean).length}/${subs.length} devices`);
}

// ------------------------------------------------------------------ Vlog your Day: friend groups ("circles")
//
// A circle is a group chat flagged as such. Every day (Europe/Berlin) one
// member is picked to vlog their day. The vlog itself is end-to-end encrypted
// media in the group; the server only knows who is picked on which day.

async function berlinNow(): Promise<{ day: string; hour: number }> {
  const [r] = await sql`select to_char((now() at time zone 'Europe/Berlin')::date, 'YYYY-MM-DD') as day,
                               extract(hour from now() at time zone 'Europe/Berlin')::int as hour`;
  return { day: r.day, hour: Number(r.hour) };
}

/** The user's friend groups (oldest first). Someone can be in several. */
async function circlesOf(userId: string): Promise<{ id: string; title: string }[]> {
  return (await sql`select c.id, c.title from haven.conversations c join haven.members m on m.conversation_id = c.id
                    where c.circle and m.user_id = ${userId} order by c.created_at`).map((r) => ({ id: r.id as string, title: r.title as string }));
}

/** One of the user's friend groups: the preferred one if they are in it, else the oldest. */
async function circleOf(userId: string, prefer?: string | null): Promise<string | null> {
  const list = await circlesOf(userId);
  return (prefer && list.find((c) => c.id === prefer)?.id) || list[0]?.id || null;
}

/** Today's pick: random among the members who have waited longest since their last turn. */
async function ensurePick(convId: string, day: string): Promise<string | null> {
  const [existing] = await sql`select user_id from haven.circle_days where conversation_id = ${convId} and day = ${day}`;
  if (existing) return existing.user_id;
  const members = await sql`select m.user_id, max(d.day) as last from haven.members m
                            join haven.users u on u.id = m.user_id and u.name <> ''
                            left join haven.circle_days d on d.conversation_id = m.conversation_id and d.user_id = m.user_id
                            where m.conversation_id = ${convId} group by m.user_id`;
  if (members.length < 2) return null;
  // Nobody should vlog for two friend groups on the same day if it can be avoided.
  const busy = new Set((await sql`select user_id from haven.circle_days where day = ${day} and conversation_id <> ${convId}`).map((r) => r.user_id as string));
  const free = members.filter((m) => !busy.has(m.user_id));
  const sorted = (free.length ? free : members)
    .map((m) => ({ id: m.user_id as string, last: m.last ? new Date(m.last).getTime() : 0, r: Math.random() }))
    .sort((a, b) => a.last - b.last || a.r - b.r);
  const pool = sorted.slice(0, Math.ceil(sorted.length / 2));
  const pick = pool[randomInt(pool.length)].id;
  await sql`insert into haven.circle_days (conversation_id, day, user_id, created_at) values (${convId}, ${day}, ${pick}, ${now()})
            on conflict do nothing`;
  const [row] = await sql`select user_id from haven.circle_days where conversation_id = ${convId} and day = ${day}`;
  return row?.user_id ?? null;
}

/** Tell the circle who vlogs today: from 6:00 (German time), once per day. */
async function announcePick(convId: string, day: string, hour: number) {
  if (hour < 6 || hour >= 22) return;
  const [row] = await sql`update haven.circle_days set notified = true
                          where conversation_id = ${convId} and day = ${day} and not notified returning user_id`;
  if (!row) return;
  const [picked] = await sql`select name from haven.users where id = ${row.user_id}`;
  const others = (await memberIds(convId)).filter((id) => id !== row.user_id);
  await notifyUsers([row.user_id], 'yourTurn', '', 'today');
  await notifyUsers(others, 'vlogsToday', picked?.name || '', 'today');
  await broadcast([row.user_id, ...others], 'conversations');
}

/** At 18:00 (German time): ask today's pick once whether they vlogged yet, if they haven't posted. */
async function remindPick(convId: string, day: string, hour: number) {
  if (hour < 18 || hour >= 22) return;
  const [row] = await sql`update haven.circle_days set reminded = true
                          where conversation_id = ${convId} and day = ${day} and not reminded and posted_at = 0 returning user_id`;
  if (!row) return;
  await notifyUsers([row.user_id], 'remind', '', 'today');
}

async function circleTick() {
  const { day, hour } = await berlinNow();
  const circles = await sql`select id from haven.conversations where circle`;
  for (const c of circles) {
    try {
      if (await ensurePick(c.id, day)) {
        await announcePick(c.id, day, hour);
        await remindPick(c.id, day, hour);
      }
    } catch (err) {
      console.error('circle tick', String(err));
    }
  }
}

// ------------------------------------------------------------------ sign-in

/**
 * Sign in to an account (proven with a passkey). Same keys as a known device:
 * that device signs in again. New keys: this becomes the account's only device
 * and every other device is signed out (like setting up a new phone).
 */
// deno-lint-ignore no-explicit-any
async function completeSignIn(reply: Reply, account: { id: string; create?: { name: string }; extra?: (tx: any) => Promise<unknown> }, encPub: string, sigPub: string, deviceName: string) {
  const t = now();
  const result = await sql.begin(async (tx) => {
    let isNew = false;
    let oldTokens: string[] = [];
    let user: Row;
    if (account.create) {
      isNew = true;
      [user] = await tx`insert into haven.users (id, phone, name, created_at, last_active_at) values (${account.id}, null, ${account.create.name}, ${t}, ${t}) returning *`;
    } else {
      [user] = await tx`select * from haven.users where id = ${account.id} for update`;
      if (!user) throw new HttpError(400, 'no_account', 'This passkey belongs to an account that no longer exists.');
    }
    if (account.extra) await account.extra(tx);
    let [device] = await tx`select * from haven.devices where user_id = ${user.id} and enc_pub = ${encPub} and sig_pub = ${sigPub}`;
    if (device) {
      await tx`delete from haven.sessions where device_id = ${device.id}`;
      [device] = await tx`update haven.devices set last_active_at = ${t} where id = ${device.id} returning *`;
    } else {
      oldTokens = (await tx`delete from haven.devices where user_id = ${user.id} returning inbox_token`).map((r: Row) => r.inbox_token);
      [device] = await tx`insert into haven.devices (id, user_id, enc_pub, sig_pub, inbox_token, name, created_at, last_active_at)
                          values (${randomId()}, ${user.id}, ${encPub}, ${sigPub}, ${newToken()}, ${deviceName}, ${t}, ${t}) returning *`;
    }
    await tx`update haven.users set last_active_at = ${t} where id = ${user.id}`;
    return { user, device, isNew, oldTokens, keysChanged: oldTokens.length > 0 };
  });
  // Tell the previous devices (on their old channels) that their session has ended.
  for (const tok of result.oldTokens) await broadcastTopic(`inbox:${tok}`, 'signout');
  // Contacts refresh keys and see the safety number change.
  if (result.keysChanged) await broadcast(await contactsOf(result.user.id), 'profiles');
  await createSession(reply, result.user.id, result.device.id);
  return { status: 'ok', isNew: result.isNew, me: await loadMe(result.user.id, result.device.id) };
}

// ------------------------------------------------------------------ conversation helpers

async function membershipOrThrow(conversationId: string, userId: string) {
  const [row] = await sql`select c.*, m.role as my_role from haven.conversations c
                          join haven.members m on m.conversation_id = c.id and m.user_id = ${userId}
                          where c.id = ${conversationId}`;
  if (!row) throw new HttpError(404, 'not_found', 'This chat does not exist or you are no longer a member.');
  return row;
}

async function memberIds(conversationId: string): Promise<string[]> {
  return (await sql`select user_id from haven.members where conversation_id = ${conversationId}`).map((r) => r.user_id);
}

async function contactsOf(userId: string): Promise<string[]> {
  return (await sql`select distinct m2.user_id as id from haven.members m1
                    join haven.members m2 on m2.conversation_id = m1.conversation_id
                    where m1.user_id = ${userId} and m2.user_id <> ${userId}`).map((r) => r.id);
}

async function hasBlocked(blockerId: string, blockedId: string) {
  const [r] = await sql`select 1 from haven.blocks where blocker_id = ${blockerId} and blocked_id = ${blockedId}`;
  return Boolean(r);
}

async function serializeConversations(convs: Row[], userId: string) {
  if (!convs.length) return [];
  const ids = convs.map((c) => c.id);
  const members = await sql`select m.conversation_id, m.role, m.joined_at, m.last_read_at, u.read_receipts, u.id, u.phone, u.username, u.name, u.about, u.avatar_version
                            from haven.members m join haven.users u on u.id = m.user_id
                            where m.conversation_id = any(${ids}) order by m.joined_at, u.id`;
  const devices = await devicesOf([...new Set(members.map((m) => m.id as string))]);
  return convs.map((c) => {
    const list = members.filter((m) => m.conversation_id === c.id);
    return {
      id: c.id,
      kind: c.kind,
      title: c.title,
      createdBy: c.created_by,
      createdAt: Number(c.created_at),
      updatedAt: Number(c.updated_at),
      myRole: list.find((m) => m.id === userId)?.role ?? 'member',
      circle: Boolean(c.circle),
      avatarVersion: Number(c.avatar_version ?? 0),
      theme: String(c.theme ?? ''),
      // Read positions are only shared by people who keep read receipts on.
      members: list.map((m) => ({ ...publicProfile(m, devices.get(m.id) ?? []), role: m.role, lastReadAt: m.read_receipts ? Number(m.last_read_at) : 0 })),
    };
  });
}

async function oneConversation(id: string, userId: string) {
  const [c] = await sql`select * from haven.conversations where id = ${id}`;
  return (await serializeConversations([c], userId))[0];
}

/** Queue a message for every device of these users (optionally except one device). */
// deno-lint-ignore no-explicit-any
async function queueFor(tx: any, seq: number | string, userIds: string[], exceptDevice: string | null = null) {
  if (!userIds.length) return;
  await tx`insert into haven.message_recipients (seq, device_id)
           select ${seq}, id from haven.devices where user_id = any(${userIds}) and id is distinct from ${exceptDevice}`;
}

// deno-lint-ignore no-explicit-any
async function systemEvent(tx: any, conversationId: string, body: unknown, recipients: string[]) {
  if (!recipients.length) return;
  const t = now();
  const [m] = await tx`insert into haven.messages (id, conversation_id, sender_id, kind, body, created_at)
                       values (${randomId()}, ${conversationId}, null, 'system', ${JSON.stringify(body)}, ${t}) returning seq`;
  await queueFor(tx, m.seq, recipients);
  await tx`update haven.conversations set updated_at = ${t} where id = ${conversationId}`;
}

// deno-lint-ignore no-explicit-any
async function namesOf(tx: any, ids: string[]) {
  const rows = await tx`select id, name from haven.users where id = any(${ids})`;
  return Object.fromEntries(ids.map((id) => [id, rows.find((r: Row) => r.id === id)?.name || '']));
}

// deno-lint-ignore no-explicit-any
async function ensureAdmin(tx: any, conversationId: string) {
  const [admin] = await tx`select 1 from haven.members where conversation_id = ${conversationId} and role = 'admin'`;
  if (admin) return;
  await tx`update haven.members set role = 'admin' where conversation_id = ${conversationId} and user_id =
           (select user_id from haven.members where conversation_id = ${conversationId} order by joined_at, user_id limit 1)`;
}

async function namedUserExists(id: string) {
  const [r] = await sql`select 1 from haven.users where id = ${id} and name <> ''`;
  return Boolean(r);
}

function validEnvelope(e: unknown): boolean {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const env = e as Row;
  const allowed = ['v', 'ts', 'eph', 'iv', 'ct', 'keys', 'sig'];
  if (Object.keys(env).some((k) => !allowed.includes(k))) return false;
  if (env.v !== 1 || !int(0)(env.ts)) return false;
  if (!str(1, 100, B64URL)(env.eph) || !str(1, 24, B64URL)(env.iv) || !str(1, 96 * 1024, B64URL)(env.ct) || !str(1, 120, B64URL)(env.sig)) return false;
  if (!env.keys || typeof env.keys !== 'object' || Array.isArray(env.keys)) return false;
  const entries = Object.entries(env.keys as Row);
  if (entries.length > MAX_GROUP * 4) return false; // several devices per member
  return entries.every(([id, k]) =>
    ID_RE.test(id) && k && typeof k === 'object' && Object.keys(k).every((x) => ['kv', 'iv', 'k'].includes(x)) &&
    int(1)(k.kv) && str(1, 24, B64URL)(k.iv) && str(1, 80, B64URL)(k.k));
}

function isJpeg(b: Uint8Array) {
  return b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
}

async function cleanup() {
  const t = now();
  await sql`delete from haven.sessions where expires_at < ${t}`;
  await sql`delete from haven.passkey_challenges where expires_at < ${t}`;
  await sql`delete from haven.call_offers where expires_at < ${t}`;
  await sql`delete from haven.link_requests where expires_at < ${t}`;
  await sql`delete from haven.rate_limits where reset_at < ${t}`;
  await sql`delete from haven.messages where created_at < ${t - RETENTION_DAYS * DAY}`;
  await sql`delete from haven.messages m where not exists (select 1 from haven.message_recipients r where r.seq = m.seq)`;
  const old = await sql`select name from storage.objects where bucket_id = 'attachments' and name not like 'backups/%' and created_at < now() - make_interval(days => ${RETENTION_DAYS}) limit 200`;
  if (old.length) await storageCall('DELETE', '/object/attachments', { prefixes: old.map((o) => o.name) }).catch(() => {});
  // Vlogs are kept on the server for a week; devices keep their decrypted copies.
  const vlogs = await sql`select o.name from storage.objects o join haven.conversations c on c.id = split_part(o.name, '/', 1) and c.circle
                          where o.bucket_id = 'attachments' and o.created_at < now() - make_interval(days => ${VLOG_RETENTION_DAYS}) limit 200`;
  if (vlogs.length) await storageCall('DELETE', '/object/attachments', { prefixes: vlogs.map((o) => o.name) }).catch(() => {});
}

// ------------------------------------------------------------------ routing

type Ctx = { req: Request; reply: Reply; params: Record<string, string>; body: unknown; raw: Uint8Array; ip: string; url: URL };
type Handler = (ctx: Ctx) => Promise<unknown>;
const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler; auth: boolean }[] = [];

function route(method: string, path: string, handler: Handler, auth = true) {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([A-Za-z0-9_-]{16,40})'; }) + '$');
  routes.push({ method, pattern, keys, handler, auth });
}

const ok = { ok: true };

// ---- auth

// Accounts are protected by passkeys (Face ID / Touch ID / device PIN). The
// passkey is stored by the phone's password manager (iCloud Keychain, Google
// Password Manager) and syncs to the user's other devices, so a new phone can
// sign in with it. No phone number and no outside service is needed.

async function relyingParty(req: Request) {
  const given = req.headers.get('origin');
  const origins = await allowedOrigins();
  const origin = given && origins.includes(given) ? given : origins[0];
  if (!origin) throw new HttpError(500, 'server_error', 'Something went wrong on our side. Please try again.');
  return { origin, rpID: new URL(origin).hostname };
}

async function newChallenge(kind: string, challenge: string, userId: string | null, userHandle: string | null) {
  const id = randomId();
  await sql`insert into haven.passkey_challenges (id, challenge, kind, user_id, user_handle, expires_at)
            values (${id}, ${challenge}, ${kind}, ${userId}, ${userHandle}, ${now() + 5 * MIN})`;
  return id;
}

async function takeChallenge(id: string, kind: string) {
  const [c] = await sql`delete from haven.passkey_challenges where id = ${id} and kind = ${kind} returning *`;
  if (!c || Number(c.expires_at) < now()) throw new HttpError(400, 'challenge_expired', 'This took too long. Please try again.');
  return c;
}

/** Options for creating a passkey. New accounts get their id now; it becomes the passkey's user handle. */
async function registrationOptions(req: Request, kind: 'register' | 'add', userId: string | null, label: string) {
  const { rpID } = await relyingParty(req);
  const handle = userId ?? randomId();
  const existing = userId ? await sql`select id, transports from haven.passkeys where user_id = ${userId}` : [];
  const options = await generateRegistrationOptions({
    rpName: 'Haven',
    rpID,
    userName: label,
    userDisplayName: label,
    userID: new TextEncoder().encode(handle),
    attestationType: 'none',
    // deno-lint-ignore no-explicit-any
    excludeCredentials: existing.map((c: Row) => ({ id: c.id, transports: c.transports ? c.transports.split(',') : undefined })) as any,
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  const challengeId = await newChallenge(kind, options.challenge, userId, handle);
  return { challengeId, options };
}

// deno-lint-ignore no-explicit-any
async function checkRegistration(req: Request, c: Row, response: any) {
  const { origin, rpID } = await relyingParty(req);
  let result;
  try {
    result = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
  } catch (e) {
    console.error('passkey register', String(e));
    throw new HttpError(400, 'passkey_failed', 'The passkey could not be set up. Please try again.');
  }
  if (!result.verified || !result.registrationInfo) throw new HttpError(400, 'passkey_failed', 'The passkey could not be set up. Please try again.');
  const cred = result.registrationInfo.credential;
  return { id: cred.id, publicKey: Buffer.from(cred.publicKey).toString('base64url'), counter: cred.counter, transports: (cred.transports ?? []).join(',') };
}

// deno-lint-ignore no-explicit-any
async function savePasskey(tx: any, userId: string, cred: { id: string; publicKey: string; counter: number; transports: string }) {
  const t = now();
  await tx`insert into haven.passkeys (id, user_id, public_key, counter, transports, created_at, last_used_at)
           values (${cred.id}, ${userId}, ${cred.publicKey}, ${cred.counter}, ${cred.transports}, ${t}, ${t})`;
}

async function validKeys(encPub: string, sigPub: string) {
  if (!(await isValidP256Key(encPub, 'ECDH')) || !(await isValidP256Key(sigPub, 'ECDSA'))) {
    throw new HttpError(400, 'invalid_keys', 'Your device produced invalid keys. Please reload and try again.');
  }
}

// ---- new account

route('POST', '/auth/passkey/register/options', async ({ req, body, ip }) => {
  const { name } = shape<{ name: string }>(body, { name: [str(1, 200), true] });
  const clean = cleanLine(name, 40);
  if (!clean) throw new HttpError(400, 'invalid_name', 'Please enter a name.');
  await enforce(`pkreg:ip:${ip}`, 30, HOUR);
  return registrationOptions(req, 'register', null, clean);
}, false);

route('POST', '/auth/passkey/register', async ({ req, reply, body, ip }) => {
  const b = shape<{ challengeId: string; response: unknown; name: string; encPub: string; sigPub: string; deviceName?: string }>(body, {
    challengeId: [isId, true], response: [isObject, true], name: [str(1, 200), true], encPub: [PUBKEY, true], sigPub: [PUBKEY, true], deviceName: [str(0, 60), false],
  });
  await enforce(`pkreg:ip:${ip}`, 30, HOUR);
  const name = cleanLine(b.name, 40);
  if (!name) throw new HttpError(400, 'invalid_name', 'Please enter a name.');
  await validKeys(b.encPub, b.sigPub);
  const c = await takeChallenge(b.challengeId, 'register');
  const cred = await checkRegistration(req, c, b.response);
  return completeSignIn(reply, { id: c.user_handle, create: { name }, extra: (tx) => savePasskey(tx, c.user_handle, cred) }, b.encPub, b.sigPub, cleanLine(b.deviceName ?? '', 40));
}, false);

// ---- sign in

route('POST', '/auth/passkey/login/options', async ({ req, ip }) => {
  await enforce(`pklogin:ip:${ip}`, 60, HOUR);
  const { rpID } = await relyingParty(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
  return { challengeId: await newChallenge('login', options.challenge, null, null), options };
}, false);

/** Check a passkey sign-in (challenge from /auth/passkey/login/options). Returns the passkey row (with user_id). */
async function passkeyOwner(req: Request, challengeId: string, response: Row) {
  const c = await takeChallenge(challengeId, 'login');
  const credId = typeof response.id === 'string' ? response.id : '';
  const [pk] = credId ? await sql`select * from haven.passkeys where id = ${credId}` : [];
  if (!pk) throw new HttpError(400, 'unknown_passkey', 'This passkey is not linked to a Haven account (any more).');
  const { origin, rpID } = await relyingParty(req);
  let result;
  try {
    result = await verifyAuthenticationResponse({
      // deno-lint-ignore no-explicit-any
      response: response as any,
      expectedChallenge: c.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      // deno-lint-ignore no-explicit-any
      credential: { id: pk.id, publicKey: new Uint8Array(Buffer.from(pk.public_key, 'base64url')), counter: Number(pk.counter), transports: pk.transports ? pk.transports.split(',') as any : undefined },
    });
  } catch (e) {
    console.error('passkey login', String(e));
    throw new HttpError(400, 'passkey_failed', 'Sign-in with this passkey failed. Please try again.');
  }
  if (!result.verified) throw new HttpError(400, 'passkey_failed', 'Sign-in with this passkey failed. Please try again.');
  await sql`update haven.passkeys set counter = ${result.authenticationInfo.newCounter}, last_used_at = ${now()} where id = ${pk.id}`;
  return pk;
}

const KEYPAIR: Check = (v) => isObject(v) && Object.keys(v as Row).every((k) => k === 'encPub' || k === 'sigPub') &&
  PUBKEY((v as Row).encPub) && PUBKEY((v as Row).sigPub);

route('POST', '/auth/passkey/login', async ({ req, reply, body, ip }) => {
  const b = shape<{ challengeId: string; response: Row; fresh: { encPub: string; sigPub: string }; stored?: { encPub: string; sigPub: string }; knownUserId?: string; deviceName?: string }>(body, {
    challengeId: [isId, true], response: [isObject, true], fresh: [KEYPAIR, true], stored: [KEYPAIR, false], knownUserId: [isId, false], deviceName: [str(0, 60), false],
  });
  await enforce(`pklogin:ip:${ip}`, 60, HOUR);
  const pk = await passkeyOwner(req, b.challengeId, b.response);
  // The same account as before on this device: keep its keys (and its chats).
  const keys = b.stored && b.knownUserId === pk.user_id ? b.stored : b.fresh;
  await validKeys(keys.encPub, keys.sigPub);
  const res = await completeSignIn(reply, { id: pk.user_id }, keys.encPub, keys.sigPub, cleanLine(b.deviceName ?? '', 40));
  return { ...res, keptKeys: keys === b.stored };
}, false);

// ---- add a passkey to the signed-in account (accounts made before passkeys)

route('POST', '/passkeys/options', async ({ req, reply }) => {
  const user = await currentUser(req, reply);
  await enforce(`pkadd:${user.id}`, 20, HOUR);
  return registrationOptions(req, 'add', user.id, user.username ? `@${user.username}` : user.name || 'Haven');
});

route('POST', '/passkeys', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ challengeId: string; response: unknown }>(body, { challengeId: [isId, true], response: [isObject, true] });
  const c = await takeChallenge(b.challengeId, 'add');
  if (c.user_id !== user.id) throw new HttpError(400, 'challenge_expired', 'This took too long. Please try again.');
  const cred = await checkRegistration(req, c, b.response);
  await savePasskey(sql, user.id, cred);
  return { me: await meOf(user) };
});

route('POST', '/auth/logout', async ({ reply, req }) => {
  const user = await currentUser(req, reply);
  // Signing out removes this device (its keys, queued messages and push subscription).
  await sql`delete from haven.devices where id = ${user.device_id}`;
  reply.cookie(sessionCookie('', 0));
  await broadcast(await contactsOf(user.id), 'profiles');
  return ok;
}, false);

// ---- linked devices (QR code / pairing code)

const LINK_CODE = /^[A-Z2-9]{12}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newLinkCode() {
  const bytes = randomBytes(12);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % 32]).join('');
}

// The new device asks to be linked and shows the code as a QR code.
route('POST', '/link/start', async ({ body, ip }) => {
  const b = shape<{ encPub: string; sigPub: string; name: string }>(body, { encPub: [PUBKEY, true], sigPub: [PUBKEY, true], name: [str(0, 60), true] });
  await enforce(`link:ip:${ip}`, 30, HOUR);
  if (!(await isValidP256Key(b.encPub, 'ECDH')) || !(await isValidP256Key(b.sigPub, 'ECDSA'))) {
    throw new HttpError(400, 'invalid_keys', 'Your device produced invalid keys. Please reload and try again.');
  }
  const id = randomId();
  const code = newLinkCode();
  const pollSecret = newToken();
  const t = now();
  await sql`insert into haven.link_requests (id, code_hash, poll_hash, enc_pub, sig_pub, name, expires_at, created_at)
            values (${id}, ${sha256(code)}, ${sha256(pollSecret)}, ${b.encPub}, ${b.sigPub}, ${cleanLine(b.name, 40)}, ${t + 5 * MIN}, ${t})`;
  return { linkId: id, code, pollSecret, expiresAt: t + 5 * MIN };
}, false);

// A signed-in device scans the code and approves.
route('POST', '/link/approve', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { code, history } = shape<{ code: string; history?: boolean }>(body, { code: [str(12, 12, LINK_CODE), true], history: [(v) => typeof v === 'boolean', false] });
  await enforce(`link:approve:${user.id}`, 10, HOUR);
  // Approved requests stay around a little longer so the history can be handed over.
  const [r] = await sql`update haven.link_requests set user_id = ${user.id}, history_state = ${history ? 'pending' : 'none'}, expires_at = ${now() + 20 * MIN}
                        where code_hash = ${sha256(code)} and user_id is null and expires_at > ${now()} returning id, name, enc_pub`;
  if (!r) throw new HttpError(400, 'link_invalid', 'This code is not valid or has expired. Show a new code on the other device.');
  return { ok: true, name: r.name, linkId: r.id, encPub: r.enc_pub };
});

// The new device waits for approval, then gets its own device and session.
route('POST', '/link/poll', async ({ body, reply, ip }) => {
  const b = shape<{ linkId: string; pollSecret: string }>(body, { linkId: [isId, true], pollSecret: [str(40, 64), true] });
  await enforce(`link:poll:${ip}`, 600, 10 * MIN);
  const [r] = await sql`select * from haven.link_requests where id = ${b.linkId}`;
  if (!r || !safeEqual(r.poll_hash, sha256(b.pollSecret)) || Number(r.expires_at) < now()) {
    throw new HttpError(400, 'link_expired', 'This code expired. Show a new one.');
  }
  if (!r.user_id) return { status: 'pending' };
  if (r.device_id) throw new HttpError(400, 'link_expired', 'This code was already used. Show a new one.');
  const t = now();
  const deviceId = randomId();
  const device = await sql.begin(async (tx) => {
    const claimed = await tx`update haven.link_requests set device_id = ${deviceId} where id = ${r.id} and device_id is null returning id`;
    if (!claimed.length) throw new HttpError(400, 'link_expired', 'This code was already used. Show a new one.');
    const [d] = await tx`insert into haven.devices (id, user_id, enc_pub, sig_pub, inbox_token, name, created_at, last_active_at)
                         values (${deviceId}, ${r.user_id}, ${r.enc_pub}, ${r.sig_pub}, ${newToken()}, ${r.name}, ${t}, ${t}) returning *`;
    return d;
  });
  if (r.history_state === 'none') await sql`delete from haven.link_requests where id = ${r.id}`;
  await createSession(reply, r.user_id, device.id);
  await broadcast(await contactsOf(r.user_id), 'profiles');
  await broadcast([r.user_id], 'profiles');
  return { status: 'ok', me: await loadMe(r.user_id, device.id), history: r.history_state !== 'none' };
}, false);

route('GET', '/devices', async ({ req, reply }) => {
  const user = await currentUser(req, reply);
  const rows = await sql`select id, name, created_at, last_active_at from haven.devices where user_id = ${user.id} order by created_at`;
  return {
    devices: rows.map((d) => ({ id: d.id, name: d.name, createdAt: Number(d.created_at), lastActiveAt: Number(d.last_active_at), current: d.id === user.device_id })),
  };
});

route('DELETE', '/devices/:deviceId', async ({ req, reply, params }) => {
  const user = await currentUser(req, reply);
  const [d] = await sql`delete from haven.devices where id = ${params.deviceId} and user_id = ${user.id} returning inbox_token`;
  if (!d) throw new HttpError(404, 'not_found');
  await broadcastTopic(`inbox:${d.inbox_token}`, 'signout');
  await broadcast(await contactsOf(user.id), 'profiles');
  await broadcast([user.id], 'profiles');
  return ok;
});

// ---- chat history hand-over (old device -> new device, end-to-end encrypted)

const transferPath = (linkId: string) => `transfer/${linkId}`;

async function ownLink(linkId: string, userId: string) {
  const [r] = await sql`select * from haven.link_requests where id = ${linkId} and user_id = ${userId} and expires_at > ${now()}`;
  if (!r) throw new HttpError(404, 'not_found', 'This transfer is no longer available.');
  return r;
}

// Old device: where to upload the encrypted bundle.
route('POST', '/link/history/upload', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { linkId } = shape<{ linkId: string; size: number }>(body, { linkId: [isId, true], size: [int(1, MAX_ATTACHMENT), true] });
  const r = await ownLink(linkId, user.id);
  if (r.history_state !== 'pending') throw new HttpError(409, 'not_pending');
  const data = await storageCall('POST', `/object/upload/sign/attachments/${transferPath(linkId)}`, {});
  return { uploadUrl: `${SUPABASE_URL}/storage/v1${data.url}` };
});

// Old device: bundle uploaded (key is wrapped for the new device), or nothing to send.
route('POST', '/link/history/done', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ linkId: string; key?: string }>(body, { linkId: [isId, true], key: [str(1, 2000), false] });
  await ownLink(b.linkId, user.id);
  if (b.key) await sql`update haven.link_requests set history_state = 'ready', history_key = ${b.key} where id = ${b.linkId}`;
  else await sql`update haven.link_requests set history_state = 'none' where id = ${b.linkId}`;
  await broadcast([user.id], 'sync');
  return ok;
});

// New device: is the history there yet?
route('GET', '/link/history', async ({ req, reply }) => {
  const user = await currentUser(req, reply);
  const [r] = await sql`select * from haven.link_requests where device_id = ${user.device_id}`;
  if (!r || r.history_state === 'none') return { state: 'none' };
  if (r.history_state === 'pending') return { state: Number(r.expires_at) > now() ? 'pending' : 'none' };
  const data = await storageCall('POST', `/object/sign/attachments/${transferPath(r.id)}`, { expiresIn: 600 });
  return { state: 'ready', url: `${SUPABASE_URL}/storage/v1${data.signedURL ?? data.signedUrl}`, key: r.history_key };
});

// New device: imported (or gave up). The bundle is deleted from the server.
route('POST', '/link/history/finish', async ({ req, reply }) => {
  const user = await currentUser(req, reply);
  const [r] = await sql`delete from haven.link_requests where device_id = ${user.device_id} returning id`;
  if (r) await storageCall('DELETE', '/object/attachments', { prefixes: [transferPath(r.id)] }).catch(() => {});
  return ok;
});

// ---- encrypted chat backup
//
// The phone encrypts its chats with a random backup key before uploading. That
// key is stored here only wrapped with a key derived from the user's backup PIN
// (on the phone; the server never sees it). To get the wrapped key back, the
// phone proves it knows the PIN with a second value derived from it; the server
// checks that with scrypt and allows 5 tries, then 24 hours of waiting.

const backupPath = (userId: string) => `backups/${userId}`;
const B64_SHORT = str(16, 200, B64URL);

route('GET', '/backup', async ({ req, reply }) => {
  const user = await currentUser(req, reply);
  return { enabled: Boolean(user.backup_auth), salt: user.backup_salt ?? null, updatedAt: Number(user.backup_updated_at ?? 0) };
});

route('PUT', '/backup/pin', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ salt: string; auth: string; wrapped: string }>(body, { salt: [B64_SHORT, true], auth: [B64_SHORT, true], wrapped: [B64_SHORT, true] });
  await enforce(`backuppin:${user.id}`, 10, HOUR);
  await sql`update haven.users set backup_salt = ${b.salt}, backup_auth = ${await hashPin(b.auth)}, backup_wrapped = ${b.wrapped},
            backup_failures = 0, backup_locked_until = 0 where id = ${user.id}`;
  return ok;
});

route('POST', '/backup/unlock', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { auth } = shape<{ auth: string }>(body, { auth: [B64_SHORT, true] });
  await enforce(`backupunlock:${user.id}`, 20, HOUR);
  if (!user.backup_auth) throw new HttpError(404, 'no_backup', 'There is no backup for this account.');
  if (Number(user.backup_locked_until) > now()) {
    throw new HttpError(429, 'backup_locked', 'Too many wrong PINs. Try again later.', { retryAfter: Math.ceil((Number(user.backup_locked_until) - now()) / 1000) });
  }
  if (!(await verifyPin(auth, user.backup_auth))) {
    const failures = Number(user.backup_failures) + 1;
    const locked = failures >= 5 ? now() + DAY : 0;
    await sql`update haven.users set backup_failures = ${locked ? 0 : failures}, backup_locked_until = ${locked} where id = ${user.id}`;
    throw new HttpError(400, 'invalid_pin', locked ? 'Too many wrong PINs. Try again in 24 hours.' : 'Wrong backup PIN.', { attemptsLeft: locked ? 0 : 5 - failures });
  }
  await sql`update haven.users set backup_failures = 0 where id = ${user.id}`;
  let url: string | null = null;
  if (Number(user.backup_updated_at)) {
    const data = await storageCall('POST', `/object/sign/attachments/${backupPath(user.id)}`, { expiresIn: 600 }).catch(() => null);
    if (data) url = `${SUPABASE_URL}/storage/v1${data.signedURL ?? data.signedUrl}`;
  }
  return { wrapped: user.backup_wrapped, url, updatedAt: Number(user.backup_updated_at) };
});

route('POST', '/backup/upload', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  shape<{ size: number }>(body, { size: [int(1, MAX_ATTACHMENT), true] });
  if (!user.backup_auth) throw new HttpError(400, 'no_backup', 'Set a backup PIN first.');
  await enforce(`backupup:${user.id}`, 120, HOUR);
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/upload/sign/attachments/${backupPath(user.id)}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', 'x-upsert': 'true' },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`storage ${res.status}: ${JSON.stringify(data)}`);
  return { uploadUrl: `${SUPABASE_URL}/storage/v1${data.url}` };
});

route('POST', '/backup/done', async ({ req, reply }) => {
  const user = await currentUser(req, reply);
  const t = now();
  await sql`update haven.users set backup_updated_at = ${t} where id = ${user.id}`;
  return { updatedAt: t };
});

route('DELETE', '/backup', async ({ req, reply }) => {
  const user = await currentUser(req, reply);
  await storageCall('DELETE', '/object/attachments', { prefixes: [backupPath(user.id)] }).catch(() => {});
  await sql`update haven.users set backup_salt = null, backup_auth = null, backup_wrapped = null, backup_updated_at = 0 where id = ${user.id}`;
  return ok;
});

// ---- me

route('GET', '/me', async ({ req, reply }) => ({ me: await meOf(await currentUser(req, reply)) }));

route('PATCH', '/me', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ name?: string; about?: string; readReceipts?: boolean; presence?: boolean; lang?: string; username?: string }>(body, {
    username: [str(0, 21), false], name: [str(0, 200), false], about: [str(0, 500), false], readReceipts: [(v) => typeof v === 'boolean', false], presence: [(v) => typeof v === 'boolean', false],
    lang: [(v) => v === 'en' || v === 'de', false],
  });
  if (b.lang !== undefined) {
    await sql`update haven.users set lang = ${b.lang} where id = ${user.id}`;
    if (Object.keys(b).length === 1) return { me: await meOf(user) };
  }
  if (b.readReceipts !== undefined) await sql`update haven.users set read_receipts = ${b.readReceipts} where id = ${user.id}`;
  // Turning "last seen & online" off also forgets when this user was last seen.
  if (b.presence !== undefined) {
    await sql`update haven.users set presence = ${b.presence}, last_seen_at = case when ${b.presence} then last_seen_at else 0 end,
              online_until = case when ${b.presence} then online_until else 0 end where id = ${user.id}`;
  }
  if (b.name !== undefined) {
    const name = cleanLine(b.name, 40);
    if (!name) throw new HttpError(400, 'invalid_name', 'Please enter a name.');
    await sql`update haven.users set name = ${name} where id = ${user.id}`;
  }
  if (b.about !== undefined) await sql`update haven.users set about = ${cleanLine(b.about, 140)} where id = ${user.id}`;
  if (b.username !== undefined) {
    const handle = b.username.replace(/^@/, '').toLowerCase();
    if (!handle) await sql`update haven.users set username = null where id = ${user.id}`;
    else {
      if (!USERNAME.test(handle)) throw new HttpError(400, 'invalid_username', 'Usernames have 3–20 letters, numbers, dots or underscores.');
      await enforce(`username:${user.id}`, 20, HOUR);
      const [taken] = await sql`select 1 from haven.users where username = ${handle} and id <> ${user.id}`;
      if (taken) throw new HttpError(400, 'username_taken', 'This username is already taken.');
      await sql`update haven.users set username = ${handle} where id = ${user.id}`;
    }
  }
  await broadcast(await contactsOf(user.id), 'profiles');
  return { me: await meOf(user) };
});

route('PUT', '/me/avatar', async ({ req, reply, raw }) => {
  const user = await currentUser(req, reply);
  await enforce(`avatar:${user.id}`, 20, HOUR);
  if (req.headers.get('content-type') !== 'image/jpeg' || raw.length > MAX_AVATAR || !isJpeg(raw)) {
    throw new HttpError(400, 'invalid_image', 'This picture could not be used.');
  }
  const t = now();
  await sql.begin(async (tx) => {
    await tx`insert into haven.avatars (user_id, data, updated_at) values (${user.id}, ${Buffer.from(raw)}, ${t})
             on conflict (user_id) do update set data = excluded.data, updated_at = excluded.updated_at`;
    await tx`update haven.users set avatar_version = ${t} where id = ${user.id}`;
  });
  await broadcast(await contactsOf(user.id), 'profiles');
  return { me: await meOf(user) };
});

route('DELETE', '/me/avatar', async ({ req, reply }) => {
  const user = await currentUser(req, reply);
  await sql.begin(async (tx) => {
    await tx`delete from haven.avatars where user_id = ${user.id}`;
    await tx`update haven.users set avatar_version = 0 where id = ${user.id}`;
  });
  await broadcast(await contactsOf(user.id), 'profiles');
  return { me: await meOf(user) };
});

route('DELETE', '/me', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  shape<{ confirm: string }>(body, { confirm: [(v) => v === 'DELETE', true] });
  const contacts = await contactsOf(user.id);
  await sql.begin(async (tx) => {
    const groups = await tx`select c.id from haven.conversations c join haven.members m on m.conversation_id = c.id
                            where m.user_id = ${user.id} and c.kind = 'group'`;
    for (const g of groups) {
      const others = (await tx`select user_id from haven.members where conversation_id = ${g.id} and user_id <> ${user.id}`).map((r: Row) => r.user_id);
      await systemEvent(tx, g.id, { type: 'member_left', actorId: user.id, names: await namesOf(tx, [user.id]) }, others);
    }
    await tx`delete from haven.users where id = ${user.id}`;
    for (const g of groups) await ensureAdmin(tx, g.id);
    await tx`delete from haven.conversations c where not exists (select 1 from haven.members m where m.conversation_id = c.id)`;
  });
  await storageCall('DELETE', '/object/attachments', { prefixes: [backupPath(user.id)] }).catch(() => {});
  reply.cookie(sessionCookie('', 0));
  await broadcast(contacts, 'conversations');
  await notifyMessages(contacts);
  return ok;
});

// ---- last seen & online (both people must share it, like read receipts)

route('POST', '/presence', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { state } = shape<{ state: string }>(body, { state: [(v) => v === 'online' || v === 'offline', true] });
  await enforce(`presence:${user.id}`, 600, HOUR);
  if (user.presence === false) return ok;
  const t = now();
  await sql`update haven.users set last_seen_at = ${t}, online_until = ${state === 'online' ? t + 75_000 : t} where id = ${user.id}`;
  return ok;
});

route('GET', '/presence/:userId', async ({ req, reply, params }) => {
  const user = await currentUser(req, reply);
  if (user.presence === false) return { visible: false };
  const [shared] = await sql`select 1 from haven.members a join haven.members b on a.conversation_id = b.conversation_id
                             where a.user_id = ${user.id} and b.user_id = ${params.userId} limit 1`;
  if (!shared || (await hasBlocked(params.userId, user.id))) return { visible: false };
  const [u] = await sql`select presence, last_seen_at, online_until from haven.users where id = ${params.userId}`;
  if (!u || u.presence === false || !Number(u.last_seen_at)) return { visible: false };
  return { visible: true, online: Number(u.online_until) > now(), lastSeen: Number(u.last_seen_at) };
});

// ---- people

route('GET', '/avatars/:userId', async ({ req, reply, params }) => {
  await currentUser(req, reply);
  const [row] = await sql`select data from haven.avatars where user_id = ${params.userId}`;
  if (!row) throw new HttpError(404, 'not_found');
  const headers = new Headers(reply.headers);
  headers.set('Content-Type', 'image/jpeg');
  headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return new Response(row.data, { status: 200, headers });
});

// Find someone by @username, or by the phone number of an older account.
route('POST', '/users/lookup', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ phone?: string; query?: string }>(body, { phone: [PHONE_IN, false], query: [str(1, 40), false] });
  const input = (b.query ?? b.phone ?? '').trim();
  await enforce(`lookup:${user.id}`, 60, HOUR);
  const handle = input.replace(/^@/, '').toLowerCase();
  if (input.startsWith('@') || /[a-z_]/i.test(input)) {
    if (!USERNAME.test(handle)) throw new HttpError(400, 'invalid_username', 'Usernames have 3–20 letters, numbers, dots or underscores.');
    const [found] = await sql`select * from haven.users where username = ${handle}`;
    if (!found || !found.name) return { found: false, phone: '', username: handle };
    if (found.id === user.id) throw new HttpError(400, 'is_self', 'That is your own username.');
    return { found: true, phone: '', username: handle, user: publicProfile(found, (await devicesOf([found.id])).get(found.id) ?? []) };
  }
  const phone = normalizePhone(input);
  if (!phone) throw new HttpError(400, 'invalid_phone', 'Enter a @username or a phone number.');
  const [found] = await sql`select * from haven.users where phone = ${phone}`;
  if (!found || !found.name) return { found: false, phone };
  if (found.id === user.id) throw new HttpError(400, 'is_self', 'That is your own number.');
  return { found: true, phone, user: publicProfile(found, (await devicesOf([found.id])).get(found.id) ?? []) };
});

route('GET', '/blocks', async ({ req, reply }) => {
  const user = await currentUser(req, reply);
  const rows = await sql`select u.* from haven.blocks b join haven.users u on u.id = b.blocked_id where b.blocker_id = ${user.id} order by b.created_at desc`;
  return { blocked: rows.map((r) => publicProfile(r)) };
});

route('PUT', '/blocks/:userId', async ({ req, reply, params }) => {
  const user = await currentUser(req, reply);
  if (params.userId === user.id) throw new HttpError(400, 'is_self');
  const [target] = await sql`select 1 from haven.users where id = ${params.userId}`;
  if (!target) throw new HttpError(404, 'not_found');
  await sql`insert into haven.blocks (blocker_id, blocked_id, created_at) values (${user.id}, ${params.userId}, ${now()}) on conflict do nothing`;
  return ok;
});

route('DELETE', '/blocks/:userId', async ({ req, reply, params }) => {
  const user = await currentUser(req, reply);
  await sql`delete from haven.blocks where blocker_id = ${user.id} and blocked_id = ${params.userId}`;
  return ok;
});

// ---- conversations

route('GET', '/conversations', async ({ req, reply }) => {
  const user = await currentUser(req, reply);
  const convs = await sql`select c.* from haven.conversations c join haven.members m on m.conversation_id = c.id
                          where m.user_id = ${user.id} order by c.updated_at desc`;
  return { conversations: await serializeConversations(convs, user.id) };
});

route('GET', '/conversations/:id', async ({ req, reply, params }) => {
  const user = await currentUser(req, reply);
  await membershipOrThrow(params.id, user.id);
  return { conversation: await oneConversation(params.id, user.id) };
});

route('POST', '/conversations/direct', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { userId: other } = shape<{ userId: string }>(body, { userId: [isId, true] });
  if (other === user.id) throw new HttpError(400, 'is_self', 'That is your own number.');
  if (!(await namedUserExists(other))) throw new HttpError(404, 'not_found', 'This person is not on Haven.');
  const key = [user.id, other].sort().join(':');
  const t = now();
  const id = randomId();
  const conv = await sql.begin(async (tx) => {
    const inserted = await tx`insert into haven.conversations (id, kind, title, direct_key, created_by, created_at, updated_at)
                              values (${id}, 'direct', '', ${key}, ${user.id}, ${t}, ${t}) on conflict (direct_key) do nothing returning *`;
    if (inserted.length) {
      await tx`insert into haven.members (conversation_id, user_id, role, joined_at) values (${id}, ${user.id}, 'admin', ${t}), (${id}, ${other}, 'admin', ${t})`;
      return inserted[0];
    }
    const [existing] = await tx`select * from haven.conversations where direct_key = ${key}`;
    return existing;
  });
  return { conversation: await oneConversation(conv.id, user.id) };
});

route('POST', '/conversations/group', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ title: string; memberIds: string[] }>(body, { title: [str(1, 200), true], memberIds: [idList(1, MAX_GROUP - 1), true] });
  await enforce(`group:${user.id}`, 20, HOUR);
  const title = cleanLine(b.title, 60);
  if (!title) throw new HttpError(400, 'invalid_title', 'Please give the group a name.');
  const memberList: string[] = [];
  for (const id of b.memberIds) {
    if (id !== user.id && (await namedUserExists(id)) && !(await hasBlocked(id, user.id))) memberList.push(id);
  }
  if (!memberList.length) throw new HttpError(400, 'no_members', 'Add at least one person.');
  const id = randomId();
  const t = now();
  await sql.begin(async (tx) => {
    await tx`insert into haven.conversations (id, kind, title, created_by, created_at, updated_at) values (${id}, 'group', ${title}, ${user.id}, ${t}, ${t})`;
    await tx`insert into haven.members (conversation_id, user_id, role, joined_at) values (${id}, ${user.id}, 'admin', ${t})`;
    for (const uid of memberList) await tx`insert into haven.members (conversation_id, user_id, role, joined_at) values (${id}, ${uid}, 'member', ${t})`;
    await systemEvent(tx, id, { type: 'group_created', actorId: user.id, title, names: await namesOf(tx, [user.id]) }, memberList);
  });
  await broadcast(memberList, 'conversations');
  await notifyMessages(memberList);
  return { conversation: await oneConversation(id, user.id) };
});

route('PATCH', '/conversations/:id', async ({ req, reply, params, body }) => {
  const user = await currentUser(req, reply);
  const conv = await membershipOrThrow(params.id, user.id);
  const b = shape<{ title: string }>(body, { title: [str(1, 200), true] });
  if (conv.kind !== 'group') throw new HttpError(400, 'not_group');
  if (conv.my_role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can change the group name.');
  const title = cleanLine(b.title, 60);
  if (!title) throw new HttpError(400, 'invalid_title', 'Please give the group a name.');
  const members = await memberIds(conv.id);
  const others = members.filter((m) => m !== user.id);
  await sql.begin(async (tx) => {
    await tx`update haven.conversations set title = ${title} where id = ${conv.id}`;
    await systemEvent(tx, conv.id, { type: 'renamed', actorId: user.id, title, names: await namesOf(tx, [user.id]) }, others);
  });
  await broadcast(members, 'conversations');
  await notifyMessages(others);
  return { conversation: await oneConversation(conv.id, user.id) };
});

route('POST', '/conversations/:id/members', async ({ req, reply, params, body }) => {
  const user = await currentUser(req, reply);
  const conv = await membershipOrThrow(params.id, user.id);
  const b = shape<{ userIds: string[] }>(body, { userIds: [idList(1, MAX_GROUP), true] });
  if (conv.kind !== 'group') throw new HttpError(400, 'not_group');
  if (conv.my_role !== 'admin' && !conv.circle) throw new HttpError(403, 'forbidden', 'Only admins can add people.');
  const current = new Set(await memberIds(conv.id));
  const toAdd: string[] = [];
  for (const id of b.userIds) {
    if (!current.has(id) && (await namedUserExists(id)) && !(await hasBlocked(id, user.id))) {
      toAdd.push(id);
    }
  }
  if (current.size + toAdd.length > MAX_GROUP) throw new HttpError(400, 'group_full', `Groups can have up to ${MAX_GROUP} members.`);
  if (toAdd.length) {
    const everyone = [...current, ...toAdd];
    await sql.begin(async (tx) => {
      const t = now();
      for (const uid of toAdd) await tx`insert into haven.members (conversation_id, user_id, role, joined_at) values (${conv.id}, ${uid}, 'member', ${t})`;
      await systemEvent(tx, conv.id, { type: 'members_added', actorId: user.id, targetIds: toAdd, names: await namesOf(tx, [user.id, ...toAdd]) },
        everyone.filter((id) => id !== user.id));
    });
    await broadcast(everyone, 'conversations');
    await notifyMessages(everyone.filter((id) => id !== user.id));
  }
  return { conversation: await oneConversation(conv.id, user.id) };
});

route('PATCH', '/conversations/:id/members/:userId', async ({ req, reply, params, body }) => {
  const user = await currentUser(req, reply);
  const conv = await membershipOrThrow(params.id, user.id);
  const { role } = shape<{ role: string }>(body, { role: [(v) => v === 'admin' || v === 'member', true] });
  if (conv.kind !== 'group') throw new HttpError(400, 'not_group');
  if (conv.my_role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can change roles.');
  const [target] = await sql`select 1 from haven.members where conversation_id = ${conv.id} and user_id = ${params.userId}`;
  if (!target) throw new HttpError(404, 'not_found');
  await sql.begin(async (tx) => {
    await tx`update haven.members set role = ${role} where conversation_id = ${conv.id} and user_id = ${params.userId}`;
    await ensureAdmin(tx, conv.id);
  });
  await broadcast(await memberIds(conv.id), 'conversations');
  return { conversation: await oneConversation(conv.id, user.id) };
});

route('DELETE', '/conversations/:id/members/:userId', async ({ req, reply, params }) => {
  const user = await currentUser(req, reply);
  const conv = await membershipOrThrow(params.id, user.id);
  const target = params.userId;
  if (conv.kind !== 'group') throw new HttpError(400, 'not_group', 'You cannot leave a direct chat. Block the person instead.');
  const leaving = target === user.id;
  if (!leaving && conv.my_role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can remove people.');
  const before = await memberIds(conv.id);
  if (!before.includes(target)) throw new HttpError(404, 'not_found');
  await sql.begin(async (tx) => {
    await tx`delete from haven.members where conversation_id = ${conv.id} and user_id = ${target}`;
    await tx`delete from haven.message_recipients where device_id in (select id from haven.devices where user_id = ${target})
             and seq in (select seq from haven.messages where conversation_id = ${conv.id})`;
    const after = before.filter((id) => id !== target);
    if (!after.length) {
      await tx`delete from haven.conversations where id = ${conv.id}`;
      return;
    }
    await ensureAdmin(tx, conv.id);
    const body = leaving
      ? { type: 'member_left', actorId: user.id, names: await namesOf(tx, [user.id]) }
      : { type: 'member_removed', actorId: user.id, targetIds: [target], names: await namesOf(tx, [user.id, target]) };
    await systemEvent(tx, conv.id, body, leaving ? after : [...after.filter((id) => id !== user.id), target]);
  });
  await broadcast(before, 'conversations');
  await notifyMessages(before.filter((id) => id !== user.id));
  return ok;
});

// ---- Vlog your Day

route('GET', '/circle', async ({ req, reply, url }) => {
  const user = await currentUser(req, reply);
  const { day, hour } = await berlinNow();
  const circles = await circlesOf(user.id);
  const want = url.searchParams.get('circle');
  const convId = (want && circles.find((c) => c.id === want)?.id) || circles[0]?.id || null;
  if (!convId) return { circle: null, circles, today: day, picks: [] };
  if (await ensurePick(convId, day)) await announcePick(convId, day, hour);
  const picks = await sql`select to_char(day, 'YYYY-MM-DD') as day, user_id from haven.circle_days
                          where conversation_id = ${convId} order by day desc limit 30`;
  return { circle: convId, circles, today: day, picks: picks.map((p) => ({ day: p.day, userId: p.user_id })) };
});

route('POST', '/circle', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ title: string; memberIds: string[] }>(body, { title: [str(1, 200), true], memberIds: [idList(1, MAX_GROUP - 1), true] });
  await enforce(`group:${user.id}`, 20, HOUR);
  if ((await circlesOf(user.id)).length >= 10) throw new HttpError(400, 'too_many_circles', 'You can be in up to 10 friend groups.');
  const title = cleanLine(b.title, 60) || 'Friends';
  const memberList: string[] = [];
  const skipped: string[] = [];
  for (const id of b.memberIds) {
    if (id === user.id || !(await namedUserExists(id)) || (await hasBlocked(id, user.id))) continue;
    memberList.push(id);
  }
  if (!memberList.length) throw new HttpError(400, 'no_members', 'Add at least one person.');
  const id = randomId();
  const t = now();
  await sql.begin(async (tx) => {
    await tx`insert into haven.conversations (id, kind, title, created_by, created_at, updated_at, circle) values (${id}, 'group', ${title}, ${user.id}, ${t}, ${t}, true)`;
    await tx`insert into haven.members (conversation_id, user_id, role, joined_at) values (${id}, ${user.id}, 'admin', ${t})`;
    for (const uid of memberList) await tx`insert into haven.members (conversation_id, user_id, role, joined_at) values (${id}, ${uid}, 'member', ${t})`;
    await systemEvent(tx, id, { type: 'group_created', actorId: user.id, title, names: await namesOf(tx, [user.id]) }, memberList);
  });
  await broadcast(memberList, 'conversations');
  await notifyMessages(memberList);
  return { conversation: await oneConversation(id, user.id), skipped };
});

// Invite link: one fixed link per friend group. Anyone in the group can share it;
// admins can replace it (the old link stops working).
route('POST', '/circle/invite', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { reset, circle } = shape<{ reset?: boolean; circle?: string }>(body, { reset: [(v) => v === true, false], circle: [isId, false] });
  const convId = await circleOf(user.id, circle);
  if (!convId) throw new HttpError(400, 'no_circle', 'Create a friend group first.');
  await enforce(`invite:${user.id}`, 60, HOUR);
  const conv = await membershipOrThrow(convId, user.id);
  if (reset && conv.my_role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can make a new link.');
  if (conv.invite_code && !reset) return { code: conv.invite_code };
  for (let i = 0; i < 5; i++) {
    const code = newLinkCode();
    const done = await sql`update haven.conversations set invite_code = ${code} where id = ${convId}
                           and not exists (select 1 from haven.conversations where invite_code = ${code}) returning id`;
    if (done.length) return { code };
  }
  throw new HttpError(500, 'server_error');
});

/** Which friend group an invite code belongs to: a fixed link, or an older 14-day code. */
async function circleByCode(code: string): Promise<Row | null> {
  const [c] = await sql`select c.id, c.title, c.created_by from haven.conversations c where c.circle and c.invite_code = ${code}`;
  if (c) return c;
  const [old] = await sql`select c.id, c.title, c.created_by from haven.circle_invites i join haven.conversations c on c.id = i.conversation_id and c.circle
                          where i.code_hash = ${sha256(code)} and i.expires_at > ${now()}`;
  return old ?? null;
}

// Before joining: show "Join „Name“ by „Creator“?". Works before signing in too.
route('POST', '/circle/invite/preview', async ({ req, body, ip }) => {
  const { code } = shape<{ code: string }>(body, { code: [str(12, 12, LINK_CODE), true] });
  await enforce(`invitepreview:${ip}`, 60, HOUR);
  const c = await circleByCode(code);
  if (!c) throw new HttpError(404, 'invite_invalid', 'This invite link is not valid anymore. Ask for a new one.');
  const [creator] = await sql`select name from haven.users where id = ${c.created_by}`;
  const [{ n }] = await sql`select count(*)::int as n from haven.members where conversation_id = ${c.id}`;
  const people = (await sql`select u.id, u.name, u.avatar_version from haven.members m join haven.users u on u.id = m.user_id
                            where m.conversation_id = ${c.id} and u.name <> '' order by (u.id = ${c.created_by}) desc, m.joined_at limit 8`)
    .map((u) => ({ id: u.id, name: u.name, avatarVersion: Number(u.avatar_version) }));
  let member = false;
  const token = readCookie(req, COOKIE);
  if (token) {
    const [s] = await sql`select user_id from haven.sessions where token_hash = ${sha256(token)} and expires_at > ${now()}`;
    if (s) member = Boolean((await sql`select 1 from haven.members where conversation_id = ${c.id} and user_id = ${s.user_id}`).length);
  }
  return { title: c.title, creator: creator?.name || '', members: n, member, people };
}, false);

/** Add this user to the friend group of an invite code. Returns the group's id. */
async function joinByCode(user: Row, code: string): Promise<string> {
  await enforce(`join:${user.id}`, 20, HOUR);
  const invalid = new HttpError(400, 'invite_invalid', 'This invite link is not valid anymore. Ask for a new one.');
  const c = await circleByCode(code);
  const inv = c ? { conversation_id: c.id as string, created_by: c.created_by as string } : null;
  if (!inv || (await hasBlocked(inv.created_by, user.id))) throw invalid;
  const current = await memberIds(inv.conversation_id);
  if (current.includes(user.id)) return inv.conversation_id;
  if ((await circlesOf(user.id)).length >= 10) throw new HttpError(400, 'too_many_circles', 'You can be in up to 10 friend groups.');
  if (!user.name) throw new HttpError(400, 'no_name', 'Add your name first.');
  if (current.length >= MAX_GROUP) throw new HttpError(400, 'group_full', `Groups can have up to ${MAX_GROUP} members.`);
  await sql.begin(async (tx) => {
    await tx`insert into haven.members (conversation_id, user_id, role, joined_at) values (${inv.conversation_id}, ${user.id}, 'member', ${now()})`;
    await systemEvent(tx, inv.conversation_id, { type: 'member_joined', actorId: user.id, names: await namesOf(tx, [user.id]) }, current);
  });
  await broadcast([...current, user.id], 'conversations');
  await broadcast(current, 'sync');
  await notifyUsers(current, 'joined', user.name, 'today');
  return inv.conversation_id;
}

route('POST', '/circle/join', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { code } = shape<{ code: string }>(body, { code: [str(12, 12, LINK_CODE), true] });
  const id = await joinByCode(user, code);
  return { conversation: await oneConversation(id, user.id) };
});

// Join with a passkey from a browser that isn't signed in (e.g. Safari on an
// iPhone whose Haven runs from the Home Screen). Only joins: no session, and
// the devices of the account stay as they are.
route('POST', '/circle/join/passkey', async ({ req, body, ip }) => {
  const b = shape<{ code: string; challengeId: string; response: Row }>(body, {
    code: [str(12, 12, LINK_CODE), true], challengeId: [isId, true], response: [isObject, true],
  });
  await enforce(`pklogin:ip:${ip}`, 60, HOUR);
  const pk = await passkeyOwner(req, b.challengeId, b.response);
  const [user] = await sql`select * from haven.users where id = ${pk.user_id}`;
  if (!user) throw new HttpError(400, 'no_account', 'This passkey belongs to an account that no longer exists.');
  const id = await joinByCode(user, b.code);
  const [c] = await sql`select title from haven.conversations where id = ${id}`;
  return { title: c?.title ?? '' };
}, false);

// Profile photos of the people in a friend group, for the invite page (before signing in).
route('GET', '/invite/avatar', async ({ url, ip }) => {
  const code = url.searchParams.get('code') ?? '';
  const userId = url.searchParams.get('user') ?? '';
  if (!LINK_CODE.test(code) || !ID_RE.test(userId)) throw new HttpError(400, 'invalid_request');
  await enforce(`inviteavatar:${ip}`, 600, HOUR);
  const c = await circleByCode(code);
  if (!c) throw new HttpError(404, 'not_found');
  const [row] = await sql`select a.data from haven.avatars a join haven.members m on m.user_id = a.user_id and m.conversation_id = ${c.id}
                          where a.user_id = ${userId}`;
  if (!row) throw new HttpError(404, 'not_found');
  const headers = new Headers(BASE_HEADERS);
  headers.set('Content-Type', 'image/jpeg');
  headers.set('Cache-Control', 'private, max-age=86400');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return new Response(row.data, { status: 200, headers });
}, false);

// ---- messages

route('POST', '/conversations/:id/messages', async ({ req, reply, params, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ id: string; envelope: Row; vlog?: boolean; pushTo?: string[] }>(body, {
    id: [isId, true], envelope: [validEnvelope, true], vlog: [(v) => v === true, false], pushTo: [(v) => Array.isArray(v) && v.length <= 5 && v.every(isId), false],
  });
  await enforce(`send:${user.id}`, 120, MIN);
  const conv = await membershipOrThrow(params.id, user.id);
  // Vlog posts: only in a friend group, and only by today's pick.
  if (b.vlog) {
    if (!conv.circle) throw new HttpError(400, 'not_circle');
    const { day } = await berlinNow();
    const [pick] = await sql`select user_id from haven.circle_days where conversation_id = ${conv.id} and day = ${day}`;
    if (pick?.user_id !== user.id) throw new HttpError(403, 'not_your_turn', 'It’s not your turn to vlog today.');
    // Remember that today's vlog has started, so the 18:00 reminder is skipped.
    await sql`update haven.circle_days set posted_at = ${now()} where conversation_id = ${conv.id} and day = ${day} and posted_at = 0`;
  }

  const [existing] = await sql`select conversation_id, sender_id, created_at from haven.messages where id = ${b.id}`;
  if (existing) {
    if (existing.sender_id === user.id && existing.conversation_id === conv.id) return { id: b.id, createdAt: Number(existing.created_at) };
    throw new HttpError(409, 'duplicate_id');
  }

  // Every device of every member (except the sending device) needs a wrapped key, and nobody else.
  const memberRows = await sql`select user_id from haven.members where conversation_id = ${conv.id}`;
  const memberList = memberRows.map((m) => m.user_id as string);
  const devices = await sql`select id, user_id from haven.devices where user_id = any(${memberList})`;
  const expected = new Set(devices.filter((d) => d.id !== user.device_id).map((d) => d.id as string));
  const given = Object.keys(b.envelope.keys as Row);
  if (given.length !== expected.size || given.some((id) => !expected.has(id))) {
    throw new HttpError(409, 'devices_changed', 'The devices in this chat changed.');
  }

  const blockers = new Set((await sql`select blocker_id from haven.blocks where blocked_id = ${user.id}`).map((r) => r.blocker_id));
  const recipientUsers = memberList.filter((uid) => !blockers.has(uid));
  const t = now();
  const hasRecipients = devices.some((d) => d.id !== user.device_id && recipientUsers.includes(d.user_id));
  if (hasRecipients) {
    await sql.begin(async (tx) => {
      const [m] = await tx`insert into haven.messages (id, conversation_id, sender_id, kind, body, created_at)
                           values (${b.id}, ${conv.id}, ${user.id}, 'msg', ${JSON.stringify(b.envelope)}, ${t}) returning seq`;
      await queueFor(tx, m.seq, recipientUsers, user.device_id);
      await tx`update haven.conversations set updated_at = ${t} where id = ${conv.id}`;
    });
    const others = recipientUsers.filter((uid) => uid !== user.id);
    await broadcast(others, 'sync');
    if (b.vlog) {
      // "X just vlogged", at most once every 10 minutes per group.
      const [{ hit }] = await sql`select haven.hit(${`vlogpush:${conv.id}`}, 1, ${10 * MIN}) as hit`;
      if (!(hit > 0)) await notifyUsers(others, 'vlogged', user.name || '', 'today');
    } else {
      await sendPush(b.pushTo ? b.pushTo.filter((id) => others.includes(id)) : others);
    }
    await broadcast([user.id], 'sync');
  }
  return { id: b.id, createdAt: t };
});

// ---- history re-delivery: someone set Haven up again (new keys, empty phone).
// Each sender's own device can send its messages again, end-to-end encrypted for
// that person's current devices only. The original time is kept, and nothing
// is re-sent from before the person joined the chat. Devices that still have a
// message ignore the copy (same id).

route('POST', '/conversations/:id/redeliver', async ({ req, reply, params, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ id: string; envelope: Row; userId: string; createdAt: number }>(body, {
    id: [isId, true], envelope: [validEnvelope, true], userId: [isId, true], createdAt: [int(0), true],
  });
  await enforce(`redeliver:${user.id}`, 3000, HOUR);
  const conv = await membershipOrThrow(params.id, user.id);
  if (b.userId === user.id) throw new HttpError(400, 'is_self');
  const t = now();
  if (b.createdAt > t || b.createdAt < t - RETENTION_DAYS * DAY) throw new HttpError(400, 'too_old', 'This message is too old to send again.');
  const [member] = await sql`select joined_at from haven.members where conversation_id = ${conv.id} and user_id = ${b.userId}`;
  if (!member) throw new HttpError(404, 'not_member');
  if (Number(member.joined_at) > b.createdAt) return { ok: false, reason: 'before_joined' };
  if (await hasBlocked(b.userId, user.id)) return { ok: false, reason: 'blocked' };
  const devices = (await sql`select id from haven.devices where user_id = ${b.userId}`).map((d) => d.id as string);
  const given = Object.keys(b.envelope.keys as Row);
  if (!devices.length || given.length !== devices.length || given.some((id) => !devices.includes(id))) {
    throw new HttpError(409, 'devices_changed', 'The devices in this chat changed.');
  }
  // The original is still queued for someone else: the copy needs its own id.
  const [existing] = await sql`select 1 from haven.messages where id = ${b.id}`;
  if (existing) return { ok: false, reason: 'exists' };
  await sql.begin(async (tx) => {
    const [m] = await tx`insert into haven.messages (id, conversation_id, sender_id, kind, body, created_at)
                         values (${b.id}, ${conv.id}, ${user.id}, 'msg', ${JSON.stringify(b.envelope)}, ${b.createdAt}) returning seq`;
    await tx`insert into haven.message_recipients (seq, device_id) select ${m.seq}, unnest(${devices}::text[]) on conflict do nothing`;
  });
  await broadcast([b.userId], 'sync');
  return { ok: true };
});

// ---- voice calls (WebRTC, phone to phone)
//
// The server only passes the call setup between the two phones. Every setup
// message is signed by the sending device, so the server can't swap in its own
// keys; the audio itself goes directly between the phones, encrypted (DTLS-SRTP).
// An incoming call is kept for 45 seconds so a phone that opens Haven from the
// notification can still answer it.

const CALL_TYPES = ['offer', 'answer', 'ice', 'hangup', 'decline', 'busy'];

// Relay (TURN) for networks that block direct connections, e.g. two phones on
// mobile data. Cloudflare's TURN service is free up to 1,000 GB a month; set the
// secrets CF_TURN_KEY_ID and CF_TURN_API_TOKEN to turn it on. Credentials are
// short-lived and fetched per day, so nothing long-lived reaches the phones.
let turnCache: { at: number; servers: unknown[] } | null = null;
async function turnServers(): Promise<unknown[]> {
  const keyId = Deno.env.get('CF_TURN_KEY_ID');
  const token = Deno.env.get('CF_TURN_API_TOKEN');
  if (!keyId || !token) return [];
  if (turnCache && now() - turnCache.at < 6 * HOUR) return turnCache.servers;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`turn ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data.iceServers) ? data.iceServers : data.iceServers ? [data.iceServers] : [];
    turnCache = { at: now(), servers: list };
    return list;
  } catch (e) {
    console.error('turn credentials', String(e));
    return turnCache?.servers ?? [];
  }
}

route('GET', '/calls/ice', async ({ req, reply }) => {
  await currentUser(req, reply);
  const servers: unknown[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  servers.push(...(await turnServers()));
  const turn = await kvGet('turn_servers');
  if (turn) {
    try { servers.push(...(JSON.parse(turn) as unknown[])); } catch { /* ignore a broken entry */ }
  }
  return { iceServers: servers };
});

// How a call went, without who or what: outcome, connection types, length. For fixing call problems.
const CAND = /^(host|srflx|prflx|relay)(,(host|srflx|prflx|relay))*$|^$/;
route('POST', '/calls/report', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ outcome: string; local: string; remote: string; pair: string; secs: number; ua: string }>(body, {
    outcome: [str(1, 30, /^[a-z_]+$/), true], local: [str(0, 40, CAND), true], remote: [str(0, 40, CAND), true],
    pair: [str(0, 20, /^[a-z,-]*$/), true], secs: [int(0, 86400), true], ua: [str(0, 20, /^[a-z0-9 ]*$/), true],
  });
  await enforce(`callreport:${user.id}`, 30, HOUR);
  console.log('call report', JSON.stringify(b));
  return ok;
});

route('POST', '/calls/signal', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ convId: string; to: string; payload: string; sig: string }>(body, {
    convId: [isId, true], to: [isId, true], payload: [str(2, 30_000), true], sig: [str(40, 120, B64URL), true],
  });
  await enforce(`call:${user.id}`, 900, 10 * MIN);
  let p: Row;
  try { p = JSON.parse(b.payload); } catch { throw new HttpError(400, 'invalid_request'); }
  if (!p || !CALL_TYPES.includes(p.type) || !ID_RE.test(String(p.callId))) throw new HttpError(400, 'invalid_request');
  const conv = await membershipOrThrow(b.convId, user.id);
  if (conv.kind !== 'direct' || b.to === user.id) throw new HttpError(400, 'not_direct', 'Calls work in one-to-one chats.');
  const [peer] = await sql`select 1 from haven.members where conversation_id = ${conv.id} and user_id = ${b.to}`;
  if (!peer) throw new HttpError(404, 'not_found');
  if (await hasBlocked(b.to, user.id)) return ok;
  const envelope = JSON.stringify({ from: user.id, fromDevice: user.device_id, conv: conv.id, payload: b.payload, sig: b.sig });
  if (p.type === 'offer') {
    await sql`insert into haven.call_offers (call_id, to_user, envelope, expires_at) values (${p.callId}, ${b.to}, ${envelope}, ${now() + 45_000})
              on conflict (call_id) do update set envelope = excluded.envelope, expires_at = excluded.expires_at`;
  } else if (p.type !== 'ice') {
    await sql`delete from haven.call_offers where call_id = ${p.callId}`;
  }
  await broadcast([b.to, user.id], 'call', { d: envelope });
  if (p.type === 'offer') await notifyUsers([b.to], 'calling', user.name || '', 'call');
  return ok;
});

// A call that is still ringing for me (opened Haven from the call notification).
route('GET', '/calls/pending', async ({ req, reply }) => {
  const user = await currentUser(req, reply);
  const [row] = await sql`select envelope from haven.call_offers where to_user = ${user.id} and expires_at > ${now()} order by expires_at desc limit 1`;
  return { envelope: row?.envelope ?? null };
});

// ---- group photo (admins; in a friend group everyone). Only members can load it.

async function canEditGroup(convId: string, userId: string) {
  const conv = await membershipOrThrow(convId, userId);
  if (conv.kind !== 'group') throw new HttpError(400, 'not_group');
  if (conv.my_role !== 'admin' && !conv.circle) throw new HttpError(403, 'forbidden', 'Only admins can change the group photo.');
  return conv;
}

route('PUT', '/conversations/:id/avatar', async ({ req, reply, params, raw }) => {
  const user = await currentUser(req, reply);
  const conv = await canEditGroup(params.id, user.id);
  await enforce(`gavatar:${user.id}`, 20, HOUR);
  if (req.headers.get('content-type') !== 'image/jpeg' || raw.length > MAX_AVATAR || !isJpeg(raw)) {
    throw new HttpError(400, 'invalid_image', 'This picture could not be used.');
  }
  const t = now();
  const members = await memberIds(conv.id);
  await sql.begin(async (tx) => {
    await tx`insert into haven.group_avatars (conversation_id, data, updated_at) values (${conv.id}, ${Buffer.from(raw)}, ${t})
             on conflict (conversation_id) do update set data = excluded.data, updated_at = excluded.updated_at`;
    await tx`update haven.conversations set avatar_version = ${t} where id = ${conv.id}`;
    await systemEvent(tx, conv.id, { type: 'photo_changed', actorId: user.id, names: await namesOf(tx, [user.id]) }, members.filter((id) => id !== user.id));
  });
  await broadcast(members, 'conversations');
  await broadcast(members.filter((id) => id !== user.id), 'sync');
  return { conversation: await oneConversation(conv.id, user.id) };
});

route('DELETE', '/conversations/:id/avatar', async ({ req, reply, params }) => {
  const user = await currentUser(req, reply);
  const conv = await canEditGroup(params.id, user.id);
  const members = await memberIds(conv.id);
  await sql.begin(async (tx) => {
    await tx`delete from haven.group_avatars where conversation_id = ${conv.id}`;
    await tx`update haven.conversations set avatar_version = 0 where id = ${conv.id}`;
    await systemEvent(tx, conv.id, { type: 'photo_removed', actorId: user.id, names: await namesOf(tx, [user.id]) }, members.filter((id) => id !== user.id));
  });
  await broadcast(members, 'conversations');
  await broadcast(members.filter((id) => id !== user.id), 'sync');
  return { conversation: await oneConversation(conv.id, user.id) };
});

route('GET', '/conversations/:id/avatar', async ({ req, reply, params }) => {
  const user = await currentUser(req, reply);
  await membershipOrThrow(params.id, user.id);
  const [row] = await sql`select data from haven.group_avatars where conversation_id = ${params.id}`;
  if (!row) throw new HttpError(404, 'not_found');
  const headers = new Headers(reply.headers);
  headers.set('Content-Type', 'image/jpeg');
  headers.set('Cache-Control', 'private, max-age=31536000, immutable');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return new Response(row.data, { status: 200, headers });
});

// ---- chat theme (any member; everyone in the chat sees the same one)

const CHAT_THEMES: Record<string, string> = { '': 'Standard', dots: 'Dot Grid', red: 'Red', type: 'Typewriter', clear: 'Transparent', glyph: 'Glyph', orange: 'Orange' };

route('PUT', '/conversations/:id/theme', async ({ req, reply, params, body }) => {
  const user = await currentUser(req, reply);
  const conv = await membershipOrThrow(params.id, user.id);
  await enforce(`theme:${user.id}`, 30, HOUR);
  const { theme } = shape<{ theme: string }>(body, { theme: [(v) => typeof v === 'string' && Object.hasOwn(CHAT_THEMES, v), true] });
  if ((conv.theme ?? '') === theme) return { conversation: await oneConversation(conv.id, user.id) };
  const members = await memberIds(conv.id);
  await sql.begin(async (tx) => {
    await tx`update haven.conversations set theme = ${theme} where id = ${conv.id}`;
    await systemEvent(tx, conv.id, { type: 'theme_changed', actorId: user.id, title: CHAT_THEMES[theme], names: await namesOf(tx, [user.id]) }, members.filter((id) => id !== user.id));
  });
  await broadcast(members, 'conversations');
  await broadcast(members.filter((id) => id !== user.id), 'sync');
  return { conversation: await oneConversation(conv.id, user.id) };
});

// ---- typing indicator (a short-lived hint, nothing is stored)

route('POST', '/conversations/:id/typing', async ({ req, reply, params }) => {
  const user = await currentUser(req, reply);
  await enforce(`typing:${user.id}`, 60, MIN);
  const conv = await membershipOrThrow(params.id, user.id);
  const blockers = new Set((await sql`select blocker_id from haven.blocks where blocked_id = ${user.id}`).map((r) => r.blocker_id));
  const others = (await memberIds(conv.id)).filter((id) => id !== user.id && !blockers.has(id));
  await broadcast(others, 'typing', { c: conv.id, u: user.id });
  return ok;
});

// ---- read receipts

route('POST', '/conversations/:id/read', async ({ req, reply, params, body }) => {
  const user = await currentUser(req, reply);
  const { at } = shape<{ at: number }>(body, { at: [int(0), true] });
  await membershipOrThrow(params.id, user.id);
  if (user.read_receipts === false) return ok;
  const upTo = Math.min(at, now());
  const updated = await sql`update haven.members set last_read_at = ${upTo}
                            where conversation_id = ${params.id} and user_id = ${user.id} and last_read_at < ${upTo} returning 1`;
  if (updated.length) await broadcast((await memberIds(params.id)).filter((id) => id !== user.id), 'read');
  return ok;
});

// ---- attachments (end-to-end encrypted before upload; the server only sees ciphertext)

async function storageCall(method: string, path: string, body: unknown) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1${path}`, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`storage ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

const ATTACHMENT_PATH = /^([A-Za-z0-9_-]{16,40})\/([A-Za-z0-9_-]{16,40})$/;

async function attachmentConv(path: unknown, userId: string) {
  const m = typeof path === 'string' ? path.match(ATTACHMENT_PATH) : null;
  if (!m) throw new HttpError(400, 'invalid_request');
  await membershipOrThrow(m[1], userId);
  return m[1];
}

route('POST', '/attachments', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ conversationId: string; size: number }>(body, { conversationId: [isId, true], size: [int(1, MAX_ATTACHMENT), true] });
  await enforce(`upload:${user.id}`, 300, HOUR);
  await membershipOrThrow(b.conversationId, user.id);
  const path = `${b.conversationId}/${randomId()}`;
  const data = await storageCall('POST', `/object/upload/sign/attachments/${path}`, {});
  return { path, uploadUrl: `${SUPABASE_URL}/storage/v1${data.url}` };
});

route('POST', '/attachments/url', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { path } = shape<{ path: string }>(body, { path: [str(33, 81), true] });
  await enforce(`download:${user.id}`, 2000, HOUR);
  await attachmentConv(path, user.id);
  // A file that was deleted (view-once opened, deleted for everyone, or expired) is a normal 404, not a server error.
  const data = await storageCall('POST', `/object/sign/attachments/${path}`, { expiresIn: 600 }).catch((err) => {
    if (String(err).includes('not_found') || String(err).includes('NoSuchKey')) throw new HttpError(404, 'file_gone', 'This file is no longer available.');
    throw err;
  });
  return { url: `${SUPABASE_URL}/storage/v1${data.signedURL ?? data.signedUrl}` };
});

route('POST', '/attachments/delete', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { path } = shape<{ path: string }>(body, { path: [str(33, 81), true] });
  await attachmentConv(path, user.id);
  await storageCall('DELETE', '/object/attachments', { prefixes: [path] }).catch(() => {});
  return ok;
});

// ---- sync

route('GET', '/sync', async ({ req, reply, url }) => {
  const user = await currentUser(req, reply);
  const after = Number(url.searchParams.get('after') ?? 0);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));
  if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit)) throw new HttpError(400, 'invalid_request');
  const rows = await sql`select m.seq, m.id, m.conversation_id, m.sender_id, m.kind, m.body, m.created_at
                         from haven.message_recipients r join haven.messages m on m.seq = r.seq
                         where r.device_id = ${user.device_id} and r.seq > ${after} order by r.seq limit ${limit + 1}`;
  return {
    more: rows.length > limit,
    messages: rows.slice(0, limit).map((m) => ({
      seq: Number(m.seq), id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, kind: m.kind,
      body: JSON.parse(m.body), createdAt: Number(m.created_at),
    })),
  };
});

route('POST', '/sync/ack', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { upTo } = shape<{ upTo: number }>(body, { upTo: [int(0), true] });
  await sql.begin(async (tx) => {
    const seqs = await tx`delete from haven.message_recipients where device_id = ${user.device_id} and seq <= ${upTo} returning seq`;
    if (seqs.length) {
      const list = seqs.map((s: Row) => s.seq);
      await tx`delete from haven.messages m where m.seq = any(${list}) and not exists (select 1 from haven.message_recipients r where r.seq = m.seq)`;
    }
  });
  return ok;
});

// ---- push

route('GET', '/push/key', async ({ req, reply }) => {
  await currentUser(req, reply);
  return { publicKey: (await vapidKeys()).publicKey };
});

route('POST', '/push/subscribe', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ endpoint: string; keys: { p256dh: string; auth: string } }>(body, {
    endpoint: [str(1, 1024), true],
    keys: [(v) => {
      try { shape(v, { p256dh: [str(1, 200, B64URL), true], auth: [str(1, 100, B64URL), true] }); return true; } catch { return false; }
    }, true],
  });
  await enforce(`push:${user.id}`, 20, HOUR);
  if (!isAllowedPushEndpoint(b.endpoint)) throw new HttpError(400, 'invalid_endpoint', 'This browser’s push service is not supported.');
  await sql`insert into haven.push_subscriptions (endpoint, user_id, device_id, p256dh, auth, created_at)
            values (${b.endpoint}, ${user.id}, ${user.device_id}, ${b.keys.p256dh}, ${b.keys.auth}, ${now()})
            on conflict (endpoint) do update set user_id = excluded.user_id, device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth`;
  return ok;
});

route('DELETE', '/push/subscribe', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { endpoint } = shape<{ endpoint: string }>(body, { endpoint: [str(1, 1024), true] });
  await sql`delete from haven.push_subscriptions where endpoint = ${endpoint} and user_id = ${user.id}`;
  return ok;
});

route('GET', '/health', async () => ok, false);

// ------------------------------------------------------------------ server

function clientIp(req: Request) {
  const h = req.headers;
  return (h.get('x-vercel-forwarded-for') || h.get('x-real-ip') || h.get('x-forwarded-for') || 'unknown').split(',')[0].trim();
}

async function isSameSite(req: Request) {
  const origin = req.headers.get('origin');
  if (origin) return (await allowedOrigins()).includes(origin);
  return req.headers.get('sec-fetch-site') === 'same-origin';
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(functions\/v1\/)?api/, '') || '/';
  const reply = new Reply();
  try {
    if (path === '/announce' && req.method === 'POST') {
      await sendPendingAnnouncement();
      return new Response(null, { status: 204 });
    }
    if (path === '/circle/tick' && req.method === 'POST') {
      await circleTick();
      return new Response(null, { status: 204 });
    }

    const match = routes.find((r) => r.method === req.method && r.pattern.test(path));
    if (!match) throw new HttpError(404, 'not_found', 'Not found.');

    // CSRF: state-changing requests must come from the app itself.
    if (req.method !== 'GET' && !(await isSameSite(req))) throw new HttpError(403, 'bad_origin', 'Request blocked.');

    const length = Number(req.headers.get('content-length') || 0);
    if (length > MAX_BODY * 4) throw new HttpError(413, 'too_large', 'This request is too large.');
    const raw = req.method === 'GET' ? new Uint8Array() : new Uint8Array(await req.arrayBuffer());
    const isJpegUpload = req.headers.get('content-type') === 'image/jpeg';
    if (raw.length > (isJpegUpload ? MAX_AVATAR : MAX_BODY)) throw new HttpError(413, 'too_large', 'This request is too large.');
    let body: unknown;
    if (raw.length && !isJpegUpload) {
      if (!(req.headers.get('content-type') || '').startsWith('application/json')) throw new HttpError(415, 'unsupported', 'Unsupported request.');
      try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new HttpError(400, 'invalid_request', 'Something in this request was not valid.'); }
    }

    const m = path.match(match.pattern)!;
    const params = Object.fromEntries(match.keys.map((k, i) => [k, m[i + 1]]));
    const ip = clientIp(req);
    await enforce(`api:${ip}`, 1200, MIN);

    const result = await match.handler({ req, reply, params, body: body ?? {}, raw, ip, url });
    if (Math.random() < 0.02) cleanup().catch((e) => console.error('cleanup', String(e)));
    return result instanceof Response ? result : reply.json(result);
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.extra.retryAfter) reply.headers.set('Retry-After', String(err.extra.retryAfter));
      return reply.json({ error: err.code, message: err.message, ...err.extra }, err.status);
    }
    console.error(err);
    return reply.json({ error: 'server_error', message: 'Something went wrong on our side. Please try again.' }, 500);
  }
});
