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
import { scrypt as scryptCb, timingSafeEqual, randomBytes, createHash } from 'node:crypto';
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
const PIN_LOCK_WINDOW = 7 * DAY;
const COOKIE = '__Host-haven';
const MAX_BODY = 100 * 1024;
const MAX_AVATAR = 300 * 1024;
const DEFAULT_REGION = 'DE';
const MAX_ATTACHMENT = 25 * 1024 * 1024;

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
async function kvSet(key: string, value: string) {
  await sql`insert into haven.kv (key, value) values (${key}, ${value}) on conflict (key) do update set value = excluded.value`;
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
  phone: u.phone,
  name: u.name,
  about: u.about,
  avatarVersion: Number(u.avatar_version),
  hasPin: Boolean(u.pin_hash),
  readReceipts: u.read_receipts !== false,
  deviceId: device.id,
  inbox: device.inbox_token,
  devices,
});

const publicProfile = (u: Row, devices: DeviceKey[] = []) => ({
  id: u.id,
  phone: u.phone,
  name: u.name,
  about: u.about,
  avatarVersion: Number(u.avatar_version),
  devices,
});

async function loadMe(userId: string, deviceId: string) {
  const [u] = await sql`select * from haven.users where id = ${userId}`;
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
async function broadcast(userIds: string[], event: 'sync' | 'conversations' | 'profiles' | 'signout' | 'read') {
  if (!userIds.length) return;
  const rows = await sql`select inbox_token from haven.devices where user_id = any(${userIds})`;
  if (!rows.length) return;
  await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: rows.map((r) => ({ topic: `inbox:${r.inbox_token}`, event, payload: {} })) }),
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
  let a: { title?: unknown; body?: unknown; open?: unknown };
  try { a = JSON.parse(row.value); } catch { return; }
  if (typeof a.title !== 'string' || typeof a.body !== 'string') return;
  const payload = JSON.stringify({ t: 'announce', title: a.title.slice(0, 80), body: a.body.slice(0, 200), open: typeof a.open === 'string' ? a.open.slice(0, 40) : undefined });
  const subs = await sql`select endpoint, p256dh, auth from haven.push_subscriptions`;
  const keys = await vapidKeys();
  const origin = (await allowedOrigins())[0] || 'https://haven.app';
  webpush.setVapidDetails(`mailto:push@${new URL(origin).hostname}`, keys.publicKey, keys.privateKey);
  const results = await Promise.all(subs.map((s) =>
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 7 * 86400, urgency: 'normal', timeout: 8000 })
      .then(() => true, async (err: { statusCode?: number }) => {
        if (err.statusCode === 404 || err.statusCode === 410) await sql`delete from haven.push_subscriptions where endpoint = ${s.endpoint}`;
        return false;
      })));
  console.log(`announcement sent to ${results.filter(Boolean).length}/${subs.length} devices`);
}

// ------------------------------------------------------------------ Telegram verification

// The bot token comes from the TELEGRAM_BOT_TOKEN secret, or else from the private kv table.
let tokenCache: { at: number; value: string } | null = null;
async function botToken(): Promise<string> {
  const fromEnv = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (fromEnv) return fromEnv;
  if (tokenCache && now() - tokenCache.at < MIN) return tokenCache.value;
  tokenCache = { at: now(), value: (await kvGet('telegram_bot_token')) || '' };
  return tokenCache.value;
}

async function telegram(method: string, payload: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${await botToken()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`telegram ${method} failed: ${data.description || res.status}`);
  return data.result;
}

/** Make sure the bot is known and its webhook points here. Returns the bot username. */
async function ensureBot(): Promise<string> {
  const token = await botToken();
  if (!token) throw new HttpError(503, 'verification_unavailable', 'Phone verification is not set up yet. Please try again later.');
  const fingerprint = sha256(token).slice(0, 16);
  const [cachedFp, cachedName] = await Promise.all([kvGet('telegram_bot_fp'), kvGet('telegram_bot_username')]);
  if (cachedFp === fingerprint && cachedName) return cachedName;

  const me = await telegram('getMe', {});
  let secret = await kvGet('telegram_webhook_secret');
  if (!secret) {
    secret = newToken();
    await kvSet('telegram_webhook_secret', secret);
  }
  await telegram('setWebhook', {
    url: `${SUPABASE_URL}/functions/v1/api/telegram/webhook`,
    secret_token: secret,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
  await telegram('setMyDescription', { description: 'Confirms your phone number for Haven, the private messenger. Open Haven and tap “Confirm with Telegram”.' }).catch(() => {});
  await kvSet('telegram_bot_username', me.username);
  await kvSet('telegram_bot_fp', fingerprint);
  return me.username;
}

const send = (chatId: number, text: string, extra: Record<string, unknown> = {}) =>
  telegram('sendMessage', { chat_id: chatId, text, ...extra }).catch((e) => console.error(String(e)));

async function telegramWebhook(req: Request) {
  const secret = await kvGet('telegram_webhook_secret');
  const given = req.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!secret || !safeEqual(given, secret)) return new Response('forbidden', { status: 403 });

  const update = JSON.parse(await req.text());
  const msg = update?.message;
  if (!msg || msg.chat?.type !== 'private') return new Response('ok');
  const chatId: number = msg.chat.id;
  const t = now();

  if (typeof msg.text === 'string' && msg.text.startsWith('/start')) {
    const startToken = msg.text.slice(6).trim();
    const [v] = startToken
      ? await sql`select * from haven.verifications where start_token = ${startToken} and expires_at > ${t} and status = 'pending'`
      : [];
    if (!v) {
      await send(chatId, 'To confirm your number, open Haven and tap “Confirm with Telegram”. Links expire after 10 minutes.');
      return new Response('ok');
    }
    await sql`update haven.verifications set chat_id = ${chatId} where id = ${v.id}`;
    await send(chatId, `Confirm ${v.phone} for Haven.\n\nTap “Share my phone number” below. Telegram shares only the number of this account.`, {
      reply_markup: { keyboard: [[{ text: 'Share my phone number', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
    });
    return new Response('ok');
  }

  if (msg.contact) {
    const [v] = await sql`select * from haven.verifications where chat_id = ${chatId} and status = 'pending' and expires_at > ${t}
                          order by created_at desc limit 1`;
    if (!v) {
      await send(chatId, 'This confirmation expired. Please start again in Haven.', { reply_markup: { remove_keyboard: true } });
      return new Response('ok');
    }
    // Only the account's own number counts, not a forwarded contact card.
    if (msg.contact.user_id !== msg.from?.id) {
      await send(chatId, 'Please use the “Share my phone number” button to share your own number.');
      return new Response('ok');
    }
    const shared = normalizePhone(`+${String(msg.contact.phone_number).replace(/\D/g, '')}`);
    if (shared && shared === v.phone) {
      await sql`update haven.verifications set status = 'verified' where id = ${v.id}`;
      await send(chatId, '✅ Your number is confirmed. You can go back to Haven now.', { reply_markup: { remove_keyboard: true } });
    } else {
      await sql`update haven.verifications set status = 'mismatch' where id = ${v.id}`;
      await send(chatId, `This Telegram account uses a different number. In Haven, enter the number of this Telegram account and try again.`, {
        reply_markup: { remove_keyboard: true },
      });
    }
    return new Response('ok');
  }

  await send(chatId, 'To confirm your number, open Haven and tap “Confirm with Telegram”.');
  return new Response('ok');
}

// ------------------------------------------------------------------ sign-in

/**
 * Sign in with a confirmed phone number. Same keys as a known device: that
 * device signs in again. New keys: this becomes the account's only device and
 * every other device is signed out (like registering on a new phone).
 */
async function completeSignIn(reply: Reply, phone: string, encPub: string, sigPub: string, deviceName: string) {
  const t = now();
  const result = await sql.begin(async (tx) => {
    let [user] = await tx`select * from haven.users where phone = ${phone} for update`;
    let isNew = false;
    let oldTokens: string[] = [];
    if (!user) {
      isNew = true;
      [user] = await tx`insert into haven.users (id, phone, created_at, last_active_at) values (${randomId()}, ${phone}, ${t}, ${t}) returning *`;
    }
    let [device] = await tx`select * from haven.devices where user_id = ${user.id} and enc_pub = ${encPub} and sig_pub = ${sigPub}`;
    if (device) {
      await tx`delete from haven.sessions where device_id = ${device.id}`;
      [device] = await tx`update haven.devices set last_active_at = ${t} where id = ${device.id} returning *`;
    } else {
      oldTokens = (await tx`delete from haven.devices where user_id = ${user.id} returning inbox_token`).map((r: Row) => r.inbox_token);
      [device] = await tx`insert into haven.devices (id, user_id, enc_pub, sig_pub, inbox_token, name, created_at, last_active_at)
                          values (${randomId()}, ${user.id}, ${encPub}, ${sigPub}, ${newToken()}, ${deviceName}, ${t}, ${t}) returning *`;
    }
    await tx`update haven.users set pin_failures = 0, pin_locked_until = 0, last_active_at = ${t} where id = ${user.id}`;
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
  const members = await sql`select m.conversation_id, m.role, m.joined_at, m.last_read_at, u.read_receipts, u.id, u.phone, u.name, u.about, u.avatar_version
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
  await sql`delete from haven.verifications where expires_at < ${t - HOUR}`;
  await sql`delete from haven.pin_challenges where expires_at < ${t}`;
  await sql`delete from haven.link_requests where expires_at < ${t}`;
  await sql`delete from haven.rate_limits where reset_at < ${t}`;
  await sql`delete from haven.messages where created_at < ${t - RETENTION_DAYS * DAY}`;
  await sql`delete from haven.messages m where not exists (select 1 from haven.message_recipients r where r.seq = m.seq)`;
  const old = await sql`select name from storage.objects where bucket_id = 'attachments' and created_at < now() - make_interval(days => ${RETENTION_DAYS}) limit 200`;
  if (old.length) await storageCall('DELETE', '/object/attachments', { prefixes: old.map((o) => o.name) }).catch(() => {});
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

route('POST', '/auth/start', async ({ body, ip }) => {
  const { phone: input } = shape<{ phone: string }>(body, { phone: [PHONE_IN, true] });
  const phone = normalizePhone(input);
  if (!phone) throw new HttpError(400, 'invalid_phone', 'Please enter a valid mobile number.');
  await enforce(`start:ip:${ip}`, 20, HOUR);
  await enforce(`start:phone:${phone}`, 10, HOUR);
  const bot = await ensureBot();
  const id = randomId();
  const pollSecret = newToken();
  const startToken = randomBytes(24).toString('base64url');
  const t = now();
  await sql`insert into haven.verifications (id, poll_hash, start_token, phone, expires_at, created_at)
            values (${id}, ${sha256(pollSecret)}, ${startToken}, ${phone}, ${t + 10 * MIN}, ${t})`;
  return { phone, verifyId: id, pollSecret, telegramUrl: `https://t.me/${bot}?start=${startToken}`, expiresAt: t + 10 * MIN };
}, false);

route('POST', '/auth/verify', async ({ body, reply, ip }) => {
  const b = shape<{ verifyId: string; pollSecret: string; encPub: string; sigPub: string; deviceName?: string }>(body, {
    verifyId: [isId, true], pollSecret: [str(40, 64), true], encPub: [PUBKEY, true], sigPub: [PUBKEY, true], deviceName: [str(0, 60), false],
  });
  await enforce(`verify:ip:${ip}`, 1200, 10 * MIN);
  await enforce(`verify:id:${b.verifyId}`, 600, 10 * MIN);
  const [v] = await sql`select * from haven.verifications where id = ${b.verifyId}`;
  if (!v || !safeEqual(v.poll_hash, sha256(b.pollSecret)) || Number(v.expires_at) < now()) {
    throw new HttpError(400, 'verification_expired', 'This confirmation expired. Please start again.');
  }
  if (v.status === 'mismatch') {
    throw new HttpError(400, 'phone_mismatch', 'Your Telegram account uses a different number. Enter the number of your Telegram account.');
  }
  if (v.status !== 'verified') return { status: 'pending' };
  if (!(await isValidP256Key(b.encPub, 'ECDH')) || !(await isValidP256Key(b.sigPub, 'ECDSA'))) {
    throw new HttpError(400, 'invalid_keys', 'Your device produced invalid keys. Please reload and try again.');
  }
  // One use only.
  const used = await sql`delete from haven.verifications where id = ${v.id} returning id`;
  if (!used.length) throw new HttpError(400, 'verification_expired', 'This confirmation expired. Please start again.');

  const [existing] = await sql`select pin_hash, last_active_at from haven.users where phone = ${v.phone}`;
  if (existing?.pin_hash && now() - Number(existing.last_active_at) < PIN_LOCK_WINDOW) {
    const challenge = newToken();
    await sql`insert into haven.pin_challenges (token_hash, phone, enc_pub, sig_pub, expires_at)
              values (${sha256(challenge)}, ${v.phone}, ${b.encPub}, ${b.sigPub}, ${now() + 10 * MIN})`;
    return { status: 'pin_required', challenge };
  }
  return completeSignIn(reply, v.phone, b.encPub, b.sigPub, cleanLine(b.deviceName ?? '', 40));
}, false);

route('POST', '/auth/pin', async ({ body, reply, ip }) => {
  const b = shape<{ challenge: string; pin: string }>(body, { challenge: [str(40, 64), true], pin: [str(4, 12, /^\d+$/), true] });
  await enforce(`pin:ip:${ip}`, 20, HOUR);
  const [pending] = await sql`select * from haven.pin_challenges where token_hash = ${sha256(b.challenge)} and expires_at > ${now()}`;
  if (!pending) throw new HttpError(400, 'challenge_expired', 'This sign-in expired. Please start again.');
  const [user] = await sql`select id, pin_hash, pin_failures, pin_locked_until from haven.users where phone = ${pending.phone}`;
  const finish = async () => {
    await sql`delete from haven.pin_challenges where token_hash = ${pending.token_hash}`;
    return completeSignIn(reply, pending.phone, pending.enc_pub, pending.sig_pub, '');
  };
  if (!user?.pin_hash) return finish();
  if (Number(user.pin_locked_until) > now()) {
    throw new HttpError(429, 'pin_locked', 'Too many wrong PINs. Try again later.', { retryAfter: Math.ceil((Number(user.pin_locked_until) - now()) / 1000) });
  }
  if (!(await verifyPin(b.pin, user.pin_hash))) {
    const failures = user.pin_failures + 1;
    const lockedUntil = failures >= 5 ? now() + DAY : 0;
    await sql`update haven.users set pin_failures = ${lockedUntil ? 0 : failures}, pin_locked_until = ${lockedUntil} where id = ${user.id}`;
    if (lockedUntil) await sql`delete from haven.pin_challenges where token_hash = ${pending.token_hash}`;
    throw new HttpError(400, 'invalid_pin', lockedUntil ? 'Too many wrong PINs. Try again in 24 hours.' : 'Wrong PIN.', { attemptsLeft: lockedUntil ? 0 : 5 - failures });
  }
  return finish();
}, false);

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

// ---- me

route('GET', '/me', async ({ req, reply }) => ({ me: await meOf(await currentUser(req, reply)) }));

route('PATCH', '/me', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ name?: string; about?: string; readReceipts?: boolean }>(body, {
    name: [str(0, 200), false], about: [str(0, 500), false], readReceipts: [(v) => typeof v === 'boolean', false],
  });
  if (b.readReceipts !== undefined) await sql`update haven.users set read_receipts = ${b.readReceipts} where id = ${user.id}`;
  if (b.name !== undefined) {
    const name = cleanLine(b.name, 40);
    if (!name) throw new HttpError(400, 'invalid_name', 'Please enter a name.');
    await sql`update haven.users set name = ${name} where id = ${user.id}`;
  }
  if (b.about !== undefined) await sql`update haven.users set about = ${cleanLine(b.about, 140)} where id = ${user.id}`;
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

route('PUT', '/me/pin', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { pin } = shape<{ pin: string }>(body, { pin: [str(4, 12, /^\d+$/), true] });
  await enforce(`setpin:${user.id}`, 10, HOUR);
  await sql`update haven.users set pin_hash = ${await hashPin(pin)}, pin_failures = 0, pin_locked_until = 0 where id = ${user.id}`;
  return { me: await meOf(user) };
});

route('DELETE', '/me/pin', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { pin } = shape<{ pin: string }>(body, { pin: [str(4, 12, /^\d+$/), true] });
  await enforce(`setpin:${user.id}`, 10, HOUR);
  if (user.pin_hash && !(await verifyPin(pin, user.pin_hash))) throw new HttpError(400, 'invalid_pin', 'Wrong PIN.');
  await sql`update haven.users set pin_hash = null where id = ${user.id}`;
  return { me: await meOf(user) };
});

route('DELETE', '/me', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { confirmPhone } = shape<{ confirmPhone: string }>(body, { confirmPhone: [PHONE_IN, true] });
  if (normalizePhone(confirmPhone) !== user.phone) throw new HttpError(400, 'confirm_mismatch', 'The number does not match your account.');
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
  reply.cookie(sessionCookie('', 0));
  await broadcast(contacts, 'conversations');
  await notifyMessages(contacts);
  return ok;
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

route('POST', '/users/lookup', async ({ req, reply, body }) => {
  const user = await currentUser(req, reply);
  const { phone: input } = shape<{ phone: string }>(body, { phone: [PHONE_IN, true] });
  const phone = normalizePhone(input);
  if (!phone) throw new HttpError(400, 'invalid_phone', 'Please enter a valid mobile number.');
  await enforce(`lookup:${user.id}`, 60, HOUR);
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
  if (conv.my_role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can add people.');
  const current = new Set(await memberIds(conv.id));
  const toAdd: string[] = [];
  for (const id of b.userIds) {
    if (!current.has(id) && (await namedUserExists(id)) && !(await hasBlocked(id, user.id))) toAdd.push(id);
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

// ---- messages

route('POST', '/conversations/:id/messages', async ({ req, reply, params, body }) => {
  const user = await currentUser(req, reply);
  const b = shape<{ id: string; envelope: Row }>(body, { id: [isId, true], envelope: [validEnvelope, true] });
  await enforce(`send:${user.id}`, 120, MIN);
  const conv = await membershipOrThrow(params.id, user.id);

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
    await notifyMessages(recipientUsers.filter((uid) => uid !== user.id));
    await broadcast([user.id], 'sync');
  }
  return { id: b.id, createdAt: t };
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
  const data = await storageCall('POST', `/object/sign/attachments/${path}`, { expiresIn: 600 });
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

route('GET', '/health', async () => ({ ok: true, verification: Boolean(await botToken()) }), false);

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
    if (path === '/telegram/webhook' && req.method === 'POST') return await telegramWebhook(req);

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
