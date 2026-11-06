import type { Conv, Msg } from '../lib/store';
import { displayName } from '../lib/engine';

/** Human text for group events and local notices. */
export function describeSystem(m: Msg, conv: Conv, meId: string | undefined): string {
  if (m.kind === 'notice' && m.notice) {
    return `Your safety number with ${m.notice.name} changed. Tap to verify.`;
  }
  const s = m.system;
  if (!s) return '';
  const name = (id: string) => {
    if (id === meId) return 'You';
    const member = conv.members.find((x) => x.id === id);
    return member ? displayName(member) : s.names?.[id] || 'Someone';
  };
  const list = (ids: string[] = []) => {
    const names = ids.map((id) => (id === meId ? 'you' : name(id)));
    if (names.length <= 2) return names.join(' and ');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  };
  const actor = name(s.actorId);
  switch (s.type) {
    case 'group_created':
      return s.actorId === meId ? `You created “${s.title}”` : `${actor} added you to “${s.title}”`;
    case 'members_added':
      return `${actor} added ${list(s.targetIds)}`;
    case 'member_removed':
      return `${actor} removed ${list(s.targetIds)}`;
    case 'member_left':
      return `${actor} left`;
    case 'photo_changed':
      return s.actorId === meId ? 'You changed the group photo' : `${actor} changed the group photo`;
    case 'photo_removed':
      return s.actorId === meId ? 'You removed the group photo' : `${actor} removed the group photo`;
    case 'pinned':
      return `${actor} pinned a message`;
    case 'unpinned':
      return `${actor} unpinned a message`;
    case 'timer_changed':
      return s.title === 'off' ? `${actor} turned off disappearing messages` : `${actor} turned on disappearing messages (${s.title})`;
    case 'theme_changed':
      return s.actorId === meId ? `You changed the chat theme to “${s.title}”` : `${actor} changed the chat theme to “${s.title}”`;
    case 'member_joined':
      return s.actorId === meId ? 'You joined the group' : `${actor} joined with an invite link`;
    case 'renamed':
      return `${actor} renamed the group to “${s.title}”`;
    default:
      return '';
  }
}
