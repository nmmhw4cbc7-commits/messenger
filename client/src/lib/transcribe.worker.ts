/// <reference lib="webworker" />
// Speech to text for voice messages, on this device (Whisper via transformers.js).
// The model is downloaded once from Hugging Face and kept in the browser cache;
// the voice message itself never leaves the phone.

const BASE = '/vendor/transformers/';
const MODEL = 'onnx-community/whisper-base';

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let asr: Promise<Asr> | null = null;
const loaded = new Map<string, [number, number]>();

function load(report: (pct: number) => void): Promise<Asr> {
  asr ??= (async () => {
    const T = await import(/* @vite-ignore */ `${BASE}transformers.min.js`);
    T.env.allowLocalModels = false;
    T.env.backends.onnx.wasm.wasmPaths = BASE;
    T.env.backends.onnx.wasm.numThreads = 1;
    return T.pipeline('automatic-speech-recognition', MODEL, {
      device: 'wasm',
      dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' },
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status !== 'progress' || !p.file || !p.total) return;
        loaded.set(p.file, [p.loaded ?? 0, p.total]);
        let a = 0;
        let b = 0;
        for (const [l, t] of loaded.values()) { a += l; b += t; }
        report(b ? Math.round((a / b) * 100) : 0);
      },
    }) as Promise<Asr>;
  })();
  asr.catch(() => { asr = null; });
  return asr;
}

self.onmessage = async (e: MessageEvent<{ id: string; audio: Float32Array; language: string }>) => {
  const { id, audio, language } = e.data;
  try {
    const run = await load((pct) => postMessage({ id, type: 'download', pct }));
    postMessage({ id, type: 'working' });
    const out = await run(audio, { chunk_length_s: 30, stride_length_s: 5, task: 'transcribe', language, return_timestamps: false });
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text).replace(/\s+/g, ' ').trim();
    postMessage({ id, type: 'done', text });
  } catch (err) {
    postMessage({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
