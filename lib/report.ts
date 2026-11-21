import { Platform } from 'react-native';
import { apiClientError } from './api';
import { APP_VERSION } from './version';

/**
 * Silent error reporting: what goes wrong on a phone is sent to the server (the owner reads it in the panel) and never shown to the customer.
 * It is rate limited here too (the same message once a minute, 25 per session) and can never throw.
 */
let sent = 0;
const last = new Map<string, number>();
export function reportError(where: string, e: any): void {
  try {
    const message = String((e && (e.message || e)) || 'unknown').slice(0, 400);
    if (!message || /^Network request failed$|Failed to fetch|AbortError|timeout/i.test(message)) return;   // a weak connection is not a bug
    if ((e && e.status === 401) || /^يلزم تسجيل الدخول/.test(message)) return;   // signed out / session ended: expected, not a bug
    if ((e && e.status === 0) || /^تعذر الاتصال/.test(message)) return;   // offline / weak connection (the app's own "no connection" error): not a bug, never worth the owner's attention
    const key = where + '|' + message;
    const now = Date.now();
    if ((last.get(key) || 0) > now - 60000 || sent >= 25) return;
    last.set(key, now); sent++;
    void apiClientError({ message, where, stack: String((e && e.stack) || '').slice(0, 1800), platform: Platform.OS, version: APP_VERSION });
  } catch { /* never */ }
}
/** For a catch that used to be empty: behaves the same (swallows) but tells the server. Usage: `.catch(quiet('sync'))` or `catch (e) { quiet('sync')(e); }` */
export const quiet = (where: string) => (e: any) => { reportError(where, e); };
