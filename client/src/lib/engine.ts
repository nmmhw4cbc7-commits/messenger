// The app's brain: sign-in, key pinning, sync, sending, and every server action.
// Screens call these functions and read state through useStore().

import { api, ApiError, sessionEvents } from './api';
import * as idb from './idb';
import { createIdentity, decryptMessage, encryptMessage, randomId, type Envelope, type Identity } from './crypto';
import { getState, setState, type Conv, type Me, type Member, type Msg, type Pin, type Profile, type SystemBody, type Theme } from './store';

let identity: Identity | null = null;
const MAX_TEXT = 4000;

// ------------------------------------------------------------------ boot

export async function boot() {
  const theme = ((await idb.get<Theme>('meta', 'theme').catch(() => undefined)) ?? 'system') as Theme;
  applyTheme(theme);
  setState({ theme });

  identity = (await idb.get<Identity>('meta', 'identity')) ?? null;
  const me = (await idb.get<Me>('meta', 'me')) ?? null;
  if (!identity || !me) {
    setState({ phase: 'signedOut', lastPhone: identity?.phone ?? '' });
    return;
  }

  const [convList, pinList] = await Promise.all([idb.getAll<Conv>('convs'), idb.getAll<Pin>('pins')]);
  setState({
    me,
    convs: Object.fromEntries(convList.map((c) => [c.id, c])),
    pins: Object.fromEntries(pinList.map((p) => [p.userId, p])),
    phase: me.name ? 'ready' : 'profile',
    lastPhone: me.phone,
  });

  try {
    const res = await api<{ me: Me }>('GET', '/api/me');
    await saveMe(res.me);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return; // handled by the session listener
  }
  startRealtime();
  refreshConversations().then(sync).catch(() => {});
}

sessionEvents.addEventListener('expired', () => {
  const s = getState();
  if (s.phase === 'ready' || s.phase === 'profile') endSession();
});

/** The server ended our session (expired, or signed in elsewhere). Local data stays. */
function endSession() {
  stopRealtime();
  setState({ phase: 'signedOut', sessionEnded: true, connected: false });
}

async function saveMe(me: Me) {
  await idb.put('meta', me, 'me');
  setState((s) => ({ me, phase: s.phase === 'ready' || s.phase === 'profile' ? (me.name ? 'ready' : 'profile') : s.phase }));
  if (wanted && me.inbox !== socketInbox) connect();
}

// ------------------------------------------------------------------ sign in

export interface Verification {
  phone: string;
  verifyId: string;
  pollSecret: string;
  telegramUrl: string;
  expiresAt: number;
}

type VerifyResponse = { status: 'ok'; isNew: boolean; me: Me } | { status: 'pin_required'; challenge: string } | { status: 'pending' };

let pendingIdentity: Identity | null = null;
let pendingIsStored = false;

/**
 * Start phone verification. Keys for a new number are made in memory now and
 * only stored once the number is confirmed.
 */
export async function startVerification(phone: string): Promise<Verification> {
  const res = await api<Verification>('POST', '/api/auth/start', { phone });
  const stored = (await idb.get<Identity>('meta', 'identity')) ?? null;
  pendingIsStored = Boolean(stored && stored.phone === res.phone);
  pendingIdentity = pendingIsStored && stored ? stored : await createIdentity(res.phone);
  return res;
}

/** Ask whether the number was confirmed in Telegram yet. */
export async function checkVerification(v: Verification): Promise<'pending' | 'done' | { pinChallenge: string }> {
  if (!pendingIdentity) throw new Error('Please start again.');
  const res = await api<VerifyResponse>('POST', '/api/auth/verify', {
    verifyId: v.verifyId,
    pollSecret: v.pollSecret,
    encPub: pendingIdentity.encPub,
    sigPub: pendingIdentity.sigPub,
  });
  if (res.status === 'pending') return 'pending';
  if (res.status === 'pin_required') return { pinChallenge: res.challenge };
  await finishSignIn(res.me);
  return 'done';
}

export async function submitPin(challenge: string, pin: string) {
  const res = await api<VerifyResponse>('POST', '/api/auth/pin', { challenge, pin });
  if (res.status !== 'ok') throw new Error('Please start again.');
  await finishSignIn(res.me);
}

async function finishSignIn(me: Me) {
  if (!pendingIdentity) throw new Error('No keys');
  const previousMe = await idb.get<Me>('meta', 'me');
  // A different account, or a new key pair: nothing stored locally belongs to it any more.
  if (!pendingIsStored || (previousMe && previousMe.id !== me.id)) {
    await idb.wipe();
    await idb.put('meta', pendingIdentity, 'identity');
    await idb.put('meta', getState().theme, 'theme');
    setState({ convs: {}, messages: {}, pins: {} });
  }
  identity = pendingIdentity;
  pendingIdentity = null;
  await idb.put('meta', me, 'me');
  idb.requestPersistence();
  setState({ me, phase: me.name ? 'ready' : 'profile', sessionEnded: false, lastPhone: me.phone });
  startRealtime();
  refreshConversations().then(sync).catch(() => {});
}

// ------------------------------------------------------------------ profile

export async function updateProfile(patch: { name?: string; about?: string }) {
  const res = await api<{ me: Me }>('PATCH', '/api/me', patch);
  await saveMe(res.me);
}

export async function uploadAvatar(blob: Blob) {
  const res = await api<{ me: Me }>('PUT', '/api/me/avatar', blob);
  await saveMe(res.me);
}

export async function removeAvatar() {
  const res = await api<{ me: Me }>('DELETE', '/api/me/avatar');
  await saveMe(res.me);
}

export async function setPin(pin: string) {
  const res = await api<{ me: Me }>('PUT', '/api/me/pin', { pin });
  await saveMe(res.me);
}

export async function removePin(pin: string) {
  const res = await api<{ me: Me }>('DELETE', '/api/me/pin', { pin });
  await saveMe(res.me);
}

export function avatarUrl(p: { id: string; avatarVersion: number } | null | undefined) {
  return p && p.avatarVersion ? `/api/avatars/${encodeURIComponent(p.id)}?v=${p.avatarVersion}` : null;
}

export async function setTheme(theme: Theme) {
  applyTheme(theme);
  setState({ theme });
  await idb.put('meta', theme, 'theme');
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0f1012' : '#ffffff');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(getState().theme));

// ------------------------------------------------------------------ key pinning

/**
 * Trust on first use: the first key we see for a person is pinned. If the
 * server later hands out a different key, every chat with that person gets a
 * notice, and if the person was verified, sending pauses until the user accepts.
 */
async function checkPins(members: Profile[]) {
  const me = getState().me;
  const pins = { ...getState().pins };
  const changed: Pin[] = [];
  const notices: { userId: string; name: string }[] = [];

  for (const m of members) {
    if (m.id === me?.id) continue;
    const pin = pins[m.id];
    if (!pin) {
      pins[m.id] = { userId: m.id, encPub: m.encPub, sigPub: m.sigPub, keyVersion: m.keyVersion, verified: false, needsAck: false, history: [] };
      changed.push(pins[m.id]);
    } else if (pin.encPub !== m.encPub || pin.sigPub !== m.sigPub) {
      pins[m.id] = {
        ...pin,
        encPub: m.encPub,
        sigPub: m.sigPub,
        keyVersion: m.keyVersion,
        verified: false,
        needsAck: pin.verified || pin.needsAck,
        history: [pin.sigPub, ...pin.history.filter((k) => k !== pin.sigPub)].slice(0, 5),
      };
      changed.push(pins[m.id]);
      notices.push({ userId: m.id, name: m.name || m.phone });
    } else if (pin.keyVersion !== m.keyVersion) {
      pins[m.id] = { ...pin, keyVersion: m.keyVersion };
      changed.push(pins[m.id]);
    }
  }
  if (!changed.length) return;
  await idb.putMany('pins', changed);
  setState({ pins });

  for (const n of notices) {
    const convIds = Object.values(getState().convs).filter((c) => c.members.some((m) => m.id === n.userId)).map((c) => c.id);
    const now = Date.now();
    await addMessages(convIds.map((convId) => ({
      id: `notice-${n.userId}-${now}-${convId}`,
      convId,
      senderId: null,
      kind: 'notice' as const,
      notice: { type: 'key_changed' as const, userId: n.userId, name: n.name },
      createdAt: now,
      sortKey: now,
      status: 'received' as const,
    })), false);
  }
}

export async function setVerified(userId: string, verified: boolean) {
  const pin = getState().pins[userId];
  if (!pin) return;
  const next = { ...pin, verified, needsAck: false };
  await idb.put('pins', next);
  setState((s) => ({ pins: { ...s.pins, [userId]: next } }));
}

export async function acceptKeyChange(userId: string) {
  const pin = getState().pins[userId];
  if (!pin) return;
  const next = { ...pin, needsAck: false };
  await idb.put('pins', next);
  setState((s) => ({ pins: { ...s.pins, [userId]: next } }));
  flushOutbox();
}

// ------------------------------------------------------------------ conversations

interface ServerConv {
  id: string;
  kind: 'direct' | 'group';
  title: string;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  myRole: 'admin' | 'member';
  members: Member[];
}

function mergeConv(server: ServerConv, local?: Conv): Conv {
  return {
    ...server,
    left: false,
    lastReadAt: local?.lastReadAt ?? 0,
    unread: local?.unread ?? 0,
    last: local?.last ?? null,
    hidden: local?.hidden ?? false,
  };
}

let refreshing: Promise<void> | null = null;

export function refreshConversations(): Promise<void> {
  if (!refreshing) {
    refreshing = (async () => {
      const { conversations } = await api<{ conversations: ServerConv[] }>('GET', '/api/conversations');
      const current = getState().convs;
      const next: Record<string, Conv> = {};
      for (const c of conversations) next[c.id] = mergeConv(c, current[c.id]);
      // Chats we are no longer part of stay on the device, read-only.
      for (const c of Object.values(current)) if (!next[c.id]) next[c.id] = { ...c, left: true };
      await idb.putMany('convs', Object.values(next));
      setState({ convs: next });
      await checkPins(conversations.flatMap((c) => c.members));
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

async function saveConv(conv: Conv) {
  await idb.put('convs', conv);
  setState((s) => ({ convs: { ...s.convs, [conv.id]: conv } }));
}

async function upsertServerConv(server: ServerConv) {
  const conv = mergeConv(server, getState().convs[server.id]);
  await saveConv(conv);
  await checkPins(server.members);
  return conv;
}

export async function lookupPhone(phone: string) {
  return api<{ found: boolean; phone: string; user?: Profile }>('POST', '/api/users/lookup', { phone });
}

export async function openDirect(userId: string) {
  const existing = Object.values(getState().convs).find((c) => c.kind === 'direct' && !c.left && c.members.some((m) => m.id === userId));
  if (existing) return existing;
  const res = await api<{ conversation: ServerConv }>('POST', '/api/conversations/direct', { userId });
  return upsertServerConv(res.conversation);
}

export async function createGroup(title: string, memberIds: string[]) {
  const res = await api<{ conversation: ServerConv }>('POST', '/api/conversations/group', { title, memberIds });
  const conv = await upsertServerConv(res.conversation);
  const now = Date.now();
  await addMessages([{
    id: `local-created-${conv.id}`,
    convId: conv.id,
    senderId: null,
    kind: 'system',
    system: { type: 'group_created', actorId: getState().me!.id, title },
    createdAt: now,
    sortKey: now,
    status: 'received',
  }], false);
  return conv;
}

export async function renameGroup(convId: string, title: string) {
  const res = await api<{ conversation: ServerConv }>('PATCH', `/api/conversations/${convId}`, { title });
  await upsertServerConv(res.conversation);
  await localSystem(convId, { type: 'renamed', actorId: getState().me!.id, title });
}

export async function addMembers(convId: string, userIds: string[]) {
  const res = await api<{ conversation: ServerConv }>('POST', `/api/conversations/${convId}/members`, { userIds });
  const before = new Set(getState().convs[convId]?.members.map((m) => m.id));
  const conv = await upsertServerConv(res.conversation);
  const added = conv.members.filter((m) => !before.has(m.id));
  if (added.length) {
    await localSystem(convId, {
      type: 'members_added',
      actorId: getState().me!.id,
      targetIds: added.map((m) => m.id),
      names: Object.fromEntries(added.map((m) => [m.id, m.name])),
    });
  }
}

export async function removeMember(convId: string, userId: string) {
  const target = getState().convs[convId]?.members.find((m) => m.id === userId);
  await api('DELETE', `/api/conversations/${convId}/members/${userId}`);
  await localSystem(convId, { type: 'member_removed', actorId: getState().me!.id, targetIds: [userId], names: { [userId]: target?.name ?? '' } });
  await refreshConversations();
}

export async function leaveGroup(convId: string) {
  await api('DELETE', `/api/conversations/${convId}/members/${getState().me!.id}`);
  await localSystem(convId, { type: 'member_left', actorId: getState().me!.id });
  await refreshConversations();
}

export async function setRole(convId: string, userId: string, role: 'admin' | 'member') {
  const res = await api<{ conversation: ServerConv }>('PATCH', `/api/conversations/${convId}/members/${userId}`, { role });
  await upsertServerConv(res.conversation);
}

async function localSystem(convId: string, system: SystemBody) {
  const now = Date.now();
  await addMessages([{ id: `local-${randomId()}`, convId, senderId: null, kind: 'system', system, createdAt: now, sortKey: now, status: 'received' }], false);
}

/** Delete a chat from this device. It comes back if someone writes again. */
export async function deleteChat(convId: string) {
  await idb.deleteMessagesOf(convId);
  const conv = getState().convs[convId];
  setState((s) => {
    const messages = { ...s.messages };
    delete messages[convId];
    return { messages };
  });
  if (!conv) return;
  if (conv.left) {
    await idb.del('convs', convId);
    setState((s) => {
      const convs = { ...s.convs };
      delete convs[convId];
      return { convs };
    });
  } else {
    await saveConv({ ...conv, hidden: true, last: null, unread: 0 });
  }
}

export async function clearChat(convId: string) {
  await idb.deleteMessagesOf(convId);
  setState((s) => ({ messages: { ...s.messages, [convId]: [] } }));
  const conv = getState().convs[convId];
  if (conv) await saveConv({ ...conv, last: null, unread: 0 });
}

export async function deleteMessage(msg: Msg) {
  await idb.del('messages', msg.id);
  const list = (getState().messages[msg.convId] ?? []).filter((m) => m.id !== msg.id);
  setState((s) => ({ messages: { ...s.messages, [msg.convId]: list } }));
  const conv = getState().convs[msg.convId];
  if (conv && conv.last?.id === msg.id) await saveConv({ ...conv, last: lastVisible(list) });
}

// ------------------------------------------------------------------ messages

const lastVisible = (list: Msg[]) => [...list].reverse().find((m) => m.kind !== 'notice') ?? null;

export async function loadMessages(convId: string) {
  if (getState().messages[convId]) return;
  const list = await idb.messagesOf<Msg>(convId);
  setState((s) => ({ messages: { ...s.messages, [convId]: list } }));
}

/** Store new messages and update chat previews and unread counts. */
async function addMessages(msgs: Msg[], countUnread: boolean) {
  if (!msgs.length) return;
  await idb.putMany('messages', msgs);
  const s = getState();
  const meId = s.me?.id;
  const messages = { ...s.messages };
  const convs = { ...s.convs };
  const visible = document.visibilityState === 'visible';

  for (const m of msgs) {
    if (messages[m.convId]) {
      const list = messages[m.convId].filter((x) => x.id !== m.id);
      list.push(m);
      list.sort((a, b) => a.sortKey - b.sortKey);
      messages[m.convId] = list;
    }
    const conv = convs[m.convId];
    if (!conv) continue;
    const isOpen = s.openConvId === m.convId && visible;
    const unreadBump = countUnread && m.senderId !== meId && m.kind !== 'notice' && !isOpen ? 1 : 0;
    const newer = m.kind !== 'notice' && (!conv.last || m.sortKey >= conv.last.sortKey);
    convs[m.convId] = {
      ...conv,
      hidden: false,
      unread: conv.unread + unreadBump,
      last: newer ? m : conv.last,
      lastReadAt: isOpen ? Date.now() : conv.lastReadAt,
    };
  }
  const touched = [...new Set(msgs.map((m) => m.convId))].map((id) => convs[id]).filter(Boolean);
  await idb.putMany('convs', touched);
  setState({ messages, convs });
  updateBadge();
}

async function updateMessage(msg: Msg) {
  await idb.put('messages', msg);
  setState((s) => {
    const list = s.messages[msg.convId];
    const conv = s.convs[msg.convId];
    return {
      messages: list ? { ...s.messages, [msg.convId]: list.map((m) => (m.id === msg.id ? msg : m)) } : s.messages,
      convs: conv && conv.last?.id === msg.id ? { ...s.convs, [msg.convId]: { ...conv, last: msg } } : s.convs,
    };
  });
  const conv = getState().convs[msg.convId];
  if (conv && conv.last?.id === msg.id) await idb.put('convs', conv);
}

export async function markRead(convId: string) {
  const conv = getState().convs[convId];
  if (!conv || (conv.unread === 0 && conv.lastReadAt > (conv.last?.sortKey ?? 0))) return;
  await saveConv({ ...conv, unread: 0, lastReadAt: Date.now() });
  updateBadge();
}

export function setOpenConv(convId: string | null) {
  setState({ openConvId: convId });
  if (convId) markRead(convId);
}

function updateBadge() {
  const total = Object.values(getState().convs).reduce((n, c) => n + (c.hidden ? 0 : c.unread), 0);
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (total > 0) nav.setAppBadge?.(total).catch(() => {});
  else nav.clearAppBadge?.().catch(() => {});
}

// ------------------------------------------------------------------ sending

export async function sendText(convId: string, raw: string) {
  const text = raw.replace(/\s+$/, '').replace(/^\s*\n/, '').slice(0, MAX_TEXT);
  if (!text.trim() || !getState().me) return;
  const now = Date.now();
  const msg: Msg = { id: randomId(), convId, senderId: getState().me!.id, kind: 'text', text, createdAt: now, sortKey: now, status: 'pending' };
  await addMessages([msg], false);
  await addToOutbox(msg.id);
  flushOutbox();
}

export async function retry(msg: Msg) {
  await updateMessage({ ...msg, status: 'pending' });
  await addToOutbox(msg.id);
  flushOutbox();
}

async function addToOutbox(id: string) {
  const outbox = (await idb.get<string[]>('meta', 'outbox')) ?? [];
  if (!outbox.includes(id)) await idb.put('meta', [...outbox, id], 'outbox');
}

async function removeFromOutbox(id: string) {
  const outbox = (await idb.get<string[]>('meta', 'outbox')) ?? [];
  await idb.put('meta', outbox.filter((x) => x !== id), 'outbox');
}

let flushing = false;
let flushAgain = false;

export async function flushOutbox() {
  if (flushing) {
    flushAgain = true;
    return;
  }
  flushing = true;
  try {
    do {
      flushAgain = false;
      const outbox = (await idb.get<string[]>('meta', 'outbox')) ?? [];
      for (const id of outbox) {
        const msg = await idb.get<Msg>('messages', id);
        if (!msg || msg.status !== 'pending') {
          await removeFromOutbox(id);
          continue;
        }
        const result = await deliver(msg);
        if (result === 'offline' || result === 'paused') return;
        await removeFromOutbox(id);
      }
    } while (flushAgain);
  } finally {
    flushing = false;
  }
}

async function deliver(msg: Msg): Promise<'sent' | 'failed' | 'offline' | 'paused'> {
  const me = getState().me;
  if (!me || !identity) return 'offline';
  for (let attempt = 0; attempt < 3; attempt++) {
    const conv = getState().convs[msg.convId];
    if (!conv || conv.left) {
      await updateMessage({ ...msg, status: 'failed' });
      return 'failed';
    }
    const others = conv.members.filter((m) => m.id !== me.id);
    if (others.some((m) => getState().pins[m.id]?.needsAck)) return 'paused';
    try {
      const envelope = await encryptMessage(identity, me.id, conv.id, msg.id, { type: 'text', text: msg.text ?? '' },
        others.map((m) => ({ id: m.id, encPub: m.encPub, keyVersion: m.keyVersion })));
      const res = await api<{ id: string; createdAt: number }>('POST', `/api/conversations/${conv.id}/messages`, { id: msg.id, envelope });
      await updateMessage({ ...msg, status: 'sent', createdAt: res.createdAt });
      return 'sent';
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 0 || err.status >= 500 || err.status === 429) return 'offline';
        if (err.status === 401) return 'offline';
        if (err.code === 'members_changed' || err.code === 'keys_changed') {
          await refreshConversations().catch(() => {});
          continue;
        }
      }
      await updateMessage({ ...msg, status: 'failed' });
      return 'failed';
    }
  }
  await updateMessage({ ...msg, status: 'failed' });
  return 'failed';
}

// ------------------------------------------------------------------ receiving

interface SyncMessage {
  seq: number;
  id: string;
  conversationId: string;
  senderId: string | null;
  kind: 'msg' | 'system';
  body: Envelope | (SystemBody & { type: string });
  createdAt: number;
}

let syncing = false;
let syncAgain = false;

export async function sync(): Promise<void> {
  if (syncing) {
    syncAgain = true;
    return;
  }
  syncing = true;
  try {
    do {
      syncAgain = false;
      let more = true;
      while (more) {
        const after = (await idb.get<number>('meta', 'cursor')) ?? 0;
        const res = await api<{ messages: SyncMessage[]; more: boolean }>('GET', `/api/sync?after=${after}&limit=200`);
        more = res.more;
        if (!res.messages.length) break;
        await processBatch(res.messages);
        const upTo = res.messages[res.messages.length - 1].seq;
        await idb.put('meta', upTo, 'cursor');
        await api('POST', '/api/sync/ack', { upTo });
      }
    } while (syncAgain);
  } catch {
    // Offline or signed out; the next connection or event retries.
  } finally {
    syncing = false;
  }
}

async function processBatch(batch: SyncMessage[]) {
  const me = getState().me;
  if (!me || !identity) return;
  let refreshedOnce = false;
  let refreshAfter = false;
  const ensureFresh = async () => {
    if (refreshedOnce) return;
    refreshedOnce = true;
    await refreshConversations().catch(() => {});
  };

  const out: Msg[] = [];
  for (const m of batch) {
    if (await idb.get('messages', m.id)) continue;

    if (m.kind === 'system') {
      const body = m.body as SystemBody & { type: string };
      refreshAfter = true;
      if ((body.type as string) === 'key_changed') continue; // detected and shown by key pinning
      out.push({ id: m.id, convId: m.conversationId, senderId: null, kind: 'system', system: body, createdAt: m.createdAt, sortKey: m.createdAt, status: 'received' });
      continue;
    }

    if (!getState().convs[m.conversationId] || !getState().pins[m.senderId!]) await ensureFresh();
    const tryDecrypt = () => {
      const pin = getState().pins[m.senderId!];
      return decryptMessage(identity!, me.id, m.conversationId, m.senderId!, m.id, m.body as Envelope, pin ? [pin.sigPub, ...pin.history] : []);
    };
    let result = await tryDecrypt();
    if (!result.ok && result.reason === 'bad_signature' && !refreshedOnce) {
      await ensureFresh();
      result = await tryDecrypt();
    }
    out.push(result.ok
      ? { id: m.id, convId: m.conversationId, senderId: m.senderId, kind: 'text', text: result.payload.text, createdAt: m.createdAt, sortKey: m.createdAt, status: 'received' }
      : { id: m.id, convId: m.conversationId, senderId: m.senderId, kind: 'undecryptable', createdAt: m.createdAt, sortKey: m.createdAt, status: 'received' });
  }

  if (refreshAfter) await refreshConversations().catch(() => {});
  await addMessages(out, true);
}

// ------------------------------------------------------------------ realtime

// Live updates come over Supabase Realtime: a broadcast channel whose name is
// a per-user secret. Hints carry no data; the app then syncs over the API.
const RT_BASE = (import.meta.env.VITE_SUPABASE_URL as string).replace(/^http/, 'ws');
const RT_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

let socket: WebSocket | null = null;
let socketInbox = '';
let retryTimer: number | undefined;
let heartbeat: number | undefined;
let backoff = 1000;
let wanted = false;
let ref = 0;

function startRealtime() {
  wanted = true;
  connect();
}

function stopRealtime() {
  wanted = false;
  clearTimeout(retryTimer);
  clearInterval(heartbeat);
  socket?.close();
  socket = null;
}

function connect() {
  const inbox = getState().me?.inbox;
  if (!wanted || !inbox) return;
  if (socket && socket.readyState <= 1 && socketInbox === inbox) return;
  if (socket) {
    const old = socket;
    socket = null;
    old.close();
  }
  clearTimeout(retryTimer);
  clearInterval(heartbeat);
  const topic = `realtime:inbox:${inbox}`;
  const ws = new WebSocket(`${RT_BASE}/realtime/v1/websocket?apikey=${encodeURIComponent(RT_KEY)}&vsn=1.0.0`);
  socket = ws;
  socketInbox = inbox;
  const joinRef = String(++ref);
  const sendFrame = (frame: object) => ws.readyState === 1 && ws.send(JSON.stringify(frame));

  ws.onopen = () => {
    sendFrame({ topic, event: 'phx_join', payload: { config: { broadcast: { self: false, ack: false }, presence: { key: '' }, private: false } }, ref: joinRef, join_ref: joinRef });
    heartbeat = window.setInterval(() => sendFrame({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) }), 25_000);
  };
  ws.onmessage = (e) => {
    let msg: { event?: string; ref?: string; payload?: { status?: string; event?: string } };
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.event === 'phx_reply' && msg.ref === joinRef) {
      if (msg.payload?.status === 'ok') {
        backoff = 1000;
        setState({ connected: true });
        sync();
        flushOutbox();
      } else {
        ws.close();
      }
      return;
    }
    if (msg.event !== 'broadcast') return;
    const kind = msg.payload?.event;
    if (kind === 'sync') sync();
    else if (kind === 'conversations' || kind === 'profiles') refreshConversations().catch(() => {});
    else if (kind === 'signout') api('GET', '/api/me').catch(() => {});
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    clearInterval(heartbeat);
    setState({ connected: false });
    if (wanted) scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(retryTimer);
  retryTimer = window.setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, 30_000);
}

// Safety net: sync now and then even if a realtime hint was missed.
window.setInterval(() => {
  if (wanted && document.visibilityState === 'visible') sync();
}, 30_000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !wanted) return;
  backoff = 1000;
  connect();
  sync();
  const open = getState().openConvId;
  if (open) markRead(open);
  navigator.serviceWorker?.getRegistration().then((reg) => reg?.getNotifications().then((ns) => ns.forEach((n) => n.close()))).catch(() => {});
});
window.addEventListener('online', () => {
  if (!wanted) return;
  backoff = 1000;
  connect();
  flushOutbox();
});

// ------------------------------------------------------------------ blocking

export async function listBlocked() {
  return (await api<{ blocked: Profile[] }>('GET', '/api/blocks')).blocked;
}
export async function block(userId: string) {
  await api('PUT', `/api/blocks/${userId}`);
}
export async function unblock(userId: string) {
  await api('DELETE', `/api/blocks/${userId}`);
}

// ------------------------------------------------------------------ push notifications

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function pushEnabled() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return Boolean(await reg?.pushManager.getSubscription());
}

export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are turned off for Haven in your device settings.');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>('GET', '/api/push/key');
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  await api('POST', '/api/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api('DELETE', '/api/push/subscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

// ------------------------------------------------------------------ leaving

async function wipeDevice() {
  stopRealtime();
  await disablePush().catch(() => {});
  identity = null;
  await idb.wipe();
}

export async function signOut() {
  await api('POST', '/api/auth/logout').catch(() => {});
  await wipeDevice();
  location.reload();
}

export async function deleteAccount(confirmPhone: string) {
  await api('DELETE', '/api/me', { confirmPhone });
  await wipeDevice();
  location.reload();
}

/** Used on the sign-in screen after a session ended, to start over with another number. */
export async function forgetDevice() {
  await wipeDevice();
  location.reload();
}

export function myPublicKeys() {
  return identity ? { encPub: identity.encPub, sigPub: identity.sigPub } : null;
}

export function displayName(p: { name?: string; phone?: string } | null | undefined) {
  return p?.name?.trim() || p?.phone || 'Unknown';
}

export function convTitle(conv: Conv, meId: string | undefined) {
  if (conv.kind === 'group') return conv.title || 'Group';
  const other = conv.members.find((m) => m.id !== meId);
  return other ? displayName(other) : 'Deleted account';
}

export function otherMember(conv: Conv, meId: string | undefined) {
  return conv.kind === 'direct' ? conv.members.find((m) => m.id !== meId) ?? null : null;
}
