import { addPasskey, isPasskeyCancel, passkeySupported } from '../lib/engine';
import { errorMessage } from '../lib/api';
import { getState } from '../lib/store';
import { Button, toast, useAsync } from '../ui/components';
import { getNav } from '../ui/nav';
import { Key } from '../ui/icons';

const ASKED = 'haven.passkeyAsked';

/**
 * Accounts made before passkeys can only sign in again with one. Ask once a
 * day until the account has a passkey. Returns true if the sheet was shown.
 */
export function maybeAskPasskey(): boolean {
  const me = getState().me;
  if (!me || (me.passkeys ?? 0) > 0 || !passkeySupported()) return false;
  try {
    if (Date.now() - Number(localStorage.getItem(ASKED) || 0) < 24 * 3600_000) return false;
    localStorage.setItem(ASKED, String(Date.now()));
  } catch { return false; }
  getNav().present((close) => <PasskeySheet close={close} />, { variant: 'full' });
  return true;
}

/** Opened from the "secure your account" notification. */
export function openPasskeySheet() {
  const me = getState().me;
  if (!me) return;
  if ((me.passkeys ?? 0) > 0) { toast('Your account already has a passkey.'); return; }
  try { localStorage.setItem(ASKED, String(Date.now())); } catch { /* fine */ }
  getNav().present((close) => <PasskeySheet close={close} />, { variant: 'full' });
}

function PasskeySheet({ close }: { close: () => Promise<void> }) {
  const [busy, run] = useAsync();
  const create = () => run(async () => {
    try {
      await addPasskey();
      toast('Passkey saved. Your account is secure.');
      await close();
    } catch (err) {
      if (!isPasskeyCancel(err)) toast(errorMessage(err), 'error');
    }
  });
  return (
    <div class="sheet-page backup-sheet">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close()}>Later</button>
        <strong>Passkey</strong>
        <span class="nav-button" aria-hidden="true" />
      </div>
      <div class="sheet-content">
        <div class="feature-hero">
          <span class="feature-icon on"><Key size={30} /></span>
          <h2>Secure your account</h2>
          <p>Haven no longer uses Telegram or your phone number to sign in. Create a passkey now – one tap with Face ID. Without it you can’t sign in again on a new phone or after being signed out.</p>
        </div>
        <Button loading={busy} onClick={create}>Create passkey</Button>
        <p class="fine-print">Saved in your iCloud Keychain or Google Password Manager. Haven never sees your face or fingerprint.</p>
      </div>
    </div>
  );
}
