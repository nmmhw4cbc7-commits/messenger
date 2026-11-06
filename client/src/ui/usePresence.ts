import { useEffect, useState } from 'preact/hooks';
import { describePresence, fetchPresence, type Presence } from '../lib/engine';
import { useStore } from '../lib/store';

/** Last seen / online of one person, refreshed every 30 seconds while shown. */
export function usePresence(userId: string | undefined): string {
  const [p, setP] = useState<Presence | null>(null);
  const mine = useStore((s) => s.me?.presence !== false);
  useEffect(() => {
    if (!userId || !mine) { setP(null); return; }
    let alive = true;
    const load = () => { if (document.visibilityState === 'visible') fetchPresence(userId).then((r) => alive && setP(r), () => {}); };
    load();
    const t = setInterval(load, 30_000);
    document.addEventListener('visibilitychange', load);
    return () => { alive = false; clearInterval(t); document.removeEventListener('visibilitychange', load); };
  }, [userId, mine]);
  return describePresence(p);
}
