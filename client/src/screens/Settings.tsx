import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore, type Profile, type Theme } from '../lib/store';
import {
  avatarUrl, updateProfile, uploadAvatar, removeAvatar, setTheme, signOut, deleteAccount, addPasskey, passkeySupported, isPasskeyCancel,
  listBlocked, unblock, pushSupported, pushEnabled, enablePush, turnOffPush, displayName, setPushPreview,
  syncLanguage,
} from '../lib/engine';
import { editAvatar } from '../ui/AvatarEditor';
import { openPhoto } from '../ui/PhotoViewer';
import { prettyPhone, handleOf } from '../lib/phone';
import { errorMessage } from '../lib/api';
import { Avatar, Button, Cell, Screen, Section, Segmented, Spinner, Toggle, NavButton, actionSheet, confirmAction, toast, useAsync, Empty } from '../ui/components';
import { goBack, useNav } from '../ui/nav';
import { Bell, Block, Camera, Lock, Logout, Moon, Shield, Trash, Info, CheckDouble, Key, Clock, Vibrate, Cloud, Globe } from '../ui/icons';
import { BackupScreen } from './Backup';
import { hapticsOn, setHaptics } from '../lib/haptics';
import { langSetting, setLangSetting, type LangSetting } from '../lib/i18n';
import { DevicesScreen } from './Devices';

export function SettingsTab() {
  const nav = useNav();
  const me = useStore((s) => s.me)!;
  const theme = useStore((s) => s.theme);
  const [haptics, setHapticsState] = useState(hapticsOn());
  const [lang, setLang] = useState<LangSetting>(langSetting());
  const chooseLang = async (v: LangSetting) => {
    setLang(v);
    setLangSetting(v);
    await syncLanguage().catch(() => {});
    location.reload();
  };

  return (
    <Screen title="Settings" large grouped>
      <Section>
        <button class="profile-card" onClick={() => nav.push(<EditProfile />)}>
          <Avatar id={me.id} name={me.name} src={avatarUrl(me)} size={64} />
          <span class="profile-card-text">
            <strong>{me.name}</strong>
            <span>{me.about || handleOf(me)}</span>
          </span>
          <span class="profile-card-edit">Edit</span>
        </button>
      </Section>

      <Section header="Privacy & security" footer="With read receipts off, others don’t see when you read their messages. With last seen & online off, others don’t see when you were online, and you don’t see it for them either.">
        <Cell icon={<Lock size={19} />} iconBg="ink" title="Passkey" value={me.passkeys ? 'On' : 'Not set up'} chevron onClick={() => nav.push(<PasskeyScreen />)} />
        <Cell
          icon={<CheckDouble size={19} />}
          iconBg="ink"
          title="Read receipts"
          right={<Toggle label="Read receipts" checked={me.readReceipts !== false} onChange={(v) => updateProfile({ readReceipts: v }).catch((err) => toast(errorMessage(err), 'error'))} />}
        />
        <Cell
          icon={<Clock size={19} />}
          iconBg="ink"
          title="Last seen & online"
          right={<Toggle label="Last seen & online" checked={me.presence !== false} onChange={(v) => updateProfile({ presence: v }).catch((err) => toast(errorMessage(err), 'error'))} />}
        />
        <Cell icon={<Block size={19} />} iconBg="ink" title="Blocked people" chevron onClick={() => nav.push(<BlockedPeople />)} />
        <Cell icon={<Key size={19} />} iconBg="ink" title="Linked devices" value={String(me.devices?.length || 1)} chevron onClick={() => nav.push(<DevicesScreen />)} />
        <Cell icon={<Shield size={19} />} iconBg="ink" title="How Haven protects you" chevron onClick={() => nav.push(<SecurityInfo />)} />
      </Section>

      <Section header="Preferences">
        <Cell icon={<Cloud size={19} />} iconBg="ink" title="Chat backup" chevron onClick={() => nav.push(<BackupScreen />)} />
        <Cell icon={<Bell size={19} />} iconBg="ink" title="Notifications" chevron onClick={() => nav.push(<Notifications />)} />
        <div class="cell cell-stacked">
          <span class="cell-icon filled"><Moon size={19} /></span>
          <span class="cell-main">
            <span class="cell-title">Appearance</span>
            <Segmented<Theme> value={theme} onChange={setTheme} options={[{ value: 'system', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          </span>
        </div>
        <div class="cell cell-stacked">
          <span class="cell-icon filled"><Globe size={19} /></span>
          <span class="cell-main">
            <span class="cell-title">Language</span>
            <Segmented<LangSetting> value={lang} onChange={chooseLang} options={[{ value: 'auto', label: 'Auto' }, { value: 'en', label: 'English' }, { value: 'de', label: 'Deutsch' }]} />
          </span>
        </div>
        <Cell icon={<Vibrate size={19} />} iconBg="ink" title="Haptics" right={<Toggle label="Haptics" checked={haptics} onChange={(v) => { setHaptics(v); setHapticsState(v); }} />} />
      </Section>

      <Section>
        <Cell icon={<Logout size={19} />} title="Sign out" onClick={async () => {
          if (await confirmAction({ message: 'This device is removed from your account. Its keys and chats are deleted from it.', confirm: 'Sign out', danger: true })) await signOut();
        }} />
        <Cell icon={<Trash size={19} />} title="Delete account" danger chevron onClick={() => nav.push(<DeleteAccount />)} />
      </Section>
      <p class="app-version">Haven · end-to-end encrypted</p>
    </Screen>
  );
}

function EditProfile() {
  const me = useStore((s) => s.me)!;
  const [name, setName] = useState(me.name);
  const [about, setAbout] = useState(me.about);
  const [username, setUsername] = useState(me.username ?? '');
  const [error, setError] = useState('');
  const [saving, runSave] = useAsync();
  const [uploading, runUpload] = useAsync();
  const fileRef = useRef<HTMLInputElement>(null);
  const handle = username.trim().replace(/^@/, '').toLowerCase();
  const dirty = name.trim() !== me.name || about.trim() !== me.about || handle !== (me.username ?? '');

  const photoMenu = () => {
    if (!me.avatarVersion) {
      fileRef.current?.click();
      return;
    }
    actionSheet([
      { label: 'View photo', run: () => openPhoto(avatarUrl(me)!, me.name) },
      { label: 'Choose new photo', run: () => fileRef.current?.click() },
      { label: 'Remove photo', danger: true, run: () => runUpload(() => removeAvatar()) },
    ]);
  };

  const save = () => runSave(async () => {
    await updateProfile({ name: name.trim(), about: about.trim(), ...(handle !== (me.username ?? '') ? { username: handle } : {}) });
    await goBack();
  }, (err) => setError(errorMessage(err)));

  return (
    <Screen back title="Profile" grouped right={<NavButton bold onClick={save} disabled={!dirty || !name.trim() || saving}>Done</NavButton>}>
      <div class="profile-hero">
        <button class="avatar-picker" onClick={photoMenu} aria-label="Change profile photo" disabled={uploading}>
          <Avatar id={me.id} name={name || me.name} src={avatarUrl(me)} size={112} />
          <span class="avatar-picker-badge">{uploading ? <Spinner size={16} /> : <Camera size={18} />}</span>
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => {
          const file = (e.target as HTMLInputElement).files?.[0];
          (e.target as HTMLInputElement).value = '';
          if (file) editAvatar(file).then((blob) => blob && runUpload(() => uploadAvatar(blob)));
        }} />
      </div>
      <Section header="Name" footer="Your name and photo are visible to people you chat with.">
        <input class="cell-input" type="text" maxLength={40} value={name} aria-label="Name" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </Section>
      <Section header="About">
        <input class="cell-input" type="text" maxLength={140} value={about} placeholder="A few words about you" aria-label="About" onInput={(e) => setAbout((e.target as HTMLInputElement).value)} />
      </Section>
      <Section header="Username" footer="Friends can find you by your username. 3–20 letters, numbers, dots or underscores.">
        <input class="cell-input" type="text" maxLength={21} value={username} placeholder="@username" aria-label="Username" autoCapitalize="none" autoCorrect="off" spellcheck={false}
          onInput={(e) => { setUsername((e.target as HTMLInputElement).value.replace(/[^A-Za-z0-9_.@]/g, '')); setError(''); }} />
      </Section>
      {error && <p class="form-error shown pad-x">{error}</p>}
      {me.phone && (
        <Section header="Phone number" footer="From your old sign-in. People who have it can still find you.">
          <Cell title={prettyPhone(me.phone)} />
        </Section>
      )}
    </Screen>
  );
}

function PasskeyScreen() {
  const me = useStore((s) => s.me)!;
  const [busy, run] = useAsync();
  const add = () => {
    if (!passkeySupported()) return toast('This browser can’t use passkeys. On iPhone, update to iOS 16 or newer.', 'error');
    run(async () => {
      try {
        await addPasskey();
        toast('Passkey saved');
      } catch (err) {
        if (!isPasskeyCancel(err)) toast(errorMessage(err), 'error');
      }
    });
  };
  return (
    <Screen back title="Passkey" grouped>
      <div class="feature-hero">
        <span class={`feature-icon${me.passkeys ? ' on' : ''}`}><Key size={30} /></span>
        <h2>{me.passkeys ? 'Your account has a passkey' : 'Secure your account'}</h2>
        <p>{me.passkeys
          ? 'You sign in with Face ID, Touch ID or your device code. The passkey is stored in your iCloud Keychain or Google Password Manager, so it also works on a new phone.'
          : 'Without a passkey you can’t sign in again if you are signed out or get a new phone. It takes one tap with Face ID.'}</p>
      </div>
      {!!me.passkeys && (
        <Section footer="Add another one, for example if you also use an Android phone or a second Apple account.">
          <Cell title="Passkeys on this account" value={String(me.passkeys)} />
        </Section>
      )}
      <div class="pad-x">
        <Button variant={me.passkeys ? 'secondary' : 'primary'} loading={busy} onClick={add}>{me.passkeys ? 'Add another passkey' : 'Create passkey'}</Button>
      </div>
    </Screen>
  );
}

function BlockedPeople() {
  const [list, setList] = useState<Profile[] | null>(null);
  const [error, setError] = useState('');
  const [, run] = useAsync();

  useEffect(() => {
    listBlocked().then(setList, (err) => setError(errorMessage(err)));
  }, []);

  return (
    <Screen back title="Blocked people" grouped>
      {error ? (
        <p class="form-error shown pad">{error}</p>
      ) : !list ? (
        <div class="center pad"><Spinner /></div>
      ) : !list.length ? (
        <Empty icon={<Block size={28} />} title="No one is blocked" text="People you block can’t message you or add you to groups. They aren’t told." />
      ) : (
        <Section footer="Blocked people can’t message you or add you to groups.">
          {list.map((p) => (
            <Cell
              key={p.id}
              icon={<Avatar id={p.id} name={displayName(p)} src={avatarUrl(p)} size={36} />}
              title={displayName(p)}
              subtitle={handleOf(p)}
              right={<button class="small-button" onClick={() => run(async () => { await unblock(p.id); setList((l) => l!.filter((x) => x.id !== p.id)); toast('Unblocked'); })}>Unblock</button>}
            />
          ))}
        </Section>
      )}
    </Screen>
  );
}

function Notifications() {
  const pushPreview = useStore((s) => s.pushPreview);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, run] = useAsync();
  const supported = pushSupported();
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  useEffect(() => {
    pushEnabled().then(setEnabled, () => setEnabled(false));
  }, []);

  return (
    <Screen back title="Notifications" grouped>
      <Section footer="Messages are decrypted on this phone just for the notification. Apple’s and Google’s push servers never see names or text.">
        <Cell
          title="Message notifications"
          right={enabled === null ? <Spinner /> : (
            <Toggle label="Message notifications" checked={enabled} disabled={!supported || busy} onChange={(v) => run(async () => {
              if (v) await enablePush();
              else await turnOffPush();
              setEnabled(v);
            })} />
          )}
        />
        <Cell
          title="Show name and message"
          right={<Toggle label="Show name and message" checked={pushPreview} disabled={!enabled} onChange={(v) => setPushPreview(v)} />}
        />
      </Section>
      {!supported && (
        <div class="callout">
          <Info size={20} />
          <p>{ios && !standalone
            ? 'To get notifications on iPhone, add Haven to your Home Screen: tap Share, then “Add to Home Screen”, and open it from there.'
            : 'This browser does not support notifications.'}</p>
        </div>
      )}
    </Screen>
  );
}

function SecurityInfo() {
  const points: [string, string][] = [
    ['End-to-end encryption', 'Messages are encrypted on your device with AES-256-GCM. A new key is made for every message and wrapped for each recipient with elliptic-curve Diffie-Hellman (P-256). Only the people in the chat can decrypt it.'],
    ['Keys that never leave your phone', 'Your private keys are created on this device and stored so that not even Haven’s own code can export them.'],
    ['Signed messages', 'Every message is signed by its sender. Haven checks the signature before showing a message, so the server can’t forge or alter one.'],
    ['Safety numbers', 'If a contact’s keys change, you’ll see a notice in the chat. Verify the safety number in person to rule out anyone listening in.'],
    ['Delete after delivery', 'The server only holds encrypted messages until they are delivered, at most 30 days. Your chat history lives on your device.'],
    ['Minimal metadata', 'The server knows your name, username, photo and who is in which chat, because it needs them to deliver messages. No phone number is needed. It never sees message content.'],
    ['Passkey sign-in', 'Your account is protected by a passkey. Signing in needs Face ID, Touch ID or your device code; there is no password or SMS code anyone could steal.'],
  ];
  return (
    <Screen back title="Security" grouped>
      <div class="feature-hero">
        <span class="feature-icon on"><Shield size={30} /></span>
        <h2>How Haven protects you</h2>
      </div>
      <div class="explainer">
        {points.map(([title, text]) => (
          <div key={title} class="explainer-item">
            <h3>{title}</h3>
            <p>{text}</p>
          </div>
        ))}
      </div>
    </Screen>
  );
}

function DeleteAccount() {
  const [busy, run] = useAsync();
  return (
    <Screen back title="Delete account" grouped>
      <div class="feature-hero">
        <span class="feature-icon danger"><Trash size={30} /></span>
        <h2>Delete your account</h2>
        <p>Your profile, photo and undelivered messages are deleted from the server, you leave all groups, and everything on this device is erased. This can’t be undone.</p>
      </div>
      <div class="pad-x">
        <Button variant="danger" loading={busy} onClick={async () => {
          if (await confirmAction({ message: 'Delete your account permanently?', confirm: 'Delete account', danger: true })) {
            run(() => deleteAccount());
          }
        }}>Delete account</Button>
      </div>
    </Screen>
  );
}
