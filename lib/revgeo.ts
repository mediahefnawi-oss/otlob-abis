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

/** Looks a place up by name (free OpenStreetMap search, Egypt only, nearest to the pickup first). Returns null when nothing is found. */
export async function searchPlace(q: string, near?: { lat: number; lng: number } | null): Promise<{ lat: number; lng: number; text: string } | null> {
  const text = q.trim();
  if (text.length < 2) return null;
  try {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = setTimeout(() => ctl && ctl.abort(), 8000);
    const box = near ? `&viewbox=${near.lng - 0.5},${near.lat + 0.5},${near.lng + 0.5},${near.lat - 0.5}` : '';
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=eg&accept-language=ar${box}&q=${encodeURIComponent(text)}`, { signal: ctl ? ctl.signal : undefined, headers: { Accept: 'application/json' } });
    clearTimeout(t);
    if (!r.ok) return null;
    const j: any = await r.json();
    const h = Array.isArray(j) ? j[0] : null;
    const lat = h ? Number(h.lat) : NaN, lng = h ? Number(h.lon) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, text };
  } catch { return null; }
}
