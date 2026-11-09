// Photo -> sticker: cut out the subject on this device (see cutout.worker.ts),
// trim to it, add a white outline and an optional caption, and save as PNG.

export type CutoutStep = { type: 'download'; pct: number } | { type: 'working' };

const READY = 'haven.cutoutModel';
let worker: Worker | null = null;
const waiting = new Map<string, { step: (s: CutoutStep) => void; done: (img: ImageData) => void; fail: (e: Error) => void }>();

export const cutoutModelReady = () => { try { return localStorage.getItem(READY) === '1'; } catch { return false; } };

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./cutout.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: string; type: string; pct?: number; width?: number; height?: number; data?: Uint8ClampedArray; message?: string }>) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    if (e.data.type === 'download') w.step({ type: 'download', pct: e.data.pct ?? 0 });
    else if (e.data.type === 'working') {
      try { localStorage.setItem(READY, '1'); } catch { /* fine */ }
      w.step({ type: 'working' });
    } else if (e.data.type === 'done') {
      waiting.delete(e.data.id);
      w.done(new ImageData(new Uint8ClampedArray(e.data.data!), e.data.width!, e.data.height!));
    } else if (e.data.type === 'error') { waiting.delete(e.data.id); w.fail(new Error(e.data.message || 'Cut-out failed.')); }
  };
  worker.onerror = () => {
    for (const w of waiting.values()) w.fail(new Error('Cut-out failed.'));
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Shrink big photos first: faster, and plenty for a sticker. */
async function downscale(file: Blob, max = 1024): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const r = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * r);
  c.height = Math.round(bmp.height * r);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('image'))), 'image/jpeg', 0.92));
}

/** The photo with everything but the subject made transparent. */
export async function cutOut(file: Blob, step: (s: CutoutStep) => void): Promise<ImageData> {
  const blob = await downscale(file);
  const id = `${Date.now()}:${Math.random()}`;
  return new Promise((done, fail) => {
    waiting.set(id, { step, done, fail });
    getWorker().postMessage({ id, blob });
  });
}

/** Plain photo as ImageData (for "use the whole photo"). */
export async function wholePhoto(file: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(await downscale(file, 768));
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

export type StickerStyle = { outline: boolean; text: string; textStyle: 'meme' | 'pill' | 'red' };

/** Final sticker: trimmed to the subject, white outline, caption under it, max 512 px, PNG. */
export async function composeSticker(img: ImageData, style: StickerStyle): Promise<Blob> {
  // Bounding box of visible pixels.
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) { x0 = 0; y0 = 0; x1 = img.width - 1; y1 = img.height - 1; }
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const src = document.createElement('canvas');
  src.width = img.width;
  src.height = img.height;
  src.getContext('2d')!.putImageData(img, 0, 0);

  const size = 512;
  const border = style.outline ? 10 : 0;
  const textH = style.text.trim() ? 92 : 0;
  const scale = Math.min((size - 2 * border - 8) / bw, (size - 2 * border - 8 - textH) / bh);
  const dw = Math.round(bw * scale);
  const dh = Math.round(bh * scale);
  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const ctx = out.getContext('2d')!;
  const ox = Math.round((size - dw) / 2);
  const oy = Math.round((size - textH - dh) / 2);

  if (style.outline) {
    // White outline: the silhouette drawn in white, shifted around in a circle.
    const sil = document.createElement('canvas');
    sil.width = dw;
    sil.height = dh;
    const sctx = sil.getContext('2d')!;
    sctx.drawImage(src, x0, y0, bw, bh, 0, 0, dw, dh);
    sctx.globalCompositeOperation = 'source-in';
    sctx.fillStyle = '#ffffff';
    sctx.fillRect(0, 0, dw, dh);
    for (let a = 0; a < 360; a += 15) {
      const r = (a * Math.PI) / 180;
      ctx.drawImage(sil, ox + Math.cos(r) * border, oy + Math.sin(r) * border);
    }
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 6;
    ctx.globalCompositeOperation = 'destination-over';
    ctx.drawImage(out, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
  }
  ctx.drawImage(src, x0, y0, bw, bh, ox, oy, dw, dh);

  const text = style.text.trim().toUpperCase().slice(0, 40);
  if (text) {
    let fs = 54;
    ctx.font = `900 ${fs}px -apple-system, "Inter", "Helvetica Neue", Arial, sans-serif`;
    while (ctx.measureText(text).width > size - 40 && fs > 22) {
      fs -= 2;
      ctx.font = `900 ${fs}px -apple-system, "Inter", "Helvetica Neue", Arial, sans-serif`;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ty = size - textH / 2 - 4;
    const tw = ctx.measureText(text).width;
    if (style.textStyle === 'meme') {
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.round(fs / 5);
      ctx.strokeStyle = '#141412';
      ctx.strokeText(text, size / 2, ty);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(text, size / 2, ty);
    } else {
      const ph = fs + 26;
      const pw = tw + 44;
      ctx.fillStyle = style.textStyle === 'red' ? '#d71921' : '#141412';
      ctx.beginPath();
      ctx.roundRect?.(size / 2 - pw / 2, ty - ph / 2, pw, ph, ph / 2);
      ctx.fill();
      ctx.fillStyle = '#f8f7f3';
      ctx.fillText(text, size / 2, ty + 1);
    }
  }
  return new Promise((ok, fail) => out.toBlob((b) => (b ? ok(b) : fail(new Error('png'))), 'image/png'));
}
