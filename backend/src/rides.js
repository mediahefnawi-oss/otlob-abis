'use strict';
/**
 * Rides (like inDrive) — phase 1: the vehicle types the owner manages and the price by road distance.
 * Everything is behind the switch "rides" (OFF by default). The owner prepares the types from the panel first.
 *   price = base + km * perKm, never below the minimum. The customer may then move the offer within ±adjPct of it.
 * The road distance comes from OSRM (OpenStreetMap, free); if it cannot answer, a straight line x road factor is used.
 */
const { km: lineKm } = require('./tracking');

const ROAD_FACTOR = 1.3;          // straight line -> road, used only when the routing service is unreachable
const OSRM = process.env.OSRM_URL || 'https://router.project-osrm.org';
const NAME_MAX = 40;
const MODES = ['km', 'zones', 'captain'];     // price by distance | a fixed price between two areas | the captain names the price

const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
const okPoint = p => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) && Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180;

/** Pure: the suggested price for a type and a distance (rounded to a whole pound, 5 by 5 like a taxi meter). */
function priceFor(t, km) {
  const raw = Number(t.base_fee ?? t.base) + Math.max(0, km) * Number(t.per_km ?? t.perKm);
  const rounded = Math.ceil(raw / 5) * 5;
  const min = Number(t.min_fee ?? t.min ?? 0);
  return Math.max(min, rounded);
}
/** Pure: the lowest and highest offer a customer may type, around the suggested price. */
function bounds(price, adjPct) {
  const p = Math.max(0, Math.min(90, Number(adjPct) || 0)) / 100;
  return { lo: Math.max(5, Math.floor(price * (1 - p) / 5) * 5), hi: Math.ceil(price * (1 + p) / 5) * 5 };
}
/** Pure: validates what the owner sent for a vehicle type, or null. */
function cleanType(b, partial = false) {
  b = b || {};
  const out = {};
  if (!partial || b.name !== undefined) { const n = String(b.name || '').trim(); if (!n || n.length > NAME_MAX) return null; out.name = n; }
  const f = (k, lo, hi) => { if (partial && b[k] === undefined) return true; const v = num(b[k], lo, hi); if (v === null) return false; out[k] = v; return true; };
  if (!f('base_fee', 0, 5000) || !f('per_km', 0, 500) || !f('min_fee', 0, 5000)) return null;
  if (!partial || b.adj_pct !== undefined) { const v = num(b.adj_pct, 0, 90); if (v === null) return null; out.adj_pct = Math.round(v); }
  if (!partial || b.sort_order !== undefined) { const v = num(b.sort_order, 0, 999); if (v === null) return null; out.sort_order = Math.round(v); }
  if (b.pricing_mode !== undefined) {
    if (b.pricing_mode === null || b.pricing_mode === '') out.pricing_mode = null;
    else if (MODES.includes(b.pricing_mode)) out.pricing_mode = b.pricing_mode;
    else return null;
  }
  if (b.max_fee !== undefined) {
    if (b.max_fee === null || b.max_fee === '') out.max_fee = null;
    else { const v = num(b.max_fee, 5, 5000); if (v === null) return null; out.max_fee = v; }
  }
  if (b.active !== undefined) out.active = !!b.active;
  if (b.trips_enabled !== undefined) out.trips_enabled = !!b.trips_enabled;   // this vehicle may run intercity trips
  return out;
}

/** The road distance in km and minutes between two points: { km, min, source: 'road' | 'line' }. */
async function roadDistance(a, b, fetchFn = globalThis.fetch, withRoute = false) {
  const line = lineKm(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetchFn(`${OSRM}/route/v1/driving/${Number(a.lng)},${Number(a.lat)};${Number(b.lng)},${Number(b.lat)}?overview=${withRoute ? 'simplified&geometries=geojson' : 'false'}`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    const rt = j && j.routes && j.routes[0];
    if (r.ok && rt && Number.isFinite(rt.distance)) {
      const out = { km: Math.round(rt.distance / 100) / 10, min: Math.max(1, Math.round((rt.duration || 0) / 60)), source: 'road' };
      const cs = withRoute && rt.geometry && Array.isArray(rt.geometry.coordinates) ? rt.geometry.coordinates : null;
      if (cs && cs.length >= 2 && cs.length <= 3000) out.route = cs.map(c => [Number(c[1]), Number(c[0])]);
      return out;
    }
  } catch { /* fall through to the straight line */ }
  const d = Math.round(line * ROAD_FACTOR * 10) / 10;
  return { km: d, min: Math.max(1, Math.round(d * 2.5)), source: 'line' };
}

const pid = v => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
/**
 * Pure-ish: how a ride request is priced. t = the ride_types row, b = the request body, globalPricing = the old general setting ('fixed' | 'bidding').
 * mode: 'km' (price by the road, the customer may move it a little) | 'zones' (a fixed price between two areas) | 'captain' (the captain names it).
 * A typed destination (not found on the map) and a missing area price always fall back to 'captain'.
 */
async function planPrice(db, t, b, globalPricing, fetchFn = globalThis.fetch, withRoute = false) {
  const textDest = b.textDest === true;
  const byRegion = b.byRegion === true;       // no map at all: only the two areas decide
  let mode = t.pricing_mode || (globalPricing === 'bidding' ? 'captain' : 'km');
  if (textDest) mode = 'captain';
  const fromRegionId = pid(b.fromRegionId), toRegionId = pid(b.toRegionId);
  let zonePrice = null, zoneMissing = false;
  if (mode === 'zones') {
    if (fromRegionId && toRegionId) {
      const r = await db.query('SELECT price FROM ride_zone_prices WHERE type_id=$1 AND from_region_id=$2 AND to_region_id=$3', [t.id, fromRegionId, toRegionId]);
      if (r.rowCount) zonePrice = Number(r.rows[0].price);
    }
    if (zonePrice === null) { mode = 'captain'; zoneMissing = true; }   // a way that is not in the owner's table: the captain names the price
  }
  const d = textDest || byRegion ? { km: 0, min: 0, source: 'none' } : await roadDistance(b.from, b.to, fetchFn, withRoute);
  const maxFee = t.max_fee == null ? null : Number(t.max_fee);
  let suggested, lo, hi;
  if (mode === 'zones') { suggested = lo = hi = zonePrice; }
  else if (mode === 'captain') {
    suggested = textDest || byRegion ? Number(t.min_fee || 0) : priceFor(t, d.km);
    lo = Number(t.min_fee || 0); hi = maxFee !== null ? maxFee : textDest || byRegion ? 1000 : Math.ceil(suggested * 3);
  } else { suggested = priceFor(t, d.km); ({ lo, hi } = bounds(suggested, t.adj_pct)); }
  return { mode, textDest, zoneMissing, km: d.km, minutes: d.min, source: d.source, route: d.route || null, suggested, lo, hi, bidding: mode === 'captain', maxFee, fromRegionId, toRegionId };
}

/** The first time only: the six vehicle types with their photos and starting prices (the owner edits everything from the panel). */
const SEED_TYPES = [
  { name: 'توكتوك', file: 'tuk.jpg', base: 5, perKm: 6, min: 15 },
  { name: 'دراجة نارية', file: 'bike.jpg', base: 5, perKm: 5, min: 15 },
  { name: 'ملاكي', file: 'car.jpg', base: 10, perKm: 9, min: 30 },
  { name: 'تونية', file: 'ton.jpg', base: 15, perKm: 10, min: 40 },
  { name: 'سقف عالي', file: 'van.jpg', base: 20, perKm: 12, min: 60 },
  { name: 'عربية نقل', file: 'truck.jpg', base: 30, perKm: 15, min: 80 },
];
async function seedTypes(pool, dir = require('path').join(__dirname, '..', 'seed', 'rides')) {
  const fs = require('fs');
  const done = await pool.query("SELECT 1 FROM service_meta WHERE key='rides_seeded'");
  if (done.rowCount) return 0;                      // already done once: never re-add what the owner deleted
  const n = await pool.query('SELECT COUNT(*)::int AS c FROM ride_types');
  if (n.rows[0].c === 0) {
    let i = 0;
    for (const t of SEED_TYPES) {
      i++;
      let img = null; try { img = fs.readFileSync(require('path').join(dir, t.file)); } catch { /* the type is still created, without a picture */ }
      await pool.query('INSERT INTO ride_types(name, base_fee, per_km, min_fee, adj_pct, sort_order, active, image, mime) VALUES($1,$2,$3,$4,30,$5,TRUE,$6,$7)', [t.name, t.base, t.perKm, t.min, i, img, img ? 'image/jpeg' : null]);
    }
  }
  await pool.query("INSERT INTO service_meta(key, sub) VALUES('rides_seeded','1') ON CONFLICT (key) DO NOTHING");
  return n.rows[0].c === 0 ? SEED_TYPES.length : 0;
}

function register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib, clearCaches }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => { try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; } });
  const admin = [auth, roles('admin')];
  const on = async () => { try { return await extrasLib.featureOn(pool, 'rides'); } catch { return false; } };
  const COLS = 'id, name, base_fee, per_km, min_fee, adj_pct, sort_order, active, pricing_mode, max_fee, trips_enabled, (image IS NOT NULL) AS has_image, (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v';
  const out = r => ({ id: r.id, name: r.name, baseFee: Number(r.base_fee), perKm: Number(r.per_km), minFee: Number(r.min_fee), adjPct: r.adj_pct, sort: r.sort_order, active: r.active, pricingMode: r.pricing_mode || null, maxFee: r.max_fee == null ? null : Number(r.max_fee), tripsEnabled: !!r.trips_enabled, image: r.has_image ? `/api/ride-type-image/${r.id}?v=${r.v}` : null });

  /* ----- the owner: add / edit / stop / delete the types ----- */
  app.get('/api/admin/ride-types', ...admin, guard(async (_req, res) => {
    const r = await pool.query(`SELECT ${COLS} FROM ride_types ORDER BY sort_order, id`);
    res.json({ types: r.rows.map(out) });
  }));
  app.post('/api/admin/ride-types', ...admin, guard(async (req, res) => {
    const c = cleanType({ adj_pct: 30, sort_order: 0, ...(req.body || {}) });
    if (!c) throw fail(400, 'البيانات غير صحيحة (الاسم والأرقام)');
    const n = await pool.query('SELECT COUNT(*)::int AS c FROM ride_types');
    if (n.rows[0].c >= 20) throw fail(409, 'الحد الأقصى 20 نوع');
    const r = await pool.query(`INSERT INTO ride_types(name, base_fee, per_km, min_fee, adj_pct, sort_order, active, pricing_mode, max_fee, trips_enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${COLS}`, [c.name, c.base_fee, c.per_km, c.min_fee, c.adj_pct, c.sort_order, c.active !== false, c.pricing_mode ?? null, c.max_fee ?? null, c.trips_enabled === true]);
    clearCaches();
    res.json({ type: out(r.rows[0]) });
  }));
  app.patch('/api/admin/ride-types/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const c = cleanType(req.body, true);
    if (!c || !Object.keys(c).length) throw fail(400, 'البيانات غير صحيحة');
    const keys = Object.keys(c);
    const r = await pool.query(`UPDATE ride_types SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=NOW() WHERE id=$1 RETURNING ${COLS}`, [id, ...keys.map(k => c[k])]);
    if (!r.rowCount) throw fail(404, 'النوع غير موجود');
    clearCaches();
    res.json({ type: out(r.rows[0]) });
  }));
  app.delete('/api/admin/ride-types/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const r = await pool.query('DELETE FROM ride_types WHERE id=$1 RETURNING id', [id]);
    if (!r.rowCount) throw fail(404, 'النوع غير موجود');
    clearCaches();
    res.json({ ok: true });
  }));
  app.put('/api/admin/ride-types/:id/image', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const s = String((req.body || {}).image || '');
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(s);
    if (!m || s.length > 1500000) throw fail(400, 'ارفع صورة صالحة (JPG أو PNG أو WebP) بحجم أصغر');
    const r = await pool.query(`UPDATE ride_types SET image=$2, mime=$3, updated_at=NOW() WHERE id=$1 RETURNING ${COLS}`, [id, Buffer.from(m[2], 'base64'), m[1]]);
    if (!r.rowCount) throw fail(404, 'النوع غير موجود');
    clearCaches();
    res.json({ type: out(r.rows[0]) });
  }));
  app.get('/api/ride-type-image/:id', guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) return res.status(404).end();
    const r = await pool.query('SELECT image, mime FROM ride_types WHERE id=$1 AND image IS NOT NULL', [id]);
    if (!r.rowCount) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(r.rows[0].image);
  }));

  /* ----- the customer: the types and the price ----- */
  app.get('/api/ride-types', auth, guard(async (_req, res) => {
    if (!(await on())) throw fail(404, 'الخدمة غير متاحة الآن');
    const r = await pool.query(`SELECT ${COLS} FROM ride_types WHERE active ORDER BY sort_order, id`);
    res.json({ types: r.rows.map(out) });
  }));
  /* the sign-up screen of a ride captain lists the active vehicle types before any account exists: names and pictures only, no prices */
  app.get('/api/public/ride-types', guard(async (_req, res) => {
    if (!(await on())) return res.json({ types: [] });
    const r = await pool.query(`SELECT ${COLS} FROM ride_types WHERE active ORDER BY sort_order, id`);
    res.json({ types: r.rows.map(x => { const o = out(x); return { id: o.id, name: o.name, image: o.image }; }) });
  }));
  /* ----- the owner: the fixed price between two areas, per vehicle type ----- */
  app.get('/api/admin/ride-types/:id/zones', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const r = await pool.query('SELECT from_region_id, to_region_id, price FROM ride_zone_prices WHERE type_id=$1 ORDER BY from_region_id, to_region_id', [id]);
    res.json({ zones: r.rows.map(x => ({ fromRegionId: Number(x.from_region_id), toRegionId: Number(x.to_region_id), price: Number(x.price) })) });
  }));
  app.put('/api/admin/ride-types/:id/zones', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const raw = (req.body || {}).zones;
    if (!Array.isArray(raw) || raw.length > 600) throw fail(400, 'قائمة الأسعار غير صالحة');
    const seen = new Set(), rows = [];
    for (const z of raw) {
      const a = pid(z && z.fromRegionId), b = pid(z && z.toRegionId), p = num(z && z.price, 0, 5000);
      if (!a || !b || p === null) throw fail(400, 'كل سطر لازم فيه منطقتين وسعر صحيح');
      const k = a + '-' + b; if (seen.has(k)) throw fail(400, 'مسار مكرر في الجدول'); seen.add(k);
      rows.push([a, b, Math.round(p * 100) / 100]);
    }
    if (!(await pool.query('SELECT 1 FROM ride_types WHERE id=$1', [id])).rowCount) throw fail(404, 'النوع غير موجود');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM ride_zone_prices WHERE type_id=$1', [id]);
      if (rows.length) await c.query('INSERT INTO ride_zone_prices(type_id, from_region_id, to_region_id, price) SELECT $1, f, t, p FROM unnest($2::bigint[], $3::bigint[], $4::numeric[]) AS x(f, t, p)', [id, rows.map(r => r[0]), rows.map(r => r[1]), rows.map(r => r[2])]);
      await c.query('COMMIT');
    } catch (e) { try { await c.query('ROLLBACK'); } catch { /* already */ } throw e; } finally { c.release(); }
    clearCaches();
    res.json({ ok: true, count: rows.length });
  }));

  app.post('/api/rides/estimate', auth, roles('customer'), guard(async (req, res) => {
    if (!(await on())) throw fail(404, 'الخدمة غير متاحة الآن');
    const b = req.body || {};
    if (b.byRegion !== true && !okPoint(b.from)) throw fail(400, 'حدد نقطة التحميل');
    if (b.byRegion !== true && b.textDest !== true && !okPoint(b.to)) throw fail(400, 'حدد الوجهة على الخريطة أو اكتبها');
    const id = positiveId(b.typeId); if (!id) throw fail(400, 'اختر نوع المركبة');
    const t = await pool.query('SELECT * FROM ride_types WHERE id=$1 AND active', [id]);
    if (!t.rowCount) throw fail(404, 'النوع غير متاح');
    const g = ((await pool.query('SELECT ride_pricing FROM app_settings WHERE id=1')).rows[0] || {}).ride_pricing;
    const pl = await planPrice(pool, t.rows[0], b, g, globalThis.fetch, true);
    res.json({ mode: pl.mode, textDest: pl.textDest, zoneMissing: pl.zoneMissing, km: pl.km, minutes: pl.minutes, source: pl.source, route: pl.route, bidding: pl.bidding, price: pl.suggested, lo: pl.lo, hi: pl.hi, maxFee: pl.maxFee });
  }));
}
module.exports = { priceFor, bounds, cleanType, roadDistance, planPrice, MODES, seedTypes, register };
