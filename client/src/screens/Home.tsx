import { useMemo, useState } from 'preact/hooks';
import { useStore, type Conv, type Msg } from '../lib/store';
import { avatarUrl, convTitle, displayName, otherMember, deleteChat, markRead } from '../lib/engine';
import { formatListTime } from '../lib/format';
import { Avatar, Empty, NavButton, Screen, actionSheet, confirmAction } from '../ui/components';
import { Chats, Compose, Gear, Lock, Search, Clock, Alert } from '../ui/icons';
import { useNav } from '../ui/nav';
import { ChatScreen } from './Chat';
import { NewChatSheet } from './NewChat';
import { SettingsTab } from './Settings';
import { describeSystem } from './system';

export function Home() {
  const [tab, setTab] = useState<'chats' | 'settings'>('chats');
  const unread = useStore((s) => Object.values(s.convs).reduce((n, c) => n + (c.hidden ? 0 : c.unread), 0));

  return (
    <div class="home">
      <div class={`tab-pane${tab === 'chats' ? ' active' : ''}`}><ChatsTab /></div>
      <div class={`tab-pane${tab === 'settings' ? ' active' : ''}`}><SettingsTab /></div>
      <nav class="tabbar" aria-label="Main">
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
  const connected = useStore((s) => s.connected);
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const matches = (c: Conv) =>
      !q || convTitle(c, me?.id).toLowerCase().includes(q) || (digits.length >= 3 && c.members.some((m) => m.id !== me?.id && m.phone.includes(digits)));
    return Object.values(convs)
      .filter((c) => !c.hidden && (c.last || c.kind === 'group' || c.createdBy === me?.id))
      .filter(matches)
      .sort((a, b) => (b.last?.sortKey ?? b.createdAt) - (a.last?.sortKey ?? a.createdAt));
  }, [convs, query, me?.id]);

  const openNew = () => nav.present((close) => <NewChatSheet close={close} />, { variant: 'full' });
  const hasAny = Object.values(convs).some((c) => !c.hidden && (c.last || c.kind === 'group' || c.createdBy === me?.id));

  return (
    <Screen
      title="Chats"
      large
      titleNode={connected ? 'Chats' : <span class="connecting">Connecting…</span>}
      right={<NavButton onClick={openNew} label="New chat"><Compose size={25} /></NavButton>}
    >
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

function preview(m: Msg | null, conv: Conv, meId: string | undefined) {
  if (!m) return conv.kind === 'group' ? 'Group created' : 'Say hello';
  if (m.kind === 'system') return describeSystem(m, conv, meId);
  if (m.kind === 'undecryptable') return 'Message could not be decrypted';
  const prefix = m.senderId === meId ? 'You: ' : conv.kind === 'group' ? `${displayName(conv.members.find((x) => x.id === m.senderId)).split(' ')[0]}: ` : '';
  return prefix + (m.text ?? '').replace(/\s+/g, ' ');
}

function ChatRow({ conv, meId, onOpen }: { conv: Conv; meId?: string; onOpen: () => void }) {
  const other = otherMember(conv, meId);
  const title = convTitle(conv, meId);
  const last = conv.last;
  let pressTimer: number | undefined;
  let longPressed = false;

  const menu = () => {
    actionSheet([
      ...(conv.unread ? [{ label: 'Mark as read', run: () => markRead(conv.id) }] : []),
      {
        label: 'Delete chat',
        danger: true,
        run: async () => {
          if (await confirmAction({ message: 'Messages in this chat will be deleted from this device.', confirm: 'Delete chat', danger: true })) await deleteChat(conv.id);
        },
      },
    ], { title });
  };

  return (
    <li>
      <button
        class="chat-row"
        onClick={() => { if (!longPressed) onOpen(); longPressed = false; }}
        onContextMenu={(e) => { e.preventDefault(); menu(); }}
        onPointerDown={() => { longPressed = false; pressTimer = window.setTimeout(() => { longPressed = true; navigator.vibrate?.(8); menu(); }, 500); }}
        onPointerUp={() => clearTimeout(pressTimer)}
        onPointerLeave={() => clearTimeout(pressTimer)}
        onPointerCancel={() => clearTimeout(pressTimer)}
      >
        <Avatar id={conv.kind === 'group' ? conv.id : other?.id ?? conv.id} name={title} src={other ? avatarUrl(other) : null} size={54} group={conv.kind === 'group'} />
        <span class="chat-row-main">
          <span class="chat-row-top">
            <span class="chat-row-title">{title}</span>
            <span class={`chat-row-time${conv.unread ? ' unread' : ''}`}>{last ? formatListTime(last.createdAt) : ''}</span>
          </span>
          <span class="chat-row-bottom">
            <span class="chat-row-preview">
              {last?.senderId === meId && last?.status === 'pending' && <Clock size={14} class="inline-icon" />}
              {last?.senderId === meId && last?.status === 'failed' && <Alert size={14} class="inline-icon danger" />}
              {conv.left ? 'You are no longer a member' : preview(last, conv, meId)}
            </span>
            {conv.unread > 0 && <span class="unread-badge">{conv.unread > 99 ? '99+' : conv.unread}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}
