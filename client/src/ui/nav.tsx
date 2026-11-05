// Native-style navigation: a stack of screens that slide in from the right,
// an edge swipe to go back, and bottom sheets. Every layer is mirrored in the
// browser history, so the Android back button and gestures close the top layer.

import { createContext, type ComponentChildren, type JSX } from 'preact';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
const DURATION = 420;
const PARALLAX = 0.28;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ history

type Closer = (animated: boolean) => Promise<void> | void;
const closers: Closer[] = [];
let skipNextAnimation = false;
let backWaiters: (() => void)[] = [];

history.replaceState({ haven: 0 }, '');

window.addEventListener('popstate', async () => {
  const closer = closers.pop();
  const animated = !skipNextAnimation;
  skipNextAnimation = false;
  if (closer) await closer(animated);
  const waiters = backWaiters;
  backWaiters = [];
  waiters.forEach((w) => w());
});

function openLayer(closer: Closer) {
  closers.push(closer);
  history.pushState({ haven: closers.length }, '');
}

/** Close the top layer (screen or sheet). Resolves when it is gone. */
export function goBack(animated = true): Promise<void> {
  if (!closers.length) return Promise.resolve();
  skipNextAnimation = !animated;
  return new Promise((resolve) => {
    backWaiters.push(resolve);
    history.back();
  });
}

/** Forget all layers, e.g. when switching from sign-in to the main app. */
export function resetNavigation() {
  closers.length = 0;
  backWaiters = [];
  history.replaceState({ haven: 0 }, '');
}

/** Close several layers, e.g. a sheet and the screen under it. */
export async function goBackMany(count: number) {
  for (let i = 0; i < count && closers.length; i++) await goBack(false);
}

// ------------------------------------------------------------------ helpers

function animate(el: HTMLElement | null | undefined, from: string, to: string, duration = DURATION) {
  if (!el) return Promise.resolve();
  if (reducedMotion()) duration = Math.min(duration, 160);
  const anim = el.animate([{ transform: from }, { transform: to }], { duration, easing: EASE, fill: 'forwards' });
  return anim.finished.then(
    () => {
      el.style.transform = to === 'translateX(0px)' || to === 'translateY(0px)' ? '' : to;
      anim.cancel();
    },
    () => {},
  );
}

function setBusy(busy: boolean) {
  document.documentElement.classList.toggle('nav-busy', busy);
}

// ------------------------------------------------------------------ screen stack

interface Entry {
  key: number;
  node: JSX.Element;
}

interface NavApi {
  push(node: JSX.Element): void;
  present(render: (close: () => Promise<void>) => JSX.Element, options?: { variant?: SheetVariant }): void;
}

export type SheetVariant = 'card' | 'full' | 'action';

const NavContext = createContext<NavApi>(null as unknown as NavApi);
export const useNav = () => useContext(NavContext);

let globalNav: NavApi | null = null;
/** For code outside components (dialogs, toasts). */
export const getNav = () => globalNav!;

let nextKey = 1;

export function Navigator({ root }: { root: JSX.Element }) {
  const [stack, setStack] = useState<Entry[]>([{ key: 0, node: root }]);
  const [sheets, setSheets] = useState<{ key: number; render: (close: () => Promise<void>) => JSX.Element; variant: SheetVariant }[]>([]);
  const els = useRef(new Map<number, HTMLElement>());
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const pendingPush = useRef<number | null>(null);

  const api = useRef<NavApi>({
    push(node) {
      const key = nextKey++;
      pendingPush.current = key;
      setBusy(true);
      setStack((s) => [...s, { key, node }]);
      openLayer(async (animated) => {
        const s = stackRef.current;
        const top = s[s.length - 1];
        const below = s[s.length - 2];
        if (!top || top.key !== key) return;
        if (animated) {
          setBusy(true);
          const width = window.innerWidth;
          await Promise.all([
            animate(els.current.get(top.key), 'translateX(0px)', `translateX(${width}px)`, 340),
            animate(els.current.get(below?.key ?? -1), `translateX(${-width * PARALLAX}px)`, 'translateX(0px)', 340),
          ]);
          setBusy(false);
        } else {
          const belowEl = els.current.get(below?.key ?? -1);
          if (belowEl) belowEl.style.transform = '';
        }
        setStack((cur) => cur.filter((e) => e.key !== key));
      });
    },
    present(render, options) {
      const key = nextKey++;
      setSheets((s) => [...s, { key, render, variant: options?.variant ?? 'card' }]);
      openLayer(async (animated) => {
        const el = document.querySelector<HTMLElement>(`[data-sheet="${key}"]`);
        if (el && animated) {
          el.classList.add('closing');
          await new Promise((r) => setTimeout(r, reducedMotion() ? 120 : 280));
        }
        setSheets((s) => s.filter((x) => x.key !== key));
      });
    },
  });
  globalNav = api.current;

  // Run the push animation once the new screen is in the DOM.
  useLayoutEffect(() => {
    const key = pendingPush.current;
    if (key === null) return;
    pendingPush.current = null;
    const s = stackRef.current;
    const below = s[s.length - 2];
    const width = window.innerWidth;
    Promise.all([
      animate(els.current.get(key), `translateX(${width}px)`, 'translateX(0px)'),
      animate(els.current.get(below?.key ?? -1), 'translateX(0px)', `translateX(${-width * PARALLAX}px)`),
    ]).then(() => setBusy(false));
  }, [stack]);

  // Edge swipe to go back.
  useEffect(() => {
    let tracking: { id: number; x0: number; y0: number; t0: number; decided: boolean; active: boolean; top: HTMLElement; below?: HTMLElement } | null = null;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0;

    const down = (e: PointerEvent) => {
      const s = stackRef.current;
      if (s.length < 2 || e.clientX > 24 || document.documentElement.classList.contains('nav-busy') || closers.length > s.length - 1) return;
      const top = els.current.get(s[s.length - 1].key);
      if (!top) return;
      tracking = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, decided: false, active: false, top, below: els.current.get(s[s.length - 2].key) };
      lastX = e.clientX;
      lastT = e.timeStamp;
      velocity = 0;
    };
    const move = (e: PointerEvent) => {
      if (!tracking || e.pointerId !== tracking.id) return;
      const dx = e.clientX - tracking.x0;
      const dy = e.clientY - tracking.y0;
      if (!tracking.decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        tracking.decided = true;
        tracking.active = dx > 0 && Math.abs(dx) > Math.abs(dy);
        if (!tracking.active) {
          tracking = null;
          return;
        }
        document.documentElement.classList.add('nav-swiping');
      }
      const width = window.innerWidth;
      const x = Math.max(0, Math.min(width, dx));
      tracking.top.style.transform = `translateX(${x}px)`;
      if (tracking.below) tracking.below.style.transform = `translateX(${-width * PARALLAX * (1 - x / width)}px)`;
      const dt = e.timeStamp - lastT;
      if (dt > 0) velocity = (e.clientX - lastX) / dt;
      lastX = e.clientX;
      lastT = e.timeStamp;
    };
    const up = async (e: PointerEvent) => {
      if (!tracking || e.pointerId !== tracking.id) return;
      const t = tracking;
      tracking = null;
      if (!t.active) return;
      document.documentElement.classList.remove('nav-swiping');
      const width = window.innerWidth;
      const x = Math.max(0, Math.min(width, e.clientX - t.x0));
      const complete = e.type === 'pointerup' && (x > width * 0.4 || velocity > 0.45);
      setBusy(true);
      if (complete) {
        await Promise.all([
          animate(t.top, `translateX(${x}px)`, `translateX(${width}px)`, 260),
          animate(t.below, t.below?.style.transform || 'translateX(0px)', 'translateX(0px)', 260),
        ]);
        setBusy(false);
        await goBack(false);
      } else {
        await Promise.all([
          animate(t.top, `translateX(${x}px)`, 'translateX(0px)', 260),
          animate(t.below, t.below?.style.transform || 'translateX(0px)', `translateX(${-width * PARALLAX}px)`, 260),
        ]);
        setBusy(false);
      }
    };
    window.addEventListener('pointerdown', down, { passive: true });
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  return (
    <NavContext.Provider value={api.current}>
      <div class="stack">
        {stack.map((entry, i) => (
          <div
            key={entry.key}
            class={`stack-item${i === stack.length - 1 ? ' top' : ''}${i < stack.length - 2 ? ' buried' : ''}`}
            ref={(el) => {
              if (el) els.current.set(entry.key, el);
              else els.current.delete(entry.key);
            }}
            aria-hidden={i !== stack.length - 1}
            inert={i !== stack.length - 1}
          >
            {entry.node}
          </div>
        ))}
      </div>
      {sheets.map((sheet) => (
        <SheetFrame key={sheet.key} id={sheet.key} variant={sheet.variant}>
          {sheet.render(() => goBack())}
        </SheetFrame>
      ))}
    </NavContext.Provider>
  );
}

// ------------------------------------------------------------------ sheets

function SheetFrame({ id, variant, children }: { id: number; variant: SheetVariant; children: ComponentChildren }) {
  const panel = useRef<HTMLDivElement>(null);

  // Drag the header down to dismiss. Taps on buttons in the header still work:
  // the drag only starts after the finger has clearly moved down.
  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.sheet-grabber, .sheet-drag')) return;
    const el = panel.current;
    if (!el) return;
    const y0 = e.clientY;
    const x0 = e.clientX;
    let t0 = e.timeStamp;
    let dy = 0;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const d = ev.clientY - y0;
      if (!dragging) {
        if (d < 8 || Math.abs(ev.clientX - x0) > Math.abs(d)) return;
        dragging = true;
        t0 = ev.timeStamp;
        el.setPointerCapture(e.pointerId);
        el.style.transition = 'none';
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      dy = Math.max(0, d - 8);
      el.style.transform = `translateY(${dy}px)`;
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (!dragging) return;
      el.style.transition = '';
      const v = dy / Math.max(1, ev.timeStamp - t0);
      if (dy > el.offsetHeight * 0.25 || v > 0.6) {
        goBack();
      } else {
        el.style.transform = '';
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return (
    <div class={`sheet-layer ${variant}`} data-sheet={id}>
      <div class="sheet-backdrop" onClick={() => goBack()} />
      <div class="sheet" ref={panel} role="dialog" aria-modal="true" onPointerDown={variant === 'action' ? undefined : onPointerDown}>
        {variant !== 'action' && <div class="sheet-grabber" aria-hidden="true" />}
        {children}
      </div>
    </div>
  );
}
