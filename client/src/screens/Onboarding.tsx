import { useRef, useState } from 'preact/hooks';
import { Button, Screen, Avatar, toast, useAsync } from '../ui/components';
import { useNav } from '../ui/nav';
import { LinkDeviceScreen } from './Devices';
import { Camera } from '../ui/icons';
import { joinCircle, signUpWithPasskey, signInWithPasskey, passkeySupported, isPasskeyCancel, forgetDevice, updateProfile, uploadAvatar, avatarUrl } from '../lib/engine';
import { errorMessage } from '../lib/api';
import { useStore } from '../lib/store';
import { editAvatar } from '../ui/AvatarEditor';
import { offerCircleSetup } from './Today';
import { clearJoin, pendingJoin, type InvitePreview } from '../lib/invite';
import { JoinWelcome } from './JoinInvite';

export function Welcome() {
  const nav = useNav();
  const sessionEnded = useStore((s) => s.sessionEnded);
  const [error, setError] = useState('');
  const [busy, run] = useAsync();
  const [skipInvite, setSkipInvite] = useState(false);
  const code = pendingJoin();

  const signIn = () => {
    setError('');
    if (!passkeySupported()) return setError('This browser can’t use passkeys. On iPhone, update to iOS 16 or newer.');
    run(() => signInWithPasskey(), (err) => setError(isPasskeyCancel(err) ? '' : errorMessage(err)));
  };

  // Opened an invite link: straight to "Join „Friends“?".
  if (code.length === 12 && !skipInvite && !sessionEnded) {
    return <JoinWelcome code={code} onSkip={() => setSkipInvite(true)} onCreate={(info) => nav.push(<CreateAccountScreen join={{ code, info }} />)} />;
  }

  return (
    <div class="screen welcome">
      <div class="welcome-top">
        <span class="led">Encrypted</span>
        <span>v1.1</span>
      </div>
      <div class="welcome-body">
        <h1 class="wordmark">Haven</h1>
        <p class="welcome-lede">Private conversations, on your terms.</p>
        <ul class="spec">
          <li><span>01</span><span><strong>End-to-end</strong>Every message is encrypted on your device.</span></li>
          <li><span>02</span><span><strong>No phone number</strong>Your account is protected with a passkey: Face ID or Touch ID.</span></li>
          <li><span>03</span><span><strong>Verified</strong>Compare safety numbers with the people you talk to.</span></li>
        </ul>
      </div>
      <div class="welcome-actions">
        {error && <p class="form-error shown" role="alert">{error}</p>}
        {sessionEnded ? (
          <>
            <p class="notice-text">You were signed out. Sign in again to keep your chats on this device.</p>
            <Button onClick={signIn} loading={busy}><KeyIcon /> Sign in with passkey</Button>
            <Button variant="plain" onClick={() => nav.push(<LinkDeviceScreen />)}>Link to an existing account</Button>
            <Button variant="plain" onClick={() => forgetDevice()}>Start over</Button>
          </>
        ) : (
          <>
            <Button onClick={() => nav.push(<CreateAccountScreen />)}><span class="cta-dot" aria-hidden="true" />Get started</Button>
            <Button variant="secondary" onClick={signIn} loading={busy}><KeyIcon /> I already have an account</Button>
            <Button variant="plain" onClick={() => nav.push(<LinkDeviceScreen />)}>Link to an existing account</Button>
          </>
        )}
      </div>
    </div>
  );
}

function KeyIcon({ size = 19 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="8" cy="15" r="4" />
      <path d="m10.85 12.15 8.65-8.65M17 6l2.5 2.5M14.5 8.5l2 2" />
    </svg>
  );
}

function CreateAccountScreen({ join }: { join?: { code: string; info: InvitePreview } } = {}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, run] = useAsync();
  const submit = () => {
    if (!name.trim()) return;
    setError('');
    if (!passkeySupported()) return setError('This browser can’t use passkeys. On iPhone, update to iOS 16 or newer.');
    run(async () => {
      await signUpWithPasskey(name.trim());
      if (join) {
        clearJoin();
        await joinCircle(join.code).catch((err) => toast(errorMessage(err), 'error'));
      }
    }, (err) => setError(isPasskeyCancel(err) ? '' : errorMessage(err)));
  };

  return (
    <Screen back>
      <div class="form-page">
        <div class="form-icon"><KeyIcon size={28} /></div>
        <h1 class="form-title">{join ? `Join “${join.info.title}”` : 'Create your account'}</h1>
        <p class="form-lede">Haven protects your account with a passkey: Face ID, Touch ID or your device code. No phone number, no password.</p>
        <input
          class="field"
          type="text"
          placeholder="Your name"
          aria-label="Your name"
          autoComplete="name"
          maxLength={40}
          autoFocus
          value={name}
          onInput={(e) => { setName((e.target as HTMLInputElement).value); setError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <p class={`form-error${error ? ' shown' : ''}`} role="alert">{error}</p>
        <div class="form-spacer" />
        <Button onClick={submit} loading={busy} disabled={!name.trim()}>{join ? 'Join with passkey' : 'Create passkey'}</Button>
        <p class="fine-print">The passkey is saved in your iCloud Keychain or Google Password Manager, so you can sign in on a new phone too. Haven never sees your face or fingerprint.</p>
      </div>
    </Screen>
  );
}

export function ProfileSetup() {
  const me = useStore((s) => s.me)!;
  const [name, setName] = useState(me.name);
  const [username, setUsername] = useState(me.username ?? '');
  const [error, setError] = useState('');
  const [busy, run] = useAsync();
  const save = () => run(async () => {
    const handle = username.trim().replace(/^@/, '').toLowerCase();
    offerCircleSetup();
    await updateProfile(handle && handle !== me.username ? { name, username: handle } : { name });
  }, (err) => setError(errorMessage(err)));
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
            if (file) editAvatar(file).then((blob) => blob && runUpload(() => uploadAvatar(blob)));
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
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && save()}
        />
        <div class="username-field">
          <span aria-hidden="true">@</span>
          <input
            class="field"
            type="text"
            placeholder="username (optional)"
            aria-label="Username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellcheck={false}
            maxLength={21}
            value={username}
            onInput={(e) => { setUsername((e.target as HTMLInputElement).value.replace(/[^A-Za-z0-9_.@]/g, '')); setError(''); }}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && save()}
          />
        </div>
        <p class={`form-error${error ? ' shown' : ''}`} role="alert">{error}</p>
        <p class="fine-print">Friends can find you by your username. Or they send you an invite link.</p>
        <div class="form-spacer" />
        <Button onClick={save} loading={busy} disabled={!name.trim()}>Continue</Button>
      </div>
    </div>
  );
}
