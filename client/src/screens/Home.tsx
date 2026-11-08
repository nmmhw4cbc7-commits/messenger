import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { memo } from 'preact/compat';
import { getState, useStore, type Conv, type Msg } from '../lib/store';
import { chatAvatarUrl, convTitle, displayName, otherMember, deleteChat, markRead, summarize, typingLabel } from '../lib/engine';
import { formatListTime } from '../lib/format';
import { t } from '../lib/i18n';
import { Avatar, Empty, NavButton, Screen, Spinner, actionSheet, confirmAction } from '../ui/components';
import { Chats, Compose, Gear, Lock, Search, Clock, Alert, Check, Trash } from '../ui/icons';
import { openLayers, useNav } from '../ui/nav';
import { maybeShowWhatsNew } from './Guide';
import { ChatScreen } from './Chat';
import { NewChatSheet } from './NewChat';
import { SettingsTab } from './Settings';
import { describeSystem } from './system';
import { DevicesScreen } from './Devices';
import { TodayTab, VlogIcon } from './Today';

// Tabs keep their own state; switching tabs must not redraw the other tabs.
const TodayPane = memo(() => <TodayTab />);
const ChatsPane = memo(() => <ChatsTab />);
const SettingsPane = memo(() => <SettingsTab />);

import { checkBackupOnStart } from './Backup';

const PLACE_KEY = 'haven.place';
/** Where the user was within the last 30 minutes, if anywhere. */
function restoredPlace(): { tab: 'today' | 'chats' | 'settings'; chat: string | null } | null {
  try {
    const p = JSON.parse(localStorage.getItem(PLACE_KEY) || 'null');
    if (!p || Date.now() - p.at > 30 * 60_000) return null;
    return { tab: ['today', 'chats', 'settings'].includes(p.tab) ? p.tab : 'today', chat: typeof p.chat === 'string' ? p.chat : null };
  } catch {
    return null;
  }
}
export function Home() {
  const nav = useNav();
  const [tab, setTab] = useState<'today' | 'chats' | 'settings'>(() => restoredPlace()?.tab ?? 'today');
  const openConvId = useStore((s) => s.openConvId);

  // iOS may close the app in the background; it then starts fresh. Remember where
  // the user was (tab and open chat) so coming back doesn't land on the start page.
  useEffect(() => {
    try { localStorage.setItem(PLACE_KEY, JSON.stringify({ tab, chat: openConvId ?? null, at: Date.now() })); } catch { /* fine */ }
  }, [tab, openConvId]);
  useEffect(() => {
    const save = () => {
      if (document.visibilityState !== 'hidden') return;
      try { localStorage.setItem(PLACE_KEY, JSON.stringify({ tab, chat: getState().openConvId ?? null, at: Date.now() })); } catch { /* fine */ }
    };
    document.addEventListener('visibilitychange', save);
    return () => document.removeEventListener('visibilitychange', save);
  }, [tab]);

  // Tapping a notification opens that chat.
  useEffect(() => {
    const open = (convId: string) => {
      if (!getState().convs[convId]) return;
      setTab('chats');
      nav.push(<ChatScreen convId={convId} />);
    };
    const openScreen = (screen: string) => {
      if (screen === 'today') {
        setTab('today');
        return;
      }
      if (screen !== 'devices') return;
      setTab('settings');
      nav.push(<DevicesScreen />);
    };
    const params = new URLSearchParams(location.search);
    const fromUrl = params.get('chat');
    const screenFromUrl = params.get('open');
    if (fromUrl || screenFromUrl) history.replaceState(history.state, '', '/');
    if (fromUrl) open(fromUrl);
    else if (screenFromUrl) openScreen(screenFromUrl);
    else {
      const place = restoredPlace();
      if (place?.chat && getState().convs[place.chat]) nav.push(<ChatScreen convId={place.chat} />);
    }
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === 'open-chat' && typeof e.data.convId === 'string') open(e.data.convId);
      if (e.data?.type === 'open-screen' && typeof e.data.screen === 'string') openScreen(e.data.screen);
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    // After an update: what's new. Otherwise (or later) the backup offer, never on top of another sheet.
    const timer = setTimeout(() => { if (openLayers() === 0 && !maybeShowWhatsNew()) checkBackupOnStart(); }, 1800);
    return () => { clearTimeout(timer); navigator.serviceWorker?.removeEventListener('message', onMessage); };
  }, []);
  const unread = useStore((s) => Object.values(s.convs).reduce((n, c) => n + (c.hidden ? 0 : c.unread), 0));
  const myTurn = useStore((s) => Boolean(s.circle?.id && s.me && s.circle.picks.some((p) => p.day === s.circle!.today && p.userId === s.me!.id)));
  const unseenActivity = useStore((s) => s.activity.some((a) => a.at > s.activitySeen));

  return (
    <div class="home">
      <div class={`tab-pane${tab === 'today' ? ' active' : ''}`}><TodayPane /></div>
      <div class={`tab-pane${tab === 'chats' ? ' active' : ''}`}><ChatsPane /></div>
      <div class={`tab-pane${tab === 'settings' ? ' active' : ''}`}><SettingsPane /></div>
      <nav class="tabbar" aria-label="Main">
        <button class={tab === 'today' ? 'active' : ''} onClick={() => setTab('today')} aria-current={tab === 'today'}>
          <span class="tab-icon">
            <VlogIcon size={26} />
            {(myTurn || unseenActivity) && <span class="tab-badge dot" />}
          </span>
          <span>Today</span>
        </button>
        <button class={tab === 'chats' ? 'active' : ''} onClick={() => setTab('chats')} aria-current={tab === 'chats'}>
          <span class="tab-icon">
            <Chats size={26} />
            {unread > 0 && <span class="tab-badge">{unread > 99 ? '99+' : unread}</span>}
          </span>
          <span>Chats</span>
        </button>
        <button class={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')} aria-current={tab === 'settings'}>
          <span class="tab-icon"><Gear size={26} /></span>
          <span>Settings</span>
        </button>
      </nav>
    </div>
  );
}

function ChatsTab() {
  const nav = useNav();
  const convs = useStore((s) => s.convs);
  const me = useStore((s) => s.me);
  useStore((s) => s.aliases); // re-render when contact names change
  const connected = useStore((s) => s.connected);
  const importing = useStore((s) => s.importing);
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const matches = (c: Conv) =>
      !q || convTitle(c, me?.id).toLowerCase().includes(q) || (digits.length >= 3 && c.members.some((m) => m.id !== me?.id && m.phone.includes(digits)));
    return Object.values(convs)
      .filter((c) => !c.hidden && (c.last || c.kind === 'group' || c.createdBy === me?.id || c.updatedAt > c.createdAt))
      .filter(matches)
      .sort((a, b) => (b.last?.sortKey ?? b.createdAt) - (a.last?.sortKey ?? a.createdAt));
  }, [convs, query, me?.id]);

  const openNew = () => nav.present((close) => <NewChatSheet close={close} />, { variant: 'full' });
  const hasAny = Object.values(convs).some((c) => !c.hidden && (c.last || c.kind === 'group' || c.createdBy === me?.id || c.updatedAt > c.createdAt));

  return (
    <Screen
      title="Chats"
      large
      titleNode={connected ? 'Chats' : <span class="connecting">Connecting…</span>}
      right={<NavButton onClick={openNew} label="New chat"><Compose size={25} /></NavButton>}
    >
      {importing !== 'none' && (
        <div class="import-banner" role="status">
          <Spinner size={16} />
          <span>{importing === 'waiting' ? 'Waiting for your chats from your other device…' : 'Importing your chats…'}</span>
        </div>
      )}
      {hasAny && (
        <div class="search-bar in-list">
          <Search size={18} />
          <input type="search" placeholder="Search" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} aria-label="Search chats" />
        </div>
      )}
      {!hasAny ? (
        <Empty icon={<Lock size={30} />} title="No chats yet" text="Start a conversation with anyone by their phone number. Everything you send is end-to-end encrypted.">
          <button class="pill-button" onClick={openNew}>Start a chat</button>
        </Empty>
      ) : (
        <ul class="chat-list">
          {list.map((c) => (
            <ChatRow key={c.id} conv={c} meId={me?.id} onOpen={() => nav.push(<ChatScreen convId={c.id} />)} />
          ))}
          {!list.length && <li class="muted center pad">No chats match “{query}”</li>}
        </ul>
      )}
    </Screen>
  );
}

// The preview shows people's words, so it is translated here and not on screen.
function preview(m: Msg | null, conv: Conv, meId: string | undefined) {
  if (!m) return t(conv.kind === 'group' ? 'Group created' : 'Say hello');
  if (m.kind === 'system' || m.kind === 'notice') return t(describeSystem(m, conv, meId));
  if (m.kind === 'undecryptable') return t('Message could not be decrypted');
  const prefix = m.senderId === meId ? t('You: ') : conv.kind === 'group' ? `${displayName(conv.members.find((x) => x.id === m.senderId)).split(' ')[0]}: ` : '';
  const text = summarize(m).replace(/\s+/g, ' ');
  return prefix + (m.kind === 'text' && !m.deleted ? text : t(text));
}

// Only one row can be swiped open at a time.
let closeOpenRow: (() => void) | null = null;
const ACTIONS_WIDTH = 160;

function ChatRow({ conv, meId, onOpen }: { conv: Conv; meId?: string; onOpen: () => void }) {
  const other = otherMember(conv, meId);
  const title = convTitle(conv, meId);
  const last = conv.last;
  const typingNow = useStore((s) => typingLabel(conv, s.typing[conv.id], meId));
  const rowRef = useRef<HTMLButtonElement>(null);
  const offset = useRef(0);
  const suppressClick = useRef(false);

  const setOffset = (x: number, animate = true) => {
    const el = rowRef.current;
    if (!el) return;
    offset.current = x;
    el.classList.toggle('dragging', !animate);
    el.style.transform = x ? `translateX(${x}px)` : '';
  };
  const close = () => {
    setOffset(0);
    if (closeOpenRow === close) closeOpenRow = null;
  };

  const confirmDelete = async () => {
    close();
    if (await confirmAction({ message: 'Messages in this chat will be deleted from this device.', confirm: 'Delete chat', danger: true })) await deleteChat(conv.id);
  };

  const menu = () => {
    actionSheet([
      ...(conv.unread ? [{ label: 'Mark as read', run: () => markRead(conv.id) }] : []),
      { label: 'Delete chat', danger: true, run: confirmDelete },
    ], { title });
  };

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.clientX < 24) return;
    // A new touch starts fresh: a long press before may not have been followed by a click (iOS),
    // which would otherwise swallow this tap.
    suppressClick.current = false;
    if (closeOpenRow && closeOpenRow !== close) {
      closeOpenRow();
      suppressClick.current = true;
    }
    const x0 = e.clientX;
    const y0 = e.clientY;
    const start = offset.current;
    let mode: 'pending' | 'drag' | 'none' = 'pending';
    const timer = window.setTimeout(() => {
      if (mode !== 'pending') return;
      mode = 'none';
      suppressClick.current = true;
      navigator.vibrate?.(8);
      menu();
    }, 500);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (mode === 'pending') {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        clearTimeout(timer);
        mode = Math.abs(dx) > Math.abs(dy) * 1.2 && (dx < 0 || start < 0) ? 'drag' : 'none';
        if (mode === 'none') return finish();
      }
      if (mode !== 'drag') return;
      let x = Math.min(0, start + dx);
      if (x < -ACTIONS_WIDTH) x = -ACTIONS_WIDTH + (x + ACTIONS_WIDTH) * 0.3;
      setOffset(x, false);
    };
    const up = () => {
      clearTimeout(timer);
      if (mode === 'drag') {
        suppressClick.current = true;
        if (offset.current < -ACTIONS_WIDTH / 2.5) {
          setOffset(-ACTIONS_WIDTH);
          closeOpenRow = close;
        } else close();
      }
      finish();
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  return (
    <li>
      <div class="row-actions" aria-hidden={offset.current === 0}>
        <button class="read" onClick={() => { close(); markRead(conv.id); }}><Check size={20} />Read</button>
        <button class="delete" onClick={confirmDelete}><Trash size={20} />Delete</button>
      </div>
      <button
        ref={rowRef}
        class="chat-row"
        onPointerDown={onPointerDown}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (offset.current) return close();
          onOpen();
        }}
        onContextMenu={(e) => { e.preventDefault(); menu(); }}
      >
        <Avatar id={conv.kind === 'group' ? conv.id : other?.id ?? conv.id} name={title} src={chatAvatarUrl(conv, meId)} size={54} group={conv.kind === 'group'} />
        <span class="chat-row-main">
          <span class="chat-row-top">
            <span class="chat-row-title">{title}</span>
            <span class={`chat-row-time${conv.unread ? ' unread' : ''}`}>{last ? formatListTime(last.createdAt) : ''}</span>
          </span>
          <span class="chat-row-bottom">
            <span class={`chat-row-preview${typingNow ? ' typing' : ''}`}>
              {typingNow ? typingNow : <>
              {last?.senderId === meId && last?.status === 'pending' && <Clock size={14} class="inline-icon" />}
              {last?.senderId === meId && last?.status === 'failed' && <Alert size={14} class="inline-icon danger" />}
              {conv.left ? t('You are no longer a member') : preview(last, conv, meId)}
              </>}
            </span>
            {conv.unread > 0 && <span class="unread-badge">{conv.unread > 99 ? '99+' : conv.unread}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}
