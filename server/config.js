// Central configuration. Every value is read once, validated, and frozen.
// The server refuses to start with an unsafe production configuration.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

loadDotEnv(resolve(process.cwd(), '.env'));

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    let value = m[2];
    if (/^".*"$|^'.*'$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

function int(name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function bool(name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be true or false`);
}

const publicOrigin = (env.PUBLIC_ORIGIN || 'http://localhost:8080').replace(/\/+$/, '');
let originUrl;
try {
  originUrl = new URL(publicOrigin);
} catch {
  throw new Error('PUBLIC_ORIGIN must be a full origin, e.g. https://chat.example.com');
}
if (originUrl.origin !== publicOrigin) {
  throw new Error('PUBLIC_ORIGIN must be an origin only (scheme, host and port, no path)');
}

const smsProvider = env.SMS_PROVIDER || (isProduction ? 'twilio' : 'console');

const config = Object.freeze({
  isProduction,
  host: env.HOST || '0.0.0.0',
  port: int('PORT', 8080, 1, 65535),
  publicOrigin,
  // Extra origins that may call the API, e.g. the Vite dev server. Never used in production.
  devOrigins: isProduction ? [] : (env.DEV_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: bool('TRUST_PROXY', false),
  cookieSecure: bool('COOKIE_SECURE', originUrl.protocol === 'https:'),
  dataDir: resolve(env.DATA_DIR || 'data'),
  appName: env.APP_NAME || 'Haven',
  smsProvider,
  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    verifyServiceSid: env.TWILIO_VERIFY_SERVICE_SID || '',
  },
  // Default region used to parse numbers typed without a country code.
  defaultRegion: (env.DEFAULT_REGION || 'DE').toUpperCase(),
  sessionDays: int('SESSION_DAYS', 60, 1, 365),
  messageRetentionDays: int('MESSAGE_RETENTION_DAYS', 30, 1, 365),
  maxGroupSize: int('MAX_GROUP_SIZE', 100, 2, 500),
  vapidSubject: env.VAPID_SUBJECT || `mailto:admin@${originUrl.hostname}`,
});

if (!['console', 'twilio'].includes(config.smsProvider)) {
  throw new Error('SMS_PROVIDER must be "twilio" or "console"');
}
if (config.smsProvider === 'twilio') {
  const t = config.twilio;
  if (!t.accountSid || !t.authToken || !t.verifyServiceSid) {
    throw new Error('SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_VERIFY_SERVICE_SID');
  }
}
if (config.isProduction) {
  if (config.smsProvider === 'console') {
    throw new Error('SMS_PROVIDER=console prints login codes to the log and is not allowed in production');
  }
  if (originUrl.protocol !== 'https:') throw new Error('PUBLIC_ORIGIN must use https in production');
  if (!config.cookieSecure) throw new Error('COOKIE_SECURE cannot be disabled in production');
}
if (!/^[A-Z]{2}$/.test(config.defaultRegion)) throw new Error('DEFAULT_REGION must be a two-letter country code');

export default config;
