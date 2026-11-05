import { useEffect, useRef, useState } from 'preact/hooks';
import { Button, Screen, Avatar, Spinner, useAsync } from '../ui/components';
import { PhoneField, type PhoneValue } from '../ui/PhoneField';
import { goBack, useNav } from '../ui/nav';
import { Lock, Camera, Shield, Key } from '../ui/icons';
import { guessCountry, toE164, prettyPhone } from '../lib/phone';
import { startVerification, checkVerification, submitPin, forgetDevice, updateProfile, uploadAvatar, avatarUrl, type Verification } from '../lib/engine';
import { errorMessage } from '../lib/api';
import { useStore } from '../lib/store';
import { prepareAvatar } from '../lib/image';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

export function Welcome() {
  const nav = useNav();
  const sessionEnded = useStore((s) => s.sessionEnded);
  const lastPhone = useStore((s) => s.lastPhone);

  const continueWith = () => {
    const parsed = parsePhoneNumberFromString(lastPhone);
    nav.push(<PhoneScreen initial={parsed ? { country: parsed.country ?? guessCountry(), national: parsed.formatNational() } : undefined} />);
  };

  return (
    <div class="screen welcome">
      <div class="welcome-body">
        <div class="brand-mark" aria-hidden="true">
          <img src="/icons/mark.svg" alt="" width={88} height={88} />
        </div>
        <h1>Haven</h1>
        <p class="welcome-lede">Private conversations, on your terms.</p>
        <ul class="welcome-points">
          <li><span class="point-icon"><Lock size={20} /></span><span>Every message is end-to-end encrypted on your device.</span></li>
          <li><span class="point-icon"><Shield size={20} /></span><span>The server deletes messages once they are delivered.</span></li>
          <li><span class="point-icon"><Key size={20} /></span><span>Verify the people you talk to with safety numbers.</span></li>
        </ul>
      </div>
      <div class="welcome-actions">
        {sessionEnded && lastPhone ? (
          <>
            <p class="notice-text">You were signed out. Sign in again to keep your chats on this device.</p>
            <Button onClick={continueWith}>Continue as {prettyPhone(lastPhone)}</Button>
            <Button variant="plain" onClick={() => forgetDevice()}>Use another number</Button>
          </>
        ) : (
          <Button onClick={() => nav.push(<PhoneScreen />)}>Get started</Button>
        )}
      </div>
    </div>
  );
}

function PhoneScreen({ initial }: { initial?: PhoneValue }) {
  const nav = useNav();
  const [value, setValue] = useState<PhoneValue>(initial ?? { country: guessCountry(), national: '' });
  const [error, setError] = useState('');
  const [busy, run] = useAsync();
  const e164 = toE164(value.national, value.country);

  const submit = () => {
    if (!e164) {
      setError('Please enter a valid mobile number.');
      return;
    }
    setError('');
    run(async () => {
      const verification = await startVerification(e164);
      nav.push(<TelegramScreen verification={verification} />);
    }, (err) => setError(errorMessage(err)));
  };

  return (
    <Screen back>
      <div class="form-page">
        <h1 class="form-title">Your phone number</h1>
        <p class="form-lede">You’ll confirm it with one tap in Telegram. Free, and no code to type.</p>
        <PhoneField value={value} onChange={(v) => { setValue(v); setError(''); }} autoFocus onSubmit={submit} />
        <p class={`form-error${error ? ' shown' : ''}`} role="alert">{error}</p>
        <div class="form-spacer" />
        <Button onClick={submit} loading={busy} disabled={!value.national}>Continue</Button>
        <p class="fine-print">Use the number of your Telegram account. It’s used to sign in and so friends can find you.</p>
      </div>
    </Screen>
  );
}

function TelegramScreen({ verification }: { verification: Verification }) {
  const nav = useNav();
  const [error, setError] = useState('');
  const [opened, setOpened] = useState(false);
  const [left, setLeft] = useState(Math.max(0, Math.round((verification.expiresAt - Date.now()) / 1000)));
  const busy = useRef(false);
  const done = useRef(false);

  // Ask the server every 2 seconds (and right when the user comes back) whether Telegram confirmed the number.
  useEffect(() => {
    const check = async () => {
      if (busy.current || done.current || error) return;
      busy.current = true;
      try {
        const res = await checkVerification(verification);
        if (res === 'done') done.current = true;
        else if (res !== 'pending') {
          done.current = true;
          nav.push(<PinScreen challenge={res.pinChallenge} />);
        }
      } catch (err) {
        done.current = true;
        setError(errorMessage(err));
      } finally {
        busy.current = false;
      }
    };
    const timer = setInterval(check, 2000);
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [error]);

  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft(Math.max(0, Math.round((verification.expiresAt - Date.now()) / 1000))), 1000);
    return () => clearTimeout(t);
  }, [left]);

  const expired = left <= 0 && !done.current;

  return (
    <Screen back>
      <div class="form-page">
        <div class="form-icon telegram"><TelegramIcon /></div>
        <h1 class="form-title">Confirm in Telegram</h1>
        <p class="form-lede">
          Confirm <strong class="nowrap">{prettyPhone(verification.phone)}</strong> with your Telegram account. Telegram only shares this number, nothing else.
        </p>
        <ol class="steps">
          <li><span class="step-num">1</span><span>Tap “Open Telegram”</span></li>
          <li><span class="step-num">2</span><span>Tap <strong>Start</strong>, then <strong>Share my phone number</strong></span></li>
          <li><span class="step-num">3</span><span>Come back here. Haven continues on its own</span></li>
        </ol>
        {error || expired ? (
          <p class="form-error shown" role="alert">{error || 'This confirmation expired.'}</p>
        ) : opened ? (
          <p class="waiting"><Spinner size={16} /> Waiting for Telegram…</p>
        ) : null}
        <div class="form-spacer" />
        {error || expired ? (
          <Button onClick={() => goBack()}>Start again</Button>
        ) : (
          <a class="btn btn-primary btn-link" href={verification.telegramUrl} target="_blank" rel="noopener noreferrer" onClick={() => setOpened(true)}>
            <span class="btn-label"><TelegramIcon size={20} /> Open Telegram</span>
          </a>
        )}
        <p class="fine-print">
          No Telegram yet? Get it free from the App Store or Google Play, then come back. {left > 0 && !error ? `Link valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.` : ''}
        </p>
      </div>
    </Screen>
  );
}

function TelegramIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21.4 4.2 2.9 11.4c-1.3.5-1.2 1.3-.2 1.6l4.7 1.5 1.8 5.6c.2.6.4.8.9.8.4 0 .6-.2.9-.4l2.3-2.2 4.7 3.5c.9.5 1.5.2 1.7-.8l3.1-14.7c.3-1.3-.5-1.9-1.4-1.5ZM9.6 14.3l-.4 4.1-1.4-4.5 10-6.3c.5-.3.9-.1.5.2Z" />
    </svg>
  );
}

function PinScreen({ challenge }: { challenge: string }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useAsync();
  const submit = () => run(() => submitPin(challenge, pin), (err) => {
    setError(errorMessage(err));
    setPin('');
  });

  return (
    <Screen back>
      <div class="form-page">
        <div class="form-icon"><Lock size={28} /></div>
        <h1 class="form-title">Registration lock</h1>
        <p class="form-lede">This number is protected with a PIN. Enter it to sign in on this device.</p>
        <input
          class="field center-text pin-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]*"
          maxLength={12}
          autoFocus
          aria-label="PIN"
          value={pin}
          onInput={(e) => { setPin((e.target as HTMLInputElement).value.replace(/\D/g, '')); setError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && pin.length >= 4 && submit()}
        />
        <p class={`form-error${error ? ' shown' : ''}`} role="alert">{error}</p>
        <div class="form-spacer" />
        <Button onClick={submit} loading={busy} disabled={pin.length < 4}>Continue</Button>
        <p class="fine-print">Forgot it? The lock ends by itself after 7 days without activity on your account.</p>
      </div>
    </Screen>
  );
}

export function ProfileSetup() {
  const me = useStore((s) => s.me)!;
  const [name, setName] = useState(me.name);
  const [busy, run] = useAsync();
  const [uploading, runUpload] = useAsync();
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div class="screen">
      <div class="form-page profile-setup">
        <h1 class="form-title">Your profile</h1>
        <p class="form-lede">Add a name and a photo so people know it’s you.</p>
        <button class="avatar-picker" onClick={() => fileRef.current?.click()} aria-label="Choose profile photo" disabled={uploading}>
          <Avatar id={me.id} name={name || '?'} src={avatarUrl(me)} size={112} />
          <span class="avatar-picker-badge"><Camera size={18} /></span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            (e.target as HTMLInputElement).value = '';
            if (file) runUpload(async () => uploadAvatar(await prepareAvatar(file)));
          }}
        />
        <input
          class="field"
          type="text"
          placeholder="Your name"
          aria-label="Your name"
          autoComplete="name"
          maxLength={40}
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && run(() => updateProfile({ name }))}
        />
        <div class="form-spacer" />
        <Button onClick={() => run(() => updateProfile({ name }))} loading={busy} disabled={!name.trim()}>Continue</Button>
      </div>
    </div>
  );
}
