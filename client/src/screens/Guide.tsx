// A short guide for new users, and "What's new" after an update.

import { useState } from 'preact/hooks';
import { getNav } from '../ui/nav';
import { Button } from '../ui/components';
import { VlogIcon } from './Today';
import { Lock, People, Bell } from '../ui/icons';
import type { JSX } from 'preact';

// ------------------------------------------------------------------ guide

// A function, not a constant: icons come from modules that import this one.
const steps = (): { icon: JSX.Element; title: string; text: string }[] => [
  { icon: <Lock size={30} />, title: 'Welcome to Haven', text: 'A private messenger for you and your friends. Every message, photo and vlog is end-to-end encrypted.' },
  { icon: <VlogIcon size={32} />, title: 'Vlog your Day', text: 'Every day one friend from your group is picked at random to vlog their day. Everyone else follows along on the Today tab.' },
  { icon: <Bell size={30} />, title: 'When it’s your turn', text: 'You get a push in the morning. Share up to 3 videos or 6 photos during the day – your friends react with emoji.' },
  { icon: <People size={30} />, title: 'Your friend group', text: 'Create your group and share its invite link. Got a link from a friend? Open it and join their group.' },
];

export function openGuide(onDone: () => void) {
  getNav().present((close) => <Guide close={close} />, { variant: 'full', onClose: onDone });
}

function Guide({ close }: { close: () => Promise<void> }) {
  const [i, setI] = useState(0);
  const STEPS = steps();
  const step = STEPS[i];
  const last = i === STEPS.length - 1;
  return (
    <div class="sheet-page guide">
      <div class="sheet-header">
        <span />
        <span class="guide-dots" aria-hidden="true">{STEPS.map((_, k) => <span key={k} class={k === i ? 'on' : ''} />)}</span>
        <button class="nav-button" onClick={() => close()}>Skip</button>
      </div>
      <div class="guide-body" key={i}>
        <span class="guide-num">{String(i + 1).padStart(2, '0')}</span>
        <span class="guide-icon">{step.icon}</span>
        <h2>{step.title}</h2>
        <p>{step.text}</p>
      </div>
      <div class="guide-actions">
        <Button onClick={() => (last ? close() : setI(i + 1))}>{last ? 'Let’s go' : 'Next'}</Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ what's new

/** Bump with every update that has something to tell. */
export const WHATS_NEW_VERSION = '2026-11-09c';
const SEEN_KEY = 'haven.whatsNewSeen';

const WHATS_NEW: string[] = [
  'Make your own stickers: tap the sticker icon, then “From photo” – Haven cuts out the person or object automatically.',
  'New: Haven stickers – tap the sticker icon in the message field.',
  'Edit photos before sending – draw, write and add Haven stickers. View-once photos can have a caption too.',
  'Forward messages, see who voted in polls, and turn voice messages into text – right on your phone.',
  'Call people in one-to-one chats: tap the phone at the top. End-to-end encrypted and free.',
  'No more Telegram: you sign in with a passkey (Face ID). No phone number needed.',
  'Pick a @username in your profile, so friends can find you.',
  'You can be in several friend groups. Switch or add one with the button next to the bell.',
  'Haven is now available in German. Change it in Settings → Language.',
  'Every friend group has one invite link. Whoever opens it is asked whether to join.',
  'Zoom into vlog and chat photos with two fingers or a double tap.',
  'The camera opens right away. Decide after taking a photo whether it’s view once.',
  'The newest vlog posts are on top, and today’s vlogger gets a reminder at 6 pm.',
];

export function markWhatsNewSeen() {
  try { localStorage.setItem(SEEN_KEY, WHATS_NEW_VERSION); } catch { /* fine */ }
}

/** Show what's new once per update (not to brand-new users). */
export function maybeShowWhatsNew(): boolean {
  let seen: string | null = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch { return false; }
  if (seen === WHATS_NEW_VERSION) return false;
  markWhatsNewSeen();
  getNav().present((close) => <WhatsNew close={close} />, { variant: 'card' });
  return true;
}

function WhatsNew({ close }: { close: () => Promise<void> }) {
  return (
    <div class="sheet-page whats-new">
      <div class="sheet-header sheet-drag">
        <span />
        <strong>What’s new</strong>
        <button class="nav-button bold" onClick={() => close()}>Done</button>
      </div>
      <div class="sheet-content">
        <h2 class="whats-new-title">New in Haven</h2>
        <ul class="whats-new-list">
          {WHATS_NEW.map((item, k) => <li key={k}><span class="whats-new-num">{String(k + 1).padStart(2, '0')}</span><span>{item}</span></li>)}
        </ul>
        <Button onClick={() => close()}>Got it</Button>
      </div>
    </div>
  );
}
