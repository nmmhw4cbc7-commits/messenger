import { render } from 'preact';
import { App } from './app';
import { boot } from './lib/engine';
import './styles.css';

// Keep the app exactly as tall as the visible area, also while the on-screen
// keyboard is open (iOS does not resize the layout viewport on its own).
function trackViewport() {
  const root = document.documentElement;
  const vv = window.visualViewport;
  const update = () => {
    const height = vv ? vv.height : window.innerHeight;
    root.style.setProperty('--app-height', `${Math.round(height)}px`);
    // iOS may shift the visual viewport when the keyboard opens; the app follows it,
    // so headers, sheets and dialogs never end up off-screen.
    root.style.setProperty('--app-top', `${Math.round(vv ? vv.offsetTop : 0)}px`);
    root.classList.toggle('keyboard-open', window.innerHeight - height > 120);
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };
  update();
  vv?.addEventListener('resize', update);
  vv?.addEventListener('scroll', update);
  window.addEventListener('resize', update);

  // iOS pans the whole page up while the keyboard slides in, which pushes the
  // header off-screen. Undo that pan on every frame of the animation, so only
  // the message list shrinks and the header stays where it is.
  let until = 0;
  const hold = () => {
    if (vv && vv.offsetTop > 0) window.scrollTo(0, 0);
    update();
    if (performance.now() < until) requestAnimationFrame(hold);
  };
  const start = () => {
    const running = performance.now() < until;
    until = performance.now() + 900;
    if (!running) requestAnimationFrame(hold);
  };
  document.addEventListener('focusin', (e) => {
    if ((e.target as HTMLElement).matches('input, textarea')) start();
  });
  document.addEventListener('focusout', start);
}

trackViewport();

if (matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone) {
  document.documentElement.classList.add('standalone');
}

// Pinch zoom and double-tap zoom make an app feel like a web page.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => {
  if (!(e.target as HTMLElement).closest('input, textarea, .bubble-text')) e.preventDefault();
});

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}

render(<App />, document.getElementById('app')!);
boot().catch(() => {
  document.getElementById('app')!.textContent = 'Haven could not start. Please make sure your browser allows storage for this site.';
});
