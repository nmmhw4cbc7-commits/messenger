// A photo you can zoom: pinch with two fingers, double-tap to zoom in/out,
// drag to look around while zoomed. Zoomed out, it behaves like a plain image
// (so the viewer's swipe-down to close keeps working).

import { useEffect, useRef, useState } from 'preact/hooks';

const MAX = 5;
type View = { s: number; x: number; y: number };

export function ZoomImage({ src, onZoomChange }: { src: string; onZoomChange?: (zoomed: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<View>({ s: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; mx: number; my: number } | null>(null);
  const lastTap = useRef(0);

  useEffect(() => { onZoomChange?.(view.s > 1.02); }, [view.s > 1.02]);

  /** Keep the picture covering the screen edges it can reach. */
  const clamp = (v: View): View => {
    const el = img.current;
    const s = Math.min(MAX, Math.max(1, v.s));
    if (!el || s <= 1) return { s: 1, x: 0, y: 0 };
    const maxX = (el.offsetWidth * s - el.offsetWidth) / 2;
    const maxY = Math.max(0, (el.offsetHeight * s - (box.current?.clientHeight ?? el.offsetHeight)) / 2);
    return { s, x: Math.min(maxX, Math.max(-maxX, v.x)), y: Math.min(maxY, Math.max(-maxY, v.y)) };
  };
  /** Zoom to scale s around a point (relative to the image centre) so it stays under the fingers. */
  const zoomAt = (v: View, s: number, px: number, py: number): View => {
    const k = Math.min(MAX, Math.max(1, s)) / v.s;
    return { s: v.s * k, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
  };
  const centre = () => {
    const r = box.current!.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  };

  const down = (e: PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
    if (pointers.current.size > 1 || viewRef.current.s > 1.02) {
      e.stopPropagation(); // the viewer must not start closing
      box.current?.setPointerCapture(e.pointerId);
    }
  };
  const move = (e: PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const last = pinch.current;
      pinch.current = { d, mx, my };
      const { cx, cy } = centre();
      setView((v) => clamp(zoomAt({ ...v, x: v.x + mx - last.mx, y: v.y + my - last.my }, v.s * (d / Math.max(1, last.d)), mx - cx, my - cy)));
    } else if (pointers.current.size === 1 && viewRef.current.s > 1.02) {
      setView((v) => clamp({ ...v, x: v.x + e.clientX - prev.x, y: v.y + e.clientY - prev.y }));
    }
  };
  const up = (e: PointerEvent) => {
    const had = pointers.current.size;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (had === 1 && e.type === 'pointerup') {
      const now = e.timeStamp;
      if (now - lastTap.current < 300) {
        lastTap.current = 0;
        const { cx, cy } = centre();
        setView((v) => (v.s > 1.02 ? { s: 1, x: 0, y: 0 } : clamp(zoomAt(v, 2.5, e.clientX - cx, e.clientY - cy))));
      } else {
        lastTap.current = now;
      }
    }
  };

  return (
    <div class="zoom-box" ref={box} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <img
        ref={img}
        src={src}
        alt=""
        draggable={false}
        decoding="async"
        class={pointers.current.size ? '' : 'settle'}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
      />
    </div>
  );
}
