import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { goBack, getNav } from './nav';
import { ChevronLeft, ChevronRight, People, Person } from './icons';
import { initials } from '../lib/format';

// ------------------------------------------------------------------ avatar

const HUES = ['#2f7a6e', '#3d6aa8', '#8a5a9e', '#b4573c', '#a67c1f', '#3f7d3a', '#9a4767', '#4b6478'];

function hueFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

export function Avatar({ id, name, src, size = 40, group = false }: { id: string; name: string; src?: string | null; size?: number; group?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const style = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.38)}px` };
  if (src && !failed) {
    return <img class="avatar" src={src} alt="" style={style} draggable={false} onError={() => setFailed(true)} />;
  }
  const text = group ? '' : initials(name);
  return (
    <span class="avatar avatar-fallback" style={{ ...style, background: hueFor(id) }} aria-hidden="true">
      {text || (group ? <People size={Math.round(size * 0.5)} /> : <Person size={Math.round(size * 0.5)} />)}
    </span>
  );
}

// ------------------------------------------------------------------ screen scaffolding

interface ScreenProps {
  title?: string;
  /** Big title that collapses into the bar on scroll (top-level screens). */
  large?: boolean;
  back?: boolean | string;
  left?: ComponentChildren;
  right?: ComponentChildren;
  titleNode?: ComponentChildren;
  grouped?: boolean;
  children: ComponentChildren;
  footer?: ComponentChildren;
  class?: string;
  scrollRef?: { current: HTMLDivElement | null };
  below?: ComponentChildren;
}

export function Screen({ title, large, back, left, right, titleNode, grouped, children, footer, class: cls, scrollRef, below }: ScreenProps) {
  const [scrolled, setScrolled] = useState(false);
  const [collapsed, setCollapsed] = useState(!large);
  const ref = useRef<HTMLDivElement>(null);

  const onScroll = () => {
    const y = ref.current?.scrollTop ?? 0;
    setScrolled(y > 2);
    if (large) setCollapsed(y > 38);
  };

  return (
    <div class={`screen${grouped ? ' grouped' : ''}${cls ? ` ${cls}` : ''}`}>
      <header class={`navbar${scrolled ? ' scrolled' : ''}`}>
        <div class="navbar-row">
          <div class="navbar-side left">
            {back ? (
              <button class="nav-back" onClick={() => goBack()} aria-label="Back">
                <ChevronLeft size={26} />
                {typeof back === 'string' && <span>{back}</span>}
              </button>
            ) : (
              left
            )}
          </div>
          <div class={`navbar-title${collapsed ? ' shown' : ''}`}>{titleNode ?? title}</div>
          <div class="navbar-side right">{right}</div>
        </div>
        {below}
      </header>
      <div
        class="scroll"
        ref={(el) => {
          ref.current = el;
          if (scrollRef) scrollRef.current = el;
        }}
        onScroll={onScroll}
      >
        {large && <h1 class="large-title">{title}</h1>}
        {children}
      </div>
      {footer}
    </div>
  );
}

// ------------------------------------------------------------------ lists

export function Section({ header, footer, children }: { header?: ComponentChildren; footer?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="section">
      {header && <h2 class="section-header">{header}</h2>}
      <div class="section-body">{children}</div>
      {footer && <p class="section-footer">{footer}</p>}
    </section>
  );
}

interface CellProps {
  icon?: ComponentChildren;
  iconBg?: string;
  title: ComponentChildren;
  subtitle?: ComponentChildren;
  value?: ComponentChildren;
  chevron?: boolean;
  danger?: boolean;
  accent?: boolean;
  onClick?: () => void;
  right?: ComponentChildren;
  disabled?: boolean;
}

export function Cell({ icon, iconBg, title, subtitle, value, chevron, danger, accent, onClick, right, disabled }: CellProps) {
  const content = (
    <>
      {icon && (
        <span class={`cell-icon${iconBg ? ' filled' : ''}`} style={iconBg ? { background: iconBg } : undefined}>
          {icon}
        </span>
      )}
      <span class="cell-main">
        <span class="cell-text">
          <span class={`cell-title${danger ? ' danger' : ''}${accent ? ' accent' : ''}`}>{title}</span>
          {subtitle && <span class="cell-subtitle">{subtitle}</span>}
        </span>
        {value !== undefined && <span class="cell-value">{value}</span>}
        {right}
        {chevron && <ChevronRight size={18} class="cell-chevron" />}
      </span>
    </>
  );
  return onClick ? (
    <button class="cell" onClick={onClick} disabled={disabled}>
      {content}
    </button>
  ) : (
    <div class="cell">{content}</div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      class={`toggle${checked ? ' on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <span class="toggle-knob" />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div class="segmented" role="radiogroup" style={{ '--count': options.length, '--index': index } as JSX.CSSProperties}>
      <span class="segmented-thumb" aria-hidden="true" />
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} class={o.value === value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ size = 20 }: { size?: number }) {
  return <span class="spinner" style={{ width: `${size}px`, height: `${size}px` }} role="progressbar" aria-label="Loading" />;
}

export function Button({ children, onClick, disabled, loading, variant = 'primary', type = 'button' }: {
  children: ComponentChildren;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'plain' | 'danger';
  type?: 'button' | 'submit';
}) {
  return (
    <button type={type} class={`btn btn-${variant}${loading ? ' loading' : ''}`} onClick={onClick} disabled={disabled || loading}>
      <span class="btn-label">{children}</span>
      {loading && <Spinner size={20} />}
    </button>
  );
}

export function NavButton({ children, onClick, disabled, bold, label }: { children: ComponentChildren; onClick: () => void; disabled?: boolean; bold?: boolean; label?: string }) {
  return (
    <button class={`nav-button${bold ? ' bold' : ''}`} onClick={onClick} disabled={disabled} aria-label={label}>
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ toasts

let toastTimer: number | undefined;

export function toast(message: string, kind: 'info' | 'error' = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast ${kind}`;
  void el.offsetWidth;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('visible'), 2800);
}

// ------------------------------------------------------------------ action sheet & dialogs

export interface Action {
  label: string;
  danger?: boolean;
  run: () => void | Promise<void>;
}

/** iOS-style action sheet. Picking an action closes the sheet first, then runs it. */
export function actionSheet(actions: Action[], options: { title?: string; message?: string } = {}) {
  getNav().present(
    (close) => (
      <div class="action-sheet">
        <div class="action-group">
          {(options.title || options.message) && (
            <div class="action-header">
              {options.title && <strong>{options.title}</strong>}
              {options.message && <span>{options.message}</span>}
            </div>
          )}
          {actions.map((a) => (
            <button
              key={a.label}
              class={`action${a.danger ? ' danger' : ''}`}
              onClick={async () => {
                await close();
                await a.run();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
        <div class="action-group">
          <button class="action cancel" onClick={() => close()}>
            Cancel
          </button>
        </div>
      </div>
    ),
    { variant: 'action' },
  );
}

export function confirmAction(opts: { title?: string; message: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    actionSheet([{ label: opts.confirm, danger: opts.danger, run: () => { decided = true; resolve(true); } }], { title: opts.title, message: opts.message });
    // Resolve false when the sheet is dismissed any other way.
    const onPop = () => setTimeout(() => {
      if (!decided) resolve(false);
    }, 400);
    window.addEventListener('popstate', onPop, { once: true });
  });
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const run = async (fn: () => Promise<void>, onError?: (e: unknown) => void) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      if (onError) onError(err);
      else toast(err instanceof Error ? err.message : 'Something went wrong.', 'error');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return [busy, run] as const;
}

export function Empty({ icon, title, text, children }: { icon: ComponentChildren; title: string; text?: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <div class="empty-icon">{icon}</div>
      <h2>{title}</h2>
      {text && <p>{text}</p>}
      {children}
    </div>
  );
}
