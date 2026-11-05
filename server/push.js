// Web Push. Notifications carry no sender and no content, only "new message",
// so nothing readable ever passes through Apple, Google or Mozilla push servers.

import webpush from 'web-push';
import config from './config.js';
import { db, kvGet, kvSet } from './db.js';

let keys = JSON.parse(kvGet('vapid') || 'null');
if (!keys) {
  keys = webpush.generateVAPIDKeys();
  kvSet('vapid', JSON.stringify(keys));
}
webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);

export const vapidPublicKey = keys.publicKey;

// Only real browser push services. Without this list the server could be told
// to send requests to arbitrary (for example internal) URLs.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

export function isAllowedPushEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some((re) => re.test(url.hostname));
  } catch {
    return false;
  }
}

const lastPush = new Map();

export function sendPush(userId) {
  // At most one push per user every 5 seconds; the client collapses them anyway.
  const now = Date.now();
  if (now - (lastPush.get(userId) || 0) < 5000) return;
  lastPush.set(userId, now);

  const subs = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);
  for (const sub of subs) {
    webpush
      .sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify({ t: 'msg' }), {
        TTL: 86400,
        urgency: 'high',
        topic: 'new-messages',
        timeout: 10_000,
      })
      .catch((err) => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
        }
      });
  }
}

setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [id, t] of lastPush) if (t < cutoff) lastPush.delete(id);
}, 60_000).unref();
