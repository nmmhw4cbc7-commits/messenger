// Friends tab: requests, your friends, and people you may know (from your groups).
import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { avatarUrl, loadMessages, react, openDirect, refreshConversations } from '../lib/engine';
import { useStore, type Conv, type Msg } from '../lib/store';
import { cameraPhoto, openPhotoSend, pickFile, useMediaUrl } from './Attachments';
import { Comments } from './Today';
import { Avatar, Button, Empty, Screen, Spinner, toast } from '../ui/components';
import { People } from '../ui/icons';

interface Person { id: string; name: string; username: string | null; avatar_version: number }
interface Data { friends: Person[]; incoming: Person[]; outgoing: string[]; suggestions: Person[]; publicId?: string }

/** Hidden conversation that carries someone's public posts to their friends. */
export const isPublicConv = (c: Conv) => c.kind === 'group' && c.title === '\u2063public';

let pending = 0;
const listeners = new Set<(n: number) => void>();
/** Number of open friend requests, for the tab badge. */
export function useFriendRequests() {
  const [n, setN] = useState(pending);
  useEffect(() => { listeners.add(setN); return () => { listeners.delete(setN); }; }, []);
  return n;
}
export async function loadFriends(): Promise<Data> {
  const d = await api<Data>('GET', '/social/friends');
  pending = d.incoming.length;
  listeners.forEach((f) => f(pending));
  return d;
}

export function FriendsTab({ active, onChat }: { active: boolean; onChat: (convId: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<'friends' | 'public'>('friends');
  const [q, setQ] = useState('');
  const hit = (p: Person) => !q.trim() || `${p.name} ${p.username ?? ''}`.toLowerCase().includes(q.trim().toLowerCase().replace(/^@/, ''));
  const load = () => loadFriends().then((d) => { setData(d); refreshConversations().catch(() => {}); }, () => {});
  useEffect(() => { if (active) load(); }, [active]);

  const act = async (path: string, userId: string) => {
    setBusy(userId);
    try { await api('POST', `/social/${path}`, { userId }); await load(); }
    catch (err) { toast(err instanceof Error ? err.message : 'Something went wrong.', 'error'); }
    finally { setBusy(null); }
  };
  const chat = async (p: Person) => {
    try { onChat((await openDirect(p.id)).id); }
    catch (err) { toast(err instanceof Error ? err.message : 'Could not open the chat.', 'error'); }
  };
  const row = (p: Person, actions: preact.ComponentChildren) => (
    <div class="friend-row" key={p.id}>
      <Avatar id={p.id} name={p.name} src={avatarUrl({ id: p.id, avatarVersion: p.avatar_version })} size={44} />
      <div class="friend-name"><strong data-no-i18n>{p.name}</strong>{p.username && <span data-no-i18n>@{p.username}</span>}</div>
      <div class="friend-actions">{actions}</div>
    </div>
  );

  return (
    <Screen title={mode === 'public' ? 'Public' : 'Friends'} large>
      <div class="maker-switch friends-switch">
        <button class={mode === 'friends' ? 'on' : ''} onClick={() => setMode('friends')}>Friends</button>
        <button class={mode === 'public' ? 'on' : ''} onClick={() => setMode('public')}>Public</button>
      </div>
      {mode === 'public' ? <PublicFeed publicId={data?.publicId} /> : !data ? <div class="center-pad"><Spinner /></div> : (
        <div class="friends">
          <input class="field friends-search" type="search" placeholder="Search name or @username" aria-label="Search" value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
          {data.incoming.length > 0 && <h3 class="section-title">Friend requests</h3>}
          {data.incoming.map((p) => row(p, <>
            <Button onClick={() => act('accept', p.id)} loading={busy === p.id}>Accept</Button>
            <button class="nav-button" onClick={() => act('remove', p.id)}>Decline</button>
          </>))}
          <h3 class="section-title">Your friends</h3>
          {data.friends.length === 0 && <p class="fine-print">No friends yet. Add people below.</p>}
          {data.friends.filter(hit).map((p) => row(p, <button class="nav-button bold" onClick={() => chat(p)}>Message</button>))}
          {data.suggestions.length > 0 && <h3 class="section-title">People you may know</h3>}
          {data.suggestions.filter(hit).map((p) => row(p, data.outgoing.includes(p.id)
            ? <button class="nav-button" onClick={() => act('remove', p.id)}>Requested</button>
            : <Button onClick={() => act('request', p.id)} loading={busy === p.id}>Add</Button>))}
          {data.friends.length === 0 && data.suggestions.length === 0 && data.incoming.length === 0 && (
            <Empty icon={<People size={32} />} title="Invite your friends" text="Share your group's invite link – people who join show up here." />
          )}
        </div>
      )}
    </Screen>
  );
}

/** Posts your friends shared in public mode, newest first, with comments. */
function PublicFeed({ publicId }: { publicId?: string }) {
  const all = useStore((s) => s.convs);
  const messages = useStore((s) => s.messages);
  const convs = Object.values(all).filter(isPublicConv);
  const posts = convs.flatMap((c) => (messages[c.id] ?? []).filter((m) => m.kind === 'media' && !m.deleted))
    .sort((a, b) => b.createdAt - a.createdAt).slice(0, 60);
  const ids = convs.map((c) => c.id).join();
  useEffect(() => { convs.forEach((c) => loadMessages(c.id).catch(() => {})); }, [ids]);
  const post = async (camera: boolean) => {
    if (!publicId) return;
    const file = camera ? await cameraPhoto() : await pickFile('image/*');
    if (!file) return;
    openPhotoSend(publicId, file, true);
  };
  return (
    <div class="friends">
      <div class="public-actions">
        <Button onClick={() => post(true)} disabled={!publicId}>Take photo</Button>
        <Button variant="secondary" onClick={() => post(false)} disabled={!publicId}>Choose photo</Button>
      </div>
      <p class="fine-print">Only your friends see public posts. End-to-end encrypted.</p>
      {posts.length === 0 && <Empty icon={<People size={32} />} title="Nothing here yet" text="When your friends post in public, it shows up here." />}
      {posts.map((m) => <PublicPost key={m.id} msg={m} />)}
    </div>
  );
}

function PublicPost({ msg }: { msg: Msg }) {
  const conv = useStore((s) => s.convs[msg.convId]);
  const meId = useStore((s) => s.me?.id);
  const { url } = useMediaUrl(msg);
  // A like is a ❤️ reaction: it goes to everyone who sees the post, so all see the count.
  const likes = Object.values(msg.reactions ?? {}).filter((e) => e === '❤️').length;
  const liked = Boolean(meId && msg.reactions?.[meId] === '❤️');
  const who = msg.senderId === meId ? 'You' : conv?.members.find((m) => m.id === msg.senderId)?.name ?? '';
  return (
    <article class="public-post">
      <header data-no-i18n><strong>{who}</strong> <span>{new Date(msg.createdAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span></header>
      {url ? <img src={url} alt="" /> : <div class="center-pad"><Spinner /></div>}
      <div class="public-like">
        {msg.senderId !== meId
          ? <button class={liked ? 'on' : ''} aria-pressed={liked} aria-label="Like" onClick={() => react(msg, '❤️').catch(() => {})}>{liked ? '♥' : '♡'}</button>
          : <span>♥</span>}
        <span>{likes} {likes === 1 ? 'like' : 'likes'}</span>
      </div>
      {msg.media?.caption && <p data-no-i18n>{msg.media.caption}</p>}
      <Comments msg={msg} />
    </article>
  );
}
