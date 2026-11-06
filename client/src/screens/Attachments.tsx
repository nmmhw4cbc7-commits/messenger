import { useEffect, useRef, useState } from 'preact/hooks';
import type { Conv, Msg, Profile } from '../lib/store';
import { useStore } from '../lib/store';
import {
  avatarUrl, displayName, formatDuration, lookupPhone, markOpened, openDirect, sendContact, sendLocation, sendMedia, sendPoll, vote,
} from '../lib/engine';
import { mediaUrl, prepareVideo, preparePhoto, startRecording, type Recording } from '../lib/media';
import { guessCountry, prettyPhone, toE164 } from '../lib/phone';
import { errorMessage } from '../lib/api';
import { Avatar, Button, Spinner, toast, useAsync } from '../ui/components';
import { PhoneField, type PhoneValue } from '../ui/PhoneField';
import { getNav } from '../ui/nav';
import { Camera, Close, Contacts, Lock, People, Plus, Trash, ArrowUp, Check } from '../ui/icons';
import { invite } from './NewChat';
import { ChatScreen } from './Chat';

// ------------------------------------------------------------------ icons used only here

const Img = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="m4 17.5 5-4.5 4 3.5 2.5-2 4.5 4" />
  </svg>
);
const Pin = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" /><circle cx="12" cy="10" r="2.4" />
  </svg>
);
const Chart = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
    <path d="M5 19.5V11M12 19.5V5M19 19.5v-6" />
  </svg>
);

/** Waveform bars as columns of dots (dot-matrix): 1 to 6 dots, 4px apart. */
const dotBar = (v: number) => 4 * (1 + Math.round(Math.min(1, Math.max(0, v)) * 5));
export const Mic = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="9" y="3.5" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
  </svg>
);
const Play = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8Z" /></svg>
);
const Pause = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></svg>
);
const Once = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" stroke-dasharray="3 2.4" /><path d="M10.8 9.2 12.6 8v8" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

// ------------------------------------------------------------------ attach sheet

export function openAttachSheet(conv: Conv) {
  getNav().present((close) => <AttachSheet conv={conv} close={close} />, { variant: 'card' });
}

export function pickFile(accept: string, capture?: boolean): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    if (capture) input.setAttribute('capture', 'environment');
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

async function sendPickedFile(convId: string, file: File, viewOnce = false) {
  try {
    if (file.type.startsWith('video/')) {
      if (viewOnce) throw new Error('View-once works with photos.');
      const v = await prepareVideo(file);
      await sendMedia(convId, v.blob, { kind: 'video', w: v.w, h: v.h, duration: v.duration, thumb: v.thumb });
    } else if (file.type.startsWith('image/')) {
      if (!viewOnce) {
        getNav().present((close) => <PhotoSendSheet convId={convId} file={file} close={close} />, { variant: 'full' });
        return;
      }
      const p = await preparePhoto(file);
      await sendMedia(convId, p.blob, { kind: 'image', w: p.w, h: p.h, viewOnce: true });
    } else {
      throw new Error('Please choose a photo or video.');
    }
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

const HD_KEY = 'haven.photoHD';

/** Look at the photo before sending: HD on or off, optional caption. */
function PhotoSendSheet({ convId, file, close }: { convId: string; file: File; close: () => Promise<void> }) {
  const [hd, setHd] = useState(() => { try { return localStorage.getItem(HD_KEY) === '1'; } catch { return false; } });
  const [caption, setCaption] = useState('');
  const [busy, run] = useAsync();
  const [url] = useState(() => URL.createObjectURL(file));
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  const toggle = () => {
    const next = !hd;
    setHd(next);
    try { localStorage.setItem(HD_KEY, next ? '1' : '0'); } catch { /* fine */ }
  };
  const send = () => run(async () => {
    const p = await preparePhoto(file, hd);
    const text = caption.trim().slice(0, 1000);
    await sendMedia(convId, p.blob, { kind: 'image', w: p.w, h: p.h, thumb: p.thumb, ...(hd ? { hd: true } : {}), ...(text ? { caption: text } : {}) });
    await close();
  });
  return (
    <div class="sheet-page photo-send">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close()}>Cancel</button>
        <strong>Photo</strong>
        <button class={`hd-toggle${hd ? ' on' : ''}`} onClick={toggle} aria-pressed={hd} aria-label="Send in HD">HD</button>
      </div>
      <div class="photo-send-preview"><img src={url} alt="" draggable={false} /></div>
      <p class="photo-send-note">{hd ? 'HD: full resolution. Takes longer to send and uses more data.' : 'Standard quality. Tap HD for full resolution.'}</p>
      <div class="photo-send-bar">
        <input class="field" type="text" placeholder="Add a caption" maxLength={1000} value={caption} aria-label="Caption"
          onInput={(e) => setCaption((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
        <button class="send-button ready" onClick={send} disabled={busy} aria-label="Send">{busy ? <Spinner size={18} /> : <ArrowUp size={20} />}</button>
      </div>
    </div>
  );
}

function AttachSheet({ conv, close }: { conv: Conv; close: () => Promise<void> }) {
  const [busy, run] = useAsync();
  const after = (fn: () => Promise<void>) => async () => {
    await close();
    await fn();
  };

  const options = [
    { label: 'Photo or video', icon: <Img />, run: after(async () => { const f = await pickFile('image/*,video/*'); if (f) await sendPickedFile(conv.id, f); }) },
    { label: 'Camera', icon: <Camera />, run: after(async () => { const f = await pickFile('image/*', true); if (f) await sendPickedFile(conv.id, f); }) },
    { label: 'View once', icon: <Once />, run: after(async () => { const f = await pickFile('image/*'); if (f) await sendPickedFile(conv.id, f, true); }) },
    {
      label: 'Location',
      icon: <Pin />,
      run: () => run(async () => {
        const pos = await currentPosition();
        await close();
        await sendLocation(conv.id, pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      }),
    },
    { label: 'Contact', icon: <Contacts />, run: after(async () => getNav().present((c) => <ContactShareSheet conv={conv} close={c} />, { variant: 'full' })) },
    ...(conv.kind === 'group'
      ? [{ label: 'Poll', icon: <Chart />, run: after(async () => getNav().present((c) => <PollSheet conv={conv} close={c} />, { variant: 'full' })) }]
      : []),
  ];

  return (
    <div class="sheet-page compact attach-sheet">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close()}>Cancel</button>
        <strong>Share</strong>
        <span />
      </div>
      <div class="attach-grid">
        {options.map((o) => (
          <button key={o.label} class="attach-option" onClick={o.run} disabled={busy}>
            <span class="attach-icon">{busy && o.label === 'Location' ? <Spinner /> : o.icon}</span>
            <span>{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location is not available on this device.'));
    navigator.geolocation.getCurrentPosition(resolve, (err) => {
      reject(new Error(err.code === err.PERMISSION_DENIED ? 'Haven needs location access. You can allow it in your settings.' : 'Your location could not be found.'));
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
  });
}

// ------------------------------------------------------------------ contact sharing

function ContactShareSheet({ conv, close }: { conv: Conv; close: () => Promise<void> }) {
  const convs = useStore((s) => s.convs);
  const meId = useStore((s) => s.me?.id);
  const [value, setValue] = useState<PhoneValue>({ country: guessCountry(), national: '' });
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const people = [...new Map(Object.values(convs).flatMap((c) => c.members).filter((m) => m.id !== meId && m.name).map((m) => [m.id, m])).values()];

  const share = async (n: string, phone: string) => {
    await close();
    await sendContact(conv.id, n || phone, phone);
  };

  return (
    <div class="sheet-page">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close()}>Cancel</button>
        <strong>Share contact</strong>
        <span />
      </div>
      <div class="sheet-scroll">
        <div class="sheet-content">
          <input class="field" placeholder="Name" aria-label="Name" maxLength={80} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <PhoneField value={value} onChange={(v) => { setValue(v); setError(''); }} />
          {error && <p class="form-error shown">{error}</p>}
          <Button onClick={() => {
            const e164 = toE164(value.national, value.country);
            if (!e164) return setError('Please enter a valid number.');
            share(name.trim(), e164);
          }} disabled={!value.national}>Share</Button>
        </div>
        {people.length > 0 && (
          <>
            <h2 class="list-heading">People on Haven</h2>
            <div class="plain-list">
              {people.map((p) => (
                <button key={p.id} class="plain-row person" onClick={() => share(displayName(p), p.phone)}>
                  <Avatar id={p.id} name={displayName(p)} src={avatarUrl(p)} size={40} />
                  <span class="plain-row-text">
                    <span class="plain-row-title">{displayName(p)}</span>
                    <span class="plain-row-sub">{prettyPhone(p.phone)}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ polls

function PollSheet({ conv, close }: { conv: Conv; close: () => Promise<void> }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multi, setMulti] = useState(false);
  const filled = options.map((o) => o.trim()).filter(Boolean);
  const valid = question.trim() && filled.length >= 2;

  const setOption = (i: number, v: string) => {
    const next = [...options];
    next[i] = v;
    if (i === next.length - 1 && v && next.length < 12) next.push('');
    setOptions(next);
  };

  return (
    <div class="sheet-page">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close()}>Cancel</button>
        <strong>New poll</strong>
        <button class="nav-button bold" disabled={!valid} onClick={async () => {
          await close();
          await sendPoll(conv.id, question.trim(), filled, multi);
        }}>Send</button>
      </div>
      <div class="sheet-scroll">
        <div class="sheet-content">
          <input class="field" placeholder="Question" aria-label="Question" maxLength={300} autoFocus value={question} onInput={(e) => setQuestion((e.target as HTMLInputElement).value)} />
        </div>
        <h2 class="list-heading">Options</h2>
        <div class="sheet-content">
          {options.map((o, i) => (
            <input key={i} class="field" placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`} maxLength={100} value={o}
              onInput={(e) => setOption(i, (e.target as HTMLInputElement).value)} />
          ))}
          <label class="check-row">
            <input type="checkbox" checked={multi} onChange={(e) => setMulti((e.target as HTMLInputElement).checked)} />
            <span>Allow several answers</span>
          </label>
        </div>
      </div>
    </div>
  );
}

export function PollCard({ msg, conv, meId }: { msg: Msg; conv: Conv; meId: string }) {
  const poll = msg.poll!;
  const votes = msg.votes ?? {};
  const mine = votes[meId] ?? [];
  const voters = Object.keys(votes).length;
  const counts = poll.options.map((_, i) => Object.values(votes).filter((v) => v.includes(i)).length);
  const pending = msg.status === 'pending';

  const pick = (i: number) => {
    if (pending) return;
    const next = poll.multi ? (mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i]) : mine.includes(i) ? [] : [i];
    navigator.vibrate?.(6);
    vote(msg, next).catch((err) => toast(errorMessage(err), 'error'));
  };

  return (
    <div class="poll">
      <div class="poll-label">Poll{poll.multi ? ' · several answers' : ''}</div>
      <div class="poll-question">{poll.question}</div>
      {poll.options.map((o, i) => {
        const pct = voters ? Math.round((counts[i] / voters) * 100) : 0;
        return (
          <button key={i} class={`poll-option${mine.includes(i) ? ' chosen' : ''}`} onClick={(e) => { e.stopPropagation(); pick(i); }} disabled={pending}>
            <span class="poll-check">{mine.includes(i) && <Check size={13} stroke={3} />}</span>
            <span class="poll-text">{o}</span>
            <span class="poll-count">{counts[i]}</span>
            <span class="poll-bar" style={{ width: `${pct}%` }} />
          </button>
        );
      })}
      <div class="poll-foot">{voters === 1 ? '1 vote' : `${voters} votes`} · {conv.members.length} members</div>
    </div>
  );
}

// ------------------------------------------------------------------ location & contact cards

export function LocationCard({ msg }: { msg: Msg }) {
  const { lat, lng, acc } = msg.location!;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const href = ios ? `https://maps.apple.com/?ll=${lat},${lng}&q=${lat},${lng}` : `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  return (
    <a class="location-card" href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      <span class="location-map" aria-hidden="true">
        <span class="location-grid" />
        <span class="location-dot"><Pin size={22} /></span>
      </span>
      <span class="location-meta">
        <strong>Location</strong>
        <span>{lat.toFixed(5)}, {lng.toFixed(5)}{acc ? ` · ±${acc} m` : ''}</span>
      </span>
    </a>
  );
}

export function ContactCard({ msg, meId }: { msg: Msg; meId: string }) {
  const { name, phone } = msg.contactCard!;
  const [busy, run] = useAsync();
  const mine = msg.senderId === meId;
  const message = () => run(async () => {
    const res = await lookupPhone(phone);
    if (!res.found || !res.user) {
      await invite(phone);
      return;
    }
    const conv = await openDirect(res.user.id);
    getNav().push(<ChatScreen convId={conv.id} />);
  });
  return (
    <div class="contact-card">
      <div class="contact-card-top">
        <Avatar id={phone} name={name} size={40} />
        <span class="contact-card-text">
          <strong>{name}</strong>
          <span>{prettyPhone(phone)}</span>
        </span>
      </div>
      {!mine && (
        <button class="contact-card-action" onClick={(e) => { e.stopPropagation(); message(); }} disabled={busy}>
          {busy ? <Spinner size={16} /> : 'Message'}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ photos, videos, view once

export function MediaView({ msg, meId }: { msg: Msg; meId: string }) {
  const media = msg.media!;
  if (media.kind === 'voice') return <VoicePlayer msg={msg} />;
  if (media.viewOnce) return <ViewOnce msg={msg} mine={msg.senderId === meId} />;
  return <Visual msg={msg} />;
}

export function useMediaUrl(msg: Msg, enabled = true) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!enabled || !msg.media) return;
    let alive = true;
    mediaUrl(msg.id, msg.media).then((u) => alive && setUrl(u), (err) => alive && setError(errorMessage(err)));
    return () => { alive = false; };
  }, [msg.id, msg.media?.path, enabled]);
  return { url, error };
}

function Visual({ msg }: { msg: Msg }) {
  const media = msg.media!;
  const { url, error } = useMediaUrl(msg);
  const ratio = media.w && media.h ? Math.min(Math.max(media.h / media.w, 0.5), 1.6) : 0.75;
  const width = 240;
  return (
    <button
      class={`visual${media.kind === 'video' ? ' video' : ''}`}
      style={{ width: `${width}px`, height: `${Math.round(width * ratio)}px`, ...(media.thumb ? { backgroundImage: `url(${media.thumb})` } : {}) }}
      onClick={(e) => { e.stopPropagation(); if (url) openViewer(msg, url); }}
      aria-label={media.kind === 'video' ? 'Play video' : 'Open photo'}
    >
      {url && media.kind === 'image' && <img src={url} alt="" draggable={false} decoding="async" />}
      {url && media.kind === 'video' && <video src={url} muted playsInline preload="metadata" />}
      {media.hd && <span class="hd-badge">HD</span>}
      {media.kind === 'video' && <span class="visual-play"><Play size={22} />{media.duration ? <em>{formatDuration(media.duration)}</em> : null}</span>}
      {!url && !error && <span class="visual-loading"><Spinner /></span>}
      {error && <span class="visual-error">{error}</span>}
    </button>
  );
}

function ViewOnce({ msg, mine }: { msg: Msg; mine: boolean }) {
  const [busy, run] = useAsync();
  const label = mine ? (msg.opened ? 'Opened' : msg.status === 'pending' ? 'Sending…' : 'Photo · view once') : msg.opened ? 'Opened' : 'Tap to view once';
  const open = () => run(async () => {
    if (mine || msg.opened) return;
    const url = await mediaUrl(msg.id, msg.media!);
    openViewer(msg, url, () => markOpened(msg));
  });
  return (
    <button class={`view-once${msg.opened ? ' opened' : ''}`} onClick={(e) => { e.stopPropagation(); open(); }} disabled={mine || msg.opened || busy}>
      <span class="view-once-icon">{busy ? <Spinner size={18} /> : <Once size={22} />}</span>
      <span>{label}</span>
    </button>
  );
}

/** Full-screen photo/video viewer. Swipe down or tap × to close. */
export function openViewer(msg: Msg, url: string, onClosed?: () => void) {
  getNav().present((close) => <Viewer msg={msg} url={url} close={close} />, { variant: 'full', onClose: onClosed });
}

function Viewer({ msg, url, close }: { msg: Msg; url: string; close: () => Promise<void> }) {
  const media = msg.media!;
  const ref = useRef<HTMLDivElement>(null);
  const onPointerDown = (e: PointerEvent) => {
    const el = ref.current;
    if (!el || (e.target as HTMLElement).closest('video, button')) return;
    const y0 = e.clientY;
    let dy = 0;
    const move = (ev: PointerEvent) => {
      dy = ev.clientY - y0;
      el.style.transform = `translateY(${Math.max(0, dy)}px)`;
      el.style.opacity = String(Math.max(0.3, 1 - Math.max(0, dy) / 500));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (dy > 120) close();
      else {
        el.style.transform = '';
        el.style.opacity = '';
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div class="viewer" ref={ref} onPointerDown={onPointerDown}>
      <button class="viewer-close" onClick={() => close()} aria-label="Close"><Close size={22} /></button>
      {media.viewOnce && <div class="viewer-note"><Once size={16} /> Opens once. It disappears when you close it.</div>}
      {media.kind === 'video' ? (
        <video src={url} controls autoPlay playsInline />
      ) : (
        <img src={url} alt="" draggable={false} decoding="async" />
      )}
      {media.caption && <p class="viewer-caption">{media.caption}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ voice messages

let playing: HTMLAudioElement | null = null;

function VoicePlayer({ msg }: { msg: Msg }) {
  const media = msg.media!;
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'paused'>('idle');
  const [progress, setProgress] = useState(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const wave = media.wave?.length ? media.wave : Array.from({ length: 40 }, (_, i) => 0.25 + 0.5 * Math.abs(Math.sin(i * 1.7)));

  useEffect(() => () => { audio.current?.pause(); }, []);

  const toggle = async () => {
    if (state === 'playing') {
      audio.current?.pause();
      return;
    }
    try {
      let src = url;
      if (!src) {
        setState('loading');
        src = await mediaUrl(msg.id, media);
        setUrl(src);
      }
      if (!audio.current) {
        const a = new Audio(src);
        a.ontimeupdate = () => setProgress(a.duration ? a.currentTime / a.duration : 0);
        a.onplay = () => setState('playing');
        a.onpause = () => setState('paused');
        a.onended = () => {
          setState('idle');
          setProgress(0);
        };
        audio.current = a;
      }
      if (playing && playing !== audio.current) playing.pause();
      playing = audio.current;
      await audio.current.play();
    } catch (err) {
      setState('idle');
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div class="voice">
      <button class="voice-play" onClick={(e) => { e.stopPropagation(); toggle(); }} aria-label={state === 'playing' ? 'Pause' : 'Play'}>
        {state === 'loading' ? <Spinner size={16} /> : state === 'playing' ? <Pause /> : <Play />}
      </button>
      <span class="voice-wave" aria-hidden="true">
        {wave.map((v, i) => <span key={i} class={i / wave.length < progress ? 'on' : ''} style={{ height: `${dotBar(v)}px` }} />)}
      </span>
      <span class="voice-time">{formatDuration(state === 'idle' ? media.duration ?? 0 : (audio.current?.currentTime ?? 0))}</span>
    </div>
  );
}

/** Recording bar shown in place of the text field. */
export function VoiceRecorder({ convId, onDone }: { convId: string; onDone: () => void }) {
  const rec = useRef<Recording | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    startRecording().then((r) => {
      if (!alive) return r.cancel();
      rec.current = r;
      navigator.vibrate?.(10);
    }, (err) => {
      toast(errorMessage(err), 'error');
      onDone();
    });
    const t = setInterval(() => {
      const r = rec.current;
      if (!r) return;
      setSeconds(Math.floor((Date.now() - r.startedAt) / 1000));
      setLevels((l) => [...l.slice(-31), r.level()]);
      if (Date.now() - r.startedAt > 15 * 60_000) send();
    }, 100);
    return () => {
      alive = false;
      clearInterval(t);
      rec.current?.cancel();
    };
  }, []);

  const send = async () => {
    const r = rec.current;
    if (!r || busy) return;
    setBusy(true);
    rec.current = null;
    const result = await r.stop();
    onDone();
    if (!result) {
      toast('Hold on a little longer to record.');
      return;
    }
    await sendMedia(convId, result.blob, { kind: 'voice', duration: result.duration, wave: result.wave });
  };

  return (
    <div class="composer recorder">
      <button class="recorder-cancel" onClick={() => { rec.current?.cancel(); rec.current = null; onDone(); }} aria-label="Cancel recording"><Trash size={20} /></button>
      <div class="recorder-body">
        <span class="recorder-time">{formatDuration(seconds)}</span>
        <span class="recorder-levels" aria-hidden="true">
          {levels.map((v, i) => <span key={i} style={{ height: `${dotBar(v)}px` }} />)}
        </span>
      </div>
      <button class="send-button ready" onClick={send} disabled={busy} aria-label="Send voice message"><ArrowUp size={20} /></button>
    </div>
  );
}

export { Plus, Lock, People };
export type { Profile };
