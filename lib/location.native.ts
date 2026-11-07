import { apiCourierPing, apiCourierStop } from './api';

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
    try { await apiCourierPing({ lat: p.latitude, lng: p.longitude, accuracy: p.accuracy ?? undefined, heading: p.heading ?? undefined }); } catch { /* next fix retries */ }
  });
} catch { /* a build without the library: tracking is simply off */ }

export async function getPosition(): Promise<Fix> {
  const Loc = L();
  const perm = await Loc.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('اسمح للتطبيق بتحديد الموقع من إعدادات الهاتف');
  const p = await Loc.getCurrentPositionAsync({ accuracy: Loc.Accuracy.High });
  return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? undefined };
}
export async function startCourierTracking(): Promise<boolean> {
  try {
    const Loc = L();
    if (await Loc.hasStartedLocationUpdatesAsync(TASK)) return true;
    const fg = await Loc.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return false;
    // "always" lets it keep going when the app is minimised; if refused the foreground service still keeps it alive
    try { await Loc.requestBackgroundPermissionsAsync(); } catch { /* optional */ }
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
