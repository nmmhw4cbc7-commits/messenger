// Haptic feedback everywhere, iPhone included.
//
// Android: the Vibration API. iPhone has no Vibration API, but since iOS 18
// toggling a native switch (<input type="checkbox" switch>) plays the system
// "tick". Clicking a hidden label for such a switch triggers that tick, so a
// web app gets real haptics too. Older iPhones simply do nothing.

const KEY = 'haven.haptics';
type Kind = 'light' | 'medium' | 'heavy' | 'success' | 'error' | number;

const PATTERN: Record<string, number | number[]> = {
  light: 8,
  medium: 14,
  heavy: 22,
  success: [10, 60, 14],
  error: [16, 50, 16, 50, 16],
};
/** How many iOS ticks each kind plays. */
const TICKS: Record<string, number> = { light: 1, medium: 1, heavy: 2, success: 2, error: 3 };

let on = (() => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } })();

export const hapticsOn = () => on;
export function setHaptics(value: boolean) {
  on = value;
  try { localStorage.setItem(KEY, value ? 'on' : 'off'); } catch { /* fine */ }
  if (value) haptic('medium');
}

let label: HTMLLabelElement | null = null;
function iosTick() {
  if (!label) {
    label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.display = 'none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
  }
  label.click();
}

export function haptic(kind: Kind = 'light') {
  if (!on) return;
  const name = typeof kind === 'number' ? (kind >= 20 ? 'heavy' : kind >= 11 ? 'medium' : 'light') : kind;
  if (typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(typeof kind === 'number' ? kind : PATTERN[name]); } catch { /* ignore */ }
    return;
  }
  const n = TICKS[name] ?? 1;
  iosTick();
  for (let i = 1; i < n; i++) setTimeout(iosTick, i * 70);
}

// Taps on the app's controls tick automatically.
const TAPPABLE = [
  '.tabbar button', '.toggle', '.segmented button', '.btn', '.pill-button', '.send-button', '.vlog-action',
  '.vlog-reaction', '.vlog-react-add', '.emoji-cell', '.emoji-tabs button', '.theme-tile', '.bell-button',
  '.reaction-bar button', '.context-actions button', '.action', '.nav-back', '.chip', '.timer-option', '.icon-option',
  '.poll-option', '.pinned-main', '.voice-play', '.composer-plus', '.attach-option',
].join(',');

document.addEventListener('click', (e) => {
  const el = (e.target as Element | null)?.closest?.(TAPPABLE);
  if (!el || (el as HTMLButtonElement).disabled) return;
  haptic(el.matches('.send-button, .vlog-action, .btn-primary') ? 'medium' : 'light');
}, true);
