import { apiPushSubscribeDevice, apiPushUnsubscribe } from './api';
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
  const t = await n.getDevicePushTokenAsync(); // the phone's Firebase (FCM) token
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
    return { ok: false, error: 'تعذر تفعيل الإشعارات. تأكد أن النسخة مبنية مع ملف Firebase.' };
  }
}

/** Silent: after a sign-in, attach this phone to the account that just signed in. */
export async function syncPushSubscription() {
  try {
    const n = N();
    const p = await n.getPermissionsAsync();
    if (p.status === 'granted' && !(await storage.getItem(OPTOUT))) await register();
  } catch {}
}

let askedThisRun = false;
/**
 * Called when the app opens and the person is signed in: asks for the notification permission once per app start
 * (unless he switched notifications off himself) and keeps retrying the registration silently, so nobody has to tap a bar.
 */
export async function autoEnablePush(): Promise<void> {
  try {
    if (await storage.getItem(OPTOUT)) return;
    const n = await setup();
    let p = await n.getPermissionsAsync();
    if (p.status !== 'granted') {
      if (p.canAskAgain === false || askedThisRun) return;
      askedThisRun = true;
      p = await n.requestPermissionsAsync();
      if (p.status !== 'granted') return;
    }
    await register();
  } catch {}
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
