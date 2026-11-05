// Phone verification.
//
//  - "twilio": Twilio Verify generates, sends, expires and checks the code.
//    The code never touches this server.
//  - "console": development only. The code is printed to the server log and
//    stored as a hash. config.js refuses this provider in production.

import config from './config.js';
import { db } from './db.js';
import { newOtpCode, sha256, safeEqual, maskPhone } from './security.js';

const CODE_TTL_MS = 10 * 60_000;

/** Automated tests read codes from here. Only filled outside production with HAVEN_TEST_CODES=1. */
export const testCodes = new Map();
const recordTestCodes = !config.isProduction && process.env.HAVEN_TEST_CODES === '1';
const MAX_ATTEMPTS = 5;

async function twilio(path, params) {
  const { accountSid, authToken, verifyServiceSid } = config.twilio;
  const res = await fetch(`https://verify.twilio.com/v2/Services/${encodeURIComponent(verifyServiceSid)}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/** Send a code. Resolves to true if the provider accepted the request. */
export async function sendCode(phone, log) {
  if (config.smsProvider === 'twilio') {
    const { status, data } = await twilio('Verifications', { To: phone, Channel: 'sms' });
    if (status >= 200 && status < 300) return true;
    log.warn({ status, twilioCode: data.code, phone: maskPhone(phone) }, 'twilio verification failed');
    return false;
  }

  const code = newOtpCode();
  db.prepare(
    `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
     ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
  ).run(phone, sha256(`${phone}:${code}`), Date.now() + CODE_TTL_MS);
  log.info(`[dev] verification code for ${phone}: ${code}`);
  if (recordTestCodes) testCodes.set(phone, code);
  return true;
}

/** Check a code. Resolves to true only for a correct, unexpired, unused code. */
export async function checkCode(phone, code, log) {
  if (config.smsProvider === 'twilio') {
    const { status, data } = await twilio('VerificationCheck', { To: phone, Code: code });
    if (status === 404) return false; // expired, used, or too many attempts
    if (status < 200 || status >= 300) {
      log.warn({ status, twilioCode: data.code }, 'twilio verification check failed');
      return false;
    }
    return data.status === 'approved';
  }

  const row = db.prepare('SELECT code_hash, expires_at, attempts FROM otp_codes WHERE phone = ?').get(phone);
  if (!row || row.expires_at < Date.now() || row.attempts >= MAX_ATTEMPTS) return false;
  if (!safeEqual(row.code_hash, sha256(`${phone}:${code}`))) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?').run(phone);
    return false;
  }
  db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(phone);
  return true;
}
