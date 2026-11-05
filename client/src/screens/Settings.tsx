import { useEffect, useRef, useState } from 'preact/hooks';
import { useStore, type Profile, type Theme } from '../lib/store';
import {
  avatarUrl, updateProfile, uploadAvatar, removeAvatar, setTheme, signOut, deleteAccount, setPin, removePin,
  listBlocked, unblock, pushSupported, pushEnabled, enablePush, disablePush, displayName, setPushPreview,
} from '../lib/engine';
import { prepareAvatar } from '../lib/image';
import { prettyPhone, toE164 } from '../lib/phone';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { errorMessage } from '../lib/api';
import { Avatar, Button, Cell, Screen, Section, Segmented, Spinner, Toggle, NavButton, actionSheet, confirmAction, toast, useAsync, Empty } from '../ui/components';
import { goBack, useNav } from '../ui/nav';
import { Bell, Block, Camera, Lock, Logout, Moon, Shield, Trash, Info, CheckDouble } from '../ui/icons';

export function SettingsTab() {
  const nav = useNav();
  const me = useStore((s) => s.me)!;
  const theme = useStore((s) => s.theme);

  return (
    <Screen title="Settings" large grouped>
      <Section>
        <button class="profile-card" onClick={() => nav.push(<EditProfile />)}>
          <Avatar id={me.id} name={me.name} src={avatarUrl(me)} size={64} />
          <span class="profile-card-text">
            <strong>{me.name}</strong>
            <span>{me.about || prettyPhone(me.phone)}</span>
          </span>
          <span class="profile-card-edit">Edit</span>
        </button>
      </Section>

      <Section header="Privacy & security" footer="With read receipts off, others don’t see when you read their messages.">
        <Cell icon={<Lock size={19} />} iconBg="ink" title="Registration lock" value={me.hasPin ? 'On' : 'Off'} chevron onClick={() => nav.push(<RegistrationLock />)} />
        <Cell
          icon={<CheckDouble size={19} />}
          iconBg="ink"
          title="Read receipts"
          right={<Toggle label="Read receipts" checked={me.readReceipts !== false} onChange={(v) => updateProfile({ readReceipts: v }).catch((err) => toast(errorMessage(err), 'error'))} />}
        />
        <Cell icon={<Block size={19} />} iconBg="ink" title="Blocked people" chevron onClick={() => nav.push(<BlockedPeople />)} />
        <Cell icon={<Shield size={19} />} iconBg="ink" title="How Haven protects you" chevron onClick={() => nav.push(<SecurityInfo />)} />
      </Section>

      <Section header="Preferences">
        <Cell icon={<Bell size={19} />} iconBg="ink" title="Notifications" chevron onClick={() => nav.push(<Notifications />)} />
        <div class="cell cell-stacked">
          <span class="cell-icon filled"><Moon size={19} /></span>
          <span class="cell-main">
            <span class="cell-title">Appearance</span>
            <Segmented<Theme> value={theme} onChange={setTheme} options={[{ value: 'system', label: 'Auto' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          </span>
        </div>
      </Section>

      <Section>
        <Cell icon={<Logout size={19} />} title="Sign out" onClick={async () => {
          if (await confirmAction({ message: 'Signing out deletes your keys and all chats from this device. They cannot be restored.', confirm: 'Sign out', danger: true })) await signOut();
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
  const [saving, runSave] = useAsync();
  const [uploading, runUpload] = useAsync();
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = name.trim() !== me.name || about.trim() !== me.about;

  const photoMenu = () => {
    if (!me.avatarVersion) {
      fileRef.current?.click();
      return;
    }
    actionSheet([
      { label: 'Choose new photo', run: () => fileRef.current?.click() },
      { label: 'Remove photo', danger: true, run: () => runUpload(() => removeAvatar()) },
    ]);
  };

  const save = () => runSave(async () => {
    await updateProfile({ name: name.trim(), about: about.trim() });
    await goBack();
  });

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
          if (file) runUpload(async () => uploadAvatar(await prepareAvatar(file)));
        }} />
      </div>
      <Section header="Name" footer="Your name and photo are visible to people who have your number.">
        <input class="cell-input" type="text" maxLength={40} value={name} aria-label="Name" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </Section>
      <Section header="About">
        <input class="cell-input" type="text" maxLength={140} value={about} placeholder="A few words about you" aria-label="About" onInput={(e) => setAbout((e.target as HTMLInputElement).value)} />
      </Section>
      <Section header="Phone number">
        <Cell title={prettyPhone(me.phone)} />
      </Section>
    </Screen>
  );
}

function RegistrationLock() {
  const me = useStore((s) => s.me)!;
  const [pin, setPinValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, run] = useAsync();

  if (me.hasPin) {
    return (
      <Screen back title="Registration lock" grouped>
        <div class="feature-hero">
          <span class="feature-icon on"><Lock size={30} /></span>
          <h2>Registration lock is on</h2>
          <p>Signing in to your number on a new device needs your PIN, even with the SMS code. This protects you if someone takes over your phone number.</p>
        </div>
        <Section header="Turn off" footer="Enter your current PIN to turn the lock off.">
          <input class="cell-input" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={12} placeholder="Current PIN" aria-label="Current PIN" value={pin}
            onInput={(e) => setPinValue((e.target as HTMLInputElement).value.replace(/\D/g, ''))} />
        </Section>
        <div class="pad-x">
          <Button variant="danger" disabled={pin.length < 4} loading={busy} onClick={() => run(async () => { await removePin(pin); setPinValue(''); toast('Registration lock turned off'); })}>Turn off</Button>
        </div>
      </Screen>
    );
  }

  const valid = pin.length >= 4 && pin === confirm;
  return (
    <Screen back title="Registration lock" grouped>
      <div class="feature-hero">
        <span class="feature-icon"><Lock size={30} /></span>
        <h2>Protect your number</h2>
        <p>With a PIN, nobody can register your number on another device, even if they receive your SMS codes. The lock ends after 7 days without activity, so you can’t be locked out forever.</p>
      </div>
      <Section header="Choose a PIN" footer="4 to 12 digits. Don’t use your phone’s unlock code.">
        <input class="cell-input" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={12} placeholder="New PIN" aria-label="New PIN" value={pin}
          onInput={(e) => setPinValue((e.target as HTMLInputElement).value.replace(/\D/g, ''))} />
        <input class="cell-input" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={12} placeholder="Repeat PIN" aria-label="Repeat PIN" value={confirm}
          onInput={(e) => setConfirm((e.target as HTMLInputElement).value.replace(/\D/g, ''))} />
      </Section>
      {confirm.length >= 4 && pin !== confirm && <p class="form-error shown pad-x">The PINs don’t match.</p>}
      <div class="pad-x">
        <Button disabled={!valid} loading={busy} onClick={() => run(async () => { await setPin(pin); setPinValue(''); setConfirm(''); toast('Registration lock is on'); })}>Turn on</Button>
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
              subtitle={prettyPhone(p.phone)}
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
              else await disablePush();
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
    ['Minimal metadata', 'The server knows your phone number, name, photo and who is in which chat, because it needs them to deliver messages. It never sees message content.'],
    ['Registration lock', 'An optional PIN stops anyone who takes over your phone number from registering it on another device.'],
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
  const me = useStore((s) => s.me)!;
  const [phone, setPhone] = useState('');
  const [busy, run] = useAsync();
  const region = parsePhoneNumberFromString(me.phone)?.country ?? 'DE';
  const confirmed = toE164(phone, region);
  return (
    <Screen back title="Delete account" grouped>
      <div class="feature-hero">
        <span class="feature-icon danger"><Trash size={30} /></span>
        <h2>Delete your account</h2>
        <p>Your profile, photo and undelivered messages are deleted from the server, you leave all groups, and everything on this device is erased. This can’t be undone.</p>
      </div>
      <Section header="Confirm with your phone number" footer={`Enter ${prettyPhone(me.phone)} to confirm.`}>
        <input class="cell-input" type="tel" inputMode="tel" placeholder="Your phone number" aria-label="Your phone number" value={phone} onInput={(e) => setPhone((e.target as HTMLInputElement).value)} />
      </Section>
      <div class="pad-x">
        <Button variant="danger" disabled={confirmed !== me.phone} loading={busy} onClick={async () => {
          if (await confirmAction({ message: 'Delete your account permanently?', confirm: 'Delete account', danger: true })) {
            run(() => deleteAccount(me.phone));
          }
        }}>Delete account</Button>
      </div>
    </Screen>
  );
}
