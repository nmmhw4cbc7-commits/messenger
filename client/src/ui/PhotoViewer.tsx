// Full-screen view of a profile picture. Tap, swipe down or × to close.

import { useRef } from 'preact/hooks';
import { getNav } from './nav';
import { Close } from './icons';

export function openPhoto(src: string, name: string) {
  getNav().present((close) => <PhotoViewer src={src} name={name} close={close} />, { variant: 'editor' });
}

function PhotoViewer({ src, name, close }: { src: string; name: string; close: () => Promise<void> }) {
  const ref = useRef<HTMLDivElement>(null);
  const onPointerDown = (e: PointerEvent) => {
    const el = ref.current;
    if (!el || (e.target as HTMLElement).closest('button')) return;
    const y0 = e.clientY;
    let dy = 0;
    const move = (ev: PointerEvent) => {
      dy = ev.clientY - y0;
      el.style.transform = `translateY(${Math.max(0, dy)}px)`;
      el.style.opacity = String(Math.max(0.3, 1 - Math.max(0, dy) / 500));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (dy > 100 || Math.abs(dy) < 6) close();
      else {
        el.style.transform = '';
        el.style.opacity = '';
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  return (
    <div class="photo-viewer" ref={ref} onPointerDown={onPointerDown}>
      <div class="photo-viewer-top">
        <span>{name}</span>
        <button class="viewer-close" onClick={() => close()} aria-label="Close"><Close size={22} /></button>
      </div>
      <img src={src} alt={name} draggable={false} />
    </div>
  );
}
