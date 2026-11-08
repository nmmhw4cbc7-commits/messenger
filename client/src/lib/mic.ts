// One shared microphone stream for voice messages and calls.
//
// iPhones ask for the microphone again whenever it was switched off for a
// while. So instead of switching it off after every voice message, the same
// stream is kept (silenced) for a few minutes and reused: recording several
// voice messages or calling right after asks only once. It is switched off
// for real after a few idle minutes and whenever Haven goes to the background.

const KEEP_MS = 3 * 60_000;

let stream: MediaStream | null = null;
let users = 0;
let offTimer: number | undefined;

const alive = (s: MediaStream | null): s is MediaStream => Boolean(s && s.getAudioTracks().some((t) => t.readyState === 'live'));

/** Get the microphone (asks only if it isn't on already). Call releaseMic() when done. */
export async function takeMic(): Promise<MediaStream> {
  clearTimeout(offTimer);
  if (!alive(stream)) {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  }
  users++;
  for (const t of stream.getAudioTracks()) t.enabled = true;
  return stream;
}

/** Done with the microphone: silence it now, switch it off a little later. */
export function releaseMic() {
  users = Math.max(0, users - 1);
  if (users > 0 || !stream) return;
  for (const t of stream.getAudioTracks()) t.enabled = false;
  clearTimeout(offTimer);
  offTimer = window.setTimeout(stopMic, KEEP_MS);
}

function stopMic() {
  clearTimeout(offTimer);
  if (users > 0) return;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

// Never keep the microphone in the background.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') stopMic(); });
window.addEventListener('pagehide', () => { users = 0; stopMic(); });
