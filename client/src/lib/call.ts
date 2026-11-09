// Voice calls in one-to-one chats: WebRTC, directly from phone to phone.
//
// Setup messages (offer, answer, network candidates, hang up) go through the
// server, signed by the sending device; the receiver checks the signature with
// the device keys it already knows. That signature covers the DTLS fingerprint
// in the offer/answer, so the audio stream (DTLS-SRTP) is end-to-end encrypted
// and the server can't put itself in the middle.

import { api } from './api';
import { addCallNote, callEvents, signCall, verifyCall } from './engine';
import { getState, setState, type CallState } from './store';
import { randomId } from './crypto';
import { releaseMic, takeMic } from './mic';

type Signal = {
  type: 'offer' | 'answer' | 'ice' | 'hangup' | 'decline' | 'busy';
  callId: string;
  ts: number;
  sdp?: string;
  cand?: RTCIceCandidateInit;
  /** The device this is meant for (after the call was answered). */
  toDevice?: string;
};
type Envelope = { from: string; fromDevice: string; conv: string; payload: string; sig: string };

const RING_TIMEOUT = 40_000;

let pc: RTCPeerConnection | null = null;
let local: MediaStream | null = null;
let remoteAudio: HTMLAudioElement | null = null;
let peerDevice: string | null = null;
let pendingOffer: { sdp: string; fromDevice: string } | null = null;
let queuedIce: RTCIceCandidateInit[] = [];
let ringTimer: number | undefined;
let dropTimer: number | undefined;
let tone: { stop: () => void } | null = null;
let iceServers: RTCIceServer[] | null = null;

const call = () => getState().call;
const patch = (p: Partial<CallState>) => setState((s) => (s.call ? { call: { ...s.call, ...p } } : {}));

export const callsSupported = () => typeof RTCPeerConnection !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);

async function servers(): Promise<RTCIceServer[]> {
  if (iceServers) return iceServers;
  const res = await api<{ iceServers: RTCIceServer[] }>('GET', '/api/calls/ice').catch(() => null);
  iceServers = res?.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }];
  return iceServers;
}

async function send(c: { convId: string; peerId: string }, sig: Omit<Signal, 'ts'>) {
  const payload = JSON.stringify({ ...sig, ts: Date.now() });
  await api('POST', '/api/calls/signal', { convId: c.convId, to: c.peerId, payload, sig: await signCall(payload) });
}

async function microphone() {
  return takeMic();
}

function newConnection(c: CallState, list: RTCIceServer[]) {
  const conn = new RTCPeerConnection({ iceServers: list });
  conn.onicecandidate = (e) => {
    if (e.candidate) send(c, { type: 'ice', callId: c.callId, cand: e.candidate.toJSON(), toDevice: peerDevice ?? undefined }).catch(() => {});
  };
  conn.ontrack = (e) => {
    if (!remoteAudio) {
      remoteAudio = document.createElement('audio');
      remoteAudio.autoplay = true;
      remoteAudio.setAttribute('playsinline', '');
      remoteAudio.style.display = 'none';
      document.body.appendChild(remoteAudio);
    }
    remoteAudio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
    remoteAudio.play().catch(() => {});
  };
  conn.onconnectionstatechange = () => {
    const state = conn.connectionState;
    if (state === 'connected') {
      clearTimeout(dropTimer);
      stopTone();
      if (call()?.phase !== 'active') patch({ phase: 'active', startedAt: Date.now() });
    } else if (state === 'disconnected') {
      clearTimeout(dropTimer);
      dropTimer = window.setTimeout(() => finish('Connection lost', true), 10_000);
    } else if (state === 'failed') {
      finish(call()?.startedAt ? 'Connection lost' : 'Couldn’t connect', true);
    }
  };
  return conn;
}

async function flushIce() {
  if (!pc?.remoteDescription) return;
  const list = queuedIce;
  queuedIce = [];
  for (const cand of list) await pc.addIceCandidate(cand).catch(() => {});
}

// ------------------------------------------------------------------ start / answer / end

/** Call the other person in this one-to-one chat. */
export async function startCall(convId: string) {
  const me = getState().me;
  const conv = getState().convs[convId];
  const peer = conv?.members.find((m) => m.id !== me?.id);
  if (!me || !conv || conv.kind !== 'direct' || !peer) return;
  if (call()) return;
  const c: CallState = { callId: randomId(), convId, peerId: peer.id, direction: 'out', phase: 'calling', muted: false, speaker: false };
  setState({ call: c });
  ringback();
  try {
    local = await microphone();
    pc = newConnection(c, await servers());
    for (const track of local.getTracks()) pc.addTrack(track, local);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await send(c, { type: 'offer', callId: c.callId, sdp: pc.localDescription!.sdp });
    ringTimer = window.setTimeout(() => {
      if (call()?.phase === 'calling') {
        send(c, { type: 'hangup', callId: c.callId }).catch(() => {});
        finish('No answer', false, 'missed');
      }
    }, RING_TIMEOUT);
  } catch (err) {
    finish(micError(err), false, 'none');
  }
}

/** Answer the ringing call. */
export async function acceptCall() {
  const c = call();
  if (!c || c.phase !== 'ringing' || !pendingOffer) return;
  stopTone();
  patch({ phase: 'connecting' });
  try {
    peerDevice = pendingOffer.fromDevice;
    local = await microphone();
    pc = newConnection(c, await servers());
    for (const track of local.getTracks()) pc.addTrack(track, local);
    await pc.setRemoteDescription({ type: 'offer', sdp: pendingOffer.sdp });
    await flushIce();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await send(c, { type: 'answer', callId: c.callId, sdp: pc.localDescription!.sdp, toDevice: peerDevice });
    pendingOffer = null;
  } catch (err) {
    send(c, { type: 'hangup', callId: c.callId }).catch(() => {});
    finish(micError(err), false, 'none');
  }
}

export function declineCall() {
  const c = call();
  if (!c) return;
  send(c, { type: 'decline', callId: c.callId }).catch(() => {});
  finish('Declined', false, 'missed');
}

export function hangUp() {
  const c = call();
  if (!c) return;
  send(c, { type: 'hangup', callId: c.callId, toDevice: peerDevice ?? undefined }).catch(() => {});
  finish('Call ended', false);
}

export function toggleMute() {
  const c = call();
  if (!c || !local) return;
  const muted = !c.muted;
  for (const t of local.getAudioTracks()) t.enabled = !muted;
  patch({ muted });
}

/** Loudspeaker: only where the browser can pick the output (not on iPhone). */
export const canPickSpeaker = () => typeof (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: unknown }).setSinkId === 'function';

function micError(err: unknown) {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Allow Haven to use the microphone to call.';
  if (name === 'NotFoundError') return 'No microphone found.';
  return 'Couldn’t start the call.';
}

/**
 * End the call here. note: what to write into the chat ("Call · 2:31",
 * "Missed call", or nothing).
 */
function finish(text: string, failed: boolean, note: 'auto' | 'missed' | 'none' = 'auto') {
  const c = call();
  clearTimeout(ringTimer);
  clearTimeout(dropTimer);
  stopTone();
  const old = pc;
  pc = null;
  if (old && c) {
    const outcome = c.startedAt ? (failed ? 'dropped' : 'ok') : failed ? 'failed' : c.phase === 'connecting' ? 'ended_connecting' : 'not_answered';
    report(old, outcome, c.startedAt ? Math.round((Date.now() - c.startedAt) / 1000) : 0).finally(() => old.close());
  } else old?.close();
  if (local) releaseMic();
  local = null;
  if (remoteAudio) {
    remoteAudio.srcObject = null;
    remoteAudio.remove();
    remoteAudio = null;
  }
  peerDevice = null;
  pendingOffer = null;
  queuedIce = [];
  if (!c) return;
  const caller = c.direction === 'out' ? getState().me!.id : c.peerId;
  if (note !== 'none') {
    if (c.startedAt) {
      const secs = Math.max(1, Math.round((Date.now() - c.startedAt) / 1000));
      addCallNote(c.convId, { type: 'call_ended', actorId: caller, title: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` }).catch(() => {});
    } else if (failed) {
      addCallNote(c.convId, { type: 'call_failed', actorId: caller }).catch(() => {});
    } else {
      addCallNote(c.convId, { type: 'call_missed', actorId: caller }).catch(() => {});
    }
  }
  patch({ phase: 'ended', endText: text });
  window.setTimeout(() => { if (getState().call?.callId === c.callId) setState({ call: null }); }, 1400);
}

/** Tell the server how the call went (only connection types, no people or content), to fix call problems. */
async function report(conn: RTCPeerConnection, outcome: string, secs: number) {
  try {
    const stats = await conn.getStats();
    const local = new Set<string>();
    const remote = new Set<string>();
    let pair = '';
    const byId = new Map<string, RTCStats & Record<string, unknown>>();
    stats.forEach((r) => byId.set(r.id, r as RTCStats & Record<string, unknown>));
    for (const r of byId.values()) {
      if (r.type === 'local-candidate' && typeof r.candidateType === 'string') local.add(r.candidateType);
      if (r.type === 'remote-candidate' && typeof r.candidateType === 'string') remote.add(r.candidateType);
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
        const l = byId.get(String(r.localCandidateId))?.candidateType;
        const rm = byId.get(String(r.remoteCandidateId))?.candidateType;
        pair = `${l}-${rm}`;
      }
    }
    const ua = /iPhone|iPad/.test(navigator.userAgent) ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'desktop';
    const standalone = matchMedia('(display-mode: standalone)').matches ? ' app' : '';
    await api('POST', '/api/calls/report', { outcome, local: [...local].sort().join(','), remote: [...remote].sort().join(','), pair, secs, ua: ua + standalone });
  } catch {
    // Diagnostics only.
  }
}

// ------------------------------------------------------------------ incoming setup messages

const seen = new Set<string>();

callEvents.addEventListener('signal', (e) => {
  onSignal((e as CustomEvent<string>).detail).catch((err) => console.warn('call signal', err));
});

async function onSignal(raw: string) {
  let env: Envelope;
  let sig: Signal;
  try {
    env = JSON.parse(raw);
    sig = JSON.parse(env.payload);
  } catch {
    return;
  }
  const me = getState().me;
  if (!me || env.fromDevice === me.deviceId) return;
  if (Math.abs(Date.now() - sig.ts) > 60_000 && sig.type === 'offer') return;
  if (!(await verifyCall(env.conv, env.from, env.fromDevice, env.payload, env.sig))) return;
  const c = call();

  // My other device answered or declined: stop ringing here.
  if (env.from === me.id) {
    if (c && c.callId === sig.callId && c.phase === 'ringing' && sig.type !== 'ice') finish(sig.type === 'answer' ? 'Answered on another device' : 'Declined', false, 'none');
    return;
  }

  if (sig.type === 'offer') {
    const key = `${sig.callId}:offer`;
    if (seen.has(key)) return;
    seen.add(key);
    if (c && c.phase !== 'ended') {
      if (c.callId !== sig.callId) send({ convId: env.conv, peerId: env.from }, { type: 'busy', callId: sig.callId }).catch(() => {});
      return;
    }
    pendingOffer = { sdp: sig.sdp ?? '', fromDevice: env.fromDevice };
    queuedIce = [];
    setState({ call: { callId: sig.callId, convId: env.conv, peerId: env.from, direction: 'in', phase: 'ringing', muted: false, speaker: false } });
    ringtone();
    ringTimer = window.setTimeout(() => { if (call()?.phase === 'ringing') finish('Missed call', false, 'missed'); }, RING_TIMEOUT + 5000);
    return;
  }

  if (!c || c.callId !== sig.callId || env.from !== c.peerId) return;
  if (sig.toDevice && sig.toDevice !== me.deviceId) return;

  switch (sig.type) {
    case 'answer':
      if (c.direction !== 'out' || !pc || pc.remoteDescription) return;
      clearTimeout(ringTimer);
      stopTone();
      peerDevice = env.fromDevice;
      patch({ phase: 'connecting' });
      await pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp ?? '' });
      await flushIce();
      break;
    case 'ice':
      if (!sig.cand) return;
      if (peerDevice && env.fromDevice !== peerDevice) return;
      if (pc?.remoteDescription) await pc.addIceCandidate(sig.cand).catch(() => {});
      else queuedIce.push(sig.cand);
      break;
    case 'decline':
      finish('Declined', false, 'missed');
      break;
    case 'busy':
      finish('Busy', false, 'missed');
      break;
    case 'hangup':
      finish(c.phase === 'ringing' ? 'Missed call' : 'Call ended', false, c.phase === 'ringing' ? 'missed' : 'auto');
      break;
  }
}

// ------------------------------------------------------------------ sounds

let audioCtx: AudioContext | null = null;

function beep(pattern: [number, number][], every: number) {
  try {
    audioCtx ??= new AudioContext();
    audioCtx.resume().catch(() => {});
  } catch {
    return null;
  }
  const ctx = audioCtx;
  let stopped = false;
  const play = () => {
    if (stopped) return;
    let t = ctx.currentTime;
    for (const [freq, len] of pattern) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.02);
      gain.gain.linearRampToValueAtTime(0, t + len);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + len + 0.05);
      t += len + 0.08;
    }
  };
  play();
  const timer = window.setInterval(play, every);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}

function ringtone() {
  stopTone();
  tone = beep([[880, 0.18], [660, 0.18], [880, 0.18]], 1800);
  navigator.vibrate?.([400, 200, 400]);
}

function ringback() {
  stopTone();
  tone = beep([[440, 0.9]], 3000);
}

function stopTone() {
  tone?.stop();
  tone = null;
  navigator.vibrate?.(0);
}
