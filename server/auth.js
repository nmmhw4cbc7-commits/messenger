// Registration and sign-in with phone number + SMS code, plus an optional
// registration lock PIN that stops SIM-swap account takeovers.

import { db, tx } from './db.js';
import { sendCode, checkCode } from './sms.js';
import { createSession, clearSessionCookie, requireUser } from './session.js';
import { normalizePhone, enforce, limiter, HttpError, randomId, newToken, verifyPin, maskPhone } from './security.js';
import { PHONE_INPUT, PUBLIC_KEY, isValidP256Key } from './validate.js';
import { closeUserSockets, notifyMessages } from './realtime.js';
import { serializeMe } from './serialize.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
// A registration lock only applies while the account is in use. After a week
// without activity it lapses, so a forgotten PIN cannot lock someone out forever.
const PIN_LOCK_WINDOW = 7 * 24 * HOUR;
const PIN_MAX_FAILURES = 5;

/** challenge token -> pending sign-in that still needs the PIN */
const pinChallenges = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pinChallenges) if (v.expiresAt < now) pinChallenges.delete(k);
}, MIN).unref();

/** Create the account or move it to this device, revoking every other session. */
const completeSignIn = tx((phone, encPub, sigPub) => {
  const now = Date.now();
  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  let isNew = false;
  let keysChanged = false;
  const affected = new Set();

  if (!user) {
    isNew = true;
    const id = randomId();
    db.prepare(
      'INSERT INTO users (id, phone, enc_pub, sig_pub, key_version, created_at, last_active_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
    ).run(id, phone, encPub, sigPub, now, now);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  } else {
    keysChanged = user.enc_pub !== encPub || user.sig_pub !== sigPub;
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(user.id);
    db.prepare('UPDATE users SET pin_failures = 0, pin_locked_until = 0, last_active_at = ? WHERE id = ?').run(now, user.id);

    if (keysChanged) {
      db.prepare('UPDATE users SET enc_pub = ?, sig_pub = ?, key_version = key_version + 1 WHERE id = ?').run(encPub, sigPub, user.id);
      // Pending messages were encrypted for the old device and can never be read here.
      db.prepare('DELETE FROM message_recipients WHERE user_id = ?').run(user.id);

      // Tell every contact that this person's safety number changed.
      const convs = db.prepare('SELECT conversation_id FROM members WHERE user_id = ?').all(user.id);
      const insertMsg = db.prepare("INSERT INTO messages (id, conversation_id, sender_id, kind, body, created_at) VALUES (?, ?, NULL, 'system', ?, ?)");
      const insertRcpt = db.prepare('INSERT INTO message_recipients (seq, user_id) VALUES (?, ?)');
      for (const { conversation_id } of convs) {
        const others = db.prepare('SELECT user_id FROM members WHERE conversation_id = ? AND user_id != ?').all(conversation_id, user.id);
        if (!others.length) continue;
        const body = JSON.stringify({ type: 'key_changed', actorId: user.id });
        const { lastInsertRowid } = insertMsg.run(randomId(), conversation_id, body, now);
        for (const o of others) {
          insertRcpt.run(lastInsertRowid, o.user_id);
          affected.add(o.user_id);
        }
      }
    }
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }
  return { user, isNew, keysChanged, affected: [...affected] };
});

function finish(reply, phone, encPub, sigPub) {
  const result = completeSignIn(phone, encPub, sigPub);
  closeUserSockets(result.user.id);
  if (result.affected.length) notifyMessages(result.affected);
  createSession(reply, result.user.id);
  return { status: 'ok', isNew: result.isNew, me: serializeMe(result.user) };
}

export async function authRoutes(app) {
  app.post('/api/auth/start', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['phone'],
        properties: { phone: PHONE_INPUT },
      },
    },
  }, async (request) => {
    const phone = normalizePhone(request.body.phone);
    if (!phone) throw new HttpError(400, 'invalid_phone', 'Please enter a valid mobile number.');

    enforce(`start:ip:${request.ip}`, 10, HOUR);
    enforce(`start:phone:${phone}`, 1, 30_000);
    enforce(`start:phone10:${phone}`, 3, 10 * MIN);
    enforce(`start:phoneDay:${phone}`, 8, 24 * HOUR);

    const sent = await sendCode(phone, request.log);
    if (!sent) throw new HttpError(502, 'sms_failed', 'We could not send a code to this number. Please check it and try again.');
    request.log.info({ phone: maskPhone(phone) }, 'verification code sent');
    // The response is the same whether or not the number is registered.
    return { phone, resendAfter: 30 };
  });

  app.post('/api/auth/verify', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['phone', 'code', 'encPub', 'sigPub'],
        properties: {
          phone: PHONE_INPUT,
          code: { type: 'string', pattern: '^[0-9]{4,8}$' },
          encPub: PUBLIC_KEY,
          sigPub: PUBLIC_KEY,
        },
      },
    },
  }, async (request, reply) => {
    const { code, encPub, sigPub } = request.body;
    const phone = normalizePhone(request.body.phone);
    if (!phone) throw new HttpError(400, 'invalid_phone', 'Please enter a valid mobile number.');

    enforce(`verify:ip:${request.ip}`, 30, 10 * MIN);
    enforce(`verify:phone:${phone}`, 8, 10 * MIN);

    if (!(await isValidP256Key(encPub, 'ECDH')) || !(await isValidP256Key(sigPub, 'ECDSA'))) {
      throw new HttpError(400, 'invalid_keys', 'Your device produced invalid keys. Please reload and try again.');
    }
    if (!(await checkCode(phone, code, request.log))) {
      throw new HttpError(400, 'invalid_code', 'That code is not correct or has expired.');
    }
    limiter.reset(`verify:phone:${phone}`);

    const existing = db.prepare('SELECT id, pin_hash, last_active_at FROM users WHERE phone = ?').get(phone);
    if (existing?.pin_hash && Date.now() - existing.last_active_at < PIN_LOCK_WINDOW) {
      const challenge = newToken();
      pinChallenges.set(challenge, { phone, encPub, sigPub, expiresAt: Date.now() + 10 * MIN });
      return { status: 'pin_required', challenge };
    }
    return finish(reply, phone, encPub, sigPub);
  });

  app.post('/api/auth/pin', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['challenge', 'pin'],
        properties: {
          challenge: { type: 'string', minLength: 40, maxLength: 64 },
          pin: { type: 'string', pattern: '^[0-9]{4,12}$' },
        },
      },
    },
  }, async (request, reply) => {
    enforce(`pin:ip:${request.ip}`, 20, HOUR);
    const pending = pinChallenges.get(request.body.challenge);
    if (!pending || pending.expiresAt < Date.now()) {
      throw new HttpError(400, 'challenge_expired', 'This sign-in expired. Please request a new code.');
    }

    const user = db.prepare('SELECT id, pin_hash, pin_failures, pin_locked_until FROM users WHERE phone = ?').get(pending.phone);
    if (!user?.pin_hash) {
      pinChallenges.delete(request.body.challenge);
      return finish(reply, pending.phone, pending.encPub, pending.sigPub);
    }
    if (user.pin_locked_until > Date.now()) {
      throw new HttpError(429, 'pin_locked', 'Too many wrong PINs. Try again later.', {
        retryAfter: Math.ceil((user.pin_locked_until - Date.now()) / 1000),
      });
    }

    if (!(await verifyPin(request.body.pin, user.pin_hash))) {
      const failures = user.pin_failures + 1;
      const lockedUntil = failures >= PIN_MAX_FAILURES ? Date.now() + 24 * HOUR : 0;
      db.prepare('UPDATE users SET pin_failures = ?, pin_locked_until = ? WHERE id = ?').run(lockedUntil ? 0 : failures, lockedUntil, user.id);
      if (lockedUntil) pinChallenges.delete(request.body.challenge);
      throw new HttpError(400, 'invalid_pin', lockedUntil ? 'Too many wrong PINs. Try again in 24 hours.' : 'Wrong PIN.', {
        attemptsLeft: lockedUntil ? 0 : PIN_MAX_FAILURES - failures,
      });
    }

    pinChallenges.delete(request.body.challenge);
    return finish(reply, pending.phone, pending.encPub, pending.sigPub);
  });

  app.post('/api/auth/logout', { preHandler: requireUser }, async (request, reply) => {
    const userId = request.user.id;
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(request.sessionHash);
    db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
    clearSessionCookie(reply);
    closeUserSockets(userId);
    return { ok: true };
  });
}
