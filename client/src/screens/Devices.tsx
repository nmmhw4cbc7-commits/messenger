import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { encode } from 'uqr';
import jsQR from 'jsqr';
import { approveLink, checkLink, listDevices, removeDevice, startLink, type LinkRequest, type LinkedDevice } from '../lib/engine';
import { errorMessage } from '../lib/api';
import { useStore } from '../lib/store';
import { formatListTime } from '../lib/format';
import { Button, Cell, Empty, Screen, Section, Spinner, alertDialog, confirmAction, toast, useAsync } from '../ui/components';
import { goBack, useNav } from '../ui/nav';
import { Plus, Trash } from '../ui/icons';

const PREFIX = 'haven-link:';
const pretty = (code: string) => code.replace(/(.{4})(?=.)/g, '$1 ');

const DeviceIcon = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="4.5" width="13" height="10" rx="1.6" /><path d="M1.5 18.5h16" /><rect x="17.5" y="8" width="5" height="11" rx="1.4" />
  </svg>
);

function QrCode({ text }: { text: string }) {
  const { data, size } = useMemo(() => encode(text, { ecc: 'M', border: 2 }), [text]);
  let path = '';
  data.forEach((row, y) => row.forEach((on, x) => { if (on) path += `M${x} ${y}h1v1h-1z`; }));
  return (
    <svg class="qr" viewBox={`0 0 ${size} ${size}`} shape-rendering="crispEdges" role="img" aria-label="QR code">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#141412" />
    </svg>
  );
}

// ------------------------------------------------------------------ new device: show the code

export function LinkDeviceScreen() {
  const [req, setReq] = useState<LinkRequest | null>(null);
  const [error, setError] = useState('');
  const [left, setLeft] = useState(0);
  const busy = useRef(false);

  const start = () => {
    setError('');
    setReq(null);
    startLink().then((r) => { setReq(r); setLeft(Math.round((r.expiresAt - Date.now()) / 1000)); }, (err) => setError(errorMessage(err)));
  };
  useEffect(start, []);

  useEffect(() => {
    if (!req) return;
    const poll = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        await checkLink(req);
      } catch (err) {
        setError(errorMessage(err));
        setReq(null);
      } finally {
        busy.current = false;
      }
    };
    const t = setInterval(poll, 2000);
    const tick = setInterval(() => setLeft(Math.max(0, Math.round((req.expiresAt - Date.now()) / 1000))), 1000);
    return () => { clearInterval(t); clearInterval(tick); };
  }, [req]);

  const expired = req && left <= 0;

  return (
    <Screen back>
      <div class="form-page">
        <h1 class="form-title">Link this device</h1>
        <p class="form-lede">On your phone, open Haven → <strong>Settings</strong> → <strong>Linked devices</strong> → <strong>Link a device</strong> and scan this code.</p>
        <div class="qr-frame">
          {req && !expired ? <QrCode text={PREFIX + req.code} /> : error || expired ? null : <Spinner size={28} />}
          {(error || expired) && <p class="form-error shown">{error || 'This code expired.'}</p>}
        </div>
        {req && !expired && (
          <>
            <p class="pair-code-label">Or type this code</p>
            <p class="pair-code">{pretty(req.code)}</p>
            <p class="waiting center"><Spinner size={14} /> Waiting for your phone · {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</p>
          </>
        )}
        <div class="form-spacer" />
        {(error || expired) && <Button onClick={start}>Show a new code</Button>}
        <p class="fine-print">This device gets its own keys. It receives new messages from now on; older messages stay on your phone.</p>
      </div>
    </Screen>
  );
}

// ------------------------------------------------------------------ settings: list and remove devices

export function DevicesScreen() {
  const nav = useNav();
  const [devices, setDevices] = useState<LinkedDevice[] | null>(null);
  const [, run] = useAsync();
  const deviceCount = useStore((st) => st.me?.devices?.length ?? 0);
  const load = () => listDevices().then(setDevices, (err) => toast(errorMessage(err), 'error'));
  // Reload when a device joins or leaves (the server tells all of this account's devices).
  useEffect(() => { load(); }, [deviceCount]);

  return (
    <Screen back title="Linked devices" grouped right={undefined}>
      <div class="feature-hero">
        <span class="feature-icon on"><DeviceIcon size={30} /></span>
        <h2>Use Haven on more devices</h2>
        <p>Each device has its own keys, so messages stay end-to-end encrypted on every one of them.</p>
      </div>
      <div class="pad-x">
        <Button onClick={() => nav.push(<ScanScreen onLinked={load} />)}><Plus size={20} /> Link a device</Button>
      </div>
      {!devices ? (
        <div class="center pad"><Spinner /></div>
      ) : (
        <Section header="Devices" footer="Removing a device signs it out and deletes its keys. Your contacts see that your safety number changed when you add or remove a device.">
          {devices.map((d) => (
            <Cell
              key={d.id}
              icon={<DeviceIcon size={20} />}
              iconBg="ink"
              title={d.name || 'Device'}
              subtitle={d.current ? 'This device' : `Active ${formatListTime(d.lastActiveAt)}`}
              right={d.current ? <span class="tag good">This device</span> : (
                <button class="small-button danger-text" aria-label={`Remove ${d.name}`} onClick={async () => {
                  if (await confirmAction({ title: 'Remove device?', message: `${d.name || 'This device'} will be signed out.`, confirm: 'Remove', danger: true })) {
                    run(async () => { await removeDevice(d.id); toast('Device removed'); await load(); });
                  }
                }}><Trash size={16} /></button>
              )}
            />
          ))}
          {!devices.length && <Empty icon={<DeviceIcon />} title="No devices" />}
        </Section>
      )}
    </Screen>
  );
}

// ------------------------------------------------------------------ scanner

function ScanScreen({ onLinked }: { onLinked: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [camError, setCamError] = useState('');
  const [manual, setManual] = useState('');
  const [busy, run] = useAsync();
  const done = useRef(false);

  const approve = (code: string) => {
    if (done.current) return;
    done.current = true;
    navigator.vibrate?.(12);
    alertDialog({
      title: 'Link this device?',
      message: 'It will be able to read and send all new messages. Only link devices you own.',
      buttons: [
        { label: 'Cancel', style: 'cancel', run: () => { done.current = false; } },
        {
          label: 'Link',
          style: 'default',
          run: () => run(async () => {
            const res = await approveLink(code);
            toast(`${res.name || 'Device'} linked`);
            onLinked();
            await goBack();
          }, (err) => { toast(errorMessage(err), 'error'); done.current = false; }),
        },
      ],
      onDismiss: () => { done.current = false; },
    });
  };

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch {
        setCamError('Haven needs camera access to scan. You can type the code below instead.');
        return;
      }
      const v = video.current;
      if (!v) return;
      v.srcObject = stream;
      await v.play().catch(() => {});
      const scan = () => {
        if (v.readyState >= 2 && ctx && !done.current) {
          const w = Math.min(640, v.videoWidth);
          const h = Math.round((v.videoHeight / v.videoWidth) * w) || w;
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(v, 0, 0, w, h);
          const found = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
          if (found?.data.startsWith(PREFIX)) {
            const code = found.data.slice(PREFIX.length);
            if (/^[A-Z2-9]{12}$/.test(code)) approve(code);
          }
        }
        raf = requestAnimationFrame(scan);
      };
      raf = requestAnimationFrame(scan);
    })();
    return () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const cleanCode = manual.toUpperCase().replace(/[^A-Z2-9]/g, '');

  return (
    <Screen back title="Scan code" grouped>
      <div class="scanner">
        {camError ? <p class="scanner-error">{camError}</p> : <video ref={video} playsInline muted />}
        <span class="scanner-frame" aria-hidden="true" />
      </div>
      <p class="scanner-hint">Point your camera at the QR code on the other device.</p>
      <Section header="Or enter the code">
        <input class="cell-input mono-input" placeholder="XXXX XXXX XXXX" aria-label="Pairing code" maxLength={16} autoCapitalize="characters" autoComplete="off"
          value={pretty(cleanCode)} onInput={(e) => setManual((e.target as HTMLInputElement).value)} />
      </Section>
      <div class="pad-x">
        <Button disabled={cleanCode.length !== 12} loading={busy} onClick={() => approve(cleanCode)}>Link</Button>
      </div>
    </Screen>
  );
}
