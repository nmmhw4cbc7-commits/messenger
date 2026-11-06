// App icon colour (black, white, red). The page points its manifest and
// apple-touch-icon at the chosen variant; the home screen picks it up the
// next time Haven is added to it (iPhone) or when the phone refreshes the
// installed app (Android).

export type AppIcon = 'black' | 'white' | 'red';
const KEY = 'haven.appIcon';

export function currentAppIcon(): AppIcon {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'white' || v === 'red' ? v : 'black';
  } catch {
    return 'black';
  }
}

export function applyAppIcon(icon: AppIcon = currentAppIcon()) {
  document.querySelector('link[rel="manifest"]')?.setAttribute('href', `/manifest-${icon}.webmanifest`);
  document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', `/icons/${icon}/apple-touch-icon.png`);
}

export function setAppIcon(icon: AppIcon) {
  try { localStorage.setItem(KEY, icon); } catch { /* fine */ }
  applyAppIcon(icon);
}
