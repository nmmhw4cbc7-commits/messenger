import type { MediaPayload } from './crypto';
import { useEffect, useReducer, useRef } from 'preact/hooks';

export interface Me {
  id: string;
  phone: string;
  name: string;
  about: string;
  avatarVersion: number;
  keyVersion: number;
  hasPin: boolean;
  /** Secret name of this user's realtime channel. */
  inbox: string;
  readReceipts: boolean;
}

export interface Profile {
  id: string;
  phone: string;
  name: string;
  about: string;
  avatarVersion: number;
  encPub: string;
  sigPub: string;
  keyVersion: number;
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
  type: 'group_created' | 'members_added' | 'member_removed' | 'member_left' | 'renamed';
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
  // Device-only fields
  left: boolean;
  lastReadAt: number;
  unread: number;
  last: Msg | null;
  /** Set when the user deleted the chat; it reappears with the next message. */
  hidden: boolean;
}

export interface Pin {
  userId: string;
  encPub: string;
  sigPub: string;
  keyVersion: number;
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
