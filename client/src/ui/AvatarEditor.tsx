// Move and scale a new profile picture inside the circle before it is used.
// Drag to move, pinch / scroll / slider to zoom. Everything happens on the
// device; only the final, re-encoded square leaves it.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { getNav } from './nav';
import { openPicture, renderAvatar, type Crop } from '../lib/image';
import { Spinner, toast } from './components';

const MAX_ZOOM = 5;
/** Below 1 the picture gets smaller than the circle; the gap is filled with a blurred copy. */
const MIN_ZOOM = 0.4;

/** Let the user frame the picture. Resolves with the JPEG, or null if cancelled. */
export async function editAvatar(file: File): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await openPicture(file);
  } catch (err) {
    toast(err instanceof Error ? err.message : 'This picture could not be opened.', 'error');
    return null;
  }
  const url = URL.createObjectURL(file);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (blob: Blob | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      if (!blob) bitmap.close();
      resolve(blob);
    };
    getNav().present(
      (close) => (
        <AvatarEditor
          url={url}
          width={bitmap.width}
          height={bitmap.height}
          onCancel={() => { finish(null); close(); }}
          onDone={async (crop) => {
            const blob = await renderAvatar(bitmap, crop);
            finish(blob);
            await close();
          }}
        />
      ),
      { variant: 'editor', onClose: () => finish(null) },
    );
  });
}

type View = { zoom: number; x: number; y: number };

function AvatarEditor({ url, width, height, onCancel, onDone }: {
  url: string; width: number; height: number; onCancel: () => void; onDone: (crop: Crop) => Promise<void>;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [d, setD] = useState(0); // circle diameter in CSS px
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;

  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setD(Math.max(160, Math.min(el.clientWidth - 40, el.clientHeight - 40, 420)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The picture always covers the circle: base scale fits its short side to the diameter.
  const base = d / Math.min(width, height);
  const clamp = (v: View): View => {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom));
    // Bigger than the circle: it must cover it. Smaller: it must stay inside it.
    const maxX = Math.abs(width * base * zoom - d) / 2;
    const maxY = Math.abs(height * base * zoom - d) / 2;
    return { zoom, x: Math.min(maxX, Math.max(-maxX, v.x)), y: Math.min(maxY, Math.max(-maxY, v.y)) };
  };
  const update = (fn: (v: View) => View) => setView((v) => clamp(fn(v)));

  // Zoom around a point (relative to the circle centre) so it stays under the fingers.
  const zoomAt = (v: View, zoom: number, px: number, py: number): View => {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const k = z / v.zoom;
    return { zoom: z, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
  };

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null);

  const centre = () => {
    const r = stage.current!.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  };
  const twoFinger = () => {
    const [a, b] = [...pointers.current.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  };

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();
    stage.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) gesture.current = twoFinger();
  };
  const onPointerMove = (e: PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const next = { x: e.clientX, y: e.clientY };
    if (pointers.current.size === 1) {
      pointers.current.set(e.pointerId, next);
      update((v) => ({ ...v, x: v.x + next.x - prev.x, y: v.y + next.y - prev.y }));
      return;
    }
    pointers.current.set(e.pointerId, next);
    if (pointers.current.size !== 2 || !gesture.current) return;
    const g = twoFinger();
    const last = gesture.current;
    gesture.current = g;
    const { cx, cy } = centre();
    update((v) => {
      const moved = { ...v, x: v.x + g.mid.x - last.mid.x, y: v.y + g.mid.y - last.mid.y };
      return zoomAt(moved, v.zoom * (g.dist / Math.max(1, last.dist)), g.mid.x - cx, g.mid.y - cy);
    });
  };
  const onPointerUp = (e: PointerEvent) => {
    pointers.current.delete(e.pointerId);
    gesture.current = pointers.current.size === 2 ? twoFinger() : null;
  };

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { cx, cy } = centre();
      update((v) => zoomAt(v, v.zoom * Math.exp(-e.deltaY * 0.002), e.clientX - cx, e.clientY - cy));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [d]);

  const done = async () => {
    if (busy || !d) return;
    setBusy(true);
    const v = viewRef.current;
    const scale = base * v.zoom; // CSS px per picture px
    const side = d / scale;
    const sx = width / 2 - v.x / scale - side / 2;
    const sy = height / 2 - v.y / scale - side / 2;
    try {
      // Zoomed out, the square reaches past the picture's edges; renderAvatar fills that with a blur.
      await onDone({ side, sx, sy });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'This picture could not be prepared.', 'error');
      setBusy(false);
    }
  };

  const w = width * base * view.zoom;
  const h = height * base * view.zoom;

  return (
    <div class="avatar-editor">
      <p class="avatar-editor-title">Move and Scale</p>
      <div
        ref={stage}
        class="avatar-editor-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDblClick={() => update((v) => (Math.abs(v.zoom - 1) > 0.01 ? { zoom: 1, x: 0, y: 0 } : { ...v, zoom: 2 }))}
      >
        {d > 0 && view.zoom < 1 && <div class="avatar-editor-blur" style={{ width: `${d}px`, height: `${d}px`, backgroundImage: `url(${url})` }} aria-hidden="true" />}
        {d > 0 && (
          <img
            src={url}
            alt=""
            draggable={false}
            style={{ width: `${w}px`, height: `${h}px`, transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))` }}
          />
        )}
        <div class="avatar-editor-mask" style={{ width: `${d}px`, height: `${d}px` }} aria-hidden="true" />
      </div>
      <div class="avatar-editor-zoom">
        <span aria-hidden="true">−</span>
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.01}
          value={view.zoom}
          aria-label="Zoom"
          onInput={(e) => {
            const z = Number((e.target as HTMLInputElement).value);
            update((v) => zoomAt(v, z, 0, 0));
          }}
        />
        <span aria-hidden="true">+</span>
      </div>
      <div class="avatar-editor-actions">
        <button class="avatar-editor-btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button class="avatar-editor-btn primary" onClick={done} disabled={busy || !d}>{busy ? <Spinner size={18} /> : 'Choose'}</button>
      </div>
    </div>
  );
}
