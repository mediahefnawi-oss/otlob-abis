/** Same maths as the server (backend/src/kmfee.js) so the price the customer sees is the price he pays. */
export type DeliveryCfg = { mode: 'region' | 'km'; perKm: number; min: number; max: number; factor: number };
export type Pt = { lat?: number | null; lng?: number | null };
export function km(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 6371, rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** The fee by distance, or null when the switch is off or a spot is missing (then the area price is used). */
export function kmFee(cfg: DeliveryCfg | undefined, a: Pt | undefined, b: Pt | undefined): { fee: number; km: number } | null {
  if (!cfg || cfg.mode !== 'km' || !a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const dist = km(a.lat, a.lng, b.lat, b.lng) * (cfg.factor || 1);
  const fee = Math.min(cfg.max, Math.max(cfg.min, Math.round(dist * cfg.perKm)));
  return { fee, km: Math.round(dist * 10) / 10 };
}
