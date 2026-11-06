import { useMemo, useState } from 'preact/hooks';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { useStore, type Profile } from '../lib/store';
import { avatarUrl, displayName, lookupPhone, openDirect, createGroup } from '../lib/engine';
import { guessCountry, prettyPhone, toE164 } from '../lib/phone';
import { errorMessage } from '../lib/api';
import { Avatar, Button, Spinner, toast, useAsync } from '../ui/components';
import { PhoneField, type PhoneValue } from '../ui/PhoneField';
import { getNav } from '../ui/nav';
import { Check, ChevronLeft, ChevronRight, Contacts, People, Share } from '../ui/icons';
import { ChatScreen } from './Chat';

type Lookup = { state: 'idle' } | { state: 'found'; user: Profile } | { state: 'missing'; phone: string } | { state: 'error'; message: string };

const contactPickerSupported = () => 'contacts' in navigator && 'ContactsManager' in window;

async function pickContactNumber(): Promise<string | null> {
  try {
    const nav = navigator as Navigator & { contacts: { select(props: string[], opts: { multiple: boolean }): Promise<{ tel?: string[] }[]> } };
    const [contact] = await nav.contacts.select(['tel'], { multiple: false });
    return contact?.tel?.[0] ?? null;
  } catch {
    return null;
  }
}

function phoneValueFrom(raw: string, fallback: PhoneValue): PhoneValue {
  const parsed = parsePhoneNumberFromString(raw, fallback.country);
  return parsed?.country ? { country: parsed.country, national: parsed.formatNational() } : { ...fallback, national: raw };
}

/** Everyone we already share a chat with. */
function useKnownPeople() {
  const convs = useStore((s) => s.convs);
  const meId = useStore((s) => s.me?.id);
  return useMemo(() => {
    const map = new Map<string, Profile>();
    for (const c of Object.values(convs)) for (const m of c.members) if (m.id !== meId && m.name) map.set(m.id, m);
    return [...map.values()].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }, [convs, meId]);
}

export async function invite(phone: string) {
  const text = `I’m using Haven for private, end-to-end encrypted messages. Join me: ${location.origin}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Haven', text });
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
    }
  }
  location.href = `sms:${encodeURIComponent(phone)}?&body=${encodeURIComponent(text)}`;
}

export function NewChatSheet({ close }: { close: () => Promise<void> }) {
  const [mode, setMode] = useState<'chat' | 'group'>('chat');
  return mode === 'chat' ? <DirectStep close={close} onGroup={() => setMode('group')} /> : <GroupFlow close={close} onBack={() => setMode('chat')} />;
}

async function openChatFromSheet(close: () => Promise<void>, convId: string) {
  await close();
  getNav().push(<ChatScreen convId={convId} />);
}

function DirectStep({ close, onGroup }: { close: () => Promise<void>; onGroup: () => void }) {
  const known = useKnownPeople();
  const [value, setValue] = useState<PhoneValue>({ country: guessCountry(), national: '' });
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });
  const [busy, run] = useAsync();
  const e164 = toE164(value.national, value.country);

  const find = () => {
    if (!e164) {
      setLookup({ state: 'error', message: 'Please enter a valid mobile number.' });
      return;
    }
    run(async () => {
      const res = await lookupPhone(e164);
      setLookup(res.found && res.user ? { state: 'found', user: res.user } : { state: 'missing', phone: res.phone });
    }, (err) => setLookup({ state: 'error', message: errorMessage(err) }));
  };

  const start = (userId: string) => run(async () => {
    const conv = await openDirect(userId);
    await openChatFromSheet(close, conv.id);
  });

  return (
    <div class="sheet-page">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close()}>Cancel</button>
        <strong>New chat</strong>
        <span />
      </div>
      <div class="sheet-scroll">
        <div class="sheet-content">
          <PhoneField value={value} onChange={(v) => { setValue(v); setLookup({ state: 'idle' }); }} autoFocus onSubmit={find} />
          <div class="row-gap">
            <Button onClick={find} loading={busy && lookup.state === 'idle'} disabled={!value.national}>Find</Button>
            {contactPickerSupported() && (
              <button class="icon-button-large" aria-label="Choose from contacts" onClick={async () => {
                const tel = await pickContactNumber();
                if (tel) { setValue(phoneValueFrom(tel, value)); setLookup({ state: 'idle' }); }
              }}>
                <Contacts size={24} />
              </button>
            )}
          </div>

          {lookup.state === 'error' && <p class="form-error shown" role="alert">{lookup.message}</p>}
          {lookup.state === 'found' && (
            <button class="result-card" onClick={() => start(lookup.user.id)} disabled={busy}>
              <Avatar id={lookup.user.id} name={displayName(lookup.user)} src={avatarUrl(lookup.user)} size={48} />
              <span class="result-text">
                <strong>{displayName(lookup.user)}</strong>
                <span>{prettyPhone(lookup.user.phone)}</span>
              </span>
              {busy ? <Spinner /> : <ChevronRight size={20} class="muted" />}
            </button>
          )}
          {lookup.state === 'missing' && (
            <div class="invite-card">
              <strong>{prettyPhone(lookup.phone)} isn’t on Haven yet</strong>
              <p>Send an invite. Once they join, you can write to them here.</p>
              <Button variant="secondary" onClick={() => invite(lookup.phone)}><Share size={19} /> Invite to Haven</Button>
            </div>
          )}
        </div>

        <div class="plain-list">
          <button class="plain-row" onClick={onGroup}>
            <span class="row-icon"><People size={22} /></span>
            <span class="plain-row-title accent">New group</span>
          </button>
        </div>

        {known.length > 0 && (
          <>
            <h2 class="list-heading">People</h2>
            <div class="plain-list">
              {known.map((p) => (
                <button key={p.id} class="plain-row person" onClick={() => start(p.id)} disabled={busy}>
                  <Avatar id={p.id} name={displayName(p)} src={avatarUrl(p)} size={40} />
                  <span class="plain-row-text">
                    <span class="plain-row-title">{displayName(p)}</span>
                    <span class="plain-row-sub">{prettyPhone(p.phone)}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Pick people (known contacts or by number), then name the group. Also used to add members later. */
export function PeoplePicker({ title, confirmLabel, exclude, onCancel, onConfirm, cancelLabel = 'Cancel', backArrow }: {
  title: string;
  confirmLabel: string;
  exclude?: Set<string>;
  onCancel: () => void;
  onConfirm: (people: Profile[]) => void;
  cancelLabel?: string;
  backArrow?: boolean;
}) {
  const knownAll = useKnownPeople();
  const [extra, setExtra] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<Map<string, Profile>>(new Map());
  const [value, setValue] = useState<PhoneValue>({ country: guessCountry(), national: '' });
  const [message, setMessage] = useState<{ text: string; phone?: string } | null>(null);
  const [busy, run] = useAsync();

  const people = useMemo(() => {
    const map = new Map<string, Profile>();
    for (const p of [...extra, ...knownAll]) if (!exclude?.has(p.id)) map.set(p.id, p);
    return [...map.values()];
  }, [knownAll, extra, exclude]);

  const toggle = (p: Profile) => {
    const next = new Map(selected);
    if (next.has(p.id)) next.delete(p.id);
    else next.set(p.id, p);
    setSelected(next);
  };

  const addByNumber = () => {
    const e164 = toE164(value.national, value.country);
    if (!e164) {
      setMessage({ text: 'Please enter a valid mobile number.' });
      return;
    }
    run(async () => {
      const res = await lookupPhone(e164);
      if (!res.found || !res.user) {
        setMessage({ text: `${prettyPhone(res.phone)} isn’t on Haven yet.`, phone: res.phone });
        return;
      }
      const user = res.user;
      if (exclude?.has(user.id)) {
        setMessage({ text: `${displayName(user)} is already in this group.` });
        return;
      }
      setExtra((e) => [user, ...e.filter((x) => x.id !== user.id)]);
      setSelected((s) => new Map(s).set(user.id, user));
      setValue({ ...value, national: '' });
      setMessage(null);
    }, (err) => setMessage({ text: errorMessage(err) }));
  };

  return (
    <div class="sheet-page">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={onCancel}>{backArrow ? <><ChevronLeft size={24} /> {cancelLabel}</> : cancelLabel}</button>
        <strong>{title}</strong>
        <button class="nav-button bold" disabled={!selected.size} onClick={() => onConfirm([...selected.values()])}>{confirmLabel}</button>
      </div>
      <div class="sheet-scroll">
        {selected.size > 0 && (
          <div class="chips">
            {[...selected.values()].map((p) => (
              <button key={p.id} class="chip" onClick={() => toggle(p)} aria-label={`Remove ${displayName(p)}`}>
                <Avatar id={p.id} name={displayName(p)} src={avatarUrl(p)} size={24} />
                <span>{displayName(p).split(' ')[0]}</span>
              </button>
            ))}
          </div>
        )}
        <div class="sheet-content">
          <PhoneField value={value} onChange={(v) => { setValue(v); setMessage(null); }} onSubmit={addByNumber} />
          <Button variant="secondary" onClick={addByNumber} loading={busy} disabled={!value.national}>Add by number</Button>
          {message && (
            <div class="inline-message">
              <span>{message.text}</span>
              {message.phone && <button class="link-button" onClick={() => invite(message.phone!)}>Invite</button>}
            </div>
          )}
        </div>
        {people.length > 0 ? (
          <div class="plain-list">
            {people.map((p) => (
              <button key={p.id} class="plain-row person" onClick={() => toggle(p)} role="checkbox" aria-checked={selected.has(p.id)}>
                <Avatar id={p.id} name={displayName(p)} src={avatarUrl(p)} size={40} />
                <span class="plain-row-text">
                  <span class="plain-row-title">{displayName(p)}</span>
                  <span class="plain-row-sub">{prettyPhone(p.phone)}</span>
                </span>
                <span class={`check-circle${selected.has(p.id) ? ' on' : ''}`}><Check size={15} stroke={3} /></span>
              </button>
            ))}
          </div>
        ) : (
          <p class="muted center pad">Add people by their phone number.</p>
        )}
      </div>
    </div>
  );
}

function GroupFlow({ close, onBack }: { close: () => Promise<void>; onBack: () => void }) {
  const [members, setMembers] = useState<Profile[] | null>(null);
  const [name, setName] = useState('');
  const [busy, run] = useAsync();

  if (!members) {
    return <PeoplePicker title="New group" confirmLabel="Next" cancelLabel="Back" backArrow onCancel={onBack} onConfirm={setMembers} />;
  }

  const create = () => run(async () => {
    const conv = await createGroup(name.trim(), members.map((m) => m.id));
    if (conv.members.length - 1 < members.length) toast('Some people could not be added.');
    await openChatFromSheet(close, conv.id);
  });

  return (
    <div class="sheet-page">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => setMembers(null)}><ChevronLeft size={24} /> Back</button>
        <strong>Name the group</strong>
        <button class="nav-button bold" disabled={!name.trim() || busy} onClick={create}>Create</button>
      </div>
      <div class="sheet-scroll">
        <div class="sheet-content">
          <div class="group-name-row">
            <span class="group-name-icon"><People size={28} /></span>
            <input class="field" type="text" placeholder="Group name" aria-label="Group name" maxLength={60} autoFocus value={name}
              onInput={(e) => setName((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()} />
          </div>
          <p class="fine-print left">Group names and members are visible to the server. Messages are end-to-end encrypted.</p>
        </div>
        <h2 class="list-heading">{members.length + 1} members</h2>
        <div class="plain-list">
          {members.map((p) => (
            <div key={p.id} class="plain-row person">
              <Avatar id={p.id} name={displayName(p)} src={avatarUrl(p)} size={40} />
              <span class="plain-row-text">
                <span class="plain-row-title">{displayName(p)}</span>
                <span class="plain-row-sub">{prettyPhone(p.phone)}</span>
              </span>
            </div>
          ))}
        </div>
        {busy && <div class="center pad"><Spinner /></div>}
      </div>
    </div>
  );
}
