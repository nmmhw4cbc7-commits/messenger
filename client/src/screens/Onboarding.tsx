import { useEffect, useRef, useState } from 'preact/hooks';
import { Button, Screen, Avatar, useAsync, toast } from '../ui/components';
import { PhoneField, type PhoneValue } from '../ui/PhoneField';
import { useNav } from '../ui/nav';
import { Lock, Camera, Shield, Key } from '../ui/icons';
import { guessCountry, toE164, prettyPhone } from '../lib/phone';
import { requestCode, verifyCode, submitPin, forgetDevice, updateProfile, uploadAvatar, avatarUrl } from '../lib/engine';
import { ApiError, errorMessage } from '../lib/api';
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
      const res = await requestCode(e164);
      nav.push(<CodeScreen phone={res.phone} resendAfter={res.resendAfter} />);
    }, (err) => setError(errorMessage(err)));
  };

  return (
    <Screen back>
      <div class="form-page">
        <h1 class="form-title">Your phone number</h1>
        <p class="form-lede">We’ll send you a text with a verification code.</p>
        <PhoneField value={value} onChange={(v) => { setValue(v); setError(''); }} autoFocus onSubmit={submit} />
        <p class={`form-error${error ? ' shown' : ''}`} role="alert">{error}</p>
        <div class="form-spacer" />
        <Button onClick={submit} loading={busy} disabled={!value.national}>Continue</Button>
        <p class="fine-print">Your number is used to sign in and so friends can find you. Carrier rates may apply.</p>
      </div>
    </Screen>
  );
}

function CodeScreen({ phone, resendAfter }: { phone: string; resendAfter: number }) {
  const nav = useNav();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [wait, setWait] = useState(resendAfter);
  const [busy, run] = useAsync();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const submit = (value: string) => {
    run(async () => {
      const res = await verifyCode(phone, value);
      if (res.pinChallenge) nav.push(<PinScreen challenge={res.pinChallenge} />);
    }, (err) => {
      setError(errorMessage(err));
      setCode('');
      navigator.vibrate?.(30);
      inputRef.current?.focus();
    });
  };

  const resend = () => {
    run(async () => {
      const res = await requestCode(phone);
      setWait(res.resendAfter);
      setError('');
      toast('A new code is on its way.');
    }, (err) => {
      setError(errorMessage(err));
      if (err instanceof ApiError && typeof err.data.retryAfter === 'number') setWait(err.data.retryAfter);
    });
  };

  return (
    <Screen back>
      <div class="form-page">
        <h1 class="form-title">Enter the code</h1>
        <p class="form-lede">Sent to <strong class="nowrap">{prettyPhone(phone)}</strong></p>
        <div class={`code-boxes${error ? ' error' : ''}`} onClick={() => inputRef.current?.focus()}>
          <input
            ref={inputRef}
            class="code-input"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            autoFocus
            aria-label="Verification code"
            value={code}
            disabled={busy}
            onInput={(e) => {
              const v = (e.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, 6);
              setCode(v);
              setError('');
              if (v.length === 6) submit(v);
            }}
          />
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} class={`code-box${i === code.length && !busy ? ' current' : ''}${code[i] ? ' filled' : ''}`}>{code[i] ?? ''}</span>
          ))}
        </div>
        <p class={`form-error${error ? ' shown' : ''}`} role="alert">{error}</p>
        <div class="code-actions">
          <button class="link-button" onClick={resend} disabled={wait > 0 || busy}>
            {wait > 0 ? `Resend code in 0:${String(wait).padStart(2, '0')}` : 'Resend code'}
          </button>
        </div>
      </div>
    </Screen>
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
