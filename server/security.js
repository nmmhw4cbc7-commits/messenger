import { randomBytes, createHash, scrypt as scryptCb, timingSafeEqual, randomInt } from 'node:crypto';
import { promisify } from 'node:util';
import { parsePhoneNumberWithError } from 'libphonenumber-js/max';
import config from './config.js';

const scrypt = promisify(scryptCb);

export const randomId = () => randomBytes(16).toString('base64url');
export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Six digit code from a CSPRNG. */
export const newOtpCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Normalize user input to E.164, or return null if it is not a valid mobile-capable number. */
export function normalizePhone(input, region = config.defaultRegion) {
  if (typeof input !== 'string' || input.length > 32) return null;
  try {
    const parsed = parsePhoneNumberWithError(input, region);
    if (!parsed.isValid()) return null;
    const type = parsed.getType();
    // Landlines cannot receive SMS. Unknown types are allowed (some regions do not distinguish).
    if (type === 'FIXED_LINE' || type === 'PREMIUM_RATE' || type === 'SHARED_COST' || type === 'TOLL_FREE') return null;
    return parsed.number;
  } catch {
    return null;
  }
}

/** For logs: never write a full phone number. */
export const maskPhone = (phone) => (phone ? `${phone.slice(0, 4)}…${phone.slice(-2)}` : '');

// ---------------------------------------------------------------- PIN (registration lock)

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPin(pin) {
  const salt = randomBytes(16);
  const key = await scrypt(pin, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPin(pin, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64url');
  const actual = await scrypt(pin, Buffer.from(saltB64, 'base64url'), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------- rate limiting

/**
 * Fixed-window counters kept in memory. Haven is designed to run as a single
 * process; if you ever run several, move this to a shared store.
 */
export class RateLimiter {
  #buckets = new Map();

  constructor() {
    setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.#buckets) if (bucket.resetAt <= now) this.#buckets.delete(key);
    }, 60_000).unref();
  }

  /** Count one hit. Returns 0 if allowed, otherwise the seconds until the window resets. */
  hit(key, limit, windowMs) {
    const now = Date.now();
    let bucket = this.#buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.#buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count > limit ? Math.ceil((bucket.resetAt - now) / 1000) : 0;
  }

  reset(key) {
    this.#buckets.delete(key);
  }
}

export const limiter = new RateLimiter();

export class HttpError extends Error {
  constructor(statusCode, code, message, extra) {
    super(message || code);
    this.statusCode = statusCode;
    this.code = code;
    this.extra = extra;
  }
}

/** Throw a 429 if the key exceeded its budget. */
export function enforce(key, limit, windowMs) {
  const retryAfter = limiter.hit(key, limit, windowMs);
  if (retryAfter) throw new HttpError(429, 'rate_limited', 'Too many attempts. Please wait a moment.', { retryAfter });
}

// ---------------------------------------------------------------- HTTP hardening

const wsOrigin = config.publicOrigin.replace(/^http/, 'ws');

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src 'self' ${wsOrigin}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(config.isProduction ? ['upgrade-insecure-requests'] : []),
].join('; ');

export function securityHeaders(reply) {
  reply.header('Content-Security-Policy', CSP);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  if (config.cookieSecure) reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

const allowedOrigins = new Set([config.publicOrigin, ...config.devOrigins]);

/** Cross-site request forgery protection for state-changing requests and WebSockets. */
export function isAllowedOrigin(origin) {
  return typeof origin === 'string' && allowedOrigins.has(origin);
}
