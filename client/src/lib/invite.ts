// Friend group invite links: https://<app>/?join=CODE. The code is remembered
// until the user is signed in, then they are asked whether to join.

import { api } from './api';

const JOIN_KEY = 'haven-join';

export const cleanCode = (v: string) => v.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 12);

/** The invite code in a pasted link or code, if any. */
export function codeFrom(text: string): string {
  const fromLink = /[?&]join=([A-Za-z2-9]{12})/.exec(text);
  if (fromLink) return cleanCode(fromLink[1]);
  const bare = cleanCode(text);
  return bare.length === 12 ? bare : '';
}

export const inviteUrl = (code: string) => `${location.origin}/?join=${code}`;

// Remember a link that opened the app, and tidy the address bar.
(() => {
  const params = new URLSearchParams(location.search);
  const code = params.get('join');
  if (!code) return;
  try { localStorage.setItem(JOIN_KEY, cleanCode(code)); } catch { /* private mode */ }
  params.delete('join');
  history.replaceState(history.state, '', location.pathname + (params.toString() ? `?${params}` : ''));
})();

export const pendingJoin = () => { try { return localStorage.getItem(JOIN_KEY) || ''; } catch { return ''; } };
export const clearJoin = () => { try { localStorage.removeItem(JOIN_KEY); } catch { /* ignore */ } };

export interface InvitePerson { id: string; name: string; avatarVersion: number }
export interface InvitePreview { title: string; creator: string; members: number; member: boolean; people?: InvitePerson[] }

/** Profile photo of someone in the group, loadable with just the invite code. */
export const inviteAvatarUrl = (code: string, p: InvitePerson) =>
  p.avatarVersion ? `/api/invite/avatar?code=${encodeURIComponent(code)}&user=${encodeURIComponent(p.id)}&v=${p.avatarVersion}` : null;

export const previewInvite = (code: string) => api<InvitePreview>('POST', '/api/circle/invite/preview', { code });
