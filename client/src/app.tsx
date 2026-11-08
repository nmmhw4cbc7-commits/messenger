import { Component, type ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { useStore } from './lib/store';
import { Navigator, resetNavigation } from './ui/nav';
import { Spinner } from './ui/components';
import { Welcome, ProfileSetup } from './screens/Onboarding';
import { Home } from './screens/Home';
import { CallOverlay } from './ui/CallScreen';

export function App() {
  return (
    <Guard>
      <Phases />
    </Guard>
  );
}

function Phases() {
  const phase = useStore((s) => s.phase);

  // Each phase has its own navigation stack; start it fresh. This must run before
  // screens open on start (e.g. a chat from a notification), or their "back" is lost
  // and the screen below stays blocked.
  useLayoutEffect(() => resetNavigation(), [phase]);

  if (phase === 'loading') return <Booting />;
  if (phase === 'signedOut') return <Navigator key="auth" root={<Welcome />} />;
  if (phase === 'profile') return <Navigator key="profile" root={<ProfileSetup />} />;
  return (
    <>
      <Navigator key="main" root={<Home />} />
      <CallOverlay />
    </>
  );
}

/** Starting normally takes well under a second; if it hangs, offer a way out instead of a blank screen. */
function Booting() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(t);
  }, []);
  if (slow) return <Problem message="Haven is taking unusually long to start." />;
  return <div class="boot"><Spinner size={28} /></div>;
}

/** Any error while drawing the app shows a recovery screen with the reason, never a black screen. */
class Guard extends Component<{ children: ComponentChildren }, { error: string | null }> {
  state = { error: null as string | null };
  componentDidCatch(err: unknown) {
    console.error(err);
    this.setState({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
  render() {
    return this.state.error ? <Problem message={this.state.error} /> : this.props.children;
  }
}

/** Remove the cached app files (not your chats or keys) and load the newest version. */
async function repair() {
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = (await caches?.keys?.()) ?? [];
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    // Reload anyway.
  }
  location.reload();
}

function Problem({ message }: { message: string }) {
  return (
    <div class="problem">
      <h1>Something went wrong</h1>
      <p>Haven could not open. Your chats and keys are safe on this device.</p>
      <code>{message}</code>
      <button class="btn btn-primary" onClick={() => location.reload()}><span class="btn-label">Try again</span></button>
      <button class="btn btn-secondary" onClick={repair}><span class="btn-label">Repair app</span></button>
      <p class="problem-hint">“Repair app” reloads the newest version of Haven. It does not delete your chats.</p>
    </div>
  );
}
