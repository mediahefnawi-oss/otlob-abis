/** Turns a GPS point into a short written address (free OpenStreetMap lookup). Returns '' when it cannot. */
export async function reverseAddress(lat: number, lng: number): Promise<string> {
  try {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => ctl && ctl.abort(), 8000);
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=ar&lat=${lat}&lon=${lng}`, { signal: ctl ? ctl.signal : undefined, headers: { Accept: 'application/json' } });
    clearTimeout(t);
    if (!r.ok) return '';
    const j: any = await r.json();
    const a = j && j.address ? j.address : {};
    const parts = [a.house_number, a.road, a.neighbourhood || a.suburb || a.quarter, a.city || a.town || a.village || a.county].filter(Boolean);
    const txt = parts.length ? parts.join('، ') : String(j && j.display_name || '').split('،').slice(0, 3).join('،').trim();
    return txt.length >= 6 ? txt : '';
  } catch { return ''; }
}
