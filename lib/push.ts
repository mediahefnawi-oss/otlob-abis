import { Platform } from 'react-native';
import { apiPushKey, apiPushSubscribe, apiPushUnsubscribe } from './api';

/**
 * Web Push: notifications on the phone even when the app is closed. Needs the browser's permission, the service
 * worker in /sw.js and the server's VAPID key. (iPhone: only after "Add to Home Screen" and opening from that icon.)
 */
const isWeb = Platform.OS === 'web' && typeof window !== 'undefined';
export const pushSupported = () => isWeb && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export type PushState = 'unsupported' | 'denied' | 'off' | 'on';

const toBytes = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg && (await reg.pushManager.getSubscription()) ? 'on' : 'off';
  } catch { return 'off'; }
}

async function subscribe(reg: ServiceWorkerRegistration) {
  const { key } = await apiPushKey();
  if (!key) throw new Error('الإشعارات غير مفعّلة على السيرفر بعد');
  const existing = await reg.pushManager.getSubscription();
  if (existing) return existing;
  try {
    return await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) });
  } catch (e) {
    // an old subscription made with another server key: drop it and try once more
    const old = await reg.pushManager.getSubscription();
    if (old) await old.unsubscribe();
    return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) });
  }
}

/** Asks for permission (must come from a tap) and links this device to the signed-in account. */
export async function enablePush(): Promise<{ ok: boolean; error?: string }> {
  if (!pushSupported()) return { ok: false, error: 'هذا المتصفح لا يدعم الإشعارات. على الآيفون: أضف الموقع للشاشة الرئيسية ثم افتحه من الأيقونة.' };
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, error: 'لم يتم السماح بالإشعارات. فعّلها من إعدادات المتصفح لهذا الموقع.' };
    const sub = await subscribe(await registration());
    await apiPushSubscribe(sub.toJSON());
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'تعذر تفعيل الإشعارات' };
  }
}

/** Silent: after a sign-in, attach the device's existing subscription to the account that just signed in. */
export async function syncPushSubscription() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const sub = await subscribe(await registration());
  await apiPushSubscribe(sub.toJSON());
}

export async function disablePush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg && (await reg.pushManager.getSubscription());
  if (!sub) return;
  await apiPushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

/** On sign-out: this device must stop receiving the previous account's notifications. */
export async function forgetPushSubscription() {
  if (!pushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) await apiPushUnsubscribe(sub.endpoint).catch(() => {});
  } catch {}
}
