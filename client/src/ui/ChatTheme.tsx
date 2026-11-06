// Chat themes: a few looks for a chat, shared by everyone in it.

import { useState } from 'preact/hooks';
import { getNav } from './nav';
import { setChatTheme } from '../lib/engine';
import { toast } from './components';
import { Check } from './icons';
import type { Conv } from '../lib/store';

export const CHAT_THEMES: { id: string; name: string }[] = [
  { id: '', name: 'Standard' },
  { id: 'dots', name: 'Dot Grid' },
  { id: 'red', name: 'Red' },
  { id: 'type', name: 'Typewriter' },
  { id: 'clear', name: 'Transparent' },
  { id: 'glyph', name: 'Glyph' },
  { id: 'orange', name: 'Orange' },
];

export const themeName = (id: string | undefined) => CHAT_THEMES.find((t) => t.id === (id ?? ''))?.name ?? 'Standard';

export function openThemePicker(conv: Conv) {
  getNav().present((close) => <ThemeSheet conv={conv} close={close} />);
}

function ThemeSheet({ conv, close }: { conv: Conv; close: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const current = conv.theme ?? '';
  const choose = async (id: string) => {
    if (busy) return;
    if (id === current) { close(); return; }
    setBusy(id);
    try {
      await setChatTheme(conv.id, id);
      await close();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'The theme could not be changed.', 'error');
      setBusy(null);
    }
  };
  return (
    <div class="sheet-page">
      <div class="sheet-header sheet-drag">
        <button class="nav-button" onClick={() => close()}>Cancel</button>
        <strong>Chat theme</strong>
        <span class="nav-button" aria-hidden="true" />
      </div>
      <div class="sheet-content">
        <p class="theme-note">Everyone in this chat sees the theme you choose.</p>
        <div class="theme-grid">
          {CHAT_THEMES.map((t) => (
            <button key={t.id} class={`theme-tile${t.id === current ? ' on' : ''}`} onClick={() => choose(t.id)} disabled={Boolean(busy)} aria-pressed={t.id === current}>
              <span class="theme-preview" data-chat-theme={t.id || undefined}>
                <span class="tp-bubble tp-in">Hey, what’s up?</span>
                <span class="tp-bubble tp-out">Vlogging today</span>
                <span class="tp-bubble tp-in short">Nice</span>
              </span>
              <span class="theme-name">
                {t.id === current && <Check size={14} stroke={2.4} />}
                {busy === t.id ? '…' : t.name}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
