// Encrypted chat backup: set a backup PIN, restore after setting Haven up again,
// and the settings screen.

import { useEffect, useState } from 'preact/hooks';
import { backupStatus, restoreBackup, runBackup, setBackupPin, turnOffBackup, type BackupStatus } from '../lib/engine';
import { formatDay, formatTime } from '../lib/format';
import { getNav } from '../ui/nav';
import { Button, Cell, Screen, Section, Spinner, confirmAction, toast, useAsync } from '../ui/components';
import { Cloud } from '../ui/icons';

const ASKED = 'haven.backupAsked';
const MIN_PIN = 6;

/** On start: offer to restore a backup (fresh install) or to turn backups on. */
export async function checkBackupOnStart() {
  let status: BackupStatus;
  try { status = await backupStatus(); } catch { return; }
  if (status.enabled && !status.local) {
    getNav().present((close) => <RestoreSheet close={close} updatedAt={status.updatedAt} />, { variant: 'full' });
    return;
  }
  if (!status.enabled) {
    let last = 0;
    try { last = Number(localStorage.getItem(ASKED) || 0); } catch { /* fine */ }
    if (Date.now() - last < 2 * 24 * 3600_000) return;
    try { localStorage.setItem(ASKED, String(Date.now())); } catch { /* fine */ }
    getNav().present((close) => <SetupSheet close={close} />, { variant: 'full' });
  }
}

const when = (t: number) => (t ? `${formatDay(t)}, ${formatTime(t)}` : 'never');

function PinFields({ pin, confirm, setPin, setConfirm, onEnter }: { pin: string; confirm?: string; setPin: (v: string) => void; setConfirm?: (v: string) => void; onEnter: () => void }) {
  const clean = (v: string) => v.replace(/\D/g, '').slice(0, 12);
  return (
    <div class="backup-pins">
      <input class="field pin-input" type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="new-password" placeholder="Backup PIN" aria-label="Backup PIN"
        value={pin} onInput={(e) => setPin(clean((e.target as HTMLInputElement).value))} onKeyDown={(e) => e.key === 'Enter' && onEnter()} />
      {setConfirm && (
        <input class="field pin-input" type="password" inputMode="numeric" pattern="[0-9]*" autoComplete="new-password" placeholder="Repeat PIN" aria-label="Repeat backup PIN"
          value={confirm} onInput={(e) => setConfirm(clean((e.target as HTMLInputElement).value))} onKeyDown={(e) => e.key === 'Enter' && onEnter()} />
      )}
    </div>
  );
}

export function SetupSheet({ close, change = false }: { close: () => Promise<void>; change?: boolean }) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, run] = useAsync();
  const ok = pin.length >= MIN_PIN && pin === confirm;
  const save = () => ok && run(async () => {
    await setBackupPin(pin);
    toast(change ? 'Backup PIN changed' : 'Backup is on. Your chats are safe.');
    await close();
  });
  return (
    <div class="sheet-page backup-sheet">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close()}>{change ? 'Cancel' : 'Later'}</button>
        <strong>Chat backup</strong>
        <span class="nav-button" aria-hidden="true" />
      </div>
      <div class="sheet-content">
        <div class="feature-hero">
          <span class="feature-icon on"><Cloud size={30} /></span>
          <h2>{change ? 'New backup PIN' : 'Never lose your chats'}</h2>
          <p>Haven keeps an encrypted copy of your chats, so they come back on a new phone or after removing the app. Only your backup PIN can unlock it – not even Haven can read it.</p>
        </div>
        <PinFields pin={pin} confirm={confirm} setPin={setPin} setConfirm={setConfirm} onEnter={save} />
        <p class="backup-hint">{pin.length > 0 && pin.length < MIN_PIN ? `At least ${MIN_PIN} digits.` : confirm && pin !== confirm ? 'The PINs don’t match.' : 'At least 6 digits. Write it down: without it the backup can’t be opened.'}</p>
        <Button disabled={!ok} loading={busy} onClick={save}>{change ? 'Save PIN' : 'Turn on backup'}</Button>
      </div>
    </div>
  );
}

function RestoreSheet({ close, updatedAt }: { close: () => Promise<void>; updatedAt: number }) {
  const [pin, setPin] = useState('');
  const [busy, run] = useAsync();
  const restore = () => pin.length >= 4 && run(async () => {
    const n = await restoreBackup(pin);
    toast(n ? `${n} messages restored` : 'Backup restored');
    await close();
  });
  const skip = async () => {
    const yes = await confirmAction({
      title: 'Skip restoring?',
      message: 'Your chats stay in the backup. To use backups on this phone you would set a new PIN, which replaces the old backup.',
      confirm: 'Skip',
      danger: true,
    });
    if (yes) await close();
  };
  return (
    <div class="sheet-page backup-sheet">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={skip}>Skip</button>
        <strong>Restore chats</strong>
        <span class="nav-button" aria-hidden="true" />
      </div>
      <div class="sheet-content">
        <div class="feature-hero">
          <span class="feature-icon on"><Cloud size={30} /></span>
          <h2>Welcome back</h2>
          <p>There is an encrypted backup of your chats from {when(updatedAt)}. Enter your backup PIN to bring them back.</p>
        </div>
        <PinFields pin={pin} setPin={setPin} onEnter={restore} />
        <Button disabled={pin.length < 4} loading={busy} onClick={restore}>Restore</Button>
      </div>
    </div>
  );
}

export function BackupScreen() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, run] = useAsync();
  const load = () => backupStatus().then(setStatus, () => setStatus(null));
  useEffect(() => { load(); }, []);

  if (!status) return <Screen back title="Chat backup" grouped><div class="center pad"><Spinner /></div></Screen>;
  const on = status.enabled && status.local;
  return (
    <Screen back title="Chat backup" grouped>
      <div class="feature-hero">
        <span class={`feature-icon${on ? ' on' : ''}`}><Cloud size={30} /></span>
        <h2>{on ? 'Backup is on' : status.enabled ? 'Backup not on this phone' : 'Backup is off'}</h2>
        <p>{on
          ? 'An encrypted copy of your chats is saved automatically. Only your backup PIN can unlock it.'
          : 'Without a backup, your chats are gone if you remove Haven or lose your phone.'}</p>
      </div>
      {on ? (
        <>
          <Section footer="Backs up every few minutes while Haven is open and when you leave it. Photos and videos stay available for 30 days.">
            <Cell title="Last backup" value={when(status.updatedAt)} />
            <Cell title="Back up now" accent onClick={() => run(async () => { await runBackup(true); await load(); toast('Backed up'); })} right={busy ? <Spinner size={16} /> : undefined} />
          </Section>
          <Section>
            <Cell title="Change backup PIN" chevron onClick={() => getNav().present((close) => <SetupSheet change close={async () => { await close(); load(); }} />, { variant: 'full' })} />
            <Cell title="Turn off backup" danger onClick={async () => {
              if (await confirmAction({ title: 'Turn off backup?', message: 'The encrypted backup is deleted from the server. Your chats stay on this phone.', confirm: 'Turn off', danger: true })) {
                run(async () => { await turnOffBackup(); await load(); });
              }
            }} />
          </Section>
        </>
      ) : (
        <div class="pad-x">
          <Button onClick={() => getNav().present((close) => <SetupSheet close={async () => { await close(); load(); }} />, { variant: 'full' })}>{status.enabled ? 'Set a new backup PIN' : 'Turn on backup'}</Button>
        </div>
      )}
    </Screen>
  );
}
