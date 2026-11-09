/// <reference lib="webworker" />
// Haven service worker: offline app shell and push notifications.
//
// The push itself carries no content. When one arrives, this worker fetches the
// waiting (encrypted) messages and decrypts the newest one on the device, using
// the same keys as the app, so the notification can show sender and text.
// Nothing readable ever passes through Apple's or Google's push servers.
// The worker never acknowledges messages; the app does that when it syncs.

import { decryptMessage, type Envelope, type Identity } from './lib/crypto';
import type { Conv, Me, Pin } from './lib/store';

declare const self: ServiceWorkerGlobalScope;
declare const __VERSION__: string;
declare const __SHELL__: string[];

const CACHE = `haven-shell-${__VERSION__}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(__SHELL__)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('haven-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async () => (await caches.match('/', { cacheName: CACHE })) ?? Response.error()));
    return;
  }
  event.respondWith(caches.match(req, { cacheName: CACHE }).then((hit) => hit || fetch(req)));
});

// ------------------------------------------------------------------ IndexedDB (read-only)

function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve) => {
    const open = indexedDB.open('haven');
    open.onerror = () => resolve(undefined);
    open.onupgradeneeded = () => {
      // The app has never run here; do not create anything.
      open.transaction?.abort();
      resolve(undefined);
    };
    open.onsuccess = () => {
      const db = open.result;
      try {
        const req = db.transaction(store, 'readonly').objectStore(store).get(key);
        req.onsuccess = () => {
          resolve(req.result as T);
          db.close();
        };
        req.onerror = () => {
          resolve(undefined);
          db.close();
        };
      } catch {
        resolve(undefined);
        db.close();
      }
    };
  });
}

// ------------------------------------------------------------------ push

interface SyncMessage {
  id: string;
  conversationId: string;
  senderId: string | null;
  kind: 'msg' | 'system';
  body: unknown;
}

async function preview(): Promise<{ title: string; body: string; tag: string; convId?: string; open?: string } | null> {
  const [identity, me, cursor, aliases] = await Promise.all([
    idbGet<Identity>('meta', 'identity'),
    idbGet<Me>('meta', 'me'),
    idbGet<number>('meta', 'cursor'),
    idbGet<Record<string, string>>('meta', 'aliases'),
  ]);
  const de = (await idbGet<string>('meta', 'langSent').catch(() => undefined)) === 'de';
  const L = (en: string, ger: string) => (de ? ger : en);
  if (!identity || !me) return null;
  const res = await fetch(`/api/sync?after=${cursor ?? 0}&limit=100`, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) return null;
  const { messages } = (await res.json()) as { messages: SyncMessage[] };
  for (const m of [...messages].reverse()) {
    if (m.kind !== 'msg' || !m.senderId || m.senderId === me.id) continue;
    const [conv, pin] = await Promise.all([idbGet<Conv>('convs', m.conversationId), idbGet<Pin>('pins', m.senderId)]);
    if (!pin) continue;
    const sigs = [...(pin.devices ?? []).map((d) => d.sigPub), ...pin.history];
    const result = await decryptMessage(identity, me.deviceId, m.conversationId, m.senderId, m.id, m.body as Envelope, sigs);
    if (!result.ok) continue;
    const member = conv?.members.find((x) => x.id === m.senderId);
    const sender = aliases?.[m.senderId] || member?.name || member?.phone || L('Someone', 'Jemand');
    const title = conv?.kind === 'group' ? `${sender} · ${conv.title}` : sender;
    const p = result.payload;
    let body: string;
    if (p.type === 'text') {
      body = p.text;
      if (p.mentions?.includes(me.id)) return { title: `${sender} ${L('mentioned you', 'hat dich erwähnt')}${conv?.kind === 'group' ? ` · ${conv.title}` : ''}`, body: body.length > 180 ? `${body.slice(0, 177)}…` : body, tag: m.conversationId, convId: m.conversationId };
    }
    else if (p.type === 'reaction') {
      if (!p.emoji) continue;
      const target = await idbGet<{ media?: { vlog?: string } }>('messages', p.target).catch(() => undefined);
      if (target?.media?.vlog) return { title: sender, body: L(`Reacted ${p.emoji} to your vlog`, `Hat mit ${p.emoji} auf deinen Vlog reagiert`), tag: 'haven-vlog', open: 'today' };
      body = L(`Reacted ${p.emoji}`, `Hat mit ${p.emoji} reagiert`);
    } else if (p.type === 'media') {
      if (p.media.vlog) continue; // announced separately as "X just vlogged"
      body = p.media.viewOnce ? L('Photo · view once', 'Foto · einmal ansehen') : p.media.kind === 'voice' ? L('Voice message', 'Sprachnachricht') : p.media.kind === 'video' ? 'Video' : L('Photo', 'Foto');
      if (p.media.caption && !p.media.viewOnce) body += ` · ${p.media.caption}`;
    } else if (p.type === 'location') body = L('Location', 'Standort');
    else if (p.type === 'contact') body = `${L('Contact', 'Kontakt')} · ${p.name}`;
    else if (p.type === 'poll') body = `${L('Poll', 'Umfrage')} · ${p.question}`;
    else if (p.type === 'sticker') body = p.value ? `Sticker · ${p.value}` : 'Sticker';
    else continue;
    return { title, body: body.length > 180 ? `${body.slice(0, 177)}…` : body, tag: m.conversationId, convId: m.conversationId };
  }
  return null;
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let data: { t?: string; title?: string; body?: string; open?: string } = {};
    try { data = event.data?.json() ?? {}; } catch { /* content-free push */ }
    if (data.t === 'announce' && data.title) {
      // Vlog news while the app is open: it is on screen already.
      if ((data.open === 'today' || data.open === 'call') && (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).some((w) => w.visibilityState === 'visible')) return;
      await self.registration.showNotification(data.title, {
        body: data.body ?? '',
        tag: 'haven-announce',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        data: { open: data.open },
      });
      return;
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((w) => w.visibilityState === 'visible')) return;
    let note: Awaited<ReturnType<typeof preview>> = null;
    const showPreview = (await idbGet<boolean>('meta', 'pushPreview')) ?? true;
    if (showPreview) {
      try {
        note = await preview();
      } catch {
        note = null;
      }
    }
    await self.registration.showNotification(note?.title ?? 'Haven', {
      body: note?.body ?? ((await idbGet<string>('meta', 'langSent').catch(() => undefined)) === 'de' ? 'Du hast eine neue Nachricht' : 'You have a new message'),
      tag: note?.tag ?? 'haven-new-message',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { convId: note?.convId, open: note?.open },
      // @ts-expect-error renotify is supported by browsers but missing from older typings
      renotify: true,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification.data ?? {}) as { convId?: string; open?: string };
  const convId = data.convId;
  const open = data.open && /^[a-z-]+$/.test(data.open) ? data.open : undefined;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if ('focus' in w) {
        await w.focus();
        if (convId) w.postMessage({ type: 'open-chat', convId });
        if (open) w.postMessage({ type: 'open-screen', screen: open });
        return;
      }
    }
    await self.clients.openWindow(convId ? `/?chat=${encodeURIComponent(convId)}` : open ? `/?open=${open}` : '/');
  })());
});
