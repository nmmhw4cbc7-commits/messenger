// Full-screen voice call: who, status, and the buttons.

import { useEffect, useState } from 'preact/hooks';
import { useStore } from '../lib/store';
import { acceptCall, declineCall, hangUp, toggleMute } from '../lib/call';
import { avatarUrl, displayName } from '../lib/engine';
import { Avatar } from './components';
import { MicLine, MicOff, Phone, PhoneDown, Lock } from './icons';

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function CallOverlay() {
  const call = useStore((s) => s.call);
  const peer = useStore((s) => {
    const c = s.call && s.convs[s.call.convId];
    return c?.members.find((m) => m.id === s.call!.peerId) ?? null;
  });
  const [, tick] = useState(0);
  useEffect(() => {
    if (call?.phase !== 'active') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [call?.phase]);
  if (!call) return null;

  const name = peer ? displayName(peer) : 'Haven';
  const status =
    call.phase === 'calling' ? 'Calling…'
      : call.phase === 'ringing' ? 'Haven voice call'
        : call.phase === 'connecting' ? 'Connecting…'
          : call.phase === 'active' ? clock(Date.now() - (call.startedAt ?? Date.now()))
            : call.endText ?? 'Call ended';

  return (
    <div class={`call-screen call-${call.phase}`} role="dialog" aria-label={`Call with ${name}`}>
      <div class="call-top">
        <span class="call-e2e"><Lock size={13} /> End-to-end encrypted</span>
      </div>
      <div class="call-who">
        <div class={`call-avatar${call.phase === 'ringing' || call.phase === 'calling' ? ' pulsing' : ''}`}>
          <Avatar id={call.peerId} name={name} src={avatarUrl(peer)} size={132} />
        </div>
        <h1 class="call-name" data-no-i18n>{name}</h1>
        <p class="call-status">{status}</p>
      </div>
      <div class="call-actions">
        {call.phase === 'ringing' ? (
          <>
            <button class="call-btn end" onClick={declineCall} aria-label="Decline"><PhoneDown size={30} /><span>Decline</span></button>
            <button class="call-btn accept" onClick={acceptCall} aria-label="Accept"><Phone size={28} /><span>Accept</span></button>
          </>
        ) : call.phase === 'ended' ? null : (
          <>
            <button class={`call-btn${call.muted ? ' on' : ''}`} onClick={toggleMute} aria-label={call.muted ? 'Unmute' : 'Mute'}>
              {call.muted ? <MicOff size={28} /> : <MicLine size={28} />}<span>{call.muted ? 'Unmute' : 'Mute'}</span>
            </button>
            <button class="call-btn end" onClick={hangUp} aria-label="End call"><PhoneDown size={30} /><span>End</span></button>
          </>
        )}
      </div>
    </div>
  );
}
