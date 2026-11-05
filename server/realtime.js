// WebSocket hub. The socket never carries message content: it only tells a
// client "there is something new, sync now". All data goes through the
// authenticated HTTP API, so there is exactly one code path to secure.

import { userFromToken, COOKIE } from './session.js';
import { isAllowedOrigin } from './security.js';
import { sendPush } from './push.js';

/** userId -> Set<{ socket, sessionHash }> */
const sockets = new Map();

export function isOnline(userId) {
  return (sockets.get(userId)?.size ?? 0) > 0;
}

function send(userId, payload) {
  const set = sockets.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const { socket } of set) if (socket.readyState === 1) socket.send(data);
}

/** New messages are waiting for these users. Offline users get a content-free push. */
export function notifyMessages(userIds) {
  for (const id of userIds) {
    send(id, { t: 'sync' });
    if (!isOnline(id)) sendPush(id);
  }
}

/** Conversation list or membership changed for these users. */
export function notifyConversations(userIds) {
  for (const id of userIds) send(id, { t: 'conversations' });
}

/** A user's profile changed; tell everyone who can see it. */
export function notifyProfile(userIds) {
  for (const id of userIds) send(id, { t: 'profiles' });
}

/** Sessions were revoked (sign-out, sign-in on another device, account deleted). */
export function closeUserSockets(userId, keepSessionHash = null) {
  const set = sockets.get(userId);
  if (!set) return;
  for (const entry of [...set]) {
    if (entry.sessionHash === keepSessionHash) continue;
    entry.socket.close(4001, 'session ended');
    set.delete(entry);
  }
  if (set.size === 0) sockets.delete(userId);
}

export async function realtimeRoutes(app) {
  app.get('/api/ws', { websocket: true }, (socket, request) => {
    const user = isAllowedOrigin(request.headers.origin) ? userFromToken(request.cookies[COOKIE]) : null;
    if (!user) {
      socket.close(4001, 'unauthorized');
      return;
    }

    const entry = { socket, sessionHash: user.token_hash };
    if (!sockets.has(user.id)) sockets.set(user.id, new Set());
    sockets.get(user.id).add(entry);

    let alive = true;
    socket.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 30_000);

    // Clients only send keep-alive text frames; anything else is ignored.
    socket.on('message', () => {});
    socket.on('close', () => {
      clearInterval(heartbeat);
      const set = sockets.get(user.id);
      if (!set) return;
      set.delete(entry);
      if (set.size === 0) sockets.delete(user.id);
    });

    socket.send(JSON.stringify({ t: 'sync' }));
  });
}
