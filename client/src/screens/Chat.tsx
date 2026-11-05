import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { useStore, type Conv, type Msg } from '../lib/store';
import { avatarUrl, convTitle, displayName, loadMessages, otherMember, sendText, setOpenConv, retry, deleteMessage, acceptKeyChange } from '../lib/engine';
import { formatDay, formatTime, sameDay } from '../lib/format';
import { Avatar, actionSheet, toast } from '../ui/components';
import { goBack, useNav } from '../ui/nav';
import { ArrowUp, ChevronLeft, Clock, Alert, Check, Lock } from '../ui/icons';
import { describeSystem } from './system';
import { ContactInfo, GroupInfo, SafetyNumberScreen } from './Info';

const GROUP_GAP = 3 * 60_000;
const coarse = matchMedia('(pointer: coarse)').matches;

export function ChatScreen({ convId }: { convId: string }) {
  const nav = useNav();
  const conv = useStore((s) => s.convs[convId]);
  const messages = useStore((s) => s.messages[convId]);
  const me = useStore((s) => s.me);
  const pins = useStore((s) => s.pins);

  useEffect(() => {
    loadMessages(convId);
    setOpenConv(convId);
    return () => setOpenConv(null);
  }, [convId]);

  if (!conv || !me) {
    return (
      <div class="screen">
        <header class="navbar"><div class="navbar-row"><div class="navbar-side left"><button class="nav-back" onClick={() => goBack()} aria-label="Back"><ChevronLeft size={26} /></button></div></div></header>
      </div>
    );
  }

  const other = otherMember(conv, me.id);
  const title = convTitle(conv, me.id);
  const openInfo = () => nav.push(conv.kind === 'group' ? <GroupInfo convId={conv.id} /> : <ContactInfo convId={conv.id} />);
  const changed = conv.members.filter((m) => m.id !== me.id && pins[m.id]?.needsAck);
  const subtitle = conv.kind === 'group'
    ? conv.members.map((m) => (m.id === me.id ? 'You' : displayName(m).split(' ')[0])).join(', ')
    : 'End-to-end encrypted';

  let blockedReason = '';
  if (conv.left) blockedReason = conv.kind === 'group' ? 'You are no longer a member of this group.' : 'This chat is no longer available.';
  else if (conv.kind === 'direct' && !other) blockedReason = 'This account has been deleted.';

  return (
    <div class="screen chat-screen">
      <header class="navbar chat-navbar scrolled">
        <div class="navbar-row">
          <div class="navbar-side left">
            <button class="nav-back" onClick={() => goBack()} aria-label="Back"><ChevronLeft size={26} /></button>
          </div>
          <button class="chat-header" onClick={openInfo} aria-label={`${title}, show info`}>
            <Avatar id={conv.kind === 'group' ? conv.id : other?.id ?? conv.id} name={title} src={other ? avatarUrl(other) : null} size={36} group={conv.kind === 'group'} />
            <span class="chat-header-text">
              <span class="chat-header-title">{title}</span>
              <span class="chat-header-sub">{subtitle}</span>
            </span>
          </button>
          <div class="navbar-side right" />
        </div>
      </header>

      {changed.length > 0 && (
        <div class="banner warn" role="alert">
          <p>
            The safety number with <strong>{changed.map((m) => displayName(m)).join(', ')}</strong> changed. You verified{' '}
            {changed.length === 1 ? 'this person' : 'these people'} before, so sending is paused.
          </p>
          <div class="banner-actions">
            <button onClick={() => nav.push(<SafetyNumberScreen userId={changed[0].id} />)}>Review</button>
            <button onClick={() => changed.forEach((m) => acceptKeyChange(m.id))}>Accept</button>
          </div>
        </div>
      )}

      <MessageList conv={conv} messages={messages ?? []} meId={me.id} onNotice={(userId) => nav.push(<SafetyNumberScreen userId={userId} />)} />

      {blockedReason ? (
        <div class="composer composer-disabled"><p>{blockedReason}</p></div>
      ) : (
        <Composer convId={conv.id} paused={changed.length > 0} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ messages

function MessageList({ conv, messages, meId, onNotice }: { conv: Conv; messages: Msg[]; meId: string; onNotice: (userId: string) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  // Jump to the newest message when we send one ourselves.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const last = messages[messages.length - 1];
    if (el && messages.length > lastCount.current && last?.senderId === meId) el.scrollTop = 0;
    lastCount.current = messages.length;
  }, [messages.length]);

  const rows = useMemo(() => {
    const out: JSX.Element[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const prev = messages[i - 1];
      const next = messages[i + 1];
      if (!prev || !sameDay(prev.createdAt, m.createdAt)) {
        out.push(<div key={`day-${m.id}`} class="day-separator"><span>{formatDay(m.createdAt)}</span></div>);
      }
      if (m.kind === 'system' || m.kind === 'notice') {
        out.push(
          <div key={m.id} class={`system-line${m.kind === 'notice' ? ' notice' : ''}`}>
            {m.kind === 'notice' && m.notice ? (
              <button onClick={() => onNotice(m.notice!.userId)}><Lock size={13} /> {describeSystem(m, conv, meId)}</button>
            ) : (
              <span>{describeSystem(m, conv, meId)}</span>
            )}
          </div>,
        );
        continue;
      }
      const bubbleLike = (x?: Msg) => x && (x.kind === 'text' || x.kind === 'undecryptable');
      const joinsPrev = bubbleLike(prev) && prev!.senderId === m.senderId && m.createdAt - prev!.createdAt < GROUP_GAP && sameDay(prev!.createdAt, m.createdAt);
      const joinsNext = bubbleLike(next) && next!.senderId === m.senderId && next!.createdAt - m.createdAt < GROUP_GAP && sameDay(next!.createdAt, m.createdAt);
      out.push(<Bubble key={m.id} msg={m} conv={conv} mine={m.senderId === meId} first={!joinsPrev} last={!joinsNext} />);
    }
    return out;
  }, [messages, conv, meId]);

  return (
    <div class="messages" ref={scrollRef}>
      <div class="messages-inner">
        <div class="e2e-note">
          <Lock size={14} />
          <span>Messages are end-to-end encrypted. Only the people in this chat can read them, not even Haven.</span>
        </div>
        {rows}
      </div>
    </div>
  );
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/gi;

function linkify(text: string) {
  const parts: (string | JSX.Element)[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    parts.push(<a key={start} href={match[0]} target="_blank" rel="noopener noreferrer nofollow">{match[0]}</a>);
    last = start + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function Bubble({ msg, conv, mine, first, last }: { msg: Msg; conv: Conv; mine: boolean; first: boolean; last: boolean }) {
  const sender = conv.kind === 'group' && !mine ? conv.members.find((m) => m.id === msg.senderId) : null;
  const showSender = conv.kind === 'group' && !mine && first;
  const showAvatar = conv.kind === 'group' && !mine;
  let pressTimer: number | undefined;

  const menu = () => {
    const actions = [];
    if (msg.kind === 'text') {
      actions.push({
        label: 'Copy',
        run: async () => {
          try {
            await navigator.clipboard.writeText(msg.text ?? '');
            toast('Copied');
          } catch {
            toast('Could not copy', 'error');
          }
        },
      });
    }
    if (msg.status === 'failed') actions.push({ label: 'Try again', run: () => retry(msg) });
    actions.push({ label: 'Delete for me', danger: true, run: () => deleteMessage(msg) });
    navigator.vibrate?.(8);
    actionSheet(actions);
  };

  const cls = ['bubble-row', mine ? 'out' : 'in', first ? 'first' : '', last ? 'last' : '', showAvatar ? 'with-avatar' : ''].filter(Boolean).join(' ');
  const senderName = sender ? displayName(sender) : 'Former member';

  return (
    <div class={cls}>
      {showAvatar && (
        <span class="bubble-avatar">{last && <Avatar id={msg.senderId ?? ''} name={senderName} src={avatarUrl(sender)} size={28} />}</span>
      )}
      <div
        class={`bubble${msg.kind === 'undecryptable' ? ' undecryptable' : ''}${msg.status === 'failed' ? ' failed' : ''}`}
        onContextMenu={(e) => { e.preventDefault(); menu(); }}
        onPointerDown={(e) => { if (e.pointerType !== 'mouse') pressTimer = window.setTimeout(menu, 480); }}
        onPointerUp={() => clearTimeout(pressTimer)}
        onPointerMove={() => clearTimeout(pressTimer)}
        onPointerCancel={() => clearTimeout(pressTimer)}
        onClick={() => msg.status === 'failed' && menu()}
      >
        {showSender && <span class="bubble-sender" data-hue={hueIndex(msg.senderId ?? '')}>{senderName}</span>}
        {msg.kind === 'undecryptable' ? (
          <span class="bubble-text"><Lock size={14} class="inline-icon" /> This message could not be decrypted on this device.</span>
        ) : (
          <span class="bubble-text">{linkify(msg.text ?? '')}</span>
        )}
        <span class="bubble-meta">
          {formatTime(msg.createdAt)}
          {mine && msg.status === 'pending' && <Clock size={12} stroke={2} />}
          {mine && msg.status === 'sent' && <Check size={13} stroke={2.4} />}
          {mine && msg.status === 'failed' && <Alert size={13} stroke={2.2} />}
        </span>
      </div>
    </div>
  );
}

function hueIndex(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 8;
}

// ------------------------------------------------------------------ composer

function Composer({ convId, paused }: { convId: string; paused: boolean }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const draftKey = `draft:${convId}`;

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(draftKey);
      if (saved) setText(saved);
    } catch { /* storage unavailable */ }
  }, [convId]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);

  const update = (value: string) => {
    setText(value);
    try {
      if (value) sessionStorage.setItem(draftKey, value);
      else sessionStorage.removeItem(draftKey);
    } catch { /* storage unavailable */ }
  };

  const send = () => {
    if (!text.trim() || paused) return;
    sendText(convId, text);
    update('');
    navigator.vibrate?.(6);
  };

  const canSend = text.trim().length > 0 && !paused;

  return (
    <div class="composer">
      <div class="composer-field">
        <textarea
          ref={ref}
          rows={1}
          placeholder={paused ? 'Sending is paused' : 'Message'}
          aria-label="Message"
          value={text}
          maxLength={4000}
          disabled={paused}
          enterkeyhint={coarse ? 'enter' : 'send'}
          onInput={(e) => update((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
      </div>
      <button
        class={`send-button${canSend ? ' ready' : ''}`}
        aria-label="Send"
        disabled={!canSend}
        // Keep the keyboard open after sending.
        onPointerDown={(e) => e.preventDefault()}
        onClick={send}
      >
        <ArrowUp size={20} />
      </button>
    </div>
  );
}
