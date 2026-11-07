'use strict';
/**
 * Live location (free: positions are plain numbers in our own database, maps are drawn from OpenStreetMap in the app).
 *  - A customer may save "my spot" once (optional). It is copied onto each new order as its destination.
 *  - A shop owner saves the shop's spot.
 *  - An available courier's phone sends its position every few seconds; only the last position is kept.
 *  - Who sees a courier: the owner, a supervisor (couriers of his areas), and for ONE order only: that order's customer and shop,
 *    and only while the courier is actually carrying it. Nobody else, and never after the order ends.
 */
const ACTIVE = ['accepted', 'quoted', 'ready', 'picked_up', 'on_the_way', 'arrived'];
const FRESH_MS = 10 * 60 * 1000;          // a position older than this is shown as "last seen"
const EGYPT = { latMin: 21.5, latMax: 32, lngMin: 24.5, lngMax: 37 };

const validPoint = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && lat >= EGYPT.latMin && lat <= EGYPT.latMax && lng >= EGYPT.lngMin && lng <= EGYPT.lngMax;
/** Straight-line distance in km (haversine). */
function km(aLat, aLng, bLat, bLng) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

module.exports = function registerTrackingRoutes(app, { pool, auth, roles, asyncRoute, positiveId }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; }
  });
  const me = req => Number(req.auth.sub);
  const point = b => {
    const lat = Number((b || {}).lat), lng = Number((b || {}).lng);
    if (!validPoint(lat, lng)) throw fail(400, 'الموقع غير صحيح');
    return { lat, lng };
  };
  const posJson = r => ({ lat: Number(r.lat), lng: Number(r.lng), at: new Date(r.updated_at).getTime(), fresh: Date.now() - new Date(r.updated_at).getTime() <= FRESH_MS, heading: r.heading == null ? undefined : Number(r.heading) });

  /* ---------- customer: "حدد موقعي" ---------- */
  app.put('/api/me/location', auth, roles('customer'), guard(async (req, res) => {
    const b = req.body || {};
    if (b.clear === true) {
      await pool.query('UPDATE users SET home_lat=NULL, home_lng=NULL WHERE id=$1', [me(req)]);
      return res.json({ location: null });
    }
    const p = point(b);
    await pool.query('UPDATE users SET home_lat=$1, home_lng=$2 WHERE id=$3', [p.lat, p.lng, me(req)]);
    res.json({ location: p });
  }));
  app.get('/api/me/location', auth, roles('customer'), asyncRoute(async (req, res) => {
    const r = await pool.query('SELECT home_lat, home_lng FROM users WHERE id=$1', [me(req)]);
    const x = r.rows[0] || {};
    res.json({ location: x.home_lat == null ? null : { lat: Number(x.home_lat), lng: Number(x.home_lng) } });
  }));

  /* ---------- shop owner: the shop's spot ---------- */
  app.put('/api/provider/location', auth, roles('provider'), guard(async (req, res) => {
    const b = req.body || {};
    const clear = b.clear === true;
    const p = clear ? { lat: null, lng: null } : point(b);
    const r = await pool.query('UPDATE providers SET lat=$1, lng=$2 WHERE owner_user_id=$3 AND deleted_at IS NULL', [p.lat, p.lng, me(req)]);
    if (!r.rowCount) throw fail(404, 'لا يوجد محل');
    res.json({ location: clear ? null : p });
  }));

  /* ---------- courier: sends its position (only while available or carrying an order) ---------- */
  app.post('/api/courier/location', auth, roles('courier'), guard(async (req, res) => {
    const p = point(req.body);
    const b = req.body || {};
    const acc = Number(b.accuracy), head = Number(b.heading);
    const u = await pool.query("SELECT available FROM users WHERE id=$1 AND status='active' AND deleted_at IS NULL", [me(req)]);
    if (!u.rowCount) throw fail(403, 'الحساب غير نشط');
    if (!u.rows[0].available) {
      const busy = await pool.query('SELECT 1 FROM orders WHERE courier_user_id=$1 AND status = ANY($2) LIMIT 1', [me(req), ACTIVE]);
      if (!busy.rowCount) throw fail(409, 'التتبع يعمل فقط وأنت متاح أو معك طلب');
    }
    await pool.query(
      `INSERT INTO courier_locations(courier_id, lat, lng, accuracy, heading, updated_at) VALUES($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (courier_id) DO UPDATE SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, accuracy=EXCLUDED.accuracy, heading=EXCLUDED.heading, updated_at=NOW()`,
      [me(req), p.lat, p.lng, Number.isFinite(acc) ? acc : null, Number.isFinite(head) ? head : null]);
    res.json({ ok: true });
  }));
  /** The courier stops sharing (went offline / logged out). */
  app.delete('/api/courier/location', auth, roles('courier'), asyncRoute(async (req, res) => {
    await pool.query('DELETE FROM courier_locations WHERE courier_id=$1', [me(req)]);
    res.json({ ok: true });
  }));

  /* ---------- owner / supervisor: all couriers on one map ---------- */
  app.get('/api/staff/courier-locations', auth, roles('admin', 'supervisor'), asyncRoute(async (req, res) => {
    let regionSql = '', params = [ACTIVE];
    if (req.auth.role === 'supervisor') {
      const s = await pool.query('SELECT sup_regions FROM users WHERE id=$1', [me(req)]);
      const list = String((s.rows[0] || {}).sup_regions || '').split(',').filter(Boolean).map(Number).filter(Boolean);
      regionSql = ' AND u.region_id = ANY($2::bigint[])';
      params.push(list);
    }
    const r = await pool.query(
      `SELECT u.id, u.name, u.phone, u.vehicle, u.available, u.region_id, c.lat, c.lng, c.heading, c.updated_at,
         (SELECT COUNT(*) FROM orders o WHERE o.courier_user_id=u.id AND o.status = ANY($1)) AS busy
       FROM courier_locations c JOIN users u ON u.id=c.courier_id
       WHERE u.role='courier' AND u.status='active' AND u.deleted_at IS NULL AND (u.available=TRUE OR EXISTS (SELECT 1 FROM orders o WHERE o.courier_user_id=u.id AND o.status = ANY($1)))${regionSql}
       ORDER BY u.name LIMIT 300`, params);
    res.json({ couriers: r.rows.map(x => ({ id: String(x.id), name: x.name, phone: x.phone, vehicle: x.vehicle || '', available: !!x.available, busy: Number(x.busy), ...posJson(x) })) });
  }));

  /* ---------- one order: courier + shop + destination ---------- */
  app.get('/api/orders/:id/tracking', auth, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'طلب غير صحيح');
    const r = await pool.query(
      `SELECT o.id, o.status, o.region_id, o.customer_user_id, o.courier_user_id, o.data, p.owner_user_id AS powner, p.lat AS plat, p.lng AS plng,
              c.lat AS clat, c.lng AS clng, c.heading AS chead, c.updated_at AS cat
       FROM orders o LEFT JOIN providers p ON p.id=o.provider_id LEFT JOIN courier_locations c ON c.courier_id=o.courier_user_id WHERE o.id=$1`, [id]);
    if (!r.rowCount) throw fail(404, 'الطلب غير موجود');
    const o = r.rows[0], who = me(req), role = req.auth.role;
    let allowed = [o.customer_user_id, o.courier_user_id, o.powner].some(v => v && Number(v) === who);
    if (role === 'admin') allowed = true;
    if (role === 'supervisor') {
      const s = await pool.query('SELECT sup_regions FROM users WHERE id=$1', [who]);
      const list = String((s.rows[0] || {}).sup_regions || '').split(',').filter(Boolean).map(Number);
      allowed = !!o.region_id && list.includes(Number(o.region_id));
    }
    if (!allowed) throw fail(403, 'غير مسموح');
    const d = o.data || {};
    const live = ACTIVE.includes(o.status) && o.courier_user_id && o.clat != null;
    // the courier is hidden from the customer and the shop when the order is over, and a courier sees no one else's position
    const showCourier = live && role !== 'courier';
    const dest = d.destLat != null && d.destLng != null ? { lat: Number(d.destLat), lng: Number(d.destLng) } : null;
    const shop = o.plat != null ? { lat: Number(o.plat), lng: Number(o.plng) } : null;
    const courier = showCourier ? posJson({ lat: o.clat, lng: o.clng, heading: o.chead, updated_at: o.cat }) : null;
    // straight-line estimate only (no routing service): about 25 km/h in town
    let target = null;
    if (courier) target = ['picked_up', 'on_the_way', 'arrived'].includes(o.status) ? dest : (shop || dest);
    const distanceKm = courier && target ? Math.round(km(courier.lat, courier.lng, target.lat, target.lng) * 10) / 10 : null;
    res.json({ status: o.status, courier, shop, dest, distanceKm, etaMin: distanceKm == null ? null : Math.max(1, Math.round(distanceKm / 25 * 60)) });
  }));
};
module.exports.km = km;
module.exports.validPoint = validPoint;
