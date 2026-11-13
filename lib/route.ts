/**
 * Road route between two points from the free public OSRM service (no key, no cost).
 * A failure or a slow answer returns null and the map falls back to a straight line, so the screen never breaks.
 */
export type LatLng = { lat: number; lng: number };
export type RouteRes = { pts: [number, number][]; km: number; min: number };

const cache = new Map<string, { at: number; r: RouteRes | null }>();
const key = (a: LatLng, b: LatLng) => `${a.lat.toFixed(4)},${a.lng.toFixed(4)};${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;

export async function fetchRoute(a: LatLng, b: LatLng): Promise<RouteRes | null> {
  const k = key(a, b);
  const hit = cache.get(k);
  // a good answer is kept for 10 minutes, a failed one for 30 seconds (so a down service is not hammered)
  if (hit && Date.now() - hit.at < (hit.r ? 600000 : 30000)) return hit.r;
  let r: RouteRes | null = null;
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctl?.abort(); } catch { /* ignore */ } }, 7000);
  try {
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`, ctl ? { signal: ctl.signal } : undefined);
    const j: any = await res.json();
    const rt = j && j.routes && j.routes[0];
    if (rt && rt.geometry && Array.isArray(rt.geometry.coordinates) && rt.geometry.coordinates.length > 1) {
      r = { pts: rt.geometry.coordinates.map((c: number[]) => [c[1], c[0]] as [number, number]), km: Math.round(rt.distance / 100) / 10, min: Math.max(1, Math.round(rt.duration / 60)) };
    }
  } catch { r = null; }
  clearTimeout(timer);
  cache.set(k, { at: Date.now(), r });
  if (cache.size > 60) { const first = cache.keys().next().value; if (first) cache.delete(first); }
  return r;
}

const sq = (a: [number, number], p: LatLng) => (a[0] - p.lat) ** 2 + ((a[1] - p.lng) * 0.86) ** 2;

/** The part of a route already travelled (from its start up to the point nearest to `pos`). */
export function travelled(pts: [number, number][], pos: LatLng): [number, number][] {
  if (pts.length < 2) return [];
  let bi = 0; let bd = Infinity;
  pts.forEach((p, i) => { const d = sq(p, pos); if (d < bd) { bd = d; bi = i; } });
  return [...pts.slice(0, bi + 1), [pos.lat, pos.lng]];
}

/** "1:34 م" for now + minutes. */
export function arrivalAt(min: number): string {
  const d = new Date(Date.now() + min * 60000);
  let h = d.getHours(); const ap = h >= 12 ? 'م' : 'ص'; h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
}
