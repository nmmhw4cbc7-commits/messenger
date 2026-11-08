// The page an invite link opens: "Join „Friends“?" with the faces of who is
// already in the group. New people create their account right there; people
// who already have one confirm with their passkey.

import { useEffect, useState } from 'preact/hooks';
import { Avatar, Button, Spinner, toast, useAsync } from '../ui/components';
import { getNav, useNav } from '../ui/nav';
import { currentLang } from '../lib/i18n';
import { clearJoin, inviteAvatarUrl, previewInvite, type InvitePerson, type InvitePreview } from '../lib/invite';
import { isPasskeyCancel, joinCircle, joinWithPasskey, passkeySupported, signInWithPasskey } from '../lib/engine';
import { errorMessage } from '../lib/api';
import { getState } from '../lib/store';

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;

/** Overlapping profile photos of the people in the group. */
export function Faces({ code, people, total, size = 64 }: { code: string; people: InvitePerson[]; total: number; size?: number }) {
  const shown = people.slice(0, 5);
  const more = Math.max(0, total - shown.length);
  return (
    <div class="faces" style={{ '--face': `${size}px` }}>
      {shown.map((p, i) => (
        <span key={p.id} class="face" style={{ zIndex: 10 - i }}>
          <Avatar id={p.id} name={p.name} src={inviteAvatarUrl(code, p)} size={size} />
        </span>
      ))}
      {more > 0 && <span class="face face-more" style={{ zIndex: 1 }}>{`+${more}`}</span>}
    </div>
  );
}

/** "Anna, Ben and Carla are already in this group." */
export function membersText(info: InvitePreview): string {
  const people = info.people ?? [];
  const de = currentLang() === 'de';
  if (!people.length) return de ? 'Sei die erste Person in dieser Gruppe.' : 'Be the first one in this group.';
  const names = people.slice(0, 3).map((p) => firstName(p.name));
  const rest = Math.max(0, info.members - names.length);
  const and = de ? 'und' : 'and';
  let list: string;
  if (rest > 0) list = `${names.join(', ')} ${and} ${rest} ${de ? (rest === 1 ? 'weitere Person' : 'weitere') : 'more'}`;
  else if (names.length === 1) list = names[0];
  else list = `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`;
  const one = names.length === 1 && rest === 0;
  return de ? `${list} ${one ? 'ist' : 'sind'} schon in dieser Gruppe.` : `${list} ${one ? 'is' : 'are'} already in this group.`;
}

/** Signed out, opened an invite link. */
export function JoinWelcome({ code, onSkip, onCreate }: { code: string; onSkip: () => void; onCreate: (info: InvitePreview) => void }) {
  const nav = useNav();
  const [info, setInfo] = useState<InvitePreview | null>(null);
  const [error, setError] = useState('');
  const [busy, run] = useAsync();
  useEffect(() => {
    previewInvite(code).then(setInfo, (err) => { toast(errorMessage(err), 'error'); clearJoin(); onSkip(); });
  }, [code]);

  if (!info) return <div class="screen welcome join-welcome"><div class="center pad grow"><Spinner /></div></div>;

  const noPasskeys = () => setError('This browser can’t use passkeys. On iPhone, update to iOS 16 or newer.');
  const existing = () => {
    setError('');
    if (!passkeySupported()) return noPasskeys();
    run(async () => {
      if (isIOS() && !isStandalone()) {
        // Haven on this iPhone runs from the Home Screen: join from here without signing this browser in.
        const title = await joinWithPasskey(code);
        clearJoin();
        nav.push(<JoinedScreen title={title || info.title} />);
        return;
      }
      await signInWithPasskey();
      clearJoin();
      await joinCircle(code).then((c) => toast(`You joined “${c.title}”`), (err) => toast(errorMessage(err), 'error'));
    }, (err) => setError(isPasskeyCancel(err) ? '' : errorMessage(err)));
  };

  return (
    <div class="screen welcome join-welcome">
      <div class="welcome-top">
        <span class="led">Invitation</span>
        <span>Haven</span>
      </div>
      <div class="join-hero">
        <Faces code={code} people={info.people ?? []} total={info.members} />
        <h1 class="join-title">{`Join “${info.title}”?`}</h1>
        <p class="join-members">{membersText(info)}</p>
        <p class="join-about">Every day one of you is picked to vlog their day. Private and end-to-end encrypted.</p>
      </div>
      <div class="welcome-actions">
        {error && <p class="form-error shown" role="alert">{error}</p>}
        <Button onClick={() => (passkeySupported() ? onCreate(info) : noPasskeys())}>Join group</Button>
        <Button variant="secondary" onClick={existing} loading={busy}>I already have an account</Button>
        <Button variant="plain" onClick={onSkip}>Not now</Button>
      </div>
    </div>
  );
}

/** Joined from Safari with an existing account. */
function JoinedScreen({ title }: { title: string }) {
  const [busy, run] = useAsync();
  return (
    <div class="screen welcome join-welcome">
      <div class="welcome-top"><span class="led">Joined</span><span>Haven</span></div>
      <div class="join-hero">
        <h1 class="join-title">{`You’re in “${title}”!`}</h1>
        <p class="join-members">Open Haven from your Home Screen – the group is already there.</p>
      </div>
      <div class="welcome-actions">
        <Button variant="secondary" loading={busy} onClick={() => run(async () => { await signInWithPasskey(); }, (err) => { if (!isPasskeyCancel(err)) toast(errorMessage(err), 'error'); })}>Use Haven here in Safari instead</Button>
        <p class="fine-print">Using Haven here signs out Haven on your Home Screen.</p>
      </div>
    </div>
  );
}

const INSTALL_ASKED = 'haven.installAsked';

/** Signed up in Safari on an iPhone: show how to put Haven on the Home Screen (for notifications). */
export function maybeAskInstall(): boolean {
  if (!isIOS() || isStandalone() || !getState().me) return false;
  try {
    if (Date.now() - Number(localStorage.getItem(INSTALL_ASKED) || 0) < 3 * 24 * 3600_000) return false;
    localStorage.setItem(INSTALL_ASKED, String(Date.now()));
  } catch { return false; }
  getNav().present((close) => <InstallSheet close={close} />, { variant: 'card' });
  return true;
}

function InstallSheet({ close }: { close: () => Promise<void> }) {
  return (
    <div class="sheet-page">
      <div class="sheet-header sheet-drag">
        <span />
        <strong>Add to Home Screen</strong>
        <button class="nav-button bold" onClick={() => close()}>Done</button>
      </div>
      <div class="sheet-content">
        <p class="muted">Put Haven on your Home Screen so you get notifications and it opens like an app.</p>
        <ol class="steps">
          <li><span class="step-num">1</span><span>Tap Share at the bottom of Safari</span></li>
          <li><span class="step-num">2</span><span>Tap “Add to Home Screen”</span></li>
          <li><span class="step-num">3</span><span>Open Haven there and tap “I already have an account”</span></li>
        </ol>
        <Button variant="secondary" onClick={() => close()}>Got it</Button>
      </div>
    </div>
  );
}
