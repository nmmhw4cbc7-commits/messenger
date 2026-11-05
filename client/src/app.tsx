import { useEffect } from 'preact/hooks';
import { useStore } from './lib/store';
import { Navigator, resetNavigation } from './ui/nav';
import { Spinner } from './ui/components';
import { Welcome, ProfileSetup } from './screens/Onboarding';
import { Home } from './screens/Home';

export function App() {
  const phase = useStore((s) => s.phase);

  // Each phase has its own navigation stack; start it fresh.
  useEffect(() => resetNavigation(), [phase]);

  if (phase === 'loading') {
    return <div class="boot"><Spinner size={28} /></div>;
  }
  if (phase === 'signedOut') return <Navigator key="auth" root={<Welcome />} />;
  if (phase === 'profile') return <Navigator key="profile" root={<ProfileSetup />} />;
  return <Navigator key="main" root={<Home />} />;
}
