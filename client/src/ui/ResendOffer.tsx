// "Jonas set up Haven again and lost their messages. Send yours again?"

import { useEffect, useState } from 'preact/hooks';
import { useStore, type Conv } from '../lib/store';
import { dismissResend, displayName, loadResendHandled, resendCandidates, resendHistoryTo } from '../lib/engine';
import { Spinner, toast } from './components';

export function ResendOffer({ conv }: { conv: Conv }) {
  const list = useStore((s) => s.messages[conv.id]);
  useStore((s) => s.pins);
  const [handled, setHandled] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  useEffect(() => { loadResendHandled().then(setHandled); }, []);
  if (!handled) return null;
  const people = resendCandidates(conv, list, handled);
  if (!people.length) return null;
  const person = people[0];
  const name = displayName(person);
  const first = name.split(' ')[0];

  const send = async () => {
    setBusy(person.id);
    setCount(0);
    try {
      const n = await resendHistoryTo(person.id, setCount);
      toast(n ? `Sent ${n} message${n === 1 ? '' : 's'} to ${first} again` : `Nothing to send – your messages from the last 30 days are not on this phone.`);
      setHandled(await loadResendHandled());
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send', 'error');
    } finally {
      setBusy(null);
    }
  };
  const later = async () => {
    await dismissResend(person.id);
    setHandled(await loadResendHandled());
  };

  return (
    <div class="resend-offer">
      <p><strong>{name}</strong> set up Haven again and lost their messages. Send them your messages and vlogs from the last 30 days again? They stay end-to-end encrypted.</p>
      <div class="resend-actions">
        <button class="pill-button" onClick={send} disabled={Boolean(busy)}>
          {busy ? <><Spinner size={14} /> {count ? `${count} sent…` : 'Sending…'}</> : `Send to ${first}`}
        </button>
        <button class="resend-later" onClick={later} disabled={Boolean(busy)}>Not now</button>
      </div>
    </div>
  );
}
