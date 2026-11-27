import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

/** Web only: "install to the home screen". Chrome (Android / computer) offers a real install prompt; iPhone and other browsers get written steps. */
let deferred: any = null;
const subs = new Set<() => void>();
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e: any) => { e.preventDefault(); deferred = e; subs.forEach((f) => f()); });
  window.addEventListener('appinstalled', () => { deferred = null; subs.forEach((f) => f()); });
}
export const isStandalone = () => {
  try { return !!((window as any).matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone); } catch { return false; }
};
export const isIOS = () => typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(String(navigator.userAgent || ''));
export const canPrompt = () => !!deferred;
/** true = the browser's own install question was shown */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const e = deferred; deferred = null;
  try { await e.prompt(); await e.userChoice; } catch { /* closed */ }
  subs.forEach((f) => f());
  return true;
}
/** the "install" entry is shown on the web only, and not once the app is already installed (opened from the home screen icon) */
export function useInstallVisible() {
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return Platform.OS === 'web' && typeof window !== 'undefined' && !isStandalone();
}
