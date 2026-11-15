// Haven friends: suggestions (people from your groups), friend requests, friend list.
// Same session cookie as the main API; the browser reaches it through /social/* on Haven's domain.
import postgres from 'npm:postgres@3.4.5';
import { createHash } from 'node:crypto';

const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 2, idle_timeout: 20 });
const ID = /^[A-Za-z0-9_-]{10,40}$/;
const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

async function me(req: Request): Promise<string | null> {
  const m = /(?:^|;\s*)__Host-haven=([^;]{40,64})/.exec(req.headers.get('cookie') || '');
  if (!m) return null;
  const hash = createHash('sha256').update(m[1]).digest('hex');
  const [row] = await sql`select user_id from haven.sessions where token_hash = ${hash} and expires_at > ${Date.now()}`;
  return row?.user_id ?? null;
}

// Each person has one hidden "public" conversation: its members are the person and their friends.
// Posts in it are normal end-to-end encrypted messages, so the server never sees them.
const PUBLIC = '\u2063public';
async function publicConv(uid: string): Promise<string> {
  const [c] = await sql`select id from haven.conversations where created_by = ${uid} and title = ${PUBLIC} and kind = 'group'`;
  if (c) return c.id;
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 22);
  const t = Date.now();
  await sql`insert into haven.conversations (id, kind, title, created_by, created_at, updated_at) values (${id}, 'group', ${PUBLIC}, ${uid}, ${t}, ${t})`;
  await sql`insert into haven.members (conversation_id, user_id, role, joined_at) values (${id}, ${uid}, 'admin', ${t})`;
  return id;
}
async function link(x: string, y: string) {
  const [cx, cy] = [await publicConv(x), await publicConv(y)];
  const t = Date.now();
  await sql`insert into haven.members (conversation_id, user_id, role, joined_at) values (${cx}, ${y}, 'member', ${t}), (${cy}, ${x}, 'member', ${t}) on conflict do nothing`;
}
async function unlink(x: string, y: string) {
  await sql`delete from haven.members m using haven.conversations c where c.id = m.conversation_id and c.title = ${PUBLIC}
            and ((c.created_by = ${x} and m.user_id = ${y}) or (c.created_by = ${y} and m.user_id = ${x}))`;
}

// Push "X wants to be your friend" through the main API's one-off announcement queue.
async function notify(from: string, to: string) {
  try {
    const [[f], [t]] = await Promise.all([sql`select name from haven.users where id = ${from}`, sql`select lang from haven.users where id = ${to}`]);
    const de = t?.lang === 'de';
    const value = JSON.stringify({ title: de ? 'Freundschaftsanfrage' : 'Friend request', body: `${f?.name || 'Someone'} ${de ? 'möchte mit dir befreundet sein.' : 'wants to be your friend.'}`, open: 'friends', to: [to] });
    await sql`insert into haven.kv (key, value) values ('announce', ${value}) on conflict (key) do update set value = excluded.value`;
    await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/api/announce`, { method: 'POST' });
  } catch (err) { console.error('notify', String(err)); }
}

const people = (ids: string[]) => ids.length
  ? sql`select id, name, username, avatar_version from haven.users where id = any(${ids})` : Promise.resolve([]);

Deno.serve(async (req) => {
  try {
    const path = new URL(req.url).pathname.replace(/^.*\/social/, '');
    if (req.method !== 'GET') {
      const origin = req.headers.get('origin') || '';
      const [ok] = await sql`select 1 from haven.kv where key = 'allowed_origins' and strpos(value, ${JSON.stringify(origin)}) > 0`;
      if (!origin || !ok) return json(403, { error: 'bad_origin' });
    }
    const uid = await me(req);
    if (!uid) return json(401, { error: 'unauthorized' });

    if (req.method === 'GET' && path === '/friends') {
      const rows = await sql`select a, b, status from haven.friends where a = ${uid} or b = ${uid}`;
      const friends = rows.filter((r) => r.status === 'accepted').map((r) => (r.a === uid ? r.b : r.a));
      const incoming = rows.filter((r) => r.status === 'pending' && r.b === uid).map((r) => r.a);
      const outgoing = rows.filter((r) => r.status === 'pending' && r.a === uid).map((r) => r.b);
      const known = new Set([uid, ...friends, ...incoming, ...outgoing]);
      // Suggestions: every Haven user, except people you already have a one-to-one chat with.
      const near = await sql`select u.id as user_id from haven.users u where u.id <> ${uid} and not exists (
                               select 1 from haven.conversations c join haven.members a on a.conversation_id = c.id and a.user_id = ${uid}
                               join haven.members b on b.conversation_id = c.id and b.user_id = u.id where c.kind = 'direct')
                             order by u.created_at desc limit 300`;
      const suggestions = near.map((r) => r.user_id as string).filter((id) => !known.has(id));
      const [f, i, s] = await Promise.all([people(friends), people(incoming), people(suggestions)]);
      return json(200, { friends: f, incoming: i, outgoing, suggestions: s, publicId: await publicConv(uid) });
    }

    const body = await req.json().catch(() => ({}));
    const other = typeof body?.userId === 'string' && ID.test(body.userId) && body.userId !== uid ? body.userId as string : null;
    if (!other || Object.keys(body).length !== 1) return json(400, { error: 'invalid' });

    if (req.method === 'POST' && path === '/request') {
      const [u] = await sql`select 1 from haven.users where id = ${other}`;
      if (!u) return json(404, { error: 'not_found' });
      const [{ n }] = await sql`select count(*)::int as n from haven.friends where a = ${uid} and status = 'pending'`;
      if (n >= 100) return json(429, { error: 'too_many' });
      // They already asked you: this accepts.
      const [back] = await sql`update haven.friends set status = 'accepted' where a = ${other} and b = ${uid} returning 1`;
      if (back) await link(uid, other);
      else {
        const added = await sql`insert into haven.friends (a, b, status, created_at) values (${uid}, ${other}, 'pending', ${Date.now()}) on conflict do nothing returning 1`;
        if (added.length) await notify(uid, other);
      }
      return json(204, null);
    }
    if (req.method === 'POST' && path === '/accept') {
      const [okay] = await sql`update haven.friends set status = 'accepted' where a = ${other} and b = ${uid} returning 1`;
      if (okay) await link(uid, other);
      return json(204, null);
    }
    if (req.method === 'POST' && path === '/remove') {
      await unlink(uid, other);
      await sql`delete from haven.friends where (a = ${uid} and b = ${other}) or (a = ${other} and b = ${uid})`;
      return json(204, null);
    }
    return json(404, { error: 'not_found' });
  } catch (err) {
    console.error('social', String(err));
    return json(500, { error: 'server' });
  }
});
