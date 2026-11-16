import { apiRequest } from './api';

/**
 * Place lookups (free OpenStreetMap data). They go through our own server: the map service refuses the phone app's direct requests
 * (the app sends no name), so the server asks on its behalf. If our server cannot be reached, the direct request is tried as a fallback.
 */
const timed = async (url: string): Promise<any> => {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = setTimeout(() => ctl && ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl ? ctl.signal : undefined, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('lookup ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
};

function shortAddress(j: any): string {
  const a = j && j.address ? j.address : {};
  const parts = [a.house_number, a.road, a.neighbourhood || a.suburb || a.quarter, a.city || a.town || a.village || a.county].filter(Boolean);
  const txt = parts.length ? parts.join('، ') : String(j && j.display_name || '').split('،').slice(0, 3).join('،').trim();
  return txt.length >= 6 ? txt : '';
}

/** Turns a GPS point into a short written address. Returns '' when it cannot. */
export async function reverseAddress(lat: number, lng: number): Promise<string> {
  try {
    return shortAddress(await apiRequest<any>(`/api/geo/reverse?lat=${lat}&lng=${lng}`, {}, false));
  } catch { /* our server is out of reach: ask the map service directly */ }
  try {
    return shortAddress(await timed(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=ar&lat=${lat}&lon=${lng}`));
  } catch { return ''; }
}

/** Looks a place up by name (Egypt only, nearest to the pickup first). Returns null when nothing is found. */
export async function searchPlace(q: string, near?: { lat: number; lng: number } | null): Promise<{ lat: number; lng: number; text: string } | null> {
  const text = q.trim();
  if (text.length < 2) return null;
  try {
    const j = await apiRequest<any>(`/api/geo/search?q=${encodeURIComponent(text)}${near ? `&lat=${near.lat}&lng=${near.lng}` : ''}`, {}, false);
    return j && j.found && Number.isFinite(Number(j.lat)) && Number.isFinite(Number(j.lng)) ? { lat: Number(j.lat), lng: Number(j.lng), text } : null;
  } catch { /* fall back below */ }
  try {
    const box = near ? `&viewbox=${near.lng - 0.5},${near.lat + 0.5},${near.lng + 0.5},${near.lat - 0.5}` : '';
    const j = await timed(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=eg&accept-language=ar${box}&q=${encodeURIComponent(text)}`);
    const h = Array.isArray(j) ? j[0] : null;
    const lat = h ? Number(h.lat) : NaN, lng = h ? Number(h.lon) : NaN;
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, text } : null;
  } catch { return null; }
}
