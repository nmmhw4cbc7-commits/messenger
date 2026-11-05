// Authenticated API: profile, contacts, conversations, encrypted messages,
// sync, blocking and push subscriptions.
//
// Authorization rule of thumb: every handler that takes a conversation id
// loads the caller's membership first (membershipOrThrow). Nothing is
// returned or changed for a conversation the caller is not a member of.

import config from './config.js';
import { db, tx } from './db.js';
import { requireUser, clearSessionCookie } from './session.js';
import { normalizePhone, enforce, HttpError, randomId, hashPin, verifyPin } from './security.js';
import { ID, PHONE_INPUT, B64URL, cleanLine } from './validate.js';
import { serializeMe, publicProfile, PROFILE_COLUMNS } from './serialize.js';
import { notifyMessages, notifyConversations, notifyProfile, closeUserSockets } from './realtime.js';
import { vapidPublicKey, isAllowedPushEndpoint } from './push.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const MAX_AVATAR_BYTES = 300 * 1024;
const MAX_ENVELOPE_BYTES = 96 * 1024;

const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const idParams = (...names) => ({ params: obj(Object.fromEntries(names.map((n) => [n, ID])), names) });

// ------------------------------------------------------------------ helpers

function membershipOrThrow(conversationId, userId) {
  const row = db.prepare(`
    SELECT c.*, m.role AS my_role FROM conversations c
    JOIN members m ON m.conversation_id = c.id AND m.user_id = ?
    WHERE c.id = ?`).get(userId, conversationId);
  if (!row) throw new HttpError(404, 'not_found', 'This chat does not exist or you are no longer a member.');
  return row;
}

function memberIds(conversationId) {
  return db.prepare('SELECT user_id FROM members WHERE conversation_id = ?').all(conversationId).map((r) => r.user_id);
}

/** Users who share at least one conversation with userId (they can see the profile). */
function contactsOf(userId) {
  return db.prepare(`
    SELECT DISTINCT m2.user_id AS id FROM members m1
    JOIN members m2 ON m2.conversation_id = m1.conversation_id
    WHERE m1.user_id = ? AND m2.user_id != ?`).all(userId, userId).map((r) => r.id);
}

function hasBlocked(blockerId, blockedId) {
  return Boolean(db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?').get(blockerId, blockedId));
}

function serializeConversation(conv, userId) {
  const members = db.prepare(`
    SELECT ${PROFILE_COLUMNS}, m.role, m.joined_at FROM members m JOIN users u ON u.id = m.user_id
    WHERE m.conversation_id = ? ORDER BY m.joined_at, u.id`).all(conv.id);
  return {
    id: conv.id,
    kind: conv.kind,
    title: conv.title,
    createdBy: conv.created_by,
    createdAt: conv.created_at,
    updatedAt: conv.updated_at,
    myRole: members.find((m) => m.id === userId)?.role ?? 'member',
    members: members.map((m) => ({ ...publicProfile(m), role: m.role })),
  };
}

const insertMessage = db.prepare('INSERT INTO messages (id, conversation_id, sender_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?)');
const insertRecipient = db.prepare('INSERT INTO message_recipients (seq, user_id) VALUES (?, ?)');

/** Store a plaintext system event (membership changes) for the given recipients. */
function systemEvent(conversationId, body, recipients) {
  if (!recipients.length) return;
  const now = Date.now();
  const { lastInsertRowid } = insertMessage.run(randomId(), conversationId, null, 'system', JSON.stringify(body), now);
  for (const id of recipients) insertRecipient.run(lastInsertRowid, id);
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);
}

function namesOf(ids) {
  const out = {};
  for (const id of ids) out[id] = db.prepare('SELECT name, phone FROM users WHERE id = ?').get(id)?.name || '';
  return out;
}

/** If a group has no admin left, the longest-standing member becomes admin. */
function ensureAdmin(conversationId) {
  const admin = db.prepare("SELECT 1 FROM members WHERE conversation_id = ? AND role = 'admin'").get(conversationId);
  if (admin) return;
  db.prepare(`UPDATE members SET role = 'admin' WHERE conversation_id = ? AND user_id =
    (SELECT user_id FROM members WHERE conversation_id = ? ORDER BY joined_at, user_id LIMIT 1)`).run(conversationId, conversationId);
}

function isJpeg(buf) {
  return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
}

// ------------------------------------------------------------------ routes

export async function apiRoutes(app) {
  app.addHook('preHandler', requireUser);

  // Per-user budget for the whole API on top of the specific limits below.
  app.addHook('preHandler', (request, _reply, done) => {
    try {
      enforce(`api:${request.user.id}`, 600, MIN);
      done();
    } catch (err) {
      done(err);
    }
  });

  // ---------------------------------------------------------------- me

  app.get('/api/me', async (request) => ({ me: serializeMe(request.user) }));

  app.patch('/api/me', {
    schema: { body: obj({ name: { type: 'string', maxLength: 200 }, about: { type: 'string', maxLength: 500 } }) },
  }, async (request) => {
    const { id } = request.user;
    if (request.body.name !== undefined) {
      const name = cleanLine(request.body.name, 40);
      if (!name) throw new HttpError(400, 'invalid_name', 'Please enter a name.');
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id);
    }
    if (request.body.about !== undefined) {
      db.prepare('UPDATE users SET about = ? WHERE id = ?').run(cleanLine(request.body.about, 140), id);
    }
    notifyProfile(contactsOf(id));
    return { me: serializeMe(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
  });

  app.put('/api/me/avatar', { bodyLimit: MAX_AVATAR_BYTES }, async (request) => {
    enforce(`avatar:${request.user.id}`, 20, HOUR);
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length > MAX_AVATAR_BYTES || !isJpeg(body)) {
      throw new HttpError(400, 'invalid_image', 'This picture could not be used.');
    }
    const now = Date.now();
    tx(() => {
      db.prepare('INSERT INTO avatars (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
        .run(request.user.id, body, now);
      db.prepare('UPDATE users SET avatar_version = ? WHERE id = ?').run(now, request.user.id);
    })();
    notifyProfile(contactsOf(request.user.id));
    return { me: serializeMe(db.prepare('SELECT * FROM users WHERE id = ?').get(request.user.id)) };
  });

  app.delete('/api/me/avatar', async (request) => {
    tx(() => {
      db.prepare('DELETE FROM avatars WHERE user_id = ?').run(request.user.id);
      db.prepare('UPDATE users SET avatar_version = 0 WHERE id = ?').run(request.user.id);
    })();
    notifyProfile(contactsOf(request.user.id));
    return { me: serializeMe(db.prepare('SELECT * FROM users WHERE id = ?').get(request.user.id)) };
  });

  app.get('/api/avatars/:userId', { schema: idParams('userId') }, async (request, reply) => {
    const row = db.prepare('SELECT data, updated_at FROM avatars WHERE user_id = ?').get(request.params.userId);
    if (!row) throw new HttpError(404, 'not_found');
    reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Disposition', 'inline');
    return reply.send(row.data);
  });

  app.put('/api/me/pin', {
    schema: { body: obj({ pin: { type: 'string', pattern: '^[0-9]{4,12}$' } }, ['pin']) },
  }, async (request) => {
    enforce(`setpin:${request.user.id}`, 10, HOUR);
    const hash = await hashPin(request.body.pin);
    db.prepare('UPDATE users SET pin_hash = ?, pin_failures = 0, pin_locked_until = 0 WHERE id = ?').run(hash, request.user.id);
    return { me: serializeMe(db.prepare('SELECT * FROM users WHERE id = ?').get(request.user.id)) };
  });

  app.delete('/api/me/pin', {
    schema: { body: obj({ pin: { type: 'string', pattern: '^[0-9]{4,12}$' } }, ['pin']) },
  }, async (request) => {
    enforce(`setpin:${request.user.id}`, 10, HOUR);
    if (request.user.pin_hash && !(await verifyPin(request.body.pin, request.user.pin_hash))) {
      throw new HttpError(400, 'invalid_pin', 'Wrong PIN.');
    }
    db.prepare('UPDATE users SET pin_hash = NULL WHERE id = ?').run(request.user.id);
    return { me: serializeMe(db.prepare('SELECT * FROM users WHERE id = ?').get(request.user.id)) };
  });

  app.delete('/api/me', {
    schema: { body: obj({ confirmPhone: PHONE_INPUT }, ['confirmPhone']) },
  }, async (request, reply) => {
    const user = request.user;
    if (normalizePhone(request.body.confirmPhone) !== user.phone) {
      throw new HttpError(400, 'confirm_mismatch', 'The number does not match your account.');
    }
    const contacts = contactsOf(user.id);
    tx(() => {
      const groups = db.prepare("SELECT c.id FROM conversations c JOIN members m ON m.conversation_id = c.id WHERE m.user_id = ? AND c.kind = 'group'").all(user.id);
      for (const g of groups) {
        const others = memberIds(g.id).filter((id) => id !== user.id);
        systemEvent(g.id, { type: 'member_left', actorId: user.id, names: namesOf([user.id]) }, others);
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      for (const g of groups) ensureAdmin(g.id);
      db.prepare('DELETE FROM conversations WHERE NOT EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = conversations.id)').run();
    })();
    clearSessionCookie(reply);
    closeUserSockets(user.id);
    notifyConversations(contacts);
    notifyMessages(contacts);
    return { ok: true };
  });

  // ---------------------------------------------------------------- people

  app.post('/api/users/lookup', { schema: { body: obj({ phone: PHONE_INPUT }, ['phone']) } }, async (request) => {
    const phone = normalizePhone(request.body.phone);
    if (!phone) throw new HttpError(400, 'invalid_phone', 'Please enter a valid mobile number.');
    // Limits how fast someone can test which numbers use Haven.
    enforce(`lookup:${request.user.id}`, 60, HOUR);
    const user = db.prepare('SELECT * FROM users u WHERE phone = ?').get(phone);
    if (!user || !user.name) return { found: false, phone };
    if (user.id === request.user.id) throw new HttpError(400, 'is_self', 'That is your own number.');
    return { found: true, phone, user: publicProfile(user) };
  });

  app.get('/api/blocks', async (request) => {
    const rows = db.prepare(`SELECT ${PROFILE_COLUMNS} FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC`).all(request.user.id);
    return { blocked: rows.map(publicProfile) };
  });

  app.put('/api/blocks/:userId', { schema: idParams('userId') }, async (request) => {
    const target = request.params.userId;
    if (target === request.user.id) throw new HttpError(400, 'is_self');
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(target)) throw new HttpError(404, 'not_found');
    db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').run(request.user.id, target, Date.now());
    return { ok: true };
  });

  app.delete('/api/blocks/:userId', { schema: idParams('userId') }, async (request) => {
    db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(request.user.id, request.params.userId);
    return { ok: true };
  });

  // ---------------------------------------------------------------- conversations

  app.get('/api/conversations', async (request) => {
    const convs = db.prepare(`
      SELECT c.* FROM conversations c JOIN members m ON m.conversation_id = c.id
      WHERE m.user_id = ? ORDER BY c.updated_at DESC`).all(request.user.id);
    return { conversations: convs.map((c) => serializeConversation(c, request.user.id)) };
  });

  app.get('/api/conversations/:id', { schema: idParams('id') }, async (request) => {
    const conv = membershipOrThrow(request.params.id, request.user.id);
    return { conversation: serializeConversation(conv, request.user.id) };
  });

  app.post('/api/conversations/direct', { schema: { body: obj({ userId: ID }, ['userId']) } }, async (request) => {
    const me = request.user.id;
    const other = request.body.userId;
    if (other === me) throw new HttpError(400, 'is_self', 'That is your own number.');
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND name != ''").get(other)) throw new HttpError(404, 'not_found', 'This person is not on Haven.');

    const key = [me, other].sort().join(':');
    const conv = tx(() => {
      const existing = db.prepare('SELECT * FROM conversations WHERE direct_key = ?').get(key);
      if (existing) return existing;
      const id = randomId();
      const now = Date.now();
      db.prepare("INSERT INTO conversations (id, kind, title, direct_key, created_by, created_at, updated_at) VALUES (?, 'direct', '', ?, ?, ?, ?)").run(id, key, me, now, now);
      const add = db.prepare("INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)");
      add.run(id, me, now);
      add.run(id, other, now);
      return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    })();
    return { conversation: serializeConversation(conv, me) };
  });

  app.post('/api/conversations/group', {
    schema: {
      body: obj({
        title: { type: 'string', minLength: 1, maxLength: 200 },
        memberIds: { type: 'array', minItems: 1, maxItems: config.maxGroupSize - 1, uniqueItems: true, items: ID },
      }, ['title', 'memberIds']),
    },
  }, async (request) => {
    enforce(`group:${request.user.id}`, 20, HOUR);
    const me = request.user.id;
    const title = cleanLine(request.body.title, 60);
    if (!title) throw new HttpError(400, 'invalid_title', 'Please give the group a name.');

    // People who blocked the creator are silently left out.
    const memberList = request.body.memberIds.filter((id) =>
      id !== me && db.prepare("SELECT 1 FROM users WHERE id = ? AND name != ''").get(id) && !hasBlocked(id, me));
    if (!memberList.length) throw new HttpError(400, 'no_members', 'Add at least one person.');

    const conv = tx(() => {
      const id = randomId();
      const now = Date.now();
      db.prepare("INSERT INTO conversations (id, kind, title, created_by, created_at, updated_at) VALUES (?, 'group', ?, ?, ?, ?)").run(id, title, me, now, now);
      db.prepare("INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'admin', ?)").run(id, me, now);
      const add = db.prepare("INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)");
      for (const uid of memberList) add.run(id, uid, now);
      systemEvent(id, { type: 'group_created', actorId: me, title, names: namesOf([me]) }, memberList);
      return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    })();
    notifyConversations(memberList);
    notifyMessages(memberList);
    return { conversation: serializeConversation(conv, me) };
  });

  app.patch('/api/conversations/:id', {
    schema: { ...idParams('id'), body: obj({ title: { type: 'string', minLength: 1, maxLength: 200 } }, ['title']) },
  }, async (request) => {
    const me = request.user.id;
    const conv = membershipOrThrow(request.params.id, me);
    if (conv.kind !== 'group') throw new HttpError(400, 'not_group');
    if (conv.my_role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can change the group name.');
    const title = cleanLine(request.body.title, 60);
    if (!title) throw new HttpError(400, 'invalid_title', 'Please give the group a name.');
    const members = memberIds(conv.id);
    tx(() => {
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, conv.id);
      systemEvent(conv.id, { type: 'renamed', actorId: me, title, names: namesOf([me]) }, members.filter((id) => id !== me));
    })();
    notifyConversations(members);
    notifyMessages(members.filter((id) => id !== me));
    return { conversation: serializeConversation(db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id), me) };
  });

  app.post('/api/conversations/:id/members', {
    schema: {
      ...idParams('id'),
      body: obj({ userIds: { type: 'array', minItems: 1, maxItems: config.maxGroupSize, uniqueItems: true, items: ID } }, ['userIds']),
    },
  }, async (request) => {
    const me = request.user.id;
    const conv = membershipOrThrow(request.params.id, me);
    if (conv.kind !== 'group') throw new HttpError(400, 'not_group');
    if (conv.my_role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can add people.');

    const current = new Set(memberIds(conv.id));
    const toAdd = request.body.userIds.filter((id) =>
      !current.has(id) && db.prepare("SELECT 1 FROM users WHERE id = ? AND name != ''").get(id) && !hasBlocked(id, me));
    if (current.size + toAdd.length > config.maxGroupSize) {
      throw new HttpError(400, 'group_full', `Groups can have up to ${config.maxGroupSize} members.`);
    }
    if (toAdd.length) {
      tx(() => {
        const now = Date.now();
        const add = db.prepare("INSERT INTO members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)");
        for (const uid of toAdd) add.run(conv.id, uid, now);
        const everyone = [...current, ...toAdd];
        systemEvent(conv.id, { type: 'members_added', actorId: me, targetIds: toAdd, names: namesOf([me, ...toAdd]) }, everyone.filter((id) => id !== me));
      })();
      const everyone = [...current, ...toAdd];
      notifyConversations(everyone);
      notifyMessages(everyone.filter((id) => id !== me));
    }
    return { conversation: serializeConversation(db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id), me) };
  });

  app.patch('/api/conversations/:id/members/:userId', {
    schema: { ...idParams('id', 'userId'), body: obj({ role: { type: 'string', enum: ['admin', 'member'] } }, ['role']) },
  }, async (request) => {
    const me = request.user.id;
    const conv = membershipOrThrow(request.params.id, me);
    if (conv.kind !== 'group') throw new HttpError(400, 'not_group');
    if (conv.my_role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can change roles.');
    const target = request.params.userId;
    if (!db.prepare('SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ?').get(conv.id, target)) throw new HttpError(404, 'not_found');
    tx(() => {
      db.prepare('UPDATE members SET role = ? WHERE conversation_id = ? AND user_id = ?').run(request.body.role, conv.id, target);
      ensureAdmin(conv.id);
    })();
    notifyConversations(memberIds(conv.id));
    return { conversation: serializeConversation(db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id), me) };
  });

  // Remove a member (admins) or leave (anyone, with their own id).
  app.delete('/api/conversations/:id/members/:userId', { schema: idParams('id', 'userId') }, async (request) => {
    const me = request.user.id;
    const target = request.params.userId;
    const conv = membershipOrThrow(request.params.id, me);
    if (conv.kind !== 'group') throw new HttpError(400, 'not_group', 'You cannot leave a direct chat. Block the person instead.');
    const leaving = target === me;
    if (!leaving && conv.my_role !== 'admin') throw new HttpError(403, 'forbidden', 'Only admins can remove people.');

    const before = memberIds(conv.id);
    if (!before.includes(target)) throw new HttpError(404, 'not_found');
    tx(() => {
      db.prepare('DELETE FROM members WHERE conversation_id = ? AND user_id = ?').run(conv.id, target);
      // Messages that were waiting for the removed person are no longer theirs to fetch.
      db.prepare('DELETE FROM message_recipients WHERE user_id = ? AND seq IN (SELECT seq FROM messages WHERE conversation_id = ?)').run(target, conv.id);
      const after = before.filter((id) => id !== target);
      if (!after.length) {
        db.prepare('DELETE FROM conversations WHERE id = ?').run(conv.id);
        return;
      }
      ensureAdmin(conv.id);
      const body = leaving
        ? { type: 'member_left', actorId: me, names: namesOf([me]) }
        : { type: 'member_removed', actorId: me, targetIds: [target], names: namesOf([me, target]) };
      // The removed person is told too, so their app can show why the chat went read-only.
      systemEvent(conv.id, body, leaving ? after : [...after.filter((id) => id !== me), target]);
    })();
    notifyConversations(before);
    notifyMessages(before.filter((id) => id !== me));
    return { ok: true };
  });

  // ---------------------------------------------------------------- messages

  app.post('/api/conversations/:id/messages', {
    bodyLimit: MAX_ENVELOPE_BYTES + 1024,
    schema: {
      ...idParams('id'),
      body: obj({
        id: ID,
        envelope: {
          type: 'object',
          additionalProperties: false,
          required: ['v', 'ts', 'eph', 'iv', 'ct', 'keys', 'sig'],
          properties: {
            v: { const: 1 },
            ts: { type: 'integer', minimum: 0 },
            eph: { type: 'string', pattern: B64URL, maxLength: 100 },
            iv: { type: 'string', pattern: B64URL, maxLength: 24 },
            ct: { type: 'string', pattern: B64URL, maxLength: MAX_ENVELOPE_BYTES },
            sig: { type: 'string', pattern: B64URL, maxLength: 120 },
            keys: {
              type: 'object',
              maxProperties: config.maxGroupSize,
              propertyNames: { pattern: '^[A-Za-z0-9_-]{16,40}$' },
              additionalProperties: obj({
                kv: { type: 'integer', minimum: 1 },
                iv: { type: 'string', pattern: B64URL, maxLength: 24 },
                k: { type: 'string', pattern: B64URL, maxLength: 80 },
              }, ['kv', 'iv', 'k']),
            },
          },
        },
      }, ['id', 'envelope']),
    },
  }, async (request) => {
    const me = request.user.id;
    enforce(`send:${me}`, 120, MIN);
    const conv = membershipOrThrow(request.params.id, me);
    const { id, envelope } = request.body;

    const existing = db.prepare('SELECT conversation_id, sender_id, created_at FROM messages WHERE id = ?').get(id);
    if (existing) {
      // A retry of a message we already have: answer the same way again.
      if (existing.sender_id === me && existing.conversation_id === conv.id) return { id, createdAt: existing.created_at };
      throw new HttpError(409, 'duplicate_id');
    }

    // Every current member except the sender must have a key wrapped for their
    // current device, and nobody else may. Otherwise the client re-encrypts.
    const members = db.prepare('SELECT u.id, u.key_version FROM members m JOIN users u ON u.id = m.user_id WHERE m.conversation_id = ?').all(conv.id);
    const byId = new Map(members.map((m) => [m.id, m.key_version]));
    for (const [uid, k] of Object.entries(envelope.keys)) {
      if (!byId.has(uid)) throw new HttpError(409, 'members_changed', 'The members of this chat changed.');
      if (byId.get(uid) !== k.kv) throw new HttpError(409, 'keys_changed', 'A safety number in this chat changed.');
    }
    for (const m of members) {
      if (m.id !== me && !envelope.keys[m.id]) throw new HttpError(409, 'members_changed', 'The members of this chat changed.');
    }

    const recipients = members.map((m) => m.id).filter((uid) => uid !== me && !hasBlocked(uid, me));
    const now = Date.now();
    if (recipients.length) {
      tx(() => {
        const { lastInsertRowid } = insertMessage.run(id, conv.id, me, 'msg', JSON.stringify(envelope), now);
        for (const uid of recipients) insertRecipient.run(lastInsertRowid, uid);
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conv.id);
      })();
      notifyMessages(recipients);
    }
    return { id, createdAt: now };
  });

  // ---------------------------------------------------------------- sync

  app.get('/api/sync', {
    schema: {
      querystring: obj({
        after: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
      }),
    },
  }, async (request) => {
    const { after, limit } = request.query;
    const rows = db.prepare(`
      SELECT m.seq, m.id, m.conversation_id, m.sender_id, m.kind, m.body, m.created_at
      FROM message_recipients r JOIN messages m ON m.seq = r.seq
      WHERE r.user_id = ? AND r.seq > ? ORDER BY r.seq LIMIT ?`).all(request.user.id, after, limit + 1);
    const more = rows.length > limit;
    return {
      more,
      messages: rows.slice(0, limit).map((m) => ({
        seq: m.seq,
        id: m.id,
        conversationId: m.conversation_id,
        senderId: m.sender_id,
        kind: m.kind,
        body: JSON.parse(m.body),
        createdAt: m.created_at,
      })),
    };
  });

  // The client confirms it has stored everything up to `upTo`; the server forgets it.
  app.post('/api/sync/ack', { schema: { body: obj({ upTo: { type: 'integer', minimum: 0 } }, ['upTo']) } }, async (request) => {
    tx(() => {
      const seqs = db.prepare('SELECT seq FROM message_recipients WHERE user_id = ? AND seq <= ?').all(request.user.id, request.body.upTo);
      db.prepare('DELETE FROM message_recipients WHERE user_id = ? AND seq <= ?').run(request.user.id, request.body.upTo);
      const orphan = db.prepare('DELETE FROM messages WHERE seq = ? AND NOT EXISTS (SELECT 1 FROM message_recipients WHERE seq = ?)');
      for (const { seq } of seqs) orphan.run(seq, seq);
    })();
    return { ok: true };
  });

  // ---------------------------------------------------------------- push

  app.get('/api/push/key', async () => ({ publicKey: vapidPublicKey }));

  app.post('/api/push/subscribe', {
    schema: {
      body: obj({
        endpoint: { type: 'string', maxLength: 1024 },
        keys: obj({
          p256dh: { type: 'string', pattern: B64URL, maxLength: 200 },
          auth: { type: 'string', pattern: B64URL, maxLength: 100 },
        }, ['p256dh', 'auth']),
      }, ['endpoint', 'keys']),
    },
  }, async (request) => {
    enforce(`push:${request.user.id}`, 20, HOUR);
    const { endpoint, keys } = request.body;
    if (!isAllowedPushEndpoint(endpoint)) throw new HttpError(400, 'invalid_endpoint', 'This browser’s push service is not supported.');
    db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(endpoint, request.user.id, keys.p256dh, keys.auth, Date.now());
    return { ok: true };
  });

  app.delete('/api/push/subscribe', {
    schema: { body: obj({ endpoint: { type: 'string', maxLength: 1024 } }, ['endpoint']) },
  }, async (request) => {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(request.body.endpoint, request.user.id);
    return { ok: true };
  });
}
