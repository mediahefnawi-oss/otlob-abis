import Constants from 'expo-constants';

/** The version this installed app / web build was made with (app.json "version"). */
export const APP_VERSION: string = String((Constants.expoConfig && Constants.expoConfig.version) || '1.0.0');

/** Compare "1.2.0" style versions: >0 when a is newer than b. */
export function cmpVersion(a: string, b: string): number {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}
