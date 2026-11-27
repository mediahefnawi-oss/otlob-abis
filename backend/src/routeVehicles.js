'use strict';
/**
 * Delivery price per delivery means (موتوسيكل / توكتوك / تروسيكل ...) between two areas, and the customer's choice of means at checkout.
 *  - the owner writes, for each route (shop's area -> customer's area), a price for every means; an empty price = that means does not go there
 *  - the plain route price (route_prices) stays: it is what an order without a chosen means pays
 *  - the customer sees which means are available (a price exists AND a courier with that means is on duty) and picks one
 * Everything here is additive: orders.js only calls vehiclePrice() / optionsFor() and stores data.vehicle on the order.
 */
const fail = (status, error) => Object.assign(new Error(error), { http: status });

const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 30);

/** The price of one means on the route of this shop to this customer area, or null (no price = not available). */
async function vehiclePrice(db, providerId, customerRegionId, vehicle) {
  const name = clean(vehicle);
  if (!name || !customerRegionId) return null;
  try {
    const r = await db.query(
      `SELECT v.price FROM providers p JOIN users u ON u.id=p.owner_user_id
         JOIN route_vehicle_prices v ON v.from_region_id=u.region_id AND v.to_region_id=$2 AND v.vehicle=$3 WHERE p.id=$1`, [providerId, customerRegionId, name]);
    return r.rowCount ? Number(r.rows[0].price) : null;
  } catch { return null; } // not migrated yet
}
/** Does this route have any price for any means? (if not, the chooser is not shown and the plain price applies) */
async function routeHasVehicles(db, providerId, customerRegionId) {
  if (!customerRegionId) return false;
  try {
    const r = await db.query(
      `SELECT 1 FROM providers p JOIN users u ON u.id=p.owner_user_id
         JOIN route_vehicle_prices v ON v.from_region_id=u.region_id AND v.to_region_id=$2 WHERE p.id=$1 LIMIT 1`, [providerId, customerRegionId]);
    return r.rowCount > 0;
  } catch { return false; }
}
/** How many couriers of each means are on duty now. */
async function onDuty(db) {
  try {
    const r = await db.query("SELECT vehicle, COUNT(*)::int AS n FROM users WHERE role='courier' AND status='active' AND available=TRUE AND NOT orders_off AND deleted_at IS NULL GROUP BY vehicle");
    return Object.fromEntries(r.rows.map(x => [clean(x.vehicle), x.n]));
  } catch { return {}; }
}
async function activeVehicles(db) {
  try { return (await db.query('SELECT id, name, (image IS NOT NULL) AS has_image FROM courier_vehicles WHERE active ORDER BY sort_order, id')).rows; }
  catch { return []; }
}

/**
 * What the customer sees: for the shops of his basket, each means with the summed price and whether it can be chosen.
 * `mode`: 'region' (prices per means) | 'courier' (no price: the courier writes it) | 'km' (no means to choose).
 */
async function optionsFor(db, providerIds, region, cfg) {
  const mode = cfg && cfg.mode ? cfg.mode : 'region';
  if (mode === 'km' || !region || (cfg && cfg.vehiclesOn === false)) return { mode, options: [] };
  const ids = [...new Set((providerIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return { mode, options: [] };
  const [vehicles, duty] = [await activeVehicles(db), await onDuty(db)];
  let any = false;
  for (const id of ids) if (await routeHasVehicles(db, id, region.id)) any = true;
  if (mode === 'region' && !any) return { mode, options: [] }; // nothing priced per means on these routes: the old behaviour
  const options = [];
  for (const v of vehicles) {
    let price = 0, priced = true;
    if (mode === 'region') {
      for (const id of ids) { const p = await vehiclePrice(db, id, region.id, v.name); if (p === null) { priced = false; break; } price += p; }
    }
    const couriers = duty[clean(v.name)] || 0;
    const reason = !priced ? 'غير متاح لهذه المنطقة' : couriers === 0 ? 'لا يوجد مندوب متاح حالياً' : '';
    options.push({ id: Number(v.id), name: v.name, image: v.has_image ? `/api/courier-vehicle-image/${v.id}` : null, price: mode === 'region' && priced ? Math.round(price * 100) / 100 : null, couriers, available: !reason, reason });
  }
  return { mode, options };
}

/** "fromAreaId:toAreaId:means" -> price (the customer's app needs them to show the total for the chosen means) */
async function listPrices(db) {
  try { return Object.fromEntries((await db.query('SELECT from_region_id, to_region_id, vehicle, price FROM route_vehicle_prices')).rows.map(x => [`${x.from_region_id}:${x.to_region_id}:${x.vehicle}`, Number(x.price)])); }
  catch { return {}; } // not migrated yet
}

function register(app, { pool, auth, roles, asyncRoute, positiveId, settingsMemo }) {
  const guard = fn => asyncRoute(async (req, res) => { try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; } });
  const kmfee = require('./kmfee');
  const regionOf = async uid => {
    const r = await pool.query('SELECT u.region_id AS id, g.name FROM users u LEFT JOIN regions g ON g.id=u.region_id AND g.active=TRUE WHERE u.id=$1', [uid]);
    return r.rows[0] && r.rows[0].name ? { id: r.rows[0].id, name: r.rows[0].name } : null;
  };

  /** The customer's checkout asks: which means can deliver this basket, and for how much? */
  app.post('/api/delivery-options', auth, roles('customer'), guard(async (req, res) => {
    const ids = (Array.isArray((req.body || {}).providerIds) ? req.body.providerIds : []).slice(0, 20).map(positiveId).filter(Boolean);
    const cfg = await kmfee.loadCfg(pool);
    const region = await regionOf(Number(req.auth.sub));
    const out = await optionsFor(pool, ids, region, cfg);
    res.json({ ...out, courierMin: cfg.courierMin, courierMax: cfg.courierMax });
  }));

  /** The owner changes a courier's delivery means (a courier who signed up on a tuk-tuk moves to a motorbike). */
  app.patch('/api/admin/couriers/:id/vehicle', auth, roles('admin'), guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const v = clean((req.body || {}).vehicle);
    if (!v) throw fail(400, 'اختر وسيلة التوصيل');
    const known = await pool.query('SELECT 1 FROM courier_vehicles WHERE name=$1', [v]);
    if (!known.rowCount) throw fail(400, 'وسيلة التوصيل غير موجودة');
    const u = await pool.query("SELECT id, vehicle FROM users WHERE id=$1 AND role='courier' AND deleted_at IS NULL", [id]);
    if (!u.rowCount) throw fail(404, 'المندوب غير موجود');
    const busy = await pool.query("SELECT 1 FROM orders WHERE courier_user_id=$1 AND status IN ('accepted','quoted','ready','picked_up','on_the_way','arrived') LIMIT 1", [id]);
    if (busy.rowCount) throw fail(409, 'المندوب معاه طلب شغال دلوقتي، غيّر الوسيلة بعد ما يخلصه');
    await pool.query('UPDATE users SET vehicle=$2 WHERE id=$1', [id, v]);
    if (settingsMemo) settingsMemo.clear();
    res.json({ ok: true, vehicle: v });
  }));

  /** The owner's switch: the customer chooses a means (on) / only the plain route price (off). The prices written stay saved either way. */
  app.patch('/api/admin/route-vehicles-switch', auth, roles('admin'), guard(async (req, res) => {
    const on = (req.body || {}).on === true;
    try { await pool.query('UPDATE app_settings SET route_vehicles_on=$1, updated_at=NOW() WHERE id=1', [on]); }
    catch (e) { if (e.code === '42703') throw fail(503, 'قاعدة البيانات لم تُحدَّث بعد'); throw e; }
    if (settingsMemo) settingsMemo.clear();
    res.json({ ok: true, on });
  }));

  /* ---------- the owner: prices per means for every route ---------- */
  /** "from:to:vehicle" -> price */
  const listAll = () => listPrices(pool);
  app.get('/api/admin/route-vehicle-prices', auth, roles('admin'), guard(async (_req, res) => {
    res.json({ prices: await listAll(), vehicles: (await activeVehicles(pool)).map(v => ({ id: Number(v.id), name: v.name })) });
  }));
  app.put('/api/admin/route-vehicle-prices', auth, roles('admin'), guard(async (req, res) => {
    const from = positiveId((req.body || {}).fromId);
    const list = Array.isArray((req.body || {}).prices) ? req.body.prices.slice(0, 600) : [];
    if (!from) throw fail(400, 'اختر منطقة المتجر');
    const known = new Set((await pool.query('SELECT id FROM regions')).rows.map(r => Number(r.id)));
    if (!known.has(from)) throw fail(400, 'المنطقة غير موجودة');
    const names = new Set((await pool.query('SELECT name FROM courier_vehicles')).rows.map(r => clean(r.name)));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const it of list) {
        const to = positiveId(it && it.toId), vehicle = clean(it && it.vehicle);
        if (!to || !known.has(to) || !vehicle || !names.has(vehicle)) continue;
        const empty = it.price === null || it.price === undefined || it.price === '';
        if (empty) { await client.query('DELETE FROM route_vehicle_prices WHERE from_region_id=$1 AND to_region_id=$2 AND vehicle=$3', [from, to, vehicle]); continue; }
        const price = Number(it.price);
        if (!Number.isFinite(price) || price < 0 || price > 100000) { await client.query('ROLLBACK'); throw fail(400, 'السعر غير صحيح'); }
        await client.query('INSERT INTO route_vehicle_prices(from_region_id, to_region_id, vehicle, price, updated_at) VALUES($1,$2,$3,$4,NOW()) ON CONFLICT (from_region_id, to_region_id, vehicle) DO UPDATE SET price=EXCLUDED.price, updated_at=NOW()', [from, to, vehicle, Math.round(price * 100) / 100]);
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    if (settingsMemo) settingsMemo.clear();
    res.json({ prices: await listAll() });
  }));
}
module.exports = { register, listPrices, vehiclePrice, routeHasVehicles, optionsFor, clean };
