// Attachments: photos, videos, voice messages.
//
// Every file is encrypted on the device with a fresh AES-256-GCM key before it
// is uploaded. The key travels only inside the end-to-end encrypted message,
// so the storage server holds nothing but ciphertext.

import { api } from './api';
import { fromB64u, toB64u, type MediaPayload } from './crypto';
import * as idb from './idb';

export const MAX_FILE = 48 * 1024 * 1024;

export type MediaRef = MediaPayload;

// ------------------------------------------------------------------ encryption

export async function encryptBlob(blob: Blob) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await blob.arrayBuffer());
  return { data, key: toB64u(raw), iv: toB64u(iv) };
}

async function decryptBytes(data: ArrayBuffer, ref: Pick<MediaRef, 'key' | 'iv' | 'mime'>) {
  const key = await crypto.subtle.importKey('raw', fromB64u(ref.key), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64u(ref.iv) }, key, data);
  return new Blob([plain], { type: ref.mime });
}

// ------------------------------------------------------------------ transfer

/** Encrypt and upload; returns the completed reference. */
export async function uploadMedia(convId: string, blob: Blob, ref: Omit<MediaRef, 'path' | 'key' | 'iv' | 'size'>): Promise<MediaRef> {
  if (blob.size > MAX_FILE) throw new Error('This file is larger than 48 MB.');
  const { data, key, iv } = await encryptBlob(blob);
  const { path, uploadUrl } = await api<{ path: string; uploadUrl: string }>('POST', '/api/attachments', { conversationId: convId, size: data.byteLength });
  const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data });
  if (!res.ok) throw new Error('The upload failed. Please try again.');
  return { ...ref, path, key, iv, size: blob.size };
}

const objectUrls = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

/** Object URL for an attachment: from memory, from this device, or downloaded and decrypted. */
export function mediaUrl(id: string, ref: MediaRef): Promise<string> {
  const cached = objectUrls.get(id);
  if (cached) return Promise.resolve(cached);
  let p = inflight.get(id);
  if (!p) {
    p = (async () => {
      let blob = await idb.get<Blob>('files', id);
      if (!blob) {
        if (!ref.path) throw new Error('Not uploaded yet');
        const { url } = await api<{ url: string }>('POST', '/api/attachments/url', { path: ref.path });
        const res = await fetch(url);
        if (!res.ok) throw new Error(res.status === 400 || res.status === 404 ? 'This file is no longer available.' : 'Could not load this file.');
        blob = await decryptBytes(await res.arrayBuffer(), ref);
        if (!ref.viewOnce) await idb.put('files', blob, id).catch(() => {});
      }
      const url = URL.createObjectURL(blob);
      objectUrls.set(id, url);
      return url;
    })().finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

export async function storeLocalFile(id: string, blob: Blob) {
  await idb.put('files', blob, id).catch(() => {});
}

export async function forgetFile(id: string, ref?: MediaRef) {
  const url = objectUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  objectUrls.delete(id);
  await idb.del('files', id).catch(() => {});
  if (ref?.path) await api('POST', '/api/attachments/delete', { path: ref.path }).catch(() => {});
}

// ------------------------------------------------------------------ preparing files

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This picture could not be opened.'));
    };
    img.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the picture.'))), type, quality));
}

function drawScaled(source: CanvasImageSource, w: number, h: number, max: number) {
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function thumbOf(source: CanvasImageSource, w: number, h: number) {
  const canvas = drawScaled(source, w, h, 24);
  return canvas.toDataURL('image/jpeg', 0.5);
}

/**
 * Re-encode a photo, metadata (location, camera) removed. Standard: at most
 * 2048 px. HD: full resolution up to 4096 px at high quality.
 */
export async function preparePhoto(file: Blob, hd = false) {
  const img = await loadImage(file);
  const canvas = drawScaled(img, img.naturalWidth, img.naturalHeight, hd ? 4096 : 2048);
  const blob = await canvasBlob(canvas, 'image/jpeg', hd ? 0.92 : 0.84);
  return { blob, w: canvas.width, h: canvas.height, thumb: await thumbOf(img, img.naturalWidth, img.naturalHeight) };
}

/** Read size, duration and a poster frame from a video. */
export function prepareVideo(file: Blob, maxSize: number = MAX_FILE): Promise<{ blob: Blob; w: number; h: number; duration: number; thumb?: string }> {
  return new Promise((resolve, reject) => {
    if (file.size > maxSize) return reject(new Error('Videos can be up to 48 MB.'));
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    let done = false;
    const finish = (thumb?: string) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      const duration = Number.isFinite(video.duration) ? Math.round(video.duration) : 0;
      resolve({ blob: file, w: video.videoWidth || 16, h: video.videoHeight || 9, duration, thumb });
    };
    video.onloadeddata = async () => {
      try {
        finish(await thumbOf(video, video.videoWidth, video.videoHeight));
      } catch {
        finish();
      }
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This video could not be opened.'));
    };
    setTimeout(() => finish(), 4000);
    video.src = url;
  });
}

// ------------------------------------------------------------------ voice recording

export interface Recording {
  stop(): Promise<{ blob: Blob; duration: number; wave: number[] } | null>;
  cancel(): void;
  level(): number;
  startedAt: number;
}

const VOICE_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

export async function startRecording(): Promise<Recording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('Voice messages are not supported in this browser.');
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    throw new Error('Haven needs microphone access to record. You can allow it in your settings.');
  }
  const mimeType = VOICE_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  const samples: number[] = [];
  let current = 0;
  const sampler = setInterval(() => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    current = Math.min(1, Math.sqrt(sum / buf.length) * 3);
    samples.push(current);
  }, 80);

  const startedAt = Date.now();
  recorder.start(250);
  const release = () => {
    clearInterval(sampler);
    stream.getTracks().forEach((t) => t.stop());
    ctx.close().catch(() => {});
  };

  return {
    startedAt,
    level: () => current,
    cancel() {
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
    stop() {
      return new Promise((resolve) => {
        recorder.onstop = () => {
          release();
          const duration = Math.round((Date.now() - startedAt) / 1000);
          if (duration < 1 || !chunks.length) return resolve(null);
          const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/mp4' });
          // Squash the level samples into 40 bars.
          const bars = 40;
          const wave = Array.from({ length: bars }, (_, i) => {
            const slice = samples.slice(Math.floor((i * samples.length) / bars), Math.floor(((i + 1) * samples.length) / bars));
            const peak = slice.length ? Math.max(...slice) : 0;
            return Math.round(Math.max(0.08, peak) * 100) / 100;
          });
          resolve({ blob, duration, wave });
        };
        recorder.stop();
      });
    },
  };
}

// ------------------------------------------------------------------ video compression

/** Can this browser re-encode a video (canvas + MediaRecorder)? */
function recorderMime(): string | null {
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) return null;
  for (const t of ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return null;
}

/**
 * Shrink a long or large video so it fits the upload limit: it is played once
 * (in real time) into a smaller canvas and recorded again with its sound.
 * Must be started from a tap so the browser lets it play with sound.
 */
export async function compressVideo(file: Blob, duration: number, onProgress: (p: number) => void, signal?: AbortSignal): Promise<Blob> {
  const mime = recorderMime();
  if (!mime) throw new Error('This video is too large. Please choose a shorter one.');
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.playsInline = true;
  video.preload = 'auto';
  // Keep it in the document (off screen) so every browser keeps decoding frames.
  video.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(video);
  const audio = new AudioContext();
  try {
    await audio.resume().catch(() => {});
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('This video could not be opened.'));
    });
    const seconds = Math.max(1, duration || video.duration || 1);
    // Fit into ~44 MB, never above 2.5 Mbit/s; smaller frames for lower rates.
    const total = Math.min(2_600_000, (44 * 1024 * 1024 * 8) / seconds);
    const videoBits = Math.max(400_000, total - 128_000);
    const longSide = videoBits >= 1_800_000 ? 1280 : videoBits >= 1_000_000 ? 960 : 720;
    const scale = Math.min(1, longSide / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round((video.videoWidth * scale) / 2) * 2);
    canvas.height = Math.max(2, Math.round((video.videoHeight * scale) / 2) * 2);
    const ctx = canvas.getContext('2d')!;
    const stream = canvas.captureStream(30);
    try {
      const source = audio.createMediaElementSource(video);
      const dest = audio.createMediaStreamDestination();
      source.connect(dest);
      for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    } catch {
      // No sound track available: keep the picture.
    }
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: videoBits, audioBitsPerSecond: 128_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    let raf = 0;
    const draw = () => {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      onProgress(Math.min(0.99, video.currentTime / seconds));
      if (!video.ended) raf = requestAnimationFrame(draw);
    };
    const abort = () => { video.pause(); if (recorder.state !== 'inactive') recorder.stop(); };
    signal?.addEventListener('abort', abort);
    recorder.start(1000);
    await video.play();
    raf = requestAnimationFrame(draw);
    await new Promise<void>((resolve) => { video.onended = () => resolve(); signal?.addEventListener('abort', () => resolve()); });
    cancelAnimationFrame(raf);
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const out = new Blob(chunks, { type: mime.split(';')[0] });
    if (!out.size) throw new Error('This video could not be compressed.');
    onProgress(1);
    return out;
  } finally {
    video.pause();
    video.remove();
    URL.revokeObjectURL(url);
    audio.close().catch(() => {});
  }
}
