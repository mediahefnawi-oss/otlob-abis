import { apiCourierPing, apiCourierStop } from './api';
import { markPing, LocPerm } from './locState';

/** Web: the browser's own location (asks the person once). Courier tracking on the web works while the page is open. */
export type Fix = { lat: number; lng: number; accuracy?: number; heading?: number };
export function getPosition(): Promise<Fix> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return reject(new Error('الجهاز لا يدعم تحديد الموقع'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? 'اسمح للتطبيق بتحديد الموقع من إعدادات المتصفح' : 'تعذر تحديد موقعك، تأكد من تشغيل الموقع (GPS)')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 });
  });
}
let watch: number | null = null;
export async function startCourierTracking(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return false;
  if (watch != null) return true;
  let last = 0;
  watch = navigator.geolocation.watchPosition((p) => {
    if (Date.now() - last < 8000) return; last = Date.now();
    apiCourierPing({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, heading: p.coords.heading ?? undefined }).then(markPing).catch(() => {});
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
  return true;
}
export async function stopCourierTracking() {
  if (watch != null && typeof navigator !== 'undefined') navigator.geolocation.clearWatch(watch);
  watch = null;
  try { await apiCourierStop(); } catch { /* offline: the server drops stale positions by itself */ }
}

/** Asking for the location when the customer signs in is done in the phone app only; a browser asks when the location is first used. */
export type LocAccess = 'granted' | 'denied' | 'unsupported';
export async function askLocationAccess(): Promise<LocAccess> { return 'unsupported'; }
export async function openLocationSettings() { /* nothing to open on the web */ }

/** Where the location permission stands (the browser tells without asking). */
export async function locationPermission(): Promise<LocPerm> {
  try {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return 'unsupported';
    const q = (navigator as any).permissions && (navigator as any).permissions.query;
    if (!q) return 'prompt';
    const r = await (navigator as any).permissions.query({ name: 'geolocation' });
    return r.state === 'granted' ? 'granted' : r.state === 'denied' ? 'denied' : 'prompt';
  } catch { return 'prompt'; }
}
