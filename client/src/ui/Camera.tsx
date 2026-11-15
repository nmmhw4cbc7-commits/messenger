// In-app camera: opens straight into the camera, double-tap (or the button) flips it.
import { useEffect, useRef, useState } from 'preact/hooks';
import { getNav } from './nav';

/** Takes a photo with the in-app camera. Resolves null if cancelled; throws if there is no camera. */
export async function takePhoto(): Promise<File | null> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera');
  let facing: 'environment' | 'user' = 'environment';
  try { facing = (localStorage.getItem('haven.facing') as 'user') || 'environment'; } catch { /* default */ }
  const first = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false });
  return new Promise((resolve) => {
    let done = false;
    const finish = (f: File | null) => { if (!done) { done = true; resolve(f); } };
    getNav().present((close) => <Cam first={first} facing0={facing} done={async (f) => { finish(f); await close(); }} />, { variant: 'full', onClose: () => finish(null) });
  });
}

function Cam({ first, facing0, done }: { first: MediaStream; facing0: 'environment' | 'user'; done: (f: File | null) => Promise<void> }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef(first);
  const [facing, setFacing] = useState(facing0);
  const lastTap = useRef(0);
  const stop = () => stream.current.getTracks().forEach((t) => t.stop());

  useEffect(() => { if (video.current) video.current.srcObject = stream.current; return stop; }, []);

  const flip = async () => {
    const next = facing === 'user' ? 'environment' : 'user';
    try {
      stop();
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next, width: { ideal: 1920 }, height: { ideal: 1920 } }, audio: false });
      if (video.current) video.current.srcObject = stream.current;
      setFacing(next);
      try { localStorage.setItem('haven.facing', next); } catch { /* ignore */ }
    } catch { /* keep the old camera */ }
  };
  const onTap = () => {
    const t = Date.now();
    if (t - lastTap.current < 300) { lastTap.current = 0; flip(); } else lastTap.current = t;
  };
  const shoot = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const g = c.getContext('2d')!;
    if (facing === 'user') { g.translate(c.width, 0); g.scale(-1, 1); }
    g.drawImage(v, 0, 0);
    c.toBlob((b) => { stop(); done(b ? new File([b], 'photo.jpg', { type: 'image/jpeg' }) : null); }, 'image/jpeg', 0.92);
  };

  return (
    <div class="cam" onClick={onTap}>
      <video ref={video} autoplay playsInline muted class={facing === 'user' ? 'mirror' : ''} />
      <button class="cam-close" aria-label="Close" onClick={(e) => { e.stopPropagation(); stop(); done(null); }}>✕</button>
      <div class="cam-bar" onClick={(e) => e.stopPropagation()}>
        <span />
        <button class="cam-shutter" aria-label="Take photo" onClick={shoot} />
        <button class="cam-flip" aria-label="Flip camera" onClick={flip}>⟲</button>
      </div>
    </div>
  );
}
