// Photo editor before sending: draw, add text and Haven stickers. Items can be
// moved with one finger, scaled and turned with two, and dragged onto the bin to
// remove them. The result is a new JPEG; the original file is not changed.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { getNav } from './nav';
import { Close, Trash } from './icons';
import { STICKERS, stickerSvg, stickerUrl } from '../lib/stickers';

type Stroke = { color: string; width: number; points: [number, number][] };
type Item = {
  id: number;
  kind: 'text' | 'sticker';
  x: number; // centre, 0..1 of the image width
  y: number; // centre, 0..1 of the image height
  scale: number;
  rot: number; // radians
  text?: string;
  style?: 'pill' | 'plain' | 'red';
  sticker?: string;
  value?: string;
};

const COLORS = ['#f8f7f3', '#141412', '#d71921', '#ff6a00', '#ffd400', '#1db954', '#2f6bff'];
const SIZES = [4, 8, 14];
const STICKER_H = 64; // display height of a sticker at scale 1
const TEXT_PX = 26; // display font size at scale 1

/** Open the editor. Resolves with the edited photo, or null if nothing was changed / it was cancelled. */
export function editPhoto(file: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (b: Blob | null) => { if (!done) { done = true; resolve(b); } };
    getNav().present((close) => <Editor file={file} close={async (b) => { finish(b); await close(); }} />, { variant: 'editor', onClose: () => finish(null) });
  });
}

function Editor({ file, close }: { file: Blob; close: (b: Blob | null) => Promise<void> }) {
  const [url] = useState(() => URL.createObjectURL(file));
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<'move' | 'draw'>('move');
  const [color, setColor] = useState(COLORS[2]);
  const [size, setSize] = useState(SIZES[1]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<('stroke' | 'item')[]>([]);
  const [textEdit, setTextEdit] = useState<{ id?: number; text: string; style: Item['style'] } | null>(null);
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [overBin, setOverBin] = useState(false);
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);

  useEffect(() => {
    const i = new Image();
    i.onload = () => setImg(i);
    i.src = url;
  }, [url]);

  // Fit the photo into the stage.
  useLayoutEffect(() => {
    const fit = () => {
      const el = stage.current;
      if (!el || !img) return;
      const sw = el.clientWidth;
      const sh = el.clientHeight;
      const r = Math.min(sw / img.naturalWidth, sh / img.naturalHeight);
      setBox({ w: Math.round(img.naturalWidth * r), h: Math.round(img.naturalHeight * r) });
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [img]);

  // Redraw strokes on the overlay.
  useEffect(() => {
    const c = canvas.current;
    if (!c || !box.w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = box.w * dpr;
    c.height = box.h * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStrokes(ctx, strokes, box.w, 1);
  }, [strokes, box]);

  // ---- drawing
  const drawing = useRef<Stroke | null>(null);
  const onDrawDown = (e: PointerEvent) => {
    if (mode !== 'draw' || !e.isPrimary) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    drawing.current = { color, width: size / box.w, points: [[(e.clientX - r.left) / box.w, (e.clientY - r.top) / box.h]] };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setStrokes((s) => [...s, drawing.current!]);
  };
  const onDrawMove = (e: PointerEvent) => {
    const d = drawing.current;
    if (!d) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    d.points.push([(e.clientX - r.left) / box.w, (e.clientY - r.top) / box.h]);
    setStrokes((s) => [...s.slice(0, -1), { ...d }]);
  };
  const onDrawUp = () => {
    if (!drawing.current) return;
    drawing.current = null;
    setHistory((h) => [...h, 'stroke']);
  };

  // ---- items: one finger moves, two fingers scale and turn
  const gesture = useRef<{ id: number; pts: Map<number, [number, number]>; start: { x: number; y: number; scale: number; rot: number; d: number; a: number; cx: number; cy: number } } | null>(null);
  const onItemDown = (e: PointerEvent, it: Item) => {
    if (mode !== 'move') return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const g = gesture.current?.id === it.id ? gesture.current : { id: it.id, pts: new Map(), start: { x: it.x, y: it.y, scale: it.scale, rot: it.rot, d: 0, a: 0, cx: 0, cy: 0 } };
    g.pts.set(e.pointerId, [e.clientX, e.clientY]);
    const p = [...g.pts.values()];
    const cx = p.reduce((s, q) => s + q[0], 0) / p.length;
    const cy = p.reduce((s, q) => s + q[1], 0) / p.length;
    g.start = { x: it.x, y: it.y, scale: it.scale, rot: it.rot, cx, cy, d: p.length > 1 ? Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]) : 0, a: p.length > 1 ? Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]) : 0 };
    gesture.current = g;
    setDragging(it.id);
  };
  const onItemMove = (e: PointerEvent) => {
    const g = gesture.current;
    if (!g || !g.pts.has(e.pointerId)) return;
    g.pts.set(e.pointerId, [e.clientX, e.clientY]);
    const p = [...g.pts.values()];
    const cx = p.reduce((s, q) => s + q[0], 0) / p.length;
    const cy = p.reduce((s, q) => s + q[1], 0) / p.length;
    const patch: Partial<Item> = { x: g.start.x + (cx - g.start.cx) / box.w, y: g.start.y + (cy - g.start.cy) / box.h };
    if (p.length > 1 && g.start.d) {
      const d = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
      const a = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0]);
      patch.scale = Math.min(6, Math.max(0.3, g.start.scale * (d / g.start.d)));
      patch.rot = g.start.rot + (a - g.start.a);
    }
    setItems((list) => list.map((x) => (x.id === g.id ? { ...x, ...patch } : x)));
    setOverBin(p.length === 1 && window.innerHeight - cy < 110);
  };
  const onItemUp = (e: PointerEvent, it: Item) => {
    const g = gesture.current;
    if (!g) return;
    g.pts.delete(e.pointerId);
    if (g.pts.size) {
      // One finger left: continue moving from here.
      const [pt] = [...g.pts.values()];
      const cur = items.find((x) => x.id === it.id) ?? it;
      g.start = { x: cur.x, y: cur.y, scale: cur.scale, rot: cur.rot, cx: pt[0], cy: pt[1], d: 0, a: 0 };
      return;
    }
    gesture.current = null;
    setDragging(null);
    if (overBin) {
      setItems((list) => list.filter((x) => x.id !== it.id));
      setOverBin(false);
    }
  };

  const addItem = (item: Omit<Item, 'id' | 'x' | 'y' | 'scale' | 'rot'>) => {
    setItems((list) => [...list, { id: nextId.current++, x: 0.5, y: 0.45, scale: 1, rot: 0, ...item }]);
    setHistory((h) => [...h, 'item']);
    setMode('move');
  };

  const undo = () => {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    if (last === 'stroke') setStrokes((s) => s.slice(0, -1));
    else setItems((l) => l.slice(0, -1));
  };

  const finish = async () => {
    if (!img) return;
    if (!strokes.length && !items.length) return close(null);
    setBusy(true);
    try {
      close(await render(img, strokes, items, box.w));
    } catch {
      setBusy(false);
    }
  };

  const changed = strokes.length > 0 || items.length > 0;

  return (
    <div class="editor">
      <div class="editor-top">
        <button class="editor-icon" onClick={() => close(null)} aria-label="Cancel"><Close size={22} /></button>
        <div class="editor-tools">
          <button class={`editor-tool${mode === 'draw' ? ' on' : ''}`} onClick={() => setMode(mode === 'draw' ? 'move' : 'draw')} aria-label="Draw"><PenIcon /></button>
          <button class="editor-tool" onClick={() => setTextEdit({ text: '', style: 'pill' })} aria-label="Text">Aa</button>
          <button class="editor-tool" onClick={() => setPicking(true)} aria-label="Sticker"><StickerIcon /></button>
          <button class="editor-tool" onClick={undo} disabled={!history.length} aria-label="Undo"><UndoIcon /></button>
        </div>
        <button class="editor-done" onClick={finish} disabled={busy}>{changed ? 'Done' : 'Back'}</button>
      </div>

      <div class="editor-stage" ref={stage}>
        {img && box.w > 0 && (
          <div class="editor-photo" style={{ width: `${box.w}px`, height: `${box.h}px` }}
            onPointerDown={onDrawDown} onPointerMove={onDrawMove} onPointerUp={onDrawUp} onPointerCancel={onDrawUp}>
            <img src={url} alt="" draggable={false} />
            <canvas ref={canvas} style={{ width: `${box.w}px`, height: `${box.h}px` }} />
            {items.map((it) => (
              <div key={it.id} class={`editor-item${dragging === it.id && overBin ? ' over-bin' : ''}`}
                style={{ left: `${it.x * box.w}px`, top: `${it.y * box.h}px`, transform: `translate(-50%, -50%) rotate(${it.rot}rad) scale(${it.scale})` }}
                onPointerDown={(e) => onItemDown(e, it)} onPointerMove={onItemMove} onPointerUp={(e) => onItemUp(e, it)} onPointerCancel={(e) => onItemUp(e, it)}
                onDblClick={() => it.kind === 'text' && setTextEdit({ id: it.id, text: it.text ?? '', style: it.style })}>
                {it.kind === 'text'
                  ? <span class={`editor-text ${it.style}`} style={{ fontSize: `${TEXT_PX}px` }} data-no-i18n>{it.text}</span>
                  : <img src={stickerUrl(it.sticker!, it.value) ?? ''} alt="" style={{ height: `${STICKER_H}px` }} draggable={false} />}
              </div>
            ))}
          </div>
        )}
      </div>

      {dragging !== null ? (
        <div class={`editor-bin${overBin ? ' over' : ''}`}><Trash size={24} /></div>
      ) : mode === 'draw' ? (
        <div class="editor-palette">
          {COLORS.map((c) => <button key={c} class={`swatch${c === color ? ' on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label="Color" />)}
          <span class="editor-sep" />
          {SIZES.map((s) => <button key={s} class={`size${s === size ? ' on' : ''}`} onClick={() => setSize(s)} aria-label="Brush size"><span style={{ width: `${s + 2}px`, height: `${s + 2}px` }} /></button>)}
        </div>
      ) : (
        <p class="editor-hint">{items.length ? 'Drag to move · two fingers to resize and turn · drag onto the bin to remove' : 'Draw, write or add stickers'}</p>
      )}

      {textEdit && (
        <TextOverlay value={textEdit} onDone={(text, style) => {
          if (text.trim()) {
            if (textEdit.id) setItems((l) => l.map((x) => (x.id === textEdit.id ? { ...x, text: text.trim(), style } : x)));
            else addItem({ kind: 'text', text: text.trim(), style });
          }
          setTextEdit(null);
        }} />
      )}
      {picking && (
        <div class="editor-stickers" onClick={() => setPicking(false)}>
          <div class="editor-stickers-grid" onClick={(e) => e.stopPropagation()}>
            {STICKERS.map((s) => {
              const value = s.live?.();
              return (
                <button key={s.id} onClick={() => { addItem({ kind: 'sticker', sticker: s.id, value }); setPicking(false); }} aria-label={s.label}>
                  <img src={stickerUrl(s.id, value) ?? ''} alt="" draggable={false} />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function TextOverlay({ value, onDone }: { value: { text: string; style: Item['style'] }; onDone: (text: string, style: Item['style']) => void }) {
  const [text, setText] = useState(value.text);
  const [style, setStyle] = useState<Item['style']>(value.style ?? 'pill');
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const styles: Item['style'][] = ['pill', 'plain', 'red'];
  return (
    <div class="editor-textlayer">
      <div class="editor-textbar">
        <button class="editor-tool" onClick={() => setStyle(styles[(styles.indexOf(style) + 1) % styles.length])} aria-label="Text style">A</button>
        <button class="editor-done" onClick={() => onDone(text, style)}>Done</button>
      </div>
      <textarea ref={ref} class={`editor-textinput ${style}`} value={text} maxLength={120} rows={2}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} aria-label="Text" />
    </div>
  );
}

// ---------------------------------------------------------------- rendering the result

function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, k: number) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const h = ctx.canvas.height / (ctx.getTransform().d || 1);
  for (const s of strokes) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width * w * k;
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * w * k, y * h) : ctx.moveTo(x * w * k, y * h)));
    if (s.points.length === 1) ctx.lineTo(s.points[0][0] * w * k + 0.01, s.points[0][1] * h);
    ctx.stroke();
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = fail;
    i.src = src;
  });
}

async function render(img: HTMLImageElement, strokes: Stroke[], items: Item[], displayW: number): Promise<Blob> {
  const max = 4096;
  const r = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.round(img.naturalWidth * r);
  const H = Math.round(img.naturalHeight * r);
  const k = W / displayW; // display px -> output px
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, W, H);
  // Strokes: points are relative, widths relative to the width.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width * W;
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * W, y * H) : ctx.moveTo(x * W, y * H)));
    if (s.points.length === 1) ctx.lineTo(s.points[0][0] * W + 0.01, s.points[0][1] * H);
    ctx.stroke();
  }
  for (const it of items) {
    ctx.save();
    ctx.translate(it.x * W, it.y * H);
    ctx.rotate(it.rot);
    ctx.scale(it.scale * k, it.scale * k);
    if (it.kind === 'sticker') {
      const s = stickerSvg(it.sticker!, it.value);
      if (s) {
        const im = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(s.svg)}`);
        const h = STICKER_H;
        const w = (s.w / s.h) * h;
        ctx.drawImage(im, -w / 2, -h / 2, w, h);
      }
    } else {
      drawText(ctx, it.text ?? '', it.style ?? 'pill');
    }
    ctx.restore();
  }
  return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('render'))), 'image/jpeg', 0.92));
}

function drawText(ctx: CanvasRenderingContext2D, text: string, style: NonNullable<Item['style']>) {
  ctx.font = `700 ${TEXT_PX}px -apple-system, "Inter", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = text.split('\n');
  const lh = TEXT_PX * 1.25;
  const widths = lines.map((l) => ctx.measureText(l).width);
  const w = Math.max(...widths) + 28;
  const h = lines.length * lh + 14;
  if (style !== 'plain') {
    ctx.fillStyle = style === 'red' ? '#d71921' : '#141412';
    roundRect(ctx, -w / 2, -h / 2, w, h, Math.min(16, h / 2));
    ctx.fill();
  }
  ctx.fillStyle = '#f8f7f3';
  if (style === 'plain') {
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 6;
  }
  lines.forEach((l, i) => ctx.fillText(l, 0, -((lines.length - 1) * lh) / 2 + i * lh));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------- icons

const PenIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z" /><path d="M14 7l3 3" />
  </svg>
);
export const StickerIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M20.5 12.5V7a3.5 3.5 0 0 0-3.5-3.5H7A3.5 3.5 0 0 0 3.5 7v10A3.5 3.5 0 0 0 7 20.5h5.5l8-8Z" /><path d="M12.5 20.5v-4.5a3.5 3.5 0 0 1 3.5-3.5h4.5" />
    <circle cx="9" cy="10" r="1" fill="currentColor" stroke="none" /><circle cx="14" cy="10" r="1" fill="currentColor" stroke="none" />
  </svg>
);
const UndoIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M9 7 4.5 11.5 9 16" /><path d="M5 11.5h9a5 5 0 0 1 0 10h-2" />
  </svg>
);
