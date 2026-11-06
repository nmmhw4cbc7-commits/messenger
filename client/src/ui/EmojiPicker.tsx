// All emoji, by category like the phone's emoji keyboard, with recents and search.
// The emoji list is a separate chunk, loaded the first time the picker opens.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getNav } from './nav';
import { Search } from './icons';
import { Spinner } from './components';

const RECENT_KEY = 'haven.recentEmoji';
const TAB_ICONS = ['🕘', '😀', '👋', '🐶', '🍔', '✈️', '⚽', '💡', '❤️', '🏳️'];

type Group = { name: string; items: { e: string; n: string }[] };

/** Position of an element inside the scroll box, measured on screen. */
const topIn = (box: HTMLElement, el: HTMLElement) => el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;

let cache: Promise<Group[]> | null = null;
function loadGroups(): Promise<Group[]> {
  cache ??= import('../lib/emoji-data').then(({ EMOJI_GROUPS }) =>
    EMOJI_GROUPS.map(([name, list]) => ({
      name,
      items: list.split('\n').map((line) => {
        const i = line.indexOf(' ');
        return { e: line.slice(0, i), n: line.slice(i + 1) };
      }),
    })));
  return cache;
}

function recents(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 24); } catch { return []; }
}
function remember(e: string) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recents().filter((x) => x !== e)].slice(0, 24))); } catch { /* fine */ }
}

/** Show the picker. Resolves with the chosen emoji, or null if closed. */
export function pickEmoji(): Promise<string | null> {
  loadGroups().catch(() => { cache = null; });
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    getNav().present((close) => <EmojiPicker onPick={(e) => { remember(e); finish(e); close(); }} close={close} />, { onClose: () => finish(null) });
  });
}

function EmojiPicker({ onPick, close }: { onPick: (e: string) => void; close: () => Promise<void> }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const recent = useMemo(recents, []);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => { loadGroups().then(setGroups, () => setFailed(true)); }, []);

  const sections = useMemo(() => {
    if (!groups) return [];
    const all = recent.length ? [{ name: 'Recently used', items: recent.map((e) => ({ e, n: '' })) }, ...groups] : groups;
    return all;
  }, [groups, recent]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !groups) return null;
    return groups.flatMap((g) => g.items).filter((x) => x.n.includes(q)).slice(0, 160);
  }, [query, groups]);

  const jump = (i: number) => {
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>(`[data-section="${i}"]`);
    if (el && box) box.scrollTo({ top: topIn(box, el) - 4 });
    setActive(i);
  };
  const onScroll = () => {
    const box = scroller.current;
    if (!box) return;
    const heads = [...box.querySelectorAll<HTMLElement>('[data-section]')];
    let cur = 0;
    for (const h of heads) if (topIn(box, h) - 12 <= box.scrollTop) cur = Number(h.dataset.section);
    if (cur !== active) setActive(cur);
  };
  // Tabs line up with the sections that exist (no "recent" tab without recents).
  const icons = recent.length ? TAB_ICONS : TAB_ICONS.slice(1);

  const grid = (items: { e: string; n: string }[]) => (
    <div class="emoji-grid">
      {items.map((x) => (
        <button key={x.e} class="emoji-cell" onClick={() => onPick(x.e)} aria-label={x.n || x.e} title={x.n}>{x.e}</button>
      ))}
    </div>
  );

  return (
    <div class="sheet-page emoji-picker">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close()}>Cancel</button>
        <strong>Reaction</strong>
        <span class="nav-button" aria-hidden="true" />
      </div>
      <div class="search-bar">
        <Search size={18} />
        <input type="search" placeholder="Search emoji" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} aria-label="Search emoji" />
      </div>
      <div class="emoji-scroll" ref={scroller} onScroll={onScroll}>
        {failed && <p class="emoji-empty">The emoji could not be loaded. Check your connection and try again.</p>}
        {!groups && !failed && <div class="emoji-empty"><Spinner /></div>}
        {results && (results.length ? grid(results) : <p class="emoji-empty">No emoji found.</p>)}
        {!results && sections.map((s, i) => (
          <section key={s.name} class="emoji-section">
            <h4 data-section={i}>{s.name}</h4>
            {grid(s.items)}
          </section>
        ))}
      </div>
      {!results && groups && (
        <nav class="emoji-tabs" aria-label="Emoji categories">
          {sections.map((s, i) => (
            <button key={s.name} class={i === active ? 'on' : ''} onClick={() => jump(i)} aria-label={s.name}>{icons[i]}</button>
          ))}
        </nav>
      )}
    </div>
  );
}
