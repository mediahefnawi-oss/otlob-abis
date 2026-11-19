import { apiPushSubscribeDevice, apiPushUnsubscribe, hasApiToken } from './api';
import { quiet } from './report';
import { storage } from './storage';

/**
 * Android app: notifications through Firebase (works even when the app is closed).
 * Needs google-services.json at build time and FIREBASE_SERVICE_ACCOUNT on the server (see README_APK_AR.md).
 * The web build uses push.ts instead (Metro picks this file only for native builds).
 */
const KEY = 'otlob_abis_fcm_token_v1';
// set only when the person switches notifications off himself; until then they stay on and are re-enabled automatically
const OPTOUT = 'otlob_abis_push_optout_v1';
export type PushState = 'unsupported' | 'denied' | 'off' | 'on';
export const pushSupported = () => true;

function N(): any { return require('expo-notifications'); }

async function setup() {
  const n = N();
  n.setNotificationHandler({ handleNotification: async () => ({ shouldShowAlert: true, shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });
  try {
    await n.setNotificationChannelAsync('orders', { name: 'الطلبات', importance: n.AndroidImportance.MAX, vibrationPattern: [0, 400, 200, 400, 200, 400], sound: 'default', lockscreenVisibility: 1 });
  } catch {}
  // a long (about 25 s) ring for new orders while the app is in the background: a channel's sound can not be changed once made, so it is a new channel
  try {
    await n.setNotificationChannelAsync('orders2', { name: 'طلبات جديدة (رنة طويلة)', importance: n.AndroidImportance.MAX, vibrationPattern: [0, 600, 300, 600, 300, 600], sound: 'order_ring.wav', lockscreenVisibility: 1, bypassDnd: false });
  } catch {}
  return n;
}

export async function pushState(): Promise<PushState> {
  try {
    const n = N();
    const p = await n.getPermissionsAsync();
    if (p.status === 'denied' && p.canAskAgain === false) return 'denied';
    return p.status === 'granted' && (await storage.getItem(KEY)) ? 'on' : 'off';
  } catch { return 'unsupported'; }
}

async function register(): Promise<string> {
  const n = await setup();
  // the phone's Firebase (FCM) token. Google's service is often not ready in the first seconds (or on a weak network): retry a few times before giving up
  let t: any, lastErr: any;
  for (const wait of [0, 1500, 4000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try { t = await n.getDevicePushTokenAsync(); lastErr = null; break; } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  const token = String(t.data);
  await apiPushSubscribeDevice(token);
  await storage.setItem(KEY, token);
  return token;
}

export async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  try {
    const n = await setup();
    let p = await n.getPermissionsAsync();
    if (p.status !== 'granted') p = await n.requestPermissionsAsync();
    if (p.status !== 'granted') return { ok: false, error: 'لم يتم السماح بالإشعارات. فعّلها من إعدادات الموبايل ← التطبيقات ← أطلب أبيس ← الإشعارات.' };
    await storage.removeItem(OPTOUT).catch(() => {});
    await register();
    return { ok: true };
  } catch (e: any) {
    const msg = String((e && e.message) || e || '');
    if (e && e.status === 401) return { ok: false, error: 'سجّل دخولك الأول وبعدين فعّل الإشعارات.' };
    if (e && e.status === 0 || /network|timeout|abort|SERVICE_NOT_AVAILABLE|TIMEOUT/i.test(msg)) return { ok: false, error: 'تعذر الاتصال بالإنترنت، حاول مرة أخرى بعد شوية.' };
    quiet('push-enable-tap')(e);   // the real reason reaches the owner's "أخطاء التطبيق" screen
    // the app keeps trying by itself every few seconds while the person is signed in, so this is not a dead end
    return { ok: false, error: 'لسه بنكمّل تفعيل الإشعارات، هتشتغل تلقائياً خلال لحظات.' };
  }
}

/** Silent: after a sign-in, attach this phone to the account that just signed in. */
export async function syncPushSubscription() {
  try {
    const n = N();
    const p = await n.getPermissionsAsync();
    if (p.status === 'granted' && !(await storage.getItem(OPTOUT))) await register();
  } catch (e) { quiet('push-sync')(e); }
}

let askedThisRun = false;
/**
 * Called when the app opens and the person is signed in: asks for the notification permission once per app start
 * (unless he switched notifications off himself) and keeps retrying the registration silently, so nobody has to tap a bar.
 */
export async function autoEnablePush(): Promise<void> {
  try {
    if (await storage.getItem(OPTOUT)) return;
    if (!(await hasApiToken())) return;   // not signed in (yet): nothing to attach this phone to, try again on the next round
    const n = await setup();
    let p = await n.getPermissionsAsync();
    if (p.status !== 'granted') {
      if (p.canAskAgain === false || askedThisRun) return;
      askedThisRun = true;
      p = await n.requestPermissionsAsync();
      if (p.status !== 'granted') return;
    }
    await register();
  } catch (e: any) { if (e && e.status === 401) return; quiet('push-enable')(e); }
}

/** Opens the phone's own settings page of this app (for a blocked notification permission). */
export async function openPushSettings() {
  try { await require('react-native').Linking.openSettings(); } catch {}
}

export async function disablePush() {
  try { await storage.setItem(OPTOUT, '1'); } catch {}
  await unsubscribeDevice();
}
async function unsubscribeDevice() {
  try {
    const token = await storage.getItem(KEY);
    if (token) await apiPushUnsubscribe(`fcm:${token}`).catch(() => {});
    await storage.removeItem(KEY);
  } catch {}
}

/** On sign-out: this phone must stop receiving the previous account's notifications. */
export async function forgetPushSubscription() {
  await unsubscribeDevice();
}
