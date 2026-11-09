/// <reference lib="webworker" />
// Cut the subject out of a photo (person, pet, object) on this device, for stickers.
// Model: ormbg (open background removal, Apache-2.0), downloaded once and cached.

const BASE = '/vendor/transformers/';
const MODEL = 'onnx-community/ormbg-ONNX';

type Seg = (img: unknown) => Promise<{ width: number; height: number; data: Uint8ClampedArray; channels: number }[] | { width: number; height: number; data: Uint8ClampedArray; channels: number }>;
// deno-lint-ignore no-explicit-any
let T: any = null;
let seg: Promise<Seg> | null = null;
const loaded = new Map<string, [number, number]>();

function load(report: (pct: number) => void): Promise<Seg> {
  seg ??= (async () => {
    T = await import(/* @vite-ignore */ `${BASE}transformers.min.js`);
    T.env.allowLocalModels = false;
    T.env.backends.onnx.wasm.wasmPaths = BASE;
    T.env.backends.onnx.wasm.numThreads = 1;
    return T.pipeline('background-removal', MODEL, {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status !== 'progress' || !p.file || !p.total) return;
        loaded.set(p.file, [p.loaded ?? 0, p.total]);
        let a = 0;
        let b = 0;
        for (const [l, t] of loaded.values()) { a += l; b += t; }
        report(b ? Math.round((a / b) * 100) : 0);
      },
    }) as Promise<Seg>;
  })();
  seg.catch(() => { seg = null; });
  return seg;
}

self.onmessage = async (e: MessageEvent<{ id: string; blob: Blob }>) => {
  const { id, blob } = e.data;
  try {
    const run = await load((pct) => postMessage({ id, type: 'download', pct }));
    postMessage({ id, type: 'working' });
    const image = await T.RawImage.fromBlob(blob);
    const out = await run(image);
    const res = Array.isArray(out) ? out[0] : out;
    const rgba = res.channels === 4 ? res.data : (res as unknown as { rgba: () => { data: Uint8ClampedArray } }).rgba?.().data ?? res.data;
    postMessage({ id, type: 'done', width: res.width, height: res.height, data: rgba }, [rgba.buffer]);
  } catch (err) {
    postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
export {};
