import { useEffect, useState } from 'preact/hooks';
import { useStore, type Member } from '../lib/store';
import {
  avatarUrl, convTitle, displayName, otherMember, clearChat, block, unblock, listBlocked, renameGroup, addMembers,
  removeMember, leaveGroup, setRole, openDirect, setVerified, myDevices, acceptKeyChange, setAlias,
} from '../lib/engine';
import { safetyNumber } from '../lib/crypto';
import { prettyPhone } from '../lib/phone';
import { Avatar, Button, Cell, Screen, Section, Spinner, Toggle, actionSheet, confirmAction, toast, useAsync } from '../ui/components';
import { getNav, goBack, goBackMany, useNav } from '../ui/nav';
import { Block, Key, PersonAdd, Pencil, Trash, Exit, Shield } from '../ui/icons';
import { PeoplePicker } from './NewChat';
import { ChatScreen } from './Chat';
import { usePresence } from '../ui/usePresence';
import { openPhoto } from '../ui/PhotoViewer';

function VerifiedLabel({ userId }: { userId: string }) {
  const pin = useStore((s) => s.pins[userId]);
  if (!pin) return null;
  return pin.verified ? <span class="tag good"><Shield size={13} /> Verified</span> : <span class="tag">Not verified</span>;
}

export function ContactInfo({ convId }: { convId: string }) {
  const nav = useNav();
  const aliases = useStore((s) => s.aliases);
  const conv = useStore((s) => s.convs[convId]);
  const me = useStore((s) => s.me);
  const [blocked, setBlocked] = useState<boolean | null>(null);
  const [busy, run] = useAsync();
  const other = conv && me ? otherMember(conv, me.id) : null;
  const presence = usePresence(other?.id);

  useEffect(() => {
    if (!other) return;
    listBlocked().then((list) => setBlocked(list.some((p) => p.id === other.id))).catch(() => setBlocked(false));
  }, [other?.id]);

  if (!conv || !me) return <Screen back title="Info"><div /></Screen>;
  const name = convTitle(conv, me.id);
  const alias = other ? aliases[other.id] : '';

  const editName = () => {
    if (!other) return;
    getNav().present((close) => (
      <RenameSheet
        heading="Contact name"
        initial={alias || other.name}
        allowSame
        close={close}
        onSave={async (t) => {
          await setAlias(other.id, t === other.name ? '' : t);
          toast(t === other.name ? 'Name reset' : 'Contact saved');
        }}
      />
    ));
  };

  return (
    <Screen back title="" grouped>
      <div class="profile-hero">
        {other && avatarUrl(other) ? (
          <button class="avatar-zoom" onClick={() => openPhoto(avatarUrl(other)!, name)} aria-label={`View ${name}’s photo`}>
            <Avatar id={other.id} name={name} src={avatarUrl(other)} size={104} />
          </button>
        ) : (
          <Avatar id={other?.id ?? conv.id} name={name} src={avatarUrl(other)} size={104} />
        )}
        <h1>{name}</h1>
        {other && <p class="hero-sub">{prettyPhone(other.phone)}</p>}
        {presence && <p class={`hero-presence${presence === 'online' ? ' online' : ''}`}>{presence}</p>}
        {alias && other?.name && <p class="hero-sub">Calls themselves “{other.name}”</p>}
        {other?.about && <p class="hero-about">{other.about}</p>}
      </div>

      {other && (
        <Section>
          <Cell icon={<Pencil size={20} />} iconBg="ink" title={alias ? 'Edit contact name' : 'Save contact name'} chevron onClick={editName} />
        </Section>
      )}

      {other && (
        <Section footer="Compare safety numbers in person or on a call to make sure no one is listening in.">
          <Cell icon={<Key size={20} />} iconBg="ink" title="Safety number" right={<VerifiedLabel userId={other.id} />} chevron onClick={() => nav.push(<SafetyNumberScreen userId={other.id} />)} />
        </Section>
      )}

      <Section>
        <Cell icon={<Trash size={20} />} title="Clear chat" danger onClick={async () => {
          if (await confirmAction({ message: 'All messages in this chat will be deleted from this device.', confirm: 'Clear chat', danger: true })) {
            await clearChat(conv.id);
            toast('Chat cleared');
          }
        }} />
        {other && (
          <Cell
            icon={<Block size={20} />}
            title={blocked ? `Unblock ${displayName(other)}` : `Block ${displayName(other)}`}
            danger={!blocked}
            disabled={blocked === null || busy}
            onClick={async () => {
              if (blocked) {
                run(async () => { await unblock(other.id); setBlocked(false); toast('Unblocked'); });
                return;
              }
              if (await confirmAction({ message: `${displayName(other)} won’t be able to message you or add you to groups. They won’t be told.`, confirm: 'Block', danger: true })) {
                run(async () => { await block(other.id); setBlocked(true); toast('Blocked'); });
              }
            }}
          />
        )}
      </Section>
    </Screen>
  );
}

export function GroupInfo({ convId }: { convId: string }) {
  const nav = useNav();
  const conv = useStore((s) => s.convs[convId]);
  const me = useStore((s) => s.me);
  const [, run] = useAsync();
  if (!conv || !me) return <Screen back title="Info"><div /></Screen>;
  const isAdmin = conv.myRole === 'admin' && !conv.left;

  const rename = () => {
    getNav().present((close) => <RenameSheet initial={conv.title} close={close} onSave={(t) => renameGroup(conv.id, t)} />);
  };

  const add = () => {
    getNav().present((close) => (
      <PeoplePicker
        title="Add people"
        confirmLabel="Add"
        exclude={new Set(conv.members.map((m) => m.id))}
        onCancel={() => close()}
        onConfirm={(people) => run(async () => {
          await addMembers(conv.id, people.map((p) => p.id));
          await close();
        })}
      />
    ), { variant: 'full' });
  };

  const memberMenu = (m: Member) => {
    if (m.id === me.id) return;
    const actions = [
      {
        label: `Message ${displayName(m).split(' ')[0]}`,
        run: () => run(async () => {
          const direct = await openDirect(m.id);
          nav.push(<ChatScreen convId={direct.id} />);
        }),
      },
      { label: 'View safety number', run: () => nav.push(<SafetyNumberScreen userId={m.id} />) },
    ];
    if (isAdmin) {
      actions.push(m.role === 'admin'
        ? { label: 'Remove as admin', run: () => run(() => setRole(conv.id, m.id, 'member')) }
        : { label: 'Make group admin', run: () => run(() => setRole(conv.id, m.id, 'admin')) });
      actions.push({
        label: 'Remove from group',
        danger: true,
        run: async () => {
          if (await confirmAction({ message: `Remove ${displayName(m)} from “${conv.title}”?`, confirm: 'Remove', danger: true })) run(() => removeMember(conv.id, m.id));
        },
      } as { label: string; run: () => void; danger?: boolean });
    }
    actionSheet(actions, { title: displayName(m) });
  };

  const sorted = [...conv.members].sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : (a.role === b.role ? displayName(a).localeCompare(displayName(b)) : a.role === 'admin' ? -1 : 1)));

  return (
    <Screen back title="" grouped>
      <div class="profile-hero">
        <Avatar id={conv.id} name={conv.title} size={104} group />
        <h1>{conv.title}</h1>
        <p class="hero-sub">{conv.left ? 'You are no longer a member' : `Group · ${conv.members.length} members`}</p>
      </div>

      {isAdmin && (
        <Section>
          <Cell icon={<Pencil size={20} />} title="Change group name" onClick={rename} />
        </Section>
      )}

      {!conv.left && (
        <Section header={`${conv.members.length} members`}>
          {isAdmin && <Cell icon={<PersonAdd size={20} />} title="Add people" accent onClick={add} />}
          {sorted.map((m) => (
            <Cell
              key={m.id}
              icon={<Avatar id={m.id} name={displayName(m)} src={avatarUrl(m)} size={36} />}
              title={m.id === me.id ? 'You' : displayName(m)}
              subtitle={m.about || prettyPhone(m.phone)}
              right={m.role === 'admin' ? <span class="tag">Admin</span> : undefined}
              onClick={m.id === me.id ? undefined : () => memberMenu(m)}
            />
          ))}
        </Section>
      )}

      <Section>
        <Cell icon={<Trash size={20} />} title="Clear chat" danger onClick={async () => {
          if (await confirmAction({ message: 'All messages in this group will be deleted from this device.', confirm: 'Clear chat', danger: true })) {
            await clearChat(conv.id);
            toast('Chat cleared');
          }
        }} />
        {!conv.left && (
          <Cell icon={<Exit size={20} />} title="Leave group" danger onClick={async () => {
            if (await confirmAction({ message: `You will stop receiving messages from “${conv.title}”.`, confirm: 'Leave group', danger: true })) {
              run(async () => {
                await leaveGroup(conv.id);
                await goBackMany(1);
              });
            }
          }} />
        )}
      </Section>
    </Screen>
  );
}

function RenameSheet({ initial, close, onSave, heading = 'Group name', allowSame = false }: {
  initial: string;
  close: () => Promise<void>;
  onSave: (t: string) => Promise<void>;
  heading?: string;
  allowSame?: boolean;
}) {
  const [title, setTitle] = useState(initial);
  const [busy, run] = useAsync();
  const save = () => run(async () => {
    await onSave(title.trim());
    await close();
  });
  return (
    <div class="sheet-page compact">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close()}>Cancel</button>
        <strong>{heading}</strong>
        <button class="nav-button bold" disabled={!title.trim() || busy || (!allowSame && title.trim() === initial)} onClick={save}>Save</button>
      </div>
      <div class="sheet-content">
        <input class="field" type="text" maxLength={60} autoFocus value={title} aria-label={heading}
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === 'Enter' && title.trim() && save()} />
      </div>
    </div>
  );
}

export function SafetyNumberScreen({ userId }: { userId: string }) {
  const me = useStore((s) => s.me);
  const pin = useStore((s) => s.pins[userId]);
  const person = useStore((s) => {
    for (const c of Object.values(s.convs)) {
      const m = c.members.find((x) => x.id === userId);
      if (m) return m;
    }
    return null;
  });
  const [groups, setGroups] = useState<string[] | null>(null);

  useEffect(() => {
    const mine = myDevices();
    if (!me || !pin || !mine.length || !pin.devices?.length) return;
    setGroups(null);
    safetyNumber({ id: me.id, devices: mine }, { id: userId, devices: pin.devices }).then(setGroups);
  }, [me?.id, me?.devices?.length, pin?.fp, userId]);

  const name = displayName(person);

  return (
    <Screen back title="Safety number" grouped>
      <div class="safety">
        <div class="safety-avatars">
          <Avatar id={me?.id ?? ''} name={me?.name ?? ''} src={avatarUrl(me)} size={56} />
          <span class="safety-link"><Shield size={22} /></span>
          <Avatar id={userId} name={name} src={avatarUrl(person)} size={56} />
        </div>
        {!pin ? (
          <p class="muted center pad">No keys for this person yet.</p>
        ) : !groups ? (
          <div class="center pad"><Spinner /></div>
        ) : (
          <button class="safety-grid" aria-label="Safety number, tap to copy" onClick={async () => {
            try {
              await navigator.clipboard.writeText(groups.join(' '));
              toast('Safety number copied');
            } catch { /* clipboard unavailable */ }
          }}>
            {groups.map((g, i) => <span key={i}>{g}</span>)}
          </button>
        )}
        <p class="safety-text">
          If the number on {name}’s phone matches this one, your conversation is end-to-end encrypted with no one in between.
          Compare it in person or read it out on a call.
        </p>
      </div>
      {pin && (
        <Section footer={pin.verified ? `If ${name}’s safety number changes, Haven will pause sending until you check it again.` : undefined}>
          <Cell title="Mark as verified" right={<Toggle label="Mark as verified" checked={pin.verified} onChange={(v) => setVerified(userId, v)} />} />
        </Section>
      )}
      {pin?.needsAck && (
        <div class="pad-x">
          <Button onClick={async () => { await acceptKeyChange(userId); await goBack(); }}>Accept new safety number</Button>
        </div>
      )}
    </Screen>
  );
}
