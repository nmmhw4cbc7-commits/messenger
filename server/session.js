// Cookie sessions. The browser holds a random 256-bit token in an HttpOnly,
// SameSite=Strict cookie; the database only stores its SHA-256 hash.

import config from './config.js';
import { db } from './db.js';
import { newToken, sha256, HttpError } from './security.js';

export const COOKIE = config.cookieSecure ? '__Host-haven' : 'haven';
const DAY = 86400_000;
const TOUCH_INTERVAL = 3600_000;

function cookieOptions(maxAgeSeconds) {
  return { path: '/', httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', maxAge: maxAgeSeconds };
}

export function createSession(reply, userId) {
  const token = newToken();
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)').run(
    sha256(token), userId, now, now + config.sessionDays * DAY, now,
  );
  reply.setCookie(COOKIE, token, cookieOptions(config.sessionDays * 86400));
}

export function clearSessionCookie(reply) {
  reply.clearCookie(COOKIE, cookieOptions(0));
}

const findSession = db.prepare(`
  SELECT s.token_hash, s.expires_at, s.last_used_at, u.*
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ?`);

/** Resolve the user behind a raw cookie value, or null. Also slides the expiry. */
export function userFromToken(token, reply) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 64) return null;
  const row = findSession.get(sha256(token));
  const now = Date.now();
  if (!row || row.expires_at < now) return null;

  if (now - row.last_used_at > TOUCH_INTERVAL) {
    const remaining = row.expires_at - now;
    const extend = remaining < (config.sessionDays * DAY) / 2;
    const expires = extend ? now + config.sessionDays * DAY : row.expires_at;
    db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?').run(now, expires, row.token_hash);
    db.prepare('UPDATE users SET last_active_at = ? WHERE id = ?').run(now, row.id);
    if (extend && reply) reply.setCookie(COOKIE, token, cookieOptions(config.sessionDays * 86400));
  }
  return row;
}

/** Fastify preHandler: require a valid session. */
export function requireUser(request, reply, done) {
  const user = userFromToken(request.cookies[COOKIE], reply);
  if (!user) return done(new HttpError(401, 'unauthorized', 'Please sign in again.'));
  request.user = user;
  request.sessionHash = user.token_hash;
  done();
}
