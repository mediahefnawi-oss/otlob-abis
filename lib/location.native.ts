import { apiCourierPing, apiCourierStop } from './api';
import { markPing, LocPerm } from './locState';

/**
 * Android app: location through expo-location (added by the APK build). The courier is followed also when the app is minimised,
 * through a foreground service (a visible notification "التتبع يعمل"), which Android requires.
 */
export type Fix = { lat: number; lng: number; accuracy?: number; heading?: number };
const TASK = 'otlob-abis-courier-location';
const L = (): any => require('expo-location');
const TM = (): any => require('expo-task-manager');

// the background task must be defined at load time, outside any component
try {
  TM().defineTask(TASK, async ({ data, error }: any) => {
    if (error || !data || !data.locations || !data.locations.length) return;
    const p = data.locations[data.locations.length - 1].coords;
    try { await apiCourierPing({ lat: p.latitude, lng: p.longitude, accuracy: p.accuracy ?? undefined, heading: p.heading ?? undefined }); markPing(); } catch { /* next fix retries */ }
  });
} catch { /* a build without the library: tracking is simply off */ }

export async function getPosition(): Promise<Fix> {
  const Loc = L();
  const perm = await Loc.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('اسمح للتطبيق بتحديد الموقع من إعدادات الهاتف');
  let p: any;
  try { p = await Loc.getCurrentPositionAsync({ accuracy: Loc.Accuracy.High }); }
  catch (e: any) { throw new Error(/unsatisfied|settings|unavailable|disabled|services/i.test(String(e && e.message)) ? 'شغّل الموقع (GPS) من إعدادات الموبايل وجرّب تاني' : 'تعذر تحديد موقعك، جرّب تاني'); }
  return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? undefined };
}
export async function startCourierTracking(): Promise<boolean> {
  try {
    const Loc = L();
    if (await Loc.hasStartedLocationUpdatesAsync(TASK)) return true;
    const fg = await Loc.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return false;
    // no "always" (background) location permission: Google Play only allows that with a special review. The foreground service below
    // (the visible "التتبع يعمل" notification) keeps the tracking alive while the app is minimised, with the normal while-in-use permission.
    await Loc.startLocationUpdatesAsync(TASK, {
      accuracy: Loc.Accuracy.High, timeInterval: 8000, distanceInterval: 15, showsBackgroundLocationIndicator: true,
      foregroundService: { notificationTitle: 'أطلب أبيس — التتبع يعمل', notificationBody: 'موقعك يظهر للعملاء أثناء التوصيل', notificationColor: '#F2B51D' },
    });
    return true;
  } catch { return false; }
}
export async function stopCourierTracking() {
  try { const Loc = L(); if (await Loc.hasStartedLocationUpdatesAsync(TASK)) await Loc.stopLocationUpdatesAsync(TASK); } catch { /* not running */ }
  try { await apiCourierStop(); } catch { /* the server drops stale positions by itself */ }
}

export type LocAccess = 'granted' | 'denied' | 'unsupported';
/** Asks once (the phone shows its own question only while the answer is still undecided) and tells where we stand. */
export async function askLocationAccess(): Promise<LocAccess> {
  try {
    const Loc = L();
    const cur = await Loc.getForegroundPermissionsAsync();
    if (cur.status === 'granted') return 'granted';
    if (cur.canAskAgain === false) return 'denied';
    const r = await Loc.requestForegroundPermissionsAsync();
    return r.status === 'granted' ? 'granted' : 'denied';
  } catch { return 'unsupported'; } // a build without the library
}
export async function openLocationSettings() {
  try { require('react-native').Linking.openSettings(); } catch { /* nothing to open */ }
}

export async function locationPermission(): Promise<LocPerm> {
  try {
    const cur = await L().getForegroundPermissionsAsync();
    return cur.status === 'granted' ? 'granted' : cur.canAskAgain === false ? 'denied' : 'prompt';
  } catch { return 'unsupported'; }
}
