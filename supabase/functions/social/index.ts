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
      // Suggestions: people you share a chat or group with.
      const near = await sql`select distinct m2.user_id from haven.members m1 join haven.members m2 on m2.conversation_id = m1.conversation_id
                             where m1.user_id = ${uid} limit 200`;
      const suggestions = near.map((r) => r.user_id as string).filter((id) => !known.has(id));
      const [f, i, s] = await Promise.all([people(friends), people(incoming), people(suggestions)]);
      return json(200, { friends: f, incoming: i, outgoing, suggestions: s });
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
      if (!back) await sql`insert into haven.friends (a, b, status, created_at) values (${uid}, ${other}, 'pending', ${Date.now()}) on conflict do nothing`;
      return json(204, null);
    }
    if (req.method === 'POST' && path === '/accept') {
      await sql`update haven.friends set status = 'accepted' where a = ${other} and b = ${uid}`;
      return json(204, null);
    }
    if (req.method === 'POST' && path === '/remove') {
      await sql`delete from haven.friends where (a = ${uid} and b = ${other}) or (a = ${other} and b = ${uid})`;
      return json(204, null);
    }
    return json(404, { error: 'not_found' });
  } catch (err) {
    console.error('social', String(err));
    return json(500, { error: 'server' });
  }
});
