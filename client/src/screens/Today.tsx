// Vlog your Day: every day one person from your friend group is picked to
// vlog their day (3 videos, 6 minutes in total, or 6 photos). The posts are
// end-to-end encrypted media in the group's chat, so the messenger stays the
// place to talk about them.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { pickEmoji } from '../ui/EmojiPicker';
import { getState, useStore, type Activity, type Conv, type Member, type Msg } from '../lib/store';
import {
  addMembers, avatarUrl, createCircle, createCircleInvite, deleteForEveryone, displayName, formatDuration, joinCircle, loadMessages, markActivitySeen,
  react, refreshCircle, sendMedia, vlogPosts, vlogUsage, VLOG_LIMITS,
} from '../lib/engine';
import { formatListTime } from '../lib/format';
import { compressVideo, MAX_FILE, preparePhoto, prepareVideo } from '../lib/media';
import { errorMessage } from '../lib/api';
import { Avatar, Button, Screen, Spinner, actionSheet, confirmAction, toast, useAsync } from '../ui/components';
import { getNav, useNav } from '../ui/nav';
import { Bell, Camera, ChevronRight, PersonAdd, Chats as ChatIcon, Close, Share, Copy } from '../ui/icons';
import { PeoplePicker } from './NewChat';
import { ChatScreen } from './Chat';
import { openViewer, pickFile, useMediaUrl } from './Attachments';
import { markWhatsNewSeen, openGuide } from './Guide';
import { clearJoin, codeFrom, inviteUrl, pendingJoin, previewInvite, type InvitePreview } from '../lib/invite';

export const VlogIcon = ({ size = 26 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2.5" y="6" width="13" height="12" rx="2.5" /><path d="m15.5 10.5 5-3v9l-5-3" /><circle cx="9" cy="12" r="2.2" />
  </svg>
);

const SETUP_FLAG = 'haven-circle-intro';
/** Remember to offer the friend group setup right after creating a profile. */
export const offerCircleSetup = () => {
  try { localStorage.setItem(SETUP_FLAG, '1'); localStorage.setItem(GUIDE_FLAG, '1'); } catch { /* private mode */ }
  markWhatsNewSeen(); // brand-new users get the guide instead
};
const GUIDE_FLAG = 'haven.guidePending';

const dayLabel = (day: string, today: string) => {
  if (day === today) return 'Today';
  const d = new Date(`${day}T12:00:00`);
  const y = new Date(`${today}T12:00:00`);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
};
const timeOf = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const firstName = (p: Member | undefined) => displayName(p).split(' ')[0];

export function TodayTab() {
  const nav = useNav();
  const circle = useStore((s) => s.circle);
  const me = useStore((s) => s.me);
  const conv = useStore((s) => (s.circle?.id ? s.convs[s.circle.id] : undefined));
  const messages = useStore((s) => (s.circle?.id ? s.messages[s.circle.id] : undefined));
  useStore((s) => s.aliases);

  useEffect(() => { refreshCircle().catch(() => {}); }, []);
  useEffect(() => { if (circle?.id) loadMessages(circle.id); }, [circle?.id]);

  // Opened an invite link: join that friend group. Right after sign-up otherwise: offer the setup once.
  useEffect(() => {
    if (!circle) return;
    let flagged = false;
    let guide = false;
    try {
      flagged = localStorage.getItem(SETUP_FLAG) === '1';
      guide = localStorage.getItem(GUIDE_FLAG) === '1';
      localStorage.removeItem(SETUP_FLAG);
      localStorage.removeItem(GUIDE_FLAG);
    } catch { /* ignore */ }
    const next = () => {
      const code = pendingJoin();
      if (code.length === 12) {
        clearJoin();
        openJoinConfirm(code);
        return;
      }
      if (flagged && !circle.id) openCircleSetup();
    };
    // Brand-new users: a short guide first, then joining or setting up the group.
    if (guide) {
      markWhatsNewSeen();
      openGuide(next);
    } else {
      next();
    }
  }, [circle?.id, circle === null]);

  if (!circle) {
    return <Screen title="Vlog your Day" large><div class="center pad"><Spinner /></div></Screen>;
  }
  if (!circle.id || !conv) {
    return (
      <Screen title="Vlog your Day" large>
        <TopLine today={circle.today} />
        <div class="vlog-intro">
          <span class="vlog-intro-icon"><VlogIcon size={34} /></span>
          <h2>Your friends’ day, every day</h2>
          <p>Pick the friends in your group. Every day one of you is chosen at random to vlog their day: <strong>3 videos (6 minutes)</strong> or <strong>6 photos</strong>. Everyone else follows along.</p>
          <ol class="vlog-steps">
            <li><span>01</span>Choose your friend group</li>
            <li><span>02</span>Get a push when it’s your turn</li>
            <li><span>03</span>Share your day, end-to-end encrypted</li>
          </ol>
          <Button onClick={openCircleSetup}>Choose friends</Button>
          <Button variant="plain" onClick={() => openJoinSheet()}>I already have a friend group</Button>
        </div>
      </Screen>
    );
  }

  const today = circle.today;
  const pick = circle.picks.find((p) => p.day === today);
  const picked = pick ? conv.members.find((m) => m.id === pick.userId) : undefined;
  const mine = pick?.userId === me?.id;
  const posts = vlogPosts(messages, today, pick?.userId);
  const earlier = circle.picks.filter((p) => p.day !== today);

  return (
    <Screen title="Vlog your Day" large>
      <TopLine today={today} />

      {!pick ? (
        <div class="vlog-card">
          <p class="vlog-card-label">Waiting for friends</p>
          <h2 class="vlog-card-title">Invite at least one friend</h2>
          <p class="vlog-card-text">As soon as your group has two people, someone gets picked every day.</p>
          <Button onClick={() => inviteToCircle(conv)}><PersonAdd size={20} /> Invite friends</Button>
        </div>
      ) : mine ? (
        <MyTurn conv={conv} today={today} posts={posts} />
      ) : (
        <div class="vlog-card">
          <div class="vlog-card-person">
            <Avatar id={picked?.id ?? pick.userId} name={displayName(picked)} src={picked ? avatarUrl(picked) : null} size={56} />
            <div>
              <p class="vlog-card-label">Today it’s</p>
              <h2 class="vlog-card-title">{displayName(picked) || 'A friend'}</h2>
            </div>
          </div>
          <p class="vlog-card-text">{posts.length ? `${posts.length} ${posts.length === 1 ? 'post' : 'posts'} so far. Follow their day below.` : `${firstName(picked) || 'They'} hasn’t posted yet. You’ll see it here as soon as they do.`}</p>
        </div>
      )}

      {posts.length > 0 && <Timeline posts={posts} />}

      <div class="vlog-section-head">
        <h3>Friend group</h3>
        <button class="link-button" onClick={() => inviteToCircle(conv)}>Invite</button>
      </div>
      <div class="vlog-friends">
        {conv.members.map((m) => (
          <div key={m.id} class="vlog-friend">
            <Avatar id={m.id} name={displayName(m)} src={avatarUrl(m)} size={48} />
            <span class={m.id === me?.id ? '' : 'friend-name'}>{m.id === me?.id ? 'You' : firstName(m)}</span>
          </div>
        ))}
        <button class="vlog-friend add" onClick={() => inviteToCircle(conv)} aria-label="Invite friends">
          <span class="vlog-friend-add"><PersonAdd size={20} /></span>
          <span>Invite</span>
        </button>
      </div>
      <div class="pad-x">
        <Button variant="secondary" onClick={() => nav.push(<ChatScreen convId={conv.id} />)}><ChatIcon size={20} /> Group chat</Button>
      </div>

      {earlier.length > 0 && (
        <>
          <div class="vlog-section-head"><h3>Earlier</h3></div>
          <ul class="vlog-days">
            {earlier.map((p) => {
              const who = conv.members.find((m) => m.id === p.userId);
              const n = vlogPosts(messages, p.day, p.userId).length;
              return (
                <li key={p.day}>
                  <button class="vlog-day-row" onClick={() => nav.push(<DayScreen convId={conv.id} day={p.day} userId={p.userId} />)}>
                    <Avatar id={p.userId} name={displayName(who)} src={who ? avatarUrl(who) : null} size={40} />
                    <span class="vlog-day-text">
                      <strong>{dayLabel(p.day, today)}</strong>
                      <span>{p.userId === me?.id ? 'You' : displayName(who) || 'Former member'} · {n ? `${n} ${n === 1 ? 'post' : 'posts'}` : 'no posts'}</span>
                    </span>
                    <ChevronRight size={18} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p class="fine-print vlog-fine">Vlogs are end-to-end encrypted. The server deletes them after a week; your devices keep them.</p>
    </Screen>
  );
}

// ------------------------------------------------------------------ my turn

function MyTurn({ conv, today, posts }: { conv: Conv; today: string; posts: Msg[] }) {
  const usage = vlogUsage(posts);
  const pending = posts.some((p) => p.status === 'pending');
  const leftSeconds = VLOG_LIMITS.seconds - usage.seconds;
  // One budget for the day: 6 photos, or 3 videos (6 minutes), or a mix. A video counts as 2 photos.
  const used = usage.videos * 2 + usage.photos;
  const left = VLOG_LIMITS.photos - used;
  const canVideo = usage.videos < VLOG_LIMITS.videos && leftSeconds > 0 && left >= 2;
  const canPhoto = left >= 1;
  const done = !canVideo && !canPhoto;
  const videoWhyNot = canVideo ? '' : leftSeconds <= 0 ? '6 min used' : 'No room for a video';

  const addVideo = async (capture: boolean) => {
    const file = await pickFile('video/*', capture);
    if (!file) return;
    try {
      if (!file.type.startsWith('video/')) throw new Error('Please choose a video.');
      const v = await prepareVideo(file, Infinity);
      if (!v.duration) throw new Error('The length of this video could not be read.');
      if (v.duration > leftSeconds + 1) throw new Error(`This video is ${formatDuration(v.duration)} long. You have ${formatDuration(leftSeconds)} left today.`);
      openPostSheet({ conv, today, kind: 'video', file, ...v });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const addPhoto = async (capture: boolean) => {
    const file = await pickFile('image/*', capture);
    if (!file) return;
    try {
      if (!file.type.startsWith('image/')) throw new Error('Please choose a photo.');
      const p = await preparePhoto(file);
      openPostSheet({ conv, today, kind: 'image', file: p.blob, blob: p.blob, w: p.w, h: p.h, duration: 0, thumb: p.thumb });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div class="vlog-card mine">
      <p class="vlog-card-label">Today it’s you</p>
      <h2 class="vlog-card-title">{done ? 'Your day is vlogged' : 'Vlog your day'}</h2>
      <p class="vlog-card-text">
        {done ? 'Thanks for sharing. Your friends can follow your day now.'
          : used ? [
            usage.videos ? `${usage.videos} ${usage.videos === 1 ? 'video' : 'videos'} (${formatDuration(usage.seconds)})` : '',
            usage.photos ? `${usage.photos} ${usage.photos === 1 ? 'photo' : 'photos'}` : '',
          ].filter(Boolean).join(' · ') + ` · room for ${left} more ${left === 1 ? 'photo' : 'photos'}${canVideo ? ` or ${Math.floor(left / 2)} ${Math.floor(left / 2) === 1 ? 'video' : 'videos'}` : ''}`
          : 'Share up to 3 videos (6 minutes in total) or 6 photos, or mix them.'}
      </p>
      {used > 0 && (
        <div class="vlog-meter" aria-hidden="true">
          {Array.from({ length: VLOG_LIMITS.photos }, (_, i) => <span key={i} class={i < used ? 'on' : ''} />)}
        </div>
      )}
      {!done && (
        <div class="vlog-actions">
          <button class="vlog-action" disabled={pending || !canVideo} onClick={() => addVideo(true)}><VlogIcon size={22} />Take video{videoWhyNot && <em>{videoWhyNot}</em>}</button>
          <button class="vlog-action" disabled={pending || !canVideo} onClick={() => addVideo(false)}><VlogIcon size={22} />Choose video{videoWhyNot && <em>{videoWhyNot}</em>}</button>
          <button class="vlog-action" disabled={pending || !canPhoto} onClick={() => addPhoto(true)}><Camera size={22} />Take photo</button>
          <button class="vlog-action" disabled={pending || !canPhoto} onClick={() => addPhoto(false)}><Camera size={22} />Choose photo</button>
        </div>
      )}
      {!done && <p class="vlog-card-hint">A video counts as 2 photos.</p>}
    </div>
  );
}

type Picked = { conv: Conv; today: string; kind: 'video' | 'image'; file: Blob; blob: Blob; w: number; h: number; duration: number; thumb?: string };

function openPostSheet(p: Picked) {
  getNav().present((close) => <PostSheet p={p} close={close} />, { variant: 'card' });
}

function PostSheet({ p, close }: { p: Picked; close: () => Promise<void> }) {
  const [caption, setCaption] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const preview = useMemo(() => URL.createObjectURL(p.file), [p.file]);
  useEffect(() => () => { URL.revokeObjectURL(preview); abort.current?.abort(); }, []);

  const post = async () => {
    if (busy) return;
    setBusy(true);
    try {
      let blob = p.blob;
      if (p.kind === 'video' && blob.size > MAX_FILE) {
        abort.current = new AbortController();
        setProgress(0);
        blob = await compressVideo(blob, p.duration, setProgress, abort.current.signal);
        if (blob.size > MAX_FILE) throw new Error('This video is still too large. Please choose a shorter one.');
      }
      // Still the picked one today? (The day may have changed while the sheet was open.)
      const c = getState().circle;
      if (c?.today !== p.today) throw new Error('A new day has started. Check who vlogs today.');
      await sendMedia(p.conv.id, blob, {
        kind: p.kind, w: p.w, h: p.h, thumb: p.thumb, vlog: p.today,
        ...(p.kind === 'video' ? { duration: p.duration } : {}),
        ...(caption.trim() ? { caption: caption.trim().slice(0, 300) } : {}),
      });
      await close();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') toast(errorMessage(err), 'error');
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div class="sheet-page">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close()}>Cancel</button>
        <strong>{p.kind === 'video' ? 'New video' : 'New photo'}</strong>
        <button class="nav-button bold" onClick={post} disabled={busy}>Post</button>
      </div>
      <div class="sheet-scroll">
        <div class="vlog-preview">
          {p.kind === 'video' ? <video src={preview} controls playsInline /> : <img src={preview} alt="" />}
        </div>
        <div class="sheet-content">
          <input class="field" type="text" placeholder="Add a caption" maxLength={300} value={caption} aria-label="Caption"
            onInput={(e) => setCaption((e.target as HTMLInputElement).value)} disabled={busy} />
          {progress !== null && (
            <div class="vlog-progress" role="status">
              <div class="vlog-progress-bar"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
              <p>Making the video smaller… {Math.round(progress * 100)}%. Keep Haven open.</p>
            </div>
          )}
          <Button onClick={post} loading={busy}>Post to your vlog</Button>
          <p class="fine-print">Only your friend group can see it.</p>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ timeline

function Timeline({ posts }: { posts: Msg[] }) {
  // Newest first: the latest moment of the day is always on top.
  const sorted = [...posts].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <ol class="vlog-timeline">
      {sorted.map((m) => <TimelineItem key={m.id} msg={m} />)}
    </ol>
  );
}


/** React right on the post; the person who posted it gets a notification. */
/** Dashed smiley with a plus: "add a reaction". */
function AddReactionIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
      <circle cx="11.5" cy="14" r="8.5" stroke-dasharray="2.6 2.4" />
      <circle cx="8.6" cy="12.4" r="0.6" fill="currentColor" />
      <circle cx="14.4" cy="12.4" r="0.6" fill="currentColor" />
      <path d="M8.3 16.2c.8 1 1.9 1.6 3.2 1.6s2.4-.6 3.2-1.6" />
      <path d="M21 2.5v6M18 5.5h6" stroke-width="1.8" />
    </svg>
  );
}

function Reactions({ msg }: { msg: Msg }) {
  const meId = useStore((s) => s.me?.id);
  const conv = useStore((s) => s.convs[msg.convId]);
  const mine = msg.senderId === meId;
  const entries = Object.entries(msg.reactions ?? {}).filter(([, e]) => e);
  const counts = new Map<string, number>();
  for (const [, e] of entries) counts.set(e, (counts.get(e) ?? 0) + 1);
  const myEmoji = meId ? msg.reactions?.[meId] : undefined;
  const names = (emoji: string) => entries.filter(([, e]) => e === emoji)
    .map(([id]) => (id === meId ? 'You' : firstName(conv?.members.find((m) => m.id === id)))).join(', ');
  const tap = (emoji: string) => react(msg, emoji).catch((err) => toast(errorMessage(err), 'error'));
  if (mine) {
    if (!entries.length) return null;
    return (
      <div class="vlog-reactions">
        {[...counts].map(([emoji, n]) => <span key={emoji} class="vlog-reaction" title={names(emoji)}>{emoji}<em>{n}</em></span>)}
        <span class="vlog-reaction-names">{entries.map(([id]) => firstName(conv?.members.find((m) => m.id === id))).join(', ')}</span>
      </div>
    );
  }
  const openPicker = async () => {
    const emoji = await pickEmoji();
    if (emoji && emoji !== myEmoji) tap(emoji);
  };
  return (
    <div class="vlog-reactions">
      {[...counts].map(([emoji, n]) => (
        <button key={emoji} class={`vlog-reaction${myEmoji === emoji ? ' on' : ''}`} onClick={() => tap(emoji)}
          aria-pressed={myEmoji === emoji} aria-label={`React ${emoji}`} title={names(emoji)}>
          {emoji}<em>{n}</em>
        </button>
      ))}
      <button class="vlog-react-add" onClick={openPicker} aria-label="Add a reaction">
        <AddReactionIcon />
      </button>
    </div>
  );
}

function TimelineItem({ msg }: { msg: Msg }) {
  const media = msg.media!;
  const mine = useStore((s) => s.me?.id === msg.senderId);
  const { url, error } = useMediaUrl(msg);
  const ratio = media.w && media.h ? Math.min(Math.max(media.h / media.w, 0.56), 1.25) : 1;
  return (
    <li class="vlog-item">
      <span class="vlog-item-time">{timeOf(msg.createdAt)}{msg.status === 'pending' ? ' · posting…' : msg.status === 'failed' ? ' · not sent' : ''}</span>
      <button
        class="vlog-item-media"
        style={{ aspectRatio: `${1 / ratio}`, ...(media.thumb ? { backgroundImage: `url(${media.thumb})` } : {}) }}
        onClick={() => url && openViewer(msg, url)}
        aria-label={media.kind === 'video' ? 'Play video' : 'Open photo'}
      >
        {url && media.kind === 'image' && <img src={url} alt="" draggable={false} decoding="async" />}
        {url && media.kind === 'video' && <video src={url} muted playsInline preload="metadata" />}
        {media.kind === 'video' && <span class="vlog-play">▶{media.duration ? <em>{formatDuration(media.duration)}</em> : null}</span>}
        {!url && !error && <span class="visual-loading"><Spinner /></span>}
        {error && <span class="visual-error">{error}</span>}
      </button>
      {media.caption && <p class="vlog-item-caption">{media.caption}</p>}
      {msg.status !== 'pending' && msg.status !== 'failed' && <Reactions msg={msg} />}
      {mine && msg.status !== 'pending' && (
        <button class="link-button vlog-delete" onClick={async () => {
          if (await confirmAction({ title: 'Delete this post?', message: 'It will be removed for everyone in your friend group.', confirm: 'Delete', danger: true })) {
            deleteForEveryone(msg).catch((err) => toast(errorMessage(err), 'error'));
          }
        }}>Delete post</button>
      )}
    </li>
  );
}

function DayScreen({ convId, day, userId }: { convId: string; day: string; userId: string }) {
  const conv = useStore((s) => s.convs[convId]);
  const messages = useStore((s) => s.messages[convId]);
  const today = useStore((s) => s.circle?.today ?? day);
  const who = conv?.members.find((m) => m.id === userId);
  const posts = vlogPosts(messages, day, userId);
  return (
    <Screen back title={dayLabel(day, today)}>
      <div class="vlog-card">
        <div class="vlog-card-person">
          <Avatar id={userId} name={displayName(who)} src={who ? avatarUrl(who) : null} size={56} />
          <div>
            <p class="vlog-card-label">{dayLabel(day, today)}</p>
            <h2 class="vlog-card-title">{displayName(who) || 'Former member'}</h2>
          </div>
        </div>
      </div>
      {posts.length ? <Timeline posts={posts} /> : <p class="muted center pad">No posts on this day.</p>}
    </Screen>
  );
}

// ------------------------------------------------------------------ friend group setup and invites

export function openCircleSetup() {
  getNav().present((close) => <CircleSetup close={close} />, { variant: 'full' });
}

function CircleSetup({ close }: { close: () => Promise<void> }) {
  const [step, setStep] = useState<'intro' | 'pick'>('intro');
  const [name, setName] = useState('Friends');
  const [busy, run] = useAsync();
  if (step === 'pick') {
    return (
      <PeoplePicker
        title="Friend group"
        confirmLabel={busy ? 'Creating…' : 'Create'}
        cancelLabel="Back"
        backArrow
        onCancel={() => setStep('intro')}
        onConfirm={(people) => run(async () => {
          const skipped = await createCircle(name.trim() || 'Friends', people.map((p) => p.id));
          await close();
          if (skipped.length) toast(`${skipped.length === 1 ? '1 person is' : `${skipped.length} people are`} already in another friend group.`);
          else toast('Friend group created');
        }, (err) => toast(errorMessage(err), 'error'))}
      />
    );
  }
  return (
    <div class="sheet-page">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close()} aria-label="Close"><Close size={22} /></button>
        <strong>Vlog your Day</strong>
        <span />
      </div>
      <div class="sheet-scroll">
        <div class="vlog-intro in-sheet">
          <span class="vlog-intro-icon"><VlogIcon size={34} /></span>
          <h2>Your friend group</h2>
          <p>Every day one person from this group is picked at random and vlogs their day for the others: 3 videos (6 minutes) or 6 photos.</p>
        </div>
        <div class="sheet-content">
          <input class="field" type="text" maxLength={60} value={name} aria-label="Group name" placeholder="Group name" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <Button onClick={() => setStep('pick')} disabled={!name.trim()}>Choose friends</Button>
          <p class="fine-print">Friends who aren’t on Haven yet can be invited by their number. You can add more people any time.</p>
          <Button variant="plain" onClick={async () => { await close(); openJoinSheet(); }}>I already have a friend group</Button>
        </div>
      </div>
    </div>
  );
}

/** Invite: share a link, or add people you already chat with. */
export function inviteToCircle(conv: Conv) {
  actionSheet([
    { label: 'Share invite link', run: () => getNav().present((close) => <InviteLinkSheet close={close} />, { variant: 'card' }) },
    { label: 'Add from your contacts', run: () => addFromContacts(conv) },
  ], { title: 'Invite friends' });
}

function InviteLinkSheet({ close }: { close: () => Promise<void> }) {
  const conv = useStore((s) => (s.circle?.id ? s.convs[s.circle.id] : undefined));
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useAsync();
  useEffect(() => { createCircleInvite().then((r) => setCode(r.code), (err) => setError(errorMessage(err))); }, []);
  const url = code ? inviteUrl(code) : '';
  const text = `Join our friend group “${conv?.title ?? 'Friends'}” on Haven. Every day one of us vlogs their day. ${url}`;
  const share = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: 'Haven', text }); return; } catch (err) { if ((err as Error).name === 'AbortError') return; }
    }
    copy();
  };
  const copy = () => navigator.clipboard.writeText(url).then(() => toast('Link copied'), () => toast('Could not copy', 'error'));
  const renew = async () => {
    if (!(await confirmAction({ title: 'Make a new link?', message: 'The current link stops working. People who already joined stay in the group.', confirm: 'New link' }))) return;
    run(async () => { setCode((await createCircleInvite(true)).code); toast('New link ready'); });
  };
  return (
    <div class="sheet-page">
      <div class="sheet-header sheet-drag">
        <span />
        <strong>Invite link</strong>
        <button class="nav-button bold" onClick={() => close()}>Done</button>
      </div>
      <div class="sheet-content">
        <p class="muted">{`Everyone who opens this link can join “${conv?.title ?? 'Friends'}”. It’s the same link for everyone, so send it to all your friends – but only to them.`}</p>
        <div class="invite-code-box">
          {code ? <span class="invite-url">{url.replace(/^https?:\/\//, '')}</span> : error ? <span class="form-error shown">{error}</span> : <Spinner />}
        </div>
        <Button onClick={share} disabled={!code}><Share size={19} /> Share invite link</Button>
        <Button variant="secondary" onClick={copy} disabled={!code}><Copy size={19} /> Copy link</Button>
        {conv?.myRole === 'admin' && <Button variant="plain" onClick={renew} loading={busy} disabled={!code}>Make a new link</Button>}
      </div>
    </div>
  );
}

/** "Join „Friends“ by Philipp?" – after opening an invite link (or pasting it). */
export function openJoinConfirm(code: string) {
  getNav().present((close) => <JoinConfirmSheet close={close} code={code} />, { variant: 'card' });
}

function JoinConfirmSheet({ close, code }: { close: () => Promise<void>; code: string }) {
  const circle = useStore((s) => s.circle);
  const [info, setInfo] = useState<InvitePreview | null>(null);
  const [error, setError] = useState('');
  const [busy, run] = useAsync();
  useEffect(() => { previewInvite(code).then(setInfo, (err) => setError(errorMessage(err))); }, [code]);
  const elsewhere = Boolean(circle?.id) && info && !info.member;
  const join = () => run(async () => {
    const c = await joinCircle(code);
    await close();
    toast(`You joined “${c.title}”`);
  }, (err) => setError(errorMessage(err)));
  return (
    <div class="sheet-page">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close()}>Not now</button>
        <strong>Invitation</strong>
        <span />
      </div>
      <div class="sheet-content join-confirm">
        {!info && !error && <div class="center pad"><Spinner /></div>}
        {error && !info && <p class="form-error shown">{error}</p>}
        {info && (
          <>
            <span class="vlog-intro-icon"><VlogIcon size={34} /></span>
            <h2>{`Join “${info.title}”?`}</h2>
            <p class="muted">{info.creator ? <><strong>{info.creator}</strong> created this friend group. </> : ''}{info.members} {info.members === 1 ? 'member' : 'members'}. Every day one of you vlogs their day.</p>
            {info.member ? (
              <Button onClick={() => close()}>You’re already in this group</Button>
            ) : elsewhere ? (
              <p class="notice-text">You’re already in another friend group. For now you can be in one group at a time.</p>
            ) : (
              <Button onClick={join} loading={busy}>{`Join “${info.title}”`}</Button>
            )}
            {error && <p class="form-error shown">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}

/** "I already have a friend group": the way in is the group's invite link. */
export function openJoinSheet() {
  getNav().present((close) => <JoinSheet close={close} />, { variant: 'card' });
}

function JoinSheet({ close }: { close: () => Promise<void> }) {
  const [text, setText] = useState('');
  const code = codeFrom(text);
  const go = async () => { if (!code) return; await close(); openJoinConfirm(code); };
  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setText(t);
      const c = codeFrom(t);
      if (c) { await close(); openJoinConfirm(c); } else toast('No invite link on the clipboard', 'error');
    } catch {
      toast('Paste the link into the field', 'error');
    }
  };
  return (
    <div class="sheet-page">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close()}>Cancel</button>
        <strong>Join your friend group</strong>
        <span />
      </div>
      <div class="sheet-content join-confirm">
        <span class="vlog-intro-icon"><PersonAdd size={30} /></span>
        <h2>Ask for the invite link</h2>
        <p class="muted">Ask the person who created your friend group for the invite link. Open it, and you can join right away.</p>
        <Button variant="secondary" onClick={paste}>Paste invite link</Button>
        <input class="field" placeholder="…or paste the link here" aria-label="Invite link" autoCapitalize="off" autoComplete="off"
          value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
        {text && <Button onClick={go} disabled={!code}>{code ? 'Continue' : 'That’s not an invite link'}</Button>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ notification center

/** Date on the left, notifications on the right, right under the title. */
function TopLine({ today }: { today: string }) {
  const unseen = useStore((s) => s.activity.some((a) => a.at > s.activitySeen));
  return (
    <div class="vlog-topline">
      <p class="vlog-date">{new Date(`${today}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <button class={`bell-button${unseen ? ' unseen' : ''}`} onClick={openActivity} aria-label={unseen ? 'Notifications, new' : 'Notifications'}>
        <Bell size={21} />
        {unseen && <span class="bell-dot" />}
      </button>
    </div>
  );
}

export function openActivity() {
  getNav().present((close) => <ActivitySheet close={close} />, { variant: 'full' });
}

function ActivitySheet({ close }: { close: () => Promise<void> }) {
  const items = useStore((s) => s.activity);
  const convs = useStore((s) => s.convs);
  useStore((s) => s.aliases);
  const seenBefore = useRef(getState().activitySeen);
  useEffect(() => { markActivitySeen(); }, [items.length]);

  const who = (a: Activity) => convs[a.convId]?.members.find((m) => m.id === a.userId);
  const text = (a: Activity) => {
    const name = displayName(who(a)) || 'Someone';
    if (a.type === 'reaction') return <><strong>{name}</strong> reacted {a.emoji} to your {a.vlog ? 'vlog' : 'message'}</>;
    if (a.type === 'vlog') return <><strong>{name}</strong> just vlogged</>;
    if (a.type === 'mention') return <><strong>{name}</strong> mentioned you</>;
    return <><strong>{name}</strong> joined your friend group</>;
  };
  const open = async (a: Activity) => {
    await close();
    if (((a.type === 'reaction' && !a.vlog) || a.type === 'mention') && convs[a.convId]) getNav().push(<ChatScreen convId={a.convId} />);
  };

  return (
    <div class="sheet-page">
      <div class="sheet-header sheet-drag">
        <span />
        <strong>Notifications</strong>
        <button class="nav-button bold" onClick={() => close()}>Done</button>
      </div>
      <div class="sheet-scroll">
        {items.length ? (
          <ul class="activity-list">
            {items.map((a) => {
              const p = who(a);
              return (
                <li key={a.id}>
                  <button class={`activity-row${a.at > seenBefore.current ? ' new' : ''}`} onClick={() => open(a)}>
                    <span class="activity-avatar">
                      <Avatar id={a.userId} name={displayName(p) || '?'} src={p ? avatarUrl(p) : null} size={44} />
                      <span class="activity-badge">{a.type === 'reaction' ? a.emoji : a.type === 'vlog' ? '🎬' : a.type === 'mention' ? '@' : '👋'}</span>
                    </span>
                    <span class="activity-text">
                      <span>{text(a)}</span>
                      {((a.type === 'reaction' && !a.vlog) || a.type === 'mention') && a.snippet && <span class="activity-snippet">“{a.snippet}”</span>}
                      <span class="activity-time">{formatListTime(a.at)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div class="activity-empty">
            <span class="vlog-intro-icon"><Bell size={30} /></span>
            <h2>No notifications yet</h2>
            <p>When someone reacts to your messages or vlogs, or a friend posts their day, you’ll see it here.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function addFromContacts(conv: Conv) {
  getNav().present((close) => (
    <PeoplePicker
      title="Invite friends"
      confirmLabel="Add"
      exclude={new Set(conv.members.map((m) => m.id))}
      onCancel={() => close()}
      onConfirm={async (people) => {
        try {
          await addMembers(conv.id, people.map((p) => p.id));
          await close();
          toast(people.length === 1 ? `${displayName(people[0])} joined your friend group` : 'Friends added');
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      }}
    />
  ), { variant: 'full' });
}
