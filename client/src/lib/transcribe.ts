// Voice message -> text, on this phone. See transcribe.worker.ts.

import { mediaUrl } from './media';
import type { Msg } from './store';

export type TranscribeStep = { type: 'download'; pct: number } | { type: 'working' };

const READY = 'haven.speechModel';
let worker: Worker | null = null;
const waiting = new Map<string, { step: (s: TranscribeStep) => void; done: (t: string) => void; fail: (e: Error) => void }>();

export const transcribeSupported = () => typeof Worker !== 'undefined' && typeof OfflineAudioContext !== 'undefined' && typeof WebAssembly !== 'undefined';
/** The speech model was downloaded before (no need to warn about the download). */
export const speechModelReady = () => { try { return localStorage.getItem(READY) === '1'; } catch { return false; } };

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: string; type: string; pct?: number; text?: string; message?: string }>) => {
    const w = waiting.get(e.data.id);
    if (!w) return;
    if (e.data.type === 'download') w.step({ type: 'download', pct: e.data.pct ?? 0 });
    else if (e.data.type === 'working') {
      try { localStorage.setItem(READY, '1'); } catch { /* fine */ }
      w.step({ type: 'working' });
    } else if (e.data.type === 'done') { waiting.delete(e.data.id); w.done(e.data.text ?? ''); }
    else if (e.data.type === 'error') { waiting.delete(e.data.id); w.fail(new Error(e.data.message || 'Transcription failed.')); }
  };
  worker.onerror = () => {
    for (const w of waiting.values()) w.fail(new Error('Transcription failed.'));
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Decode the voice message and resample it to 16 kHz mono, as Whisper expects. */
async function toPcm16k(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  const decoded = await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(bytes);
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

/** lang: 'de' or 'en' (Whisper here can't tell the language by itself). */
export async function transcribe(msg: Msg, lang: 'de' | 'en', step: (s: TranscribeStep) => void): Promise<string> {
  if (!msg.media) throw new Error('No voice message.');
  const blob = await (await fetch(await mediaUrl(msg.id, msg.media))).blob();
  const audio = await toPcm16k(blob);
  const id = `${msg.id}:${Date.now()}`;
  return new Promise((done, fail) => {
    waiting.set(id, { step, done, fail });
    getWorker().postMessage({ id, audio, language: lang === 'de' ? 'german' : 'english' }, [audio.buffer]);
  });
}
