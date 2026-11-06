// The app's brain: sign-in, key pinning, sync, sending, and every server action.
// Screens call these functions and read state through useStore().

import { api, ApiError, sessionEvents } from './api';
import * as idb from './idb';
import { createIdentity, decryptMessage, encryptMessage, randomId, seal, unseal, toB64u, fromB64u, type Envelope, type Identity } from './crypto';
import { getState, setState, type Activity, type Conv, type DeviceKey, type Me, type Member, type Msg, type Pin, type Profile, type ReplyRef, type SystemBody, type Theme } from './store';
import type { Payload, MediaPayload } from './crypto';
import { uploadMedia, storeLocalFile, forgetFile } from './media';

let identity: Identity | null = null;
const MAX_TEXT = 4000;

// ------------------------------------------------------------------ boot

export async function boot() {
  const theme = ((await idb.get<Theme>('meta', 'theme').catch(() => undefined)) ?? 'system') as Theme;
  applyTheme(theme);
  setState({ theme });

  identity = (await idb.get<Identity>('meta', 'identity')) ?? null;
  const me = (await idb.get<Me>('meta', 'me')) ?? null;
  const aliases = (await idb.get<Record<string, string>>('meta', 'aliases').catch(() => undefined)) ?? {};
  const pushPreview = (await idb.get<boolean>('meta', 'pushPreview').catch(() => undefined)) ?? true;
  const activity = (await idb.get<Activity[]>('meta', 'activity').catch(() => undefined)) ?? [];
  const activitySeen = (await idb.get<number>('meta', 'activitySeen').catch(() => undefined)) ?? 0;
  setState({ aliases, pushPreview, activity, activitySeen });
  // Opening the app (also from a notification) clears what is already on the lock screen.
  clearNotifications();
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
  refreshCircle().catch(() => {});
  ensurePush().catch(() => {});
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
    deviceName: deviceName(),
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

export async function updateProfile(patch: { name?: string; about?: string; readReceipts?: boolean; presence?: boolean }) {
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

/** Group photo (only members can load it). */
export function groupAvatarUrl(conv: Pick<Conv, 'id' | 'avatarVersion'> | null | undefined) {
  return conv && conv.avatarVersion ? `/api/conversations/${encodeURIComponent(conv.id)}/avatar?v=${conv.avatarVersion}` : null;
}

/** Photo shown for a chat: the group photo, or the other person's profile photo. */
export function chatAvatarUrl(conv: Conv, meId: string | undefined) {
  return conv.kind === 'group' ? groupAvatarUrl(conv) : avatarUrl(otherMember(conv, meId));
}

export async function setGroupPhoto(convId: string, blob: Blob) {
  const res = await api<{ conversation: ServerConv }>('PUT', `/api/conversations/${convId}/avatar`, blob);
  await upsertServerConv(res.conversation);
}

export async function removeGroupPhoto(convId: string) {
  const res = await api<{ conversation: ServerConv }>('DELETE', `/api/conversations/${convId}/avatar`);
  await upsertServerConv(res.conversation);
}

export async function setChatTheme(convId: string, theme: string) {
  const res = await api<{ conversation: ServerConv }>('PUT', `/api/conversations/${convId}/theme`, { theme });
  await upsertServerConv(res.conversation);
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#f2f2f2');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(getState().theme));

// ------------------------------------------------------------------ key pinning

/**
 * Trust on first use: the first key we see for a person is pinned. If the
 * server later hands out a different key, every chat with that person gets a
 * notice, and if the person was verified, sending pauses until the user accepts.
 */
/** Fingerprint over a person's device keys (ids excluded, so a pure re-numbering is not a change). */
const fpOf = (devices: DeviceKey[]) => devices.map((d) => `${d.sigPub}:${d.encPub}`).sort().join(',');

async function checkPins(members: Profile[]) {
  const me = getState().me;
  const pins = { ...getState().pins };
  const changed: Pin[] = [];
  const notices: { userId: string; name: string }[] = [];

  for (const m of members) {
    if (m.id === me?.id || !m.devices) continue;
    const pin = pins[m.id] as (Pin & { sigPub?: string; encPub?: string }) | undefined;
    const fp = fpOf(m.devices);
    // Pins from before linked devices stored one key pair directly.
    const pinFp = pin ? (pin.fp ?? (pin.sigPub ? `${pin.sigPub}:${pin.encPub}` : '')) : '';
    if (!pin) {
      pins[m.id] = { userId: m.id, devices: m.devices, fp, verified: false, needsAck: false, history: [] };
      changed.push(pins[m.id]);
    } else if (pinFp !== fp) {
      const oldSigs = (pin.devices ?? []).map((d) => d.sigPub).concat(pin.sigPub ? [pin.sigPub] : []);
      // A device was only added: messages from the existing devices stay trusted, but tell the user.
      pins[m.id] = {
        userId: m.id,
        devices: m.devices,
        fp,
        verified: false,
        needsAck: pin.verified || pin.needsAck,
        history: [...new Set([...oldSigs, ...pin.history])].slice(0, 8),
      };
      changed.push(pins[m.id]);
      if (m.devices.length) notices.push({ userId: m.id, name: m.name || m.phone });
    } else if (!pin.fp || JSON.stringify(pin.devices) !== JSON.stringify(m.devices)) {
      pins[m.id] = { userId: m.id, devices: m.devices, fp, verified: pin.verified, needsAck: pin.needsAck, history: pin.history };
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
  circle?: boolean;
  avatarVersion?: number;
  theme?: string;
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
  if (msg.media) await forgetFile(msg.id);
  const list = (getState().messages[msg.convId] ?? []).filter((m) => m.id !== msg.id);
  setState((s) => ({ messages: { ...s.messages, [msg.convId]: list } }));
  const conv = getState().convs[msg.convId];
  if (conv && conv.last?.id === msg.id) await saveConv({ ...conv, last: lastVisible(list) });
}

// ------------------------------------------------------------------ messages

const lastVisible = (list: Msg[]) => [...list].reverse().find((m) => m.kind !== 'notice' && !m.media?.vlog) ?? null;

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

  // A message from someone ends their "typing…".
  for (const m of msgs) if (m.senderId) stopTyping(m.convId, m.senderId);
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
    // Vlog posts live on the Today screen, not in the chat.
    const inChat = m.kind !== 'notice' && !m.media?.vlog;
    const unreadBump = countUnread && m.senderId !== meId && inChat && !isOpen ? 1 : 0;
    const newer = inChat && (!conv.last || m.sortKey >= conv.last.sortKey);
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
  if (countUnread && s.openConvId && visible && msgs.some((m) => m.convId === s.openConvId)) sendReadReceipt(s.openConvId);
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
  sendReadReceipt(convId);
  const conv = getState().convs[convId];
  if (!conv || (conv.unread === 0 && conv.lastReadAt > (conv.last?.sortKey ?? 0))) return;
  await saveConv({ ...conv, unread: 0, lastReadAt: Date.now() });
  updateBadge();
}

export function setOpenConv(convId: string | null) {
  setState({ openConvId: convId });
  if (convId) {
    markRead(convId);
    clearNotifications(convId);
  }
}

/** Remove delivered notifications from the lock screen: for one chat, or all of them. */
export function clearNotifications(convId?: string) {
  navigator.serviceWorker?.getRegistration()
    .then((reg) => reg?.getNotifications())
    .then((list) => list?.forEach((n) => { if (!convId || n.tag === convId || n.tag === 'haven-new-message') n.close(); }))
    .catch(() => {});
}

function updateBadge() {
  const total = Object.values(getState().convs).reduce((n, c) => n + (c.hidden ? 0 : c.unread), 0);
  const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (total > 0) nav.setAppBadge?.(total).catch(() => {});
  else nav.clearAppBadge?.().catch(() => {});
}

// ------------------------------------------------------------------ sending

export async function sendText(convId: string, raw: string, reply?: ReplyRef) {
  const text = raw.replace(/\s+$/, '').replace(/^\s*\n/, '').slice(0, MAX_TEXT);
  if (!text.trim() || !getState().me) return;
  const now = Date.now();
  const msg: Msg = { id: randomId(), convId, senderId: getState().me!.id, kind: 'text', text, createdAt: now, sortKey: now, status: 'pending' };
  if (reply) msg.reply = { id: reply.id, senderId: reply.senderId, text: reply.text.slice(0, 200) };
  await addMessages([msg], false);
  await addToOutbox(msg.id);
  flushOutbox();
}

async function queue(msg: Msg) {
  await addMessages([msg], false);
  await addToOutbox(msg.id);
  flushOutbox();
}

function draft(convId: string, kind: Msg['kind']): Msg {
  const now = Date.now();
  return { id: randomId(), convId, senderId: getState().me!.id, kind, createdAt: now, sortKey: now, status: 'pending' };
}

/** Photos, videos and voice messages: stored locally first, uploaded when sending. */
export async function sendMedia(convId: string, blob: Blob, meta: Omit<MediaPayload, 'path' | 'key' | 'iv' | 'size' | 'mime'>, reply?: ReplyRef) {
  if (!getState().me) return;
  const msg = draft(convId, 'media');
  msg.media = { ...meta, mime: blob.type || 'application/octet-stream', size: blob.size, path: '', key: '', iv: '' };
  if (reply) msg.reply = reply;
  await storeLocalFile(msg.id, blob);
  await queue(msg);
}

export async function sendLocation(convId: string, lat: number, lng: number, acc?: number) {
  const msg = draft(convId, 'location');
  msg.location = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, ...(acc ? { acc: Math.round(acc) } : {}) };
  await queue(msg);
}

export async function sendContact(convId: string, name: string, phone: string) {
  const msg = draft(convId, 'contact');
  msg.contactCard = { name: name.slice(0, 80), phone };
  await queue(msg);
}

export async function sendPoll(convId: string, question: string, options: string[], multi: boolean) {
  const msg = draft(convId, 'poll');
  msg.poll = { question: question.slice(0, 300), options: options.map((o) => o.slice(0, 100)).slice(0, 12), multi };
  msg.votes = {};
  await queue(msg);
}

/** Vote in a poll (replaces earlier votes of this person). */
export async function vote(msg: Msg, choices: number[]) {
  const me = getState().me;
  if (!me) return;
  await applyVote(msg.id, me.id, choices);
  await sendPayload(msg.convId, { type: 'vote', target: msg.id, choices });
}

async function applyVote(targetId: string, userId: string, choices: number[]) {
  const msg = await idb.get<Msg>('messages', targetId);
  if (!msg || msg.kind !== 'poll') return;
  const votes = { ...(msg.votes ?? {}) };
  if (choices.length) votes[userId] = [...new Set(choices)].filter((c) => c < (msg.poll?.options.length ?? 0));
  else delete votes[userId];
  await updateMessage({ ...msg, votes });
}

/**
 * A view-once photo was looked at: delete it from this device and tell the sender.
 * In a direct chat the file is also deleted from the server. In a group the others may not
 * have opened it yet, so the server copy stays (it is removed with the usual cleanup).
 */
export async function markOpened(msg: Msg) {
  if (msg.opened) return;
  const direct = getState().convs[msg.convId]?.kind === 'direct';
  await forgetFile(msg.id, direct ? msg.media : undefined);
  await updateMessage({ ...msg, opened: true, media: msg.media ? { ...msg.media, thumb: undefined } : undefined });
  sendPayload(msg.convId, { type: 'opened', target: msg.id }).catch(() => {});
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

/** Every device of every member, including my other devices, except this one. */
function recipientsOf(conv: Conv) {
  const myDevice = getState().me?.deviceId;
  return conv.members.flatMap((m) => m.devices ?? []).filter((d) => d.id !== myDevice).map((d) => ({ id: d.id, encPub: d.encPub, keyVersion: 1 }));
}

function payloadOf(msg: Msg): Payload {
  switch (msg.kind) {
    case 'media':
      return msg.reply ? { type: 'media', media: msg.media!, reply: msg.reply } : { type: 'media', media: msg.media! };
    case 'location':
      return { type: 'location', ...msg.location! };
    case 'contact':
      return { type: 'contact', ...msg.contactCard! };
    case 'poll':
      return { type: 'poll', ...msg.poll! };
    default:
      return msg.reply ? { type: 'text', text: msg.text ?? '', reply: msg.reply } : { type: 'text', text: msg.text ?? '' };
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
      if (msg.kind === 'media' && msg.media && !msg.media.path) {
        const blob = await idb.get<Blob>('files', msg.id);
        if (!blob) throw new Error('The file is no longer on this device.');
        const { path: _p, key: _k, iv: _i, size: _s, ...meta } = msg.media;
        void _p; void _k; void _i; void _s;
        const media = await uploadMedia(conv.id, blob, meta);
        msg = { ...msg, media };
        await idb.put('messages', msg);
        // A view-once photo is not kept on the sender's phone either.
        if (media.viewOnce) await idb.del('files', msg.id);
      }
      const payload = payloadOf(msg);
      const envelope = await encryptMessage(identity, me.id, conv.id, msg.id, payload,
        recipientsOf(conv));
      // Vlog posts are announced as "X just vlogged" instead of a message notification.
      const res = await api<{ id: string; createdAt: number }>('POST', `/api/conversations/${conv.id}/messages`, { id: msg.id, envelope, ...(msg.media?.vlog ? { vlog: true } : {}) });
      await updateMessage({ ...msg, status: 'sent', createdAt: res.createdAt });
      return 'sent';
    } catch (err) {
      if (err instanceof TypeError) return 'offline'; // network failure during upload
      if (err instanceof ApiError) {
        if (err.status === 0 || err.status >= 500 || err.status === 429) return 'offline';
        if (err.status === 401) return 'offline';
        if (err.code === 'members_changed' || err.code === 'keys_changed' || err.code === 'devices_changed') {
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

// ------------------------------------------------------------------ reactions

/** Encrypt and send a control payload (reactions) right away. */
async function sendPayload(convId: string, payload: Payload, extra: Record<string, unknown> = {}) {
  const me = getState().me;
  if (!me || !identity) throw new Error('You are offline.');
  for (let attempt = 0; attempt < 3; attempt++) {
    const conv = getState().convs[convId];
    if (!conv || conv.left) throw new Error('This chat is no longer available.');
    const others = conv.members.filter((m) => m.id !== me.id);
    const id = randomId();
    void others;
    const envelope = await encryptMessage(identity, me.id, conv.id, id, payload, recipientsOf(conv));
    try {
      await api('POST', `/api/conversations/${conv.id}/messages`, { id, envelope, ...extra });
      return;
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'members_changed' || err.code === 'keys_changed' || err.code === 'devices_changed')) {
        await refreshConversations().catch(() => {});
        continue;
      }
      throw err;
    }
  }
}

async function applyReaction(targetId: string, userId: string, emoji: string) {
  const msg = await idb.get<Msg>('messages', targetId);
  if (!msg) return;
  const reactions = { ...(msg.reactions ?? {}) };
  if (emoji) reactions[userId] = emoji;
  else delete reactions[userId];
  await updateMessage({ ...msg, reactions });
}

/** React to a message; picking the same emoji again removes the reaction. */
export async function react(msg: Msg, emoji: string) {
  const me = getState().me;
  if (!me) return;
  const next = msg.reactions?.[me.id] === emoji ? '' : emoji;
  await applyReaction(msg.id, me.id, next);
  // Reactions to a vlog only notify the person who posted it.
  const extra = msg.media?.vlog ? { pushTo: next && msg.senderId && msg.senderId !== me.id ? [msg.senderId] : [] } : {};
  await sendPayload(msg.convId, { type: 'reaction', target: msg.id, emoji: next }, extra);
}

// ------------------------------------------------------------------ read receipts

const sentReadAt: Record<string, number> = {};

/** Tell the others how far this chat has been read (only if read receipts are on). */
function sendReadReceipt(convId: string) {
  const s = getState();
  if (!s.me || s.me.readReceipts === false) return;
  const list = s.messages[convId];
  const conv = s.convs[convId];
  if (!conv || conv.left) return;
  const fromOthers = (list ?? (conv.last ? [conv.last] : [])).filter((m) => m.senderId && m.senderId !== s.me!.id && m.status === 'received');
  const at = fromOthers.reduce((max, m) => Math.max(max, m.createdAt), 0);
  if (!at || at <= (sentReadAt[convId] ?? 0)) return;
  sentReadAt[convId] = at;
  api('POST', `/api/conversations/${convId}/read`, { at }).catch(() => {
    sentReadAt[convId] = 0;
  });
}

/** True if every other member has read up to this message. */
export function isReadByAll(msg: Msg, conv: Conv, meId: string) {
  const others = conv.members.filter((m) => m.id !== meId);
  return others.length > 0 && others.every((m) => (m.lastReadAt ?? 0) >= msg.createdAt);
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
  const reactions: { target: string; userId: string; emoji: string }[] = [];
  const votes: { target: string; userId: string; choices: number[] }[] = [];
  const opened: { target: string; userId: string }[] = [];
  const changes: { target: string; userId: string; text: string | null }[] = [];
  for (const m of batch) {
    if (await idb.get('messages', m.id)) continue;

    if (m.kind === 'system') {
      const body = m.body as SystemBody & { type: string };
      refreshAfter = true;
      if ((body.type as string) === 'key_changed') continue; // detected and shown by key pinning
      out.push({ id: m.id, convId: m.conversationId, senderId: null, kind: 'system', system: body, createdAt: m.createdAt, sortKey: m.createdAt, status: 'received' });
      continue;
    }

    const fromMe = m.senderId === me.id;
    if (!getState().convs[m.conversationId] || (!fromMe && !getState().pins[m.senderId!])) await ensureFresh();
    const tryDecrypt = () => {
      // My own messages from my other devices are checked against my account's device keys.
      const sigs = fromMe
        ? (getState().me?.devices ?? []).map((d) => d.sigPub)
        : (() => { const pin = getState().pins[m.senderId!]; return pin ? [...(pin.devices ?? []).map((d) => d.sigPub), ...pin.history] : []; })();
      return decryptMessage(identity!, me.deviceId, m.conversationId, m.senderId!, m.id, m.body as Envelope, sigs);
    };
    let result = await tryDecrypt();
    if (!result.ok && result.reason === 'bad_signature' && !refreshedOnce) {
      await ensureFresh();
      result = await tryDecrypt();
    }
    if (result.ok && result.payload.type === 'reaction') {
      reactions.push({ target: result.payload.target, userId: m.senderId!, emoji: result.payload.emoji });
      continue;
    }
    if (result.ok && (result.payload.type === 'edit' || result.payload.type === 'delete')) {
      changes.push({ target: result.payload.target, userId: m.senderId!, text: result.payload.type === 'edit' ? result.payload.text : null });
      continue;
    }
    if (result.ok && result.payload.type === 'vote') {
      votes.push({ target: result.payload.target, userId: m.senderId!, choices: result.payload.choices });
      continue;
    }
    if (result.ok && result.payload.type === 'opened') {
      opened.push({ target: result.payload.target, userId: m.senderId! });
      continue;
    }
    if (result.ok) {
      const p = result.payload;
      const base = { id: m.id, convId: m.conversationId, senderId: m.senderId, createdAt: m.createdAt, sortKey: m.createdAt, status: (fromMe ? 'sent' : 'received') as 'sent' | 'received' };
      if (p.type === 'text') out.push({ ...base, kind: 'text', text: p.text, ...(p.reply ? { reply: p.reply } : {}) });
      else if (p.type === 'media') out.push({ ...base, kind: 'media', media: p.media, ...(p.reply ? { reply: p.reply } : {}) });
      else if (p.type === 'location') out.push({ ...base, kind: 'location', location: { lat: p.lat, lng: p.lng, acc: p.acc } });
      else if (p.type === 'contact') out.push({ ...base, kind: 'contact', contactCard: { name: p.name, phone: p.phone } });
      else if (p.type === 'poll') out.push({ ...base, kind: 'poll', poll: { question: p.question, options: p.options, multi: p.multi }, votes: {} });
    } else {
      out.push({ id: m.id, convId: m.conversationId, senderId: m.senderId, kind: 'undecryptable', createdAt: m.createdAt, sortKey: m.createdAt, status: 'received' });
    }
  }

  if (refreshAfter) await refreshConversations().catch(() => {});
  await addMessages(out, true);
  for (const r of reactions) await applyReaction(r.target, r.userId, r.emoji);
  for (const c of changes) await applyChange(c.target, c.userId, c.text);
  await noteActivity(out, reactions, me.id);
  for (const v of votes) await applyVote(v.target, v.userId, v.choices);
  for (const o of opened) {
    const target = await idb.get<Msg>('messages', o.target);
    if (target && target.senderId === me.id && target.media?.viewOnce) {
      await forgetFile(target.id);
      await updateMessage({ ...target, opened: true });
    }
  }
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
    let msg: { event?: string; ref?: string; payload?: { status?: string; event?: string; payload?: { c?: unknown; u?: unknown } } };
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
    else if (kind === 'conversations' || kind === 'read') {
      refreshConversations().catch(() => {});
      if (kind === 'conversations') refreshCircle().catch(() => {});
    }
    else if (kind === 'profiles') {
      refreshConversations().catch(() => {});
      refreshMe().catch(() => {});
    }
    else if (kind === 'signout') api('GET', '/api/me').catch(() => {});
    else if (kind === 'typing') onTyping(msg.payload?.payload);
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
  clearNotifications();
  refreshCircle().catch(() => {});
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

const PUSH_OFF = 'haven-push-off';
const PUSH_ASKED = 'haven-push-asked';
const flag = (k: string) => { try { return localStorage.getItem(k) === '1'; } catch { return false; } };
const setFlag = (k: string, on: boolean) => { try { if (on) localStorage.setItem(k, '1'); else localStorage.removeItem(k); } catch { /* private mode */ } };

export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are turned off for Haven in your device settings.');
  setFlag(PUSH_OFF, false);
  await subscribeDevice();
}

/** Switched off by the user in Settings: stays off until they turn it on again. */
export async function turnOffPush() {
  setFlag(PUSH_OFF, true);
  await disablePush();
}

async function subscribeDevice() {
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api<{ publicKey: string }>('GET', '/api/push/key');
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
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

export function myDevices(): DeviceKey[] {
  return getState().me?.devices ?? [];
}

// ------------------------------------------------------------------ linked devices

export function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad'
    : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}

export interface LinkRequest {
  linkId: string;
  code: string;
  pollSecret: string;
  expiresAt: number;
}

/** New device: create keys and a pairing code to show as a QR code. */
export async function startLink(): Promise<LinkRequest> {
  pendingIdentity = await createIdentity('');
  pendingIsStored = false;
  return api<LinkRequest>('POST', '/api/link/start', { encPub: pendingIdentity.encPub, sigPub: pendingIdentity.sigPub, name: deviceName() });
}

/** New device: has the other device approved yet? */
export async function checkLink(req: LinkRequest): Promise<boolean> {
  const res = await api<{ status: 'pending' } | { status: 'ok'; me: Me; history: boolean }>('POST', '/api/link/poll', { linkId: req.linkId, pollSecret: req.pollSecret });
  if (res.status === 'pending') return false;
  pendingIdentity!.phone = res.me.phone;
  await finishSignIn(res.me);
  if (res.history) receiveHistory();
  return true;
}

/** Signed-in device: approve a code scanned from the new device. */
export async function approveLink(code: string, history: boolean) {
  return api<{ ok: true; name: string; linkId: string; encPub: string }>('POST', '/api/link/approve', { code, history });
}

// ------------------------------------------------------------------ chat history hand-over

const HISTORY_MEDIA_BUDGET = 18 * 1024 * 1024;

interface HistoryBundle {
  v: 1;
  convs: Conv[];
  messages: Msg[];
  pins: Pin[];
  aliases: Record<string, string>;
  files: [string, string, string][]; // [messageId, mime, base64url]
}

async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<{ data: Uint8Array<ArrayBuffer>; gz: boolean }> {
  if (typeof CompressionStream === 'undefined') return { data: bytes, gz: false };
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return { data: new Uint8Array(await new Response(stream).arrayBuffer()), gz: true };
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Old device: pack the chats stored here, encrypt them for the new device and
 * hand them over. View-once photos are never included.
 */
export async function sendHistory(linkId: string, encPub: string) {
  try {
    const messages = (await idb.getAll<Msg>('messages')).filter((m) => m.kind !== 'notice' && m.status !== 'pending' && !m.media?.viewOnce);
    const keep = new Set(messages.map((m) => m.id));
    const files: HistoryBundle['files'] = [];
    let budget = HISTORY_MEDIA_BUDGET;
    for (const [id, blob] of await idb.entries<Blob>('files')) {
      if (!keep.has(String(id)) || !(blob instanceof Blob) || blob.size > budget) continue;
      budget -= blob.size;
      files.push([String(id), blob.type, toB64u(new Uint8Array(await blob.arrayBuffer()))]);
    }
    const bundle: HistoryBundle = {
      v: 1,
      convs: await idb.getAll<Conv>('convs'),
      messages,
      pins: await idb.getAll<Pin>('pins'),
      aliases: getState().aliases,
      files,
    };
    const { data, gz } = await gzip(new TextEncoder().encode(JSON.stringify(bundle)));
    const framed = new Uint8Array(data.length + 1);
    framed[0] = gz ? 1 : 0;
    framed.set(data, 1);
    const { ciphertext, key } = await seal(framed, encPub);
    const { uploadUrl } = await api<{ uploadUrl: string }>('POST', '/api/link/history/upload', { linkId, size: ciphertext.length });
    const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: ciphertext });
    if (!res.ok) throw new Error('Upload failed');
    await api('POST', '/api/link/history/done', { linkId, key });
  } catch (err) {
    await api('POST', '/api/link/history/done', { linkId }).catch(() => {});
    throw err;
  }
}

/** New device: wait for the history from the old device and import it. */
async function receiveHistory() {
  setState({ importing: 'waiting' });
  const deadline = Date.now() + 10 * 60_000;
  try {
    while (Date.now() < deadline) {
      const res = await api<{ state: 'none' | 'pending' | 'ready'; url?: string; key?: string }>('GET', '/api/link/history').catch(() => null);
      if (res?.state === 'none') return;
      if (res?.state === 'ready' && res.url && res.key && identity) {
        setState({ importing: 'importing' });
        const download = await fetch(res.url);
        if (!download.ok) throw new Error('Download failed');
        const framed = await unseal(identity, await download.arrayBuffer(), res.key);
        const json = framed[0] === 1 ? await gunzip(framed.slice(1)) : framed.slice(1);
        await importHistory(JSON.parse(new TextDecoder().decode(json)) as HistoryBundle);
        return;
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
  } catch {
    // The chats stay on the other device; new messages arrive here anyway.
  } finally {
    setState({ importing: 'none' });
    api('POST', '/api/link/history/finish').catch(() => {});
  }
}

async function importHistory(bundle: HistoryBundle) {
  if (bundle?.v !== 1 || !Array.isArray(bundle.messages)) return;
  const known = new Set((await idb.getAll<Msg>('messages')).map((m) => m.id));
  await idb.putMany('messages', bundle.messages.filter((m) => m && typeof m.id === 'string' && !known.has(m.id)));
  for (const [id, mime, b64] of bundle.files ?? []) await idb.put('files', new Blob([fromB64u(b64)], { type: mime }), id).catch(() => {});
  // Keep my own trust decisions; take the other device's where I have none yet.
  const pins = getState().pins;
  await idb.putMany('pins', (bundle.pins ?? []).filter((p) => p && !pins[p.userId]));
  const convs = { ...getState().convs };
  for (const c of bundle.convs ?? []) {
    const cur = convs[c.id];
    convs[c.id] = cur ? { ...cur, last: c.last && (!cur.last || c.last.sortKey > cur.last.sortKey) ? c.last : cur.last, hidden: cur.hidden && c.hidden } : { ...c, unread: 0 };
  }
  await idb.putMany('convs', Object.values(convs));
  const aliases = { ...(bundle.aliases ?? {}), ...getState().aliases };
  await idb.put('meta', aliases, 'aliases');
  setState({
    convs,
    aliases,
    pins: Object.fromEntries((await idb.getAll<Pin>('pins')).map((p) => [p.userId, p])),
    messages: {},
  });
  const open = getState().openConvId;
  if (open) await loadMessages(open);
  await refreshConversations().catch(() => {});
}

export interface LinkedDevice {
  id: string;
  name: string;
  createdAt: number;
  lastActiveAt: number;
  current: boolean;
}

export async function listDevices() {
  return (await api<{ devices: LinkedDevice[] }>('GET', '/api/devices')).devices;
}

export async function removeDevice(id: string) {
  await api('DELETE', `/api/devices/${id}`);
  await refreshMe();
}

export async function refreshMe() {
  const res = await api<{ me: Me }>('GET', '/api/me');
  await saveMe(res.me);
}

/** One-line summary of a message for chat lists and notifications. */
export function summarize(m: Pick<Msg, 'kind' | 'text' | 'media' | 'contactCard' | 'poll'> & { deleted?: boolean }): string {
  if (m.deleted) return 'This message was deleted';
  switch (m.kind) {
    case 'media':
      if (m.media?.viewOnce) return 'Photo · view once';
      if (m.media?.kind === 'voice') return `Voice message${m.media.duration ? ` · ${formatDuration(m.media.duration)}` : ''}`;
      return (m.media?.kind === 'video' ? 'Video' : 'Photo') + (m.media?.caption ? ` · ${m.media.caption}` : '');
    case 'location':
      return 'Location';
    case 'contact':
      return `Contact · ${m.contactCard?.name ?? ''}`;
    case 'poll':
      return `Poll · ${m.poll?.question ?? ''}`;
    default:
      return m.text ?? '';
  }
}

export function formatDuration(sec: number) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function displayName(p: { id?: string; name?: string; phone?: string } | null | undefined) {
  const alias = p?.id ? getState().aliases[p.id] : '';
  return alias || p?.name?.trim() || p?.phone || 'Unknown';
}

/** Save a contact under your own name for them (only on this device). Empty removes it. */
export async function setAlias(userId: string, name: string) {
  const aliases = { ...getState().aliases };
  const clean = name.replace(/[\u0000-\u001F\u202A-\u202E\u2066-\u2069]/g, '').trim().slice(0, 40);
  if (clean) aliases[userId] = clean;
  else delete aliases[userId];
  await idb.put('meta', aliases, 'aliases');
  setState({ aliases });
}

export async function setPushPreview(on: boolean) {
  await idb.put('meta', on, 'pushPreview');
  setState({ pushPreview: on });
}

export function convTitle(conv: Conv, meId: string | undefined) {
  if (conv.kind === 'group') return conv.title || 'Group';
  const other = conv.members.find((m) => m.id !== meId);
  return other ? displayName(other) : 'Deleted account';
}

export function otherMember(conv: Conv, meId: string | undefined) {
  return conv.kind === 'direct' ? conv.members.find((m) => m.id !== meId) ?? null : null;
}

// ------------------------------------------------------------------ Vlog your Day

let circleLoading: Promise<void> | null = null;

/** Load my friend group and who vlogs today (the server picks one person per day). */
export function refreshCircle(): Promise<void> {
  if (!getState().me) return Promise.resolve();
  if (!circleLoading) {
    circleLoading = (async () => {
      const res = await api<{ circle: string | null; today: string; picks: { day: string; userId: string }[] }>('GET', '/api/circle');
      if (res.circle && !getState().convs[res.circle]) await refreshConversations().catch(() => {});
      setState({ circle: { id: res.circle, today: res.today, picks: res.picks } });
    })().finally(() => { circleLoading = null; });
  }
  return circleLoading;
}

export async function createCircle(title: string, memberIds: string[]) {
  const res = await api<{ conversation: ServerConv; skipped: string[] }>('POST', '/api/circle', { title, memberIds });
  await upsertServerConv(res.conversation);
  await refreshCircle();
  return res.skipped;
}

export const VLOG_LIMITS = { videos: 3, seconds: 6 * 60, photos: 6 };

/** What the picked person has posted on a day. */
export function vlogPosts(list: Msg[] | undefined, day: string, userId: string | undefined) {
  return (list ?? []).filter((m) => m.kind === 'media' && !m.deleted && m.media?.vlog === day && m.senderId === userId);
}

export function vlogUsage(posts: Msg[]) {
  const videos = posts.filter((m) => m.media!.kind === 'video');
  const photos = posts.filter((m) => m.media!.kind === 'image');
  return { videos: videos.length, seconds: videos.reduce((n, m) => n + (m.media!.duration ?? 0), 0), photos: photos.length };
}

// ------------------------------------------------------------------ notification center

const MAX_ACTIVITY = 100;

/** Record what happened for the notification center: reactions to my messages, new vlogs, people joining. */
async function noteActivity(msgs: Msg[], reactions: { target: string; userId: string; emoji: string }[], meId: string) {
  const add: Activity[] = [];
  const remove = new Set<string>();
  const now = Date.now();
  for (const r of reactions) {
    if (r.userId === meId) continue;
    const id = `r:${r.target}:${r.userId}`;
    if (!r.emoji) { remove.add(id); continue; }
    const target = await idb.get<Msg>('messages', r.target);
    if (!target || target.senderId !== meId) continue;
    add.push({ id, type: 'reaction', convId: target.convId, msgId: target.id, userId: r.userId, emoji: r.emoji, vlog: Boolean(target.media?.vlog), snippet: summarize(target).slice(0, 80), at: now });
  }
  for (const m of msgs) {
    if (m.media?.vlog && m.senderId && m.senderId !== meId) {
      add.push({ id: `v:${m.media.vlog}:${m.senderId}`, type: 'vlog', convId: m.convId, userId: m.senderId, at: m.createdAt });
    } else if (m.kind === 'system' && m.system?.type === 'member_joined' && m.system.actorId !== meId) {
      add.push({ id: `j:${m.id}`, type: 'joined', convId: m.convId, userId: m.system.actorId, at: m.createdAt });
    }
  }
  if (!add.length && !remove.size) return;
  const ids = new Set(add.map((a) => a.id));
  const next = [...add.sort((a, b) => b.at - a.at), ...getState().activity.filter((a) => !ids.has(a.id) && !remove.has(a.id))].slice(0, MAX_ACTIVITY);
  setState({ activity: next });
  await idb.put('meta', next, 'activity').catch(() => {});
}

export async function markActivitySeen() {
  const at = Date.now();
  setState({ activitySeen: at });
  await idb.put('meta', at, 'activitySeen').catch(() => {});
}

// ------------------------------------------------------------------ friend group invites

export async function createCircleInvite() {
  return api<{ code: string; expiresAt: number }>('POST', '/api/circle/invite', {});
}

export async function joinCircle(code: string) {
  const res = await api<{ conversation: ServerConv }>('POST', '/api/circle/join', { code });
  await upsertServerConv(res.conversation);
  await refreshCircle();
  return res.conversation;
}

// ------------------------------------------------------------------ edit and delete for everyone

/** Only the sender can change a message; the change is an end-to-end encrypted, signed control message. */
async function applyChange(targetId: string, userId: string, text: string | null) {
  const msg = await idb.get<Msg>('messages', targetId);
  if (!msg || msg.senderId !== userId || msg.deleted) return;
  if (text === null) {
    if (msg.media) await forgetFile(msg.id);
    await updateMessage(deletedCopy(msg));
  } else if (msg.kind === 'text') {
    await updateMessage({ ...msg, text, editedAt: Date.now() });
  }
}

function deletedCopy(msg: Msg): Msg {
  const { text: _t, media: _m, location: _l, contactCard: _c, poll: _p, votes: _v, reactions: _r, reply: _q, ...rest } = msg;
  void _t; void _m; void _l; void _c; void _p; void _v; void _r; void _q;
  return { ...rest, deleted: true };
}

export async function editMessage(msg: Msg, text: string) {
  const me = getState().me;
  const clean = text.trim();
  if (!me || msg.senderId !== me.id || msg.kind !== 'text' || msg.deleted || !clean || clean === msg.text) return;
  // Nobody is notified about an edit; the chat just updates.
  await sendPayload(msg.convId, { type: 'edit', target: msg.id, text: clean }, { pushTo: [] });
  await updateMessage({ ...msg, text: clean, editedAt: Date.now() });
}

export async function deleteForEveryone(msg: Msg) {
  const me = getState().me;
  if (!me || msg.senderId !== me.id || msg.deleted) return;
  await sendPayload(msg.convId, { type: 'delete', target: msg.id }, { pushTo: [] });
  const path = msg.media?.path;
  if (msg.media) await forgetFile(msg.id);
  await updateMessage(deletedCopy(msg));
  if (path) api('POST', '/api/attachments/delete', { path }).catch(() => {});
}

// ------------------------------------------------------------------ push on by default

/** Already allowed on this device: make sure the server has this device's subscription. */
async function ensurePush() {
  if (!pushSupported() || Notification.permission !== 'granted' || flag(PUSH_OFF)) return;
  await subscribeDevice();
}

// Notifications are on from the start: the first tap after signing in asks for permission once
// (browsers only allow that during a tap), then this device subscribes.
if (typeof document !== 'undefined') {
  const ask = () => {
    if (!getState().me || !pushSupported() || flag(PUSH_OFF) || flag(PUSH_ASKED) || Notification.permission !== 'default') {
      if (flag(PUSH_ASKED) || flag(PUSH_OFF) || (pushSupported() && Notification.permission !== 'default')) document.removeEventListener('click', ask, true);
      return;
    }
    document.removeEventListener('click', ask, true);
    setFlag(PUSH_ASKED, true);
    enablePush().catch(() => {});
  };
  document.addEventListener('click', ask, true);
}

// ------------------------------------------------------------------ last seen & online

const sharesPresence = () => { const me = getState().me; return Boolean(me && me.presence !== false && identity); };

function sendPresence(state: 'online' | 'offline') {
  if (!sharesPresence()) return;
  // keepalive: the "offline" ping still goes out while the app is being closed.
  fetch('/api/presence', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state }) }).catch(() => {});
}

if (typeof document !== 'undefined') {
  setInterval(() => { if (document.visibilityState === 'visible') sendPresence('online'); }, 30_000);
  document.addEventListener('visibilitychange', () => sendPresence(document.visibilityState === 'visible' ? 'online' : 'offline'));
  window.addEventListener('pagehide', () => sendPresence('offline'));
  setTimeout(() => sendPresence('online'), 1500);
}

export type Presence = { visible: false } | { visible: true; online: boolean; lastSeen: number };

export async function fetchPresence(userId: string): Promise<Presence> {
  if (!sharesPresence()) return { visible: false };
  return api<Presence>('GET', `/api/presence/${userId}`);
}

/** "online", "last seen today at 14:05", "last seen yesterday at 09:12", "last seen 3 Nov". */
export function describePresence(p: Presence | null): string {
  if (!p || !p.visible) return '';
  if (p.online) return 'online';
  const d = new Date(p.lastSeen);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return `last seen today at ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `last seen yesterday at ${time}`;
  return `last seen ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

// ------------------------------------------------------------------ typing indicator

const TYPING_MS = 6000;
const lastTypingSent: Record<string, number> = {};

/** Tell the others in this chat that I am typing (at most every 3 seconds). */
export function sendTyping(convId: string) {
  const now = Date.now();
  if (now - (lastTypingSent[convId] ?? 0) < 3000) return;
  lastTypingSent[convId] = now;
  api('POST', `/api/conversations/${convId}/typing`, {}).catch(() => {});
}

function onTyping(p: { c?: unknown; u?: unknown } | undefined) {
  const convId = typeof p?.c === 'string' ? p.c : '';
  const userId = typeof p?.u === 'string' ? p.u : '';
  if (!convId || !userId || userId === getState().me?.id || !getState().convs[convId]) return;
  const until = Date.now() + TYPING_MS;
  setState((s) => ({ typing: { ...s.typing, [convId]: { ...(s.typing[convId] ?? {}), [userId]: until } } }));
  setTimeout(() => {
    if ((getState().typing[convId]?.[userId] ?? 0) <= Date.now()) stopTyping(convId, userId);
  }, TYPING_MS + 50);
}

function stopTyping(convId: string, userId: string) {
  const conv = getState().typing[convId];
  if (!conv || !(userId in conv)) return;
  const { [userId]: _gone, ...rest } = conv;
  void _gone;
  setState((s) => ({ typing: { ...s.typing, [convId]: rest } }));
}

/** "typing…", "Robin is typing…", "2 people are typing…" (or '' if nobody is). */
export function typingLabel(conv: Conv | undefined, typing: Record<string, number> | undefined, meId: string | undefined) {
  if (!conv || !typing) return '';
  const now = Date.now();
  const ids = Object.entries(typing).filter(([id, until]) => until > now && id !== meId).map(([id]) => id);
  if (!ids.length) return '';
  if (conv.kind === 'direct') return 'typing…';
  if (ids.length > 1) return `${ids.length} people are typing…`;
  return `${displayName(conv.members.find((m) => m.id === ids[0])).split(' ')[0] || 'Someone'} is typing…`;
}
