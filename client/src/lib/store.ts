import type { MediaPayload } from './crypto';
import { useEffect, useReducer, useRef } from 'preact/hooks';

export interface DeviceKey {
  id: string;
  encPub: string;
  sigPub: string;
}

export interface Me {
  id: string;
  phone: string;
  name: string;
  about: string;
  avatarVersion: number;
  hasPin: boolean;
  /** This device. */
  deviceId: string;
  /** All devices of this account (this one included). */
  devices: DeviceKey[];
  /** Secret name of this user's realtime channel. */
  inbox: string;
  readReceipts: boolean;
  /** Share "last seen & online" (and see it for others). */
  presence?: boolean;
}

export interface Profile {
  id: string;
  phone: string;
  name: string;
  about: string;
  avatarVersion: number;
  devices: DeviceKey[];
}

export interface Member extends Profile {
  role: 'admin' | 'member';
  /** Server time up to which this member has read the chat (0 if they hide it). */
  lastReadAt: number;
}

export interface ReplyRef {
  id: string;
  senderId: string;
  text: string;
}

export interface SystemBody {
  type: 'group_created' | 'members_added' | 'member_removed' | 'member_left' | 'renamed' | 'member_joined' | 'photo_changed' | 'photo_removed' | 'theme_changed' | 'pinned' | 'unpinned' | 'timer_changed';
  actorId: string;
  targetIds?: string[];
  title?: string;
  names?: Record<string, string>;
}

export interface Msg {
  id: string;
  convId: string;
  senderId: string | null;
  kind: 'text' | 'media' | 'location' | 'contact' | 'poll' | 'system' | 'notice' | 'undecryptable';
  text?: string;
  system?: SystemBody;
  notice?: { type: 'key_changed'; userId: string; name: string };
  reply?: ReplyRef;
  /** userId -> emoji */
  reactions?: Record<string, string>;
  media?: MediaPayload;
  location?: { lat: number; lng: number; acc?: number };
  contactCard?: { name: string; phone: string };
  poll?: { question: string; options: string[]; multi: boolean };
  /** Poll votes: userId -> chosen option indexes */
  votes?: Record<string, number[]>;
  /** View-once photo: has it been opened (by me, or for my own: by the recipient)? */
  opened?: boolean;
  /** Deleted for everyone by its sender; the content is gone. */
  deleted?: boolean;
  /** Last time the sender edited the text. */
  editedAt?: number;
  /** Disappearing message: deleted from every device this many seconds after it was sent. */
  ttl?: number;
  createdAt: number;
  sortKey: number;
  status: 'pending' | 'sent' | 'failed' | 'received';
}

export interface Conv {
  id: string;
  kind: 'direct' | 'group';
  title: string;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  myRole: 'admin' | 'member';
  members: Member[];
  /** The friend group for Vlog your Day. */
  circle?: boolean;
  /** Group photo version (0 = none). */
  avatarVersion?: number;
  /** Chat theme id ('' = standard), shared by everyone in the chat. */
  theme?: string;
  // Device-only fields
  left: boolean;
  lastReadAt: number;
  unread: number;
  last: Msg | null;
  /** Set when the user deleted the chat; it reappears with the next message. */
  hidden: boolean;
  /** Pinned message (synced between members as an encrypted control message). */
  pinned?: string;
  /** Disappearing messages: new messages vanish after this many seconds (0/undefined = off). */
  timer?: number;
}

export interface Pin {
  userId: string;
  devices: DeviceKey[];
  /** Fingerprint of all device keys; changes when a device is added, removed or replaced. */
  fp: string;
  verified: boolean;
  /** A verified contact's key changed; sending is paused until the user accepts it. */
  needsAck: boolean;
  /** Earlier signing keys, so messages sent just before a key change still verify. */
  history: string[];
}

export type Theme = 'system' | 'light' | 'dark';

export interface State {
  phase: 'loading' | 'signedOut' | 'profile' | 'ready';
  me: Me | null;
  convs: Record<string, Conv>;
  messages: Record<string, Msg[]>;
  pins: Record<string, Pin>;
  connected: boolean;
  openConvId: string | null;
  theme: Theme;
  sessionEnded: boolean;
  lastPhone: string;
  /** Names the user gave contacts on this device (userId -> name). */
  aliases: Record<string, string>;
  /** Show sender and text in push notifications. */
  pushPreview: boolean;
  /** Chat history is being transferred from another device. */
  importing: 'none' | 'waiting' | 'importing';
  /** Vlog your Day: my friend group and who vlogs on which day. */
  circle: CircleState | null;
  /** Notification center: reactions to my messages, new vlogs, people joining. Newest first. */
  activity: Activity[];
  /** Everything up to this time has been seen. */
  activitySeen: number;
  /** Who is typing right now: convId -> userId -> until (ms). */
  typing: Record<string, Record<string, number>>;
}

export interface Activity {
  id: string;
  type: 'reaction' | 'vlog' | 'joined';
  convId: string;
  userId: string;
  msgId?: string;
  emoji?: string;
  /** The reaction was to a vlog post. */
  vlog?: boolean;
  /** Short preview of the message that got the reaction. */
  snippet?: string;
  at: number;
}

export interface CircleState {
  id: string | null;
  /** Today in Europe/Berlin, YYYY-MM-DD. */
  today: string;
  /** day -> userId, newest first */
  picks: { day: string; userId: string }[];
}

let state: State = {
  phase: 'loading',
  me: null,
  convs: {},
  messages: {},
  pins: {},
  connected: false,
  openConvId: null,
  theme: 'system',
  sessionEnded: false,
  lastPhone: '',
  aliases: {},
  pushPreview: true,
  importing: 'none',
  circle: null,
  activity: [],
  activitySeen: 0,
  typing: {},
};

const listeners = new Set<() => void>();

export const getState = () => state;

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const next = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/** Subscribe a component to a slice of state. Re-renders only when the slice changes. */
export function useStore<T>(selector: (s: State) => T): T {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const value = selector(state);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const check = () => {
      const next = selectorRef.current(state);
      if (!Object.is(next, valueRef.current)) force(0);
    };
    listeners.add(check);
    check();
    return () => {
      listeners.delete(check);
    };
  }, []);
  return value;
}
