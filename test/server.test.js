// Server security tests. Run with: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'haven-test-'));
process.env.DATA_DIR = dir;
process.env.SMS_PROVIDER = 'console';
process.env.HAVEN_TEST_CODES = '1';
process.env.PUBLIC_ORIGIN = 'http://localhost:8080';
process.env.NODE_ENV = 'test';

const { buildApp } = await import('../server/app.js');
const { testCodes } = await import('../server/sms.js');
const { db } = await import('../server/db.js');
const { limiter } = await import('../server/security.js');

const ORIGIN = 'http://localhost:8080';
let app;
let ipCounter = 1;

before(async () => {
  app = await buildApp({ logger: false });
});
after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const b64u = (buf) => Buffer.from(buf).toString('base64url');
async function keys() {
  const enc = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const sig = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    encPub: b64u(await webcrypto.subtle.exportKey('raw', enc.publicKey)),
    sigPub: b64u(await webcrypto.subtle.exportKey('raw', sig.publicKey)),
  };
}

function req(method, url, { body, cookie, origin = ORIGIN, headers = {}, ip } = {}) {
  return app.inject({
    method,
    url,
    remoteAddress: ip || `10.0.0.${ipCounter}`,
    headers: {
      ...(origin ? { origin } : {}),
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    payload: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
  });
}

async function signUp(phone, name, k) {
  ipCounter++;
  k = k || (await keys());
  let res = await req('POST', '/api/auth/start', { body: { phone } });
  assert.equal(res.statusCode, 200, res.body);
  res = await req('POST', '/api/auth/verify', { body: { phone, code: testCodes.get(phone), ...k } });
  assert.equal(res.statusCode, 200, res.body);
  const data = res.json();
  if (data.status === 'pin_required') return { data, keys: k };
  const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  if (name) {
    const r = await req('PATCH', '/api/me', { cookie, body: { name } });
    assert.equal(r.statusCode, 200, r.body);
  }
  return { cookie, me: data.me, keys: k, data };
}

const dummyKey = () => ({ kv: 1, iv: b64u(webcrypto.getRandomValues(new Uint8Array(12))), k: b64u(webcrypto.getRandomValues(new Uint8Array(48))) });
const msgId = () => b64u(webcrypto.getRandomValues(new Uint8Array(16)));
function envelope(keyMap) {
  return {
    v: 1, ts: Date.now(),
    eph: b64u(webcrypto.getRandomValues(new Uint8Array(65))),
    iv: b64u(webcrypto.getRandomValues(new Uint8Array(12))),
    ct: b64u(webcrypto.getRandomValues(new Uint8Array(40))),
    sig: b64u(webcrypto.getRandomValues(new Uint8Array(64))),
    keys: keyMap,
  };
}

test('security headers are set', async () => {
  const res = await req('GET', '/healthz');
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
});

test('state-changing requests need our Origin', async () => {
  let res = await req('POST', '/api/auth/start', { body: { phone: '+4915100000001' }, origin: null });
  assert.equal(res.statusCode, 403);
  res = await req('POST', '/api/auth/start', { body: { phone: '+4915100000001' }, origin: 'https://evil.example' });
  assert.equal(res.statusCode, 403);
});

test('invalid and landline numbers are rejected', async () => {
  let res = await req('POST', '/api/auth/start', { body: { phone: '12' } });
  assert.equal(res.statusCode, 400);
  res = await req('POST', '/api/auth/start', { body: { phone: '+49301234567' } }); // Berlin landline
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_phone');
});

test('unknown fields are rejected', async () => {
  const res = await req('POST', '/api/auth/start', { body: { phone: '+4915100000002', admin: true } });
  assert.equal(res.statusCode, 400);
});

test('wrong codes fail and are limited; invalid keys are rejected', async () => {
  ipCounter++;
  const phone = '+4915100000003';
  const k = await keys();
  await req('POST', '/api/auth/start', { body: { phone } });
  let res = await req('POST', '/api/auth/verify', { body: { phone, code: '000000' === testCodes.get(phone) ? '111111' : '000000', ...k } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_code');

  const notOnCurve = b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]));
  res = await req('POST', '/api/auth/verify', { body: { phone, code: testCodes.get(phone), encPub: notOnCurve, sigPub: k.sigPub } });
  assert.equal(res.json().error, 'invalid_keys');

  // After 5 wrong attempts the code is dead, even the right one fails.
  for (let i = 0; i < 5; i++) await req('POST', '/api/auth/verify', { body: { phone, code: '999999' === testCodes.get(phone) ? '888888' : '999999', ...k } });
  res = await req('POST', '/api/auth/verify', { body: { phone, code: testCodes.get(phone), ...k } });
  assert.equal(res.statusCode, 400);
});

test('requesting codes is rate limited per number', async () => {
  ipCounter++;
  const phone = '+4915100000004';
  let res = await req('POST', '/api/auth/start', { body: { phone } });
  assert.equal(res.statusCode, 200);
  res = await req('POST', '/api/auth/start', { body: { phone } });
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers['retry-after']) > 0);
});

test('API needs a session; the database never stores the raw token', async () => {
  let res = await req('GET', '/api/me');
  assert.equal(res.statusCode, 401);
  const { cookie } = await signUp('+4915100000005', 'Sam');
  res = await req('GET', '/api/me', { cookie });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().me.name, 'Sam');
  assert.equal(res.json().me.pin_hash, undefined);
  const token = cookie.split('=')[1];
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(token), undefined);
});

test('session cookie is HttpOnly and SameSite=Strict', async () => {
  ipCounter++;
  const phone = '+4915100000006';
  const k = await keys();
  await req('POST', '/api/auth/start', { body: { phone } });
  const res = await req('POST', '/api/auth/verify', { body: { phone, code: testCodes.get(phone), ...k } });
  const raw = String(res.headers['set-cookie']);
  assert.match(raw, /HttpOnly/i);
  assert.match(raw, /SameSite=Strict/i);
});

test('messaging: recipients, authorization, delete after delivery', async () => {
  const alice = await signUp('+4915110000001', 'Alice');
  const bob = await signUp('+4915110000002', 'Bob');
  const eve = await signUp('+4915110000003', 'Eve');

  let res = await req('POST', '/api/users/lookup', { cookie: alice.cookie, body: { phone: '0151 10000002' } });
  assert.equal(res.json().found, true);
  const bobId = res.json().user.id;
  res = await req('POST', '/api/users/lookup', { cookie: alice.cookie, body: { phone: '+4915199999999' } });
  assert.equal(res.json().found, false);

  res = await req('POST', '/api/conversations/direct', { cookie: alice.cookie, body: { userId: bobId } });
  const conv = res.json().conversation;
  assert.equal(conv.members.length, 2);

  // Same pair -> same conversation
  res = await req('POST', '/api/conversations/direct', { cookie: bob.cookie, body: { userId: alice.me.id } });
  assert.equal(res.json().conversation.id, conv.id);

  // Missing recipient key -> 409, client re-encrypts
  res = await req('POST', `/api/conversations/${conv.id}/messages`, { cookie: alice.cookie, body: { id: msgId(), envelope: envelope({}) } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'members_changed');
  // Key for an outsider -> 409
  res = await req('POST', `/api/conversations/${conv.id}/messages`, { cookie: alice.cookie, body: { id: msgId(), envelope: envelope({ [bobId]: dummyKey(), [eve.me.id]: dummyKey() }) } });
  assert.equal(res.statusCode, 409);
  // Stale key version -> 409
  res = await req('POST', `/api/conversations/${conv.id}/messages`, { cookie: alice.cookie, body: { id: msgId(), envelope: envelope({ [bobId]: { ...dummyKey(), kv: 7 } }) } });
  assert.equal(res.json().error, 'keys_changed');

  const id = msgId();
  res = await req('POST', `/api/conversations/${conv.id}/messages`, { cookie: alice.cookie, body: { id, envelope: envelope({ [bobId]: dummyKey() }) } });
  assert.equal(res.statusCode, 200, res.body);
  // Retry with the same id is idempotent
  res = await req('POST', `/api/conversations/${conv.id}/messages`, { cookie: alice.cookie, body: { id, envelope: envelope({ [bobId]: dummyKey() }) } });
  assert.equal(res.statusCode, 200);
  // Someone else reusing the id is refused
  res = await req('POST', `/api/conversations/${conv.id}/messages`, { cookie: bob.cookie, body: { id, envelope: envelope({ [alice.me.id]: dummyKey() }) } });
  assert.equal(res.statusCode, 409);

  // Outsider cannot see or post
  res = await req('GET', `/api/conversations/${conv.id}`, { cookie: eve.cookie });
  assert.equal(res.statusCode, 404);
  res = await req('POST', `/api/conversations/${conv.id}/messages`, { cookie: eve.cookie, body: { id: msgId(), envelope: envelope({ [bobId]: dummyKey() }) } });
  assert.equal(res.statusCode, 404);
  res = await req('GET', '/api/sync', { cookie: eve.cookie });
  assert.equal(res.json().messages.length, 0);

  // Sender does not get their own message; recipient does
  res = await req('GET', '/api/sync', { cookie: alice.cookie });
  assert.equal(res.json().messages.length, 0);
  res = await req('GET', '/api/sync', { cookie: bob.cookie });
  const synced = res.json().messages;
  assert.equal(synced.length, 1);
  assert.equal(synced[0].id, id);
  assert.equal(synced[0].senderId, alice.me.id);

  // After the ack the server no longer has the message at all
  res = await req('POST', '/api/sync/ack', { cookie: bob.cookie, body: { upTo: synced[0].seq } });
  assert.equal(res.statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get(id).n, 0);
});

test('blocking stops delivery and group invites', async () => {
  const a = await signUp('+4915120000001', 'Ann');
  const b = await signUp('+4915120000002', 'Bo');
  let res = await req('POST', '/api/conversations/direct', { cookie: a.cookie, body: { userId: b.me.id } });
  const conv = res.json().conversation;

  res = await req('PUT', `/api/blocks/${a.me.id}`, { cookie: b.cookie });
  assert.equal(res.statusCode, 200);
  res = await req('POST', `/api/conversations/${conv.id}/messages`, { cookie: a.cookie, body: { id: msgId(), envelope: envelope({ [b.me.id]: dummyKey() }) } });
  assert.equal(res.statusCode, 200); // the sender is not told
  res = await req('GET', '/api/sync', { cookie: b.cookie });
  assert.equal(res.json().messages.length, 0);

  res = await req('POST', '/api/conversations/group', { cookie: a.cookie, body: { title: 'Party', memberIds: [b.me.id] } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'no_members');

  res = await req('DELETE', `/api/blocks/${a.me.id}`, { cookie: b.cookie });
  assert.equal(res.statusCode, 200);
});

test('groups: only admins manage members; removed members are locked out', async () => {
  const admin = await signUp('+4915130000001', 'Admin');
  const m1 = await signUp('+4915130000002', 'Member One');
  const m2 = await signUp('+4915130000003', 'Member Two');
  const outsider = await signUp('+4915130000004', 'Out');

  let res = await req('POST', '/api/conversations/group', { cookie: admin.cookie, body: { title: '  Team ‮evil  ', memberIds: [m1.me.id] } });
  assert.equal(res.statusCode, 200, res.body);
  const group = res.json().conversation;
  assert.equal(group.title, 'Team evil'); // bidi override and extra spaces removed

  res = await req('POST', `/api/conversations/${group.id}/members`, { cookie: m1.cookie, body: { userIds: [m2.me.id] } });
  assert.equal(res.statusCode, 403);
  res = await req('PATCH', `/api/conversations/${group.id}`, { cookie: m1.cookie, body: { title: 'Mine now' } });
  assert.equal(res.statusCode, 403);
  res = await req('POST', `/api/conversations/${group.id}/members`, { cookie: outsider.cookie, body: { userIds: [outsider.me.id] } });
  assert.equal(res.statusCode, 404);

  res = await req('POST', `/api/conversations/${group.id}/members`, { cookie: admin.cookie, body: { userIds: [m2.me.id] } });
  assert.equal(res.json().conversation.members.length, 3);

  res = await req('DELETE', `/api/conversations/${group.id}/members/${m2.me.id}`, { cookie: m1.cookie });
  assert.equal(res.statusCode, 403);
  res = await req('DELETE', `/api/conversations/${group.id}/members/${m2.me.id}`, { cookie: admin.cookie });
  assert.equal(res.statusCode, 200);
  res = await req('POST', `/api/conversations/${group.id}/messages`, { cookie: m2.cookie, body: { id: msgId(), envelope: envelope({ [admin.me.id]: dummyKey() }) } });
  assert.equal(res.statusCode, 404);

  // The removed member is told, via a system event
  res = await req('GET', '/api/sync', { cookie: m2.cookie });
  assert.ok(res.json().messages.some((m) => m.kind === 'system' && m.body.type === 'member_removed'));

  // When the only admin leaves, someone else becomes admin
  res = await req('DELETE', `/api/conversations/${group.id}/members/${admin.me.id}`, { cookie: admin.cookie });
  assert.equal(res.statusCode, 200);
  res = await req('GET', `/api/conversations/${group.id}`, { cookie: m1.cookie });
  assert.equal(res.json().conversation.myRole, 'admin');
});

test('new device: keys rotate, old sessions end, contacts are told', async () => {
  const x = await signUp('+4915140000001', 'Xavi');
  const y = await signUp('+4915140000002', 'Yara');
  let res = await req('POST', '/api/conversations/direct', { cookie: x.cookie, body: { userId: y.me.id } });
  const conv = res.json().conversation;
  await req('POST', `/api/conversations/${conv.id}/messages`, { cookie: x.cookie, body: { id: msgId(), envelope: envelope({ [y.me.id]: dummyKey() }) } });

  limiter.reset('start:phone:+4915140000002');
  const y2 = await signUp('+4915140000002');
  assert.equal(y2.me.keyVersion, 2);
  res = await req('GET', '/api/me', { cookie: y.cookie });
  assert.equal(res.statusCode, 401); // old device signed out
  res = await req('GET', '/api/sync', { cookie: y2.cookie });
  assert.equal(res.json().messages.length, 0); // undecryptable old messages were dropped
  res = await req('GET', '/api/sync', { cookie: x.cookie });
  assert.ok(res.json().messages.some((m) => m.body.type === 'key_changed' && m.body.actorId === y.me.id));
});

test('registration lock requires the PIN on a new device', async () => {
  const p = await signUp('+4915150000001', 'Pia');
  let res = await req('PUT', '/api/me/pin', { cookie: p.cookie, body: { pin: '2468' } });
  assert.equal(res.json().me.hasPin, true);
  assert.equal(db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(p.me.id).pin_hash.startsWith('scrypt$'), true);

  limiter.reset('start:phone:+4915150000001');
  const attempt = await signUp('+4915150000001');
  assert.equal(attempt.data.status, 'pin_required');
  const challenge = attempt.data.challenge;

  res = await req('POST', '/api/auth/pin', { body: { challenge, pin: '1111' } });
  assert.equal(res.json().error, 'invalid_pin');
  assert.equal(res.json().attemptsLeft, 4);
  res = await req('GET', '/api/me', { cookie: p.cookie });
  assert.equal(res.statusCode, 200); // still signed in on the real device

  res = await req('POST', '/api/auth/pin', { body: { challenge, pin: '2468' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
});

test('avatars must be JPEG and are served safely', async () => {
  const u = await signUp('+4915160000001', 'Uma');
  let res = await req('PUT', '/api/me/avatar', { cookie: u.cookie, body: Buffer.from('<svg onload=alert(1)>'), headers: { 'content-type': 'image/jpeg' } });
  assert.equal(res.statusCode, 400);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100), Buffer.from([0xff, 0xd9])]);
  res = await req('PUT', '/api/me/avatar', { cookie: u.cookie, body: jpeg, headers: { 'content-type': 'image/jpeg' } });
  assert.equal(res.statusCode, 200, res.body);
  res = await req('GET', `/api/avatars/${u.me.id}`, { cookie: u.cookie });
  assert.equal(res.headers['content-type'], 'image/jpeg');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.headers['content-security-policy'], /sandbox/);
  res = await req('GET', `/api/avatars/${u.me.id}`);
  assert.equal(res.statusCode, 401);
});

test('push endpoints are restricted to real push services', async () => {
  const u = await signUp('+4915170000001', 'Push');
  const keysBody = { p256dh: b64u(Buffer.alloc(65, 4)), auth: b64u(Buffer.alloc(16, 1)) };
  for (const endpoint of ['http://169.254.169.254/latest', 'https://localhost/x', 'https://fcm.googleapis.com.evil.com/x', 'https://fcm.googleapis.com:8443/x']) {
    const res = await req('POST', '/api/push/subscribe', { cookie: u.cookie, body: { endpoint, keys: keysBody } });
    assert.equal(res.statusCode, 400, endpoint);
  }
  const res = await req('POST', '/api/push/subscribe', { cookie: u.cookie, body: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: keysBody } });
  assert.equal(res.statusCode, 200);
});

test('account deletion needs the matching number and removes everything', async () => {
  const d = await signUp('+4915180000001', 'Dee');
  let res = await req('DELETE', '/api/me', { cookie: d.cookie, body: { confirmPhone: '+4915180000002' } });
  assert.equal(res.statusCode, 400);
  res = await req('DELETE', '/api/me', { cookie: d.cookie, body: { confirmPhone: '+4915180000001' } });
  assert.equal(res.statusCode, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(d.me.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(d.me.id).n, 0);
});

test('static files cannot escape the build directory', async () => {
  for (const url of ['/assets/..%2f..%2fpackage.json', '/..%2fserver/config.js', '/assets/%2e%2e/%2e%2e/.env']) {
    const res = await req('GET', url);
    assert.ok(!res.body.includes('TWILIO') && !res.body.includes('"dependencies"'), url);
  }
});
