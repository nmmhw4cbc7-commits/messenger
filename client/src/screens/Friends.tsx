// Friends tab: requests, your friends, and people you may know (from your groups).
import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { avatarUrl, openDirect } from '../lib/engine';
import { Avatar, Button, Empty, Screen, Spinner, toast } from '../ui/components';
import { People } from '../ui/icons';

interface Person { id: string; name: string; username: string | null; avatar_version: number }
interface Data { friends: Person[]; incoming: Person[]; outgoing: string[]; suggestions: Person[] }

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
  const load = () => loadFriends().then(setData, () => {});
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
    <Screen title="Friends" large>
      {!data ? <div class="center-pad"><Spinner /></div> : (
        <div class="friends">
          {data.incoming.length > 0 && <h3 class="section-title">Friend requests</h3>}
          {data.incoming.map((p) => row(p, <>
            <Button onClick={() => act('accept', p.id)} loading={busy === p.id}>Accept</Button>
            <button class="nav-button" onClick={() => act('remove', p.id)}>Decline</button>
          </>))}
          <h3 class="section-title">Your friends</h3>
          {data.friends.length === 0 && <p class="fine-print">No friends yet. Add people below.</p>}
          {data.friends.map((p) => row(p, <button class="nav-button bold" onClick={() => chat(p)}>Message</button>))}
          {data.suggestions.length > 0 && <h3 class="section-title">People you may know</h3>}
          {data.suggestions.map((p) => row(p, data.outgoing.includes(p.id)
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
