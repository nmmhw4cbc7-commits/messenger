import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { useStore, type Conv, type Msg, type ReplyRef } from '../lib/store';
import {
  avatarUrl, convTitle, displayName, loadMessages, otherMember, sendText, setOpenConv, retry, deleteMessage, acceptKeyChange,
  react, isReadByAll,
} from '../lib/engine';
import { formatDay, formatTime, sameDay } from '../lib/format';
import { Avatar, toast } from '../ui/components';
import { goBack, useNav } from '../ui/nav';
import { ArrowUp, ChevronLeft, Clock, Alert, Check, CheckDouble, Lock, Reply, Close, Copy, Trash } from '../ui/icons';
import { describeSystem } from './system';
import { ContactInfo, GroupInfo, SafetyNumberScreen } from './Info';

const GROUP_GAP = 3 * 60_000;
const coarse = matchMedia('(pointer: coarse)').matches;
const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];
const haptic = (ms = 8) => navigator.vibrate?.(ms);

interface MenuState {
  msg: Msg;
  rect: DOMRect;
  mine: boolean;
}

export function ChatScreen({ convId }: { convId: string }) {
  const nav = useNav();
  const conv = useStore((s) => s.convs[convId]);
  const messages = useStore((s) => s.messages[convId]);
  const me = useStore((s) => s.me);
  const pins = useStore((s) => s.pins);
  useStore((s) => s.aliases); // re-render when contact names change
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

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

  const startReply = (msg: Msg) => {
    if (msg.kind !== 'text' || blockedReason) return;
    setReplyTo({ id: msg.id, senderId: msg.senderId ?? '', text: (msg.text ?? '').slice(0, 200) });
    haptic(10);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus());
  };

  const nameOf = (id: string) => (id === me.id ? 'You' : displayName(conv.members.find((m) => m.id === id)));

  return (
    <div class="screen chat-screen">
      <header class="navbar chat-navbar scrolled">
        <div class="navbar-row">
          <button class="nav-back" onClick={() => goBack()} aria-label="Back"><ChevronLeft size={26} /></button>
          <button class="chat-header" onClick={openInfo} aria-label={`${title}, show info`}>
            <Avatar id={conv.kind === 'group' ? conv.id : other?.id ?? conv.id} name={title} src={other ? avatarUrl(other) : null} size={38} group={conv.kind === 'group'} />
            <span class="chat-header-text">
              <span class="chat-header-title">{title}</span>
              <span class="chat-header-sub">{subtitle}</span>
            </span>
          </button>
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

      <MessageList
        conv={conv}
        messages={messages ?? []}
        meId={me.id}
        onNotice={(userId) => nav.push(<SafetyNumberScreen userId={userId} />)}
        onReply={startReply}
        onMenu={setMenu}
        nameOf={nameOf}
      />

      {blockedReason ? (
        <div class="composer composer-disabled"><p>{blockedReason}</p></div>
      ) : (
        <Composer convId={conv.id} paused={changed.length > 0} replyTo={replyTo} replyName={replyTo ? nameOf(replyTo.senderId) : ''} onCancelReply={() => setReplyTo(null)} />
      )}

      {menu && (
        <ContextMenu
          state={menu}
          meId={me.id}
          canReply={!blockedReason}
          onClose={() => setMenu(null)}
          onReply={() => startReply(menu.msg)}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ messages

function MessageList({ conv, messages, meId, onNotice, onReply, onMenu, nameOf }: {
  conv: Conv;
  messages: Msg[];
  meId: string;
  onNotice: (userId: string) => void;
  onReply: (msg: Msg) => void;
  onMenu: (m: MenuState) => void;
  nameOf: (id: string) => string;
}) {
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
      out.push(
        <Bubble key={m.id} msg={m} conv={conv} meId={meId} first={!joinsPrev} last={!joinsNext} onReply={onReply} onMenu={onMenu} nameOf={nameOf} />,
      );
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

function scrollToMessage(id: string) {
  const el = document.querySelector<HTMLElement>(`.stack-item.top [data-msg="${CSS.escape(id)}"]`);
  if (!el) {
    toast('That message is no longer on this device.');
    return;
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

function Ticks({ msg, conv, meId }: { msg: Msg; conv: Conv; meId: string }) {
  if (msg.status === 'pending') return <Clock size={12} stroke={2} />;
  if (msg.status === 'failed') return <Alert size={13} stroke={2.2} class="danger" />;
  if (isReadByAll(msg, conv, meId)) return <CheckDouble size={15} stroke={2.2} class="read" />;
  return <Check size={14} stroke={2.2} />;
}

function Bubble({ msg, conv, meId, first, last, onReply, onMenu, nameOf }: {
  msg: Msg;
  conv: Conv;
  meId: string;
  first: boolean;
  last: boolean;
  onReply: (msg: Msg) => void;
  onMenu: (m: MenuState) => void;
  nameOf: (id: string) => string;
}) {
  const mine = msg.senderId === meId;
  const sender = conv.kind === 'group' && !mine ? conv.members.find((m) => m.id === msg.senderId) : null;
  const showSender = conv.kind === 'group' && !mine && first;
  const showAvatar = conv.kind === 'group' && !mine;
  const senderName = sender ? displayName(sender) : 'Former member';
  const rowRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const reactions = Object.entries(msg.reactions ?? {});

  // One pointer handler for long press (menu) and horizontal swipe (reply).
  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.clientX < 30) return;
    const row = rowRef.current;
    if (!row) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let mode: 'pending' | 'swipe' | 'none' = 'pending';
    let dx = 0;
    let armed = false;
    const timer = window.setTimeout(() => {
      if (mode !== 'pending') return;
      mode = 'none';
      cleanup();
      openMenu();
    }, 420);

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const mx = ev.clientX - x0;
      const my = ev.clientY - y0;
      if (mode === 'pending') {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        clearTimeout(timer);
        if (mx > 0 && Math.abs(mx) > Math.abs(my) * 1.2 && msg.kind === 'text') {
          mode = 'swipe';
          row.classList.add('swiping');
        } else {
          mode = 'none';
          cleanup();
          return;
        }
      }
      if (mode !== 'swipe') return;
      dx = Math.max(0, mx);
      const pull = dx < 64 ? dx : 64 + (dx - 64) * 0.25;
      row.style.transform = `translateX(${pull}px)`;
      row.style.setProperty('--reply-progress', String(Math.min(1, dx / 64)));
      if (dx >= 64 && !armed) {
        armed = true;
        haptic(10);
      } else if (dx < 64) armed = false;
    };
    const up = () => {
      clearTimeout(timer);
      if (mode === 'swipe') {
        row.classList.remove('swiping');
        row.style.transform = '';
        row.style.removeProperty('--reply-progress');
        if (dx >= 64) onReply(msg);
      }
      cleanup();
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const openMenu = () => {
    const el = bubbleRef.current;
    if (!el) return;
    haptic(12);
    // Measure relative to the screen the menu is drawn in (it follows the visual viewport).
    const r = el.getBoundingClientRect();
    const host = el.closest('.stack-item')?.getBoundingClientRect();
    const rect = new DOMRect(r.left - (host?.left ?? 0), r.top - (host?.top ?? 0), r.width, r.height);
    onMenu({ msg, rect, mine });
  };

  const cls = ['bubble-row', mine ? 'out' : 'in', first ? 'first' : '', last ? 'last' : '', showAvatar ? 'with-avatar' : '', reactions.length ? 'has-reactions' : ''].filter(Boolean).join(' ');

  return (
    <div class="bubble-block" data-msg={msg.id}>
      <div class={cls} ref={rowRef} onPointerDown={onPointerDown} onContextMenu={(e) => { e.preventDefault(); openMenu(); }}>
        <span class="reply-hint" aria-hidden="true"><Reply size={18} /></span>
        {showAvatar && (
          <span class="bubble-avatar">{last && <Avatar id={msg.senderId ?? ''} name={senderName} src={avatarUrl(sender)} size={28} />}</span>
        )}
        <div class="bubble-col">
          <div
            ref={bubbleRef}
            class={`bubble${msg.kind === 'undecryptable' ? ' undecryptable' : ''}${msg.status === 'failed' ? ' failed' : ''}`}
            onClick={() => msg.status === 'failed' && openMenu()}
          >
            {showSender && <span class="bubble-sender">{senderName}</span>}
            {msg.reply && (
              <button class="quote" onClick={(e) => { e.stopPropagation(); scrollToMessage(msg.reply!.id); }}>
                <span class="quote-name">{nameOf(msg.reply.senderId)}</span>
                <span class="quote-text">{msg.reply.text}</span>
              </button>
            )}
            {msg.kind === 'undecryptable' ? (
              <span class="bubble-text"><Lock size={14} class="inline-icon" /> This message could not be decrypted on this device.</span>
            ) : (
              <span class="bubble-text">{linkify(msg.text ?? '')}</span>
            )}
            {/* Floated after the text: sits on the last line when there is room, otherwise on its own line. Never overlaps. */}
            <span class="bubble-meta">
              {formatTime(msg.createdAt)}
              {mine && <Ticks msg={msg} conv={conv} meId={meId} />}
            </span>
          </div>
          {reactions.length > 0 && (
            <button class="reactions" onClick={openMenu} aria-label="Reactions">
              {[...new Set(reactions.map(([, e]) => e))].slice(0, 4).map((e) => <span key={e}>{e}</span>)}
              {reactions.length > 1 && <span class="reactions-count">{reactions.length}</span>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ long-press menu

function ContextMenu({ state, meId, canReply, onClose, onReply }: {
  state: MenuState;
  meId: string;
  canReply: boolean;
  onClose: () => void;
  onReply: () => void;
}) {
  const { msg, rect, mine } = state;
  const [closing, setClosing] = useState(false);
  const mineReaction = msg.reactions?.[meId];

  const close = (after?: () => void) => {
    setClosing(true);
    setTimeout(() => {
      onClose();
      after?.();
    }, 160);
  };

  // Keep the bubble where it was, but make room for the reaction bar and actions.
  const vh = document.getElementById('app')?.clientHeight ?? window.innerHeight;
  const hasBar = msg.kind === 'text' && msg.status !== 'pending' && msg.status !== 'failed';
  const barHeight = hasBar ? 58 : 0;
  const actionCount = (msg.kind === 'text' && canReply ? 1 : 0) + (msg.kind === 'text' ? 1 : 0) + (msg.status === 'failed' ? 1 : 0) + 1;
  const actionsHeight = 34 + 48 * actionCount + 8;
  const bubbleH = Math.min(rect.height, vh * 0.3);
  const safeTop = 56;
  const safeBottom = 40; // includes the gaps between bar, bubble and actions
  // The bubble stays where it was when possible; the whole stack is shifted to fit on screen.
  const top = Math.max(safeTop, Math.min(rect.top - barHeight, vh - safeBottom - barHeight - bubbleH - actionsHeight));
  const side = mine ? { right: `${Math.max(10, window.innerWidth - rect.right)}px` } : { left: `${Math.max(10, rect.left)}px` };

  const actions: { label: string; icon: JSX.Element; danger?: boolean; run: () => void }[] = [];
  if (msg.kind === 'text' && canReply) actions.push({ label: 'Reply', icon: <Reply size={19} />, run: onReply });
  if (msg.kind === 'text') {
    actions.push({
      label: 'Copy',
      icon: <Copy size={19} />,
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
  if (msg.status === 'failed') actions.push({ label: 'Try again', icon: <ArrowUp size={19} />, run: () => retry(msg) });
  actions.push({ label: 'Delete for me', icon: <Trash size={19} />, danger: true, run: () => deleteMessage(msg) });

  return (
    <div class={`context-layer${closing ? ' closing' : ''}`} onClick={() => close()}>
      <div class="context-stack" style={{ top: `${top}px`, ...side }} onClick={(e) => e.stopPropagation()}>
        {msg.kind === 'text' && msg.status !== 'pending' && msg.status !== 'failed' && (
          <div class={`reaction-bar ${mine ? 'out' : 'in'}`}>
            {REACTIONS.map((emoji) => (
              <button
                key={emoji}
                class={mineReaction === emoji ? 'active' : ''}
                aria-label={`React with ${emoji}`}
                onClick={() => close(() => react(msg, emoji).catch((err) => toast(err instanceof Error ? err.message : 'Could not react', 'error')))}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
        <div class={`context-bubble ${mine ? 'out' : 'in'}`} style={{ maxHeight: `${bubbleH}px` }}>
          {msg.kind === 'undecryptable' ? 'This message could not be decrypted on this device.' : msg.text}
        </div>
        <div class={`context-actions ${mine ? 'out' : 'in'}`}>
          <div class="context-time">{new Date(msg.createdAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</div>
          {actions.map((a) => (
            <button key={a.label} class={a.danger ? 'danger' : ''} onClick={() => close(a.run)}>
              <span>{a.label}</span>
              {a.icon}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ composer

function Composer({ convId, paused, replyTo, replyName, onCancelReply }: {
  convId: string;
  paused: boolean;
  replyTo: ReplyRef | null;
  replyName: string;
  onCancelReply: () => void;
}) {
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
    sendText(convId, text, replyTo ?? undefined);
    update('');
    onCancelReply();
    haptic(6);
  };

  const canSend = text.trim().length > 0 && !paused;

  return (
    <div class="composer-wrap">
      {replyTo && (
        <div class="reply-bar">
          <span class="reply-bar-icon"><Reply size={16} /></span>
          <span class="reply-bar-text">
            <span class="quote-name">{replyName}</span>
            <span class="quote-text">{replyTo.text}</span>
          </span>
          <button class="reply-bar-close" onPointerDown={(e) => e.preventDefault()} onClick={onCancelReply} aria-label="Cancel reply"><Close size={18} /></button>
        </div>
      )}
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
              if (e.key === 'Escape' && replyTo) onCancelReply();
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
    </div>
  );
}
