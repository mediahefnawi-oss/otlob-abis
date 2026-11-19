process.env.NO_SWEEP = '1';
const { Pool } = require('./shim');
const H = require('./h26');
const R = require('../src/rides.js'), R2 = require('../src/rides2.js');
const { ok, eq, done } = H.counters();
// the routing service answers 7 km / 10 min, so every price is predictable
globalThis.fetch = async () => ({ ok: true, json: async () => ({ routes: [{ distance: 7000, duration: 600, geometry: { coordinates: [[29.9, 31.2], [29.95, 31.25]] } }] }) });
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const pushes = [];
  const extrasLib = { featureOn: async () => true };
  const { app, asyncRoute, positiveId, auth, roles, call } = H;
  R.register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib, clearCaches() {} });
  R2.register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib, pushToUsers: async (ids, p) => { pushes.push({ ids: ids.map(Number), p }); }, hashPassword: async p => 'h:' + p });
  await q('DELETE FROM order_gates'); await q("UPDATE app_settings SET ride_pricing='fixed', ride_auto_dispatch=FALSE WHERE id=1");
  const mk = async (n, role) => Number((await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',TRUE) RETURNING id", [n, H.phone(), role])).rows[0].id);
  const adm = await mk('owner', 'admin'), cust = await mk('عميل', 'customer'), cust2 = await mk('عميل ٢', 'customer'), cap = await mk('كابتن علي سعيد', 'courier');
  const A = { sub: String(adm), role: 'admin' }, C = { sub: String(cust), role: 'customer' }, C2 = { sub: String(cust2), role: 'customer' }, D = { sub: String(cap), role: 'courier' };
  const reg = async n => Number((await q("INSERT INTO regions(name) VALUES($1||floor(random()*1e9)) RETURNING id", [n])).rows[0].id); const rid1 = await reg('p1'), rid2 = await reg('p2'), rid3 = await reg('p3');

  /* ---- the owner sets the price method per vehicle ---- */
  const add = async b => (await call('POST /api/admin/ride-types', { as: A, body: { adj_pct: 30, sort_order: 1, ...b } })).json.type;
  const tuk = await add({ name: 'توكتوك', base_fee: 5, per_km: 3, min_fee: 10, pricing_mode: 'zones' });
  const car = await add({ name: 'ملاكي', base_fee: 10, per_km: 9, min_fee: 30, pricing_mode: 'captain', max_fee: 200 });
  const bike = await add({ name: 'موتوسيكل', base_fee: 5, per_km: 3, min_fee: 10, pricing_mode: 'km' });
  eq([tuk.pricingMode, car.pricingMode, car.maxFee, bike.pricingMode], ['zones', 'captain', 200, 'km'], 'the three methods are saved per vehicle');
  eq((await call('POST /api/admin/ride-types', { as: A, body: { name: 'x', base_fee: 1, per_km: 1, min_fee: 1, adj_pct: 1, pricing_mode: 'magic' } })).status, 400, 'an unknown method is refused');
  eq((await call('PATCH /api/admin/ride-types/:id', { as: A, params: { id: bike.id }, body: { pricing_mode: 'nope' } })).status, 400, 'patch: unknown method refused');
  eq((await call('PATCH /api/admin/ride-types/:id', { as: A, params: { id: bike.id }, body: { max_fee: 2 } })).status, 400, 'max fee must be at least 5');
  eq((await call('PATCH /api/admin/ride-types/:id', { as: A, params: { id: bike.id }, body: { pricing_mode: null } })).json.type.pricingMode, null, 'back to "follow the general setting"');
  await call('PATCH /api/admin/ride-types/:id', { as: A, params: { id: bike.id }, body: { pricing_mode: 'km' } });
  eq((await call('GET /api/ride-types', { as: C })).json.types.find(t => t.id === tuk.id).pricingMode, 'zones', 'the customer app gets the method of each vehicle');

  const te = await call('PATCH /api/admin/ride-types/:id', { as: A, params: { id: car.id }, body: { trips_enabled: true } }); eq([te.status, te.json.type.tripsEnabled], [200, true], 'the owner ticks a vehicle type for intercity trips');
  eq((await call('GET /api/ride-types', { as: C })).json.types.find(t => t.id === car.id).tripsEnabled, true, 'the customer app gets it');
  { const pub = (await call('GET /api/public/ride-types')).json; const row = pub.types.find(t => t.id === car.id); ok(!!row && row.name && !('baseFee' in row) && !('perKm' in row), 'sign-up lists vehicle types without any account and without prices'); }
  /* ---- the zone table ---- */
  eq((await call('PUT /api/admin/ride-types/:id/zones', { as: A, params: { id: tuk.id }, body: { zones: [{ fromRegionId: rid1, toRegionId: rid2, price: -5 }] } })).status, 400, 'negative price refused');
  eq((await call('PUT /api/admin/ride-types/:id/zones', { as: A, params: { id: tuk.id }, body: { zones: [{ fromRegionId: rid1, toRegionId: rid2, price: 10 }, { fromRegionId: rid1, toRegionId: rid2, price: 12 }] } })).status, 400, 'the same way twice refused');
  eq((await call('PUT /api/admin/ride-types/:id/zones', { as: A, params: { id: tuk.id }, body: { zones: [{ fromRegionId: 'x', toRegionId: rid2, price: 10 }] } })).status, 400, 'a bad area id refused');
  eq((await call('PUT /api/admin/ride-types/:id/zones', { as: C, params: { id: tuk.id }, body: { zones: [] } })).status, 403, 'only the owner');
  eq((await call('PUT /api/admin/ride-types/:id/zones', { as: A, params: { id: 99999999 }, body: { zones: [] } })).status, 404, 'unknown vehicle');
  const put = await call('PUT /api/admin/ride-types/:id/zones', { as: A, params: { id: tuk.id }, body: { zones: [{ fromRegionId: rid1, toRegionId: rid2, price: 15 }, { fromRegionId: rid2, toRegionId: rid1, price: 20 }, { fromRegionId: rid1, toRegionId: rid1, price: 7 }] } });
  eq([put.status, put.json.count], [200, 3], 'three ways saved');
  eq((await call('GET /api/admin/ride-types/:id/zones', { as: A, params: { id: tuk.id } })).json.zones.length, 3, 'and read back');
  await call('PUT /api/admin/ride-types/:id/zones', { as: A, params: { id: tuk.id }, body: { zones: [{ fromRegionId: rid1, toRegionId: rid2, price: 15 }, { fromRegionId: rid2, toRegionId: rid1, price: 20 }, { fromRegionId: rid1, toRegionId: rid1, price: 7 }] } });
  eq((await call('GET /api/admin/ride-types/:id/zones', { as: A, params: { id: tuk.id } })).json.zones.find(z => z.fromRegionId === rid2).price, 20, 'each direction has its own price');

  /* ---- planPrice: the pure decision ---- */
  const P = (t, b, g = 'fixed') => R.planPrice(pool, t, { from: { lat: 31.2, lng: 29.9 }, to: { lat: 31.25, lng: 29.95 }, ...b }, g, globalThis.fetch);
  const tr = async id => (await q('SELECT * FROM ride_types WHERE id=$1', [id])).rows[0];
  let p = await P(await tr(bike.id), {}); eq([p.mode, p.bidding, p.suggested, p.km], ['km', false, 30, 7], 'by km: 5 + 7*3 = 26, rounded to 30');
  eq([p.lo, p.hi], [R.bounds(30, 30).lo, R.bounds(30, 30).hi], 'the customer may move it a little');
  let t0 = await tr(bike.id);
  p = await P({ ...t0, pricing_mode: null }, {}, 'bidding'); eq([p.mode, p.bidding], ['captain', true], 'no method on the vehicle + the old general "bidding" = captain');
  p = await P({ ...t0, pricing_mode: null }, {}, 'fixed'); eq(p.mode, 'km', 'no method + old "fixed" = by km (as before)');
  p = await P(await tr(tuk.id), { fromRegionId: rid1, toRegionId: rid2 }); eq([p.mode, p.suggested, p.lo, p.hi, p.bidding], ['zones', 15, 15, 15, false], 'zones: the owner price, no room to move');
  p = await P(await tr(tuk.id), { fromRegionId: rid2, toRegionId: rid1 }); eq(p.suggested, 20, 'the other direction');
  p = await P(await tr(tuk.id), { fromRegionId: rid1, toRegionId: rid3 }); eq([p.mode, p.zoneMissing, p.bidding], ['captain', true, true], 'a way not in the table: the captain names the price');
  p = await P(await tr(tuk.id), {}); eq([p.mode, p.zoneMissing], ['captain', true], 'no areas chosen: the captain too');
  p = await P(await tr(car.id), {}); eq([p.mode, p.bidding, p.lo, p.hi], ['captain', true, 30, 200], 'captain mode with a ceiling of 200');
  p = await P(await tr(bike.id), { textDest: true, to: { text: 'قرية الصفا' } }); eq([p.mode, p.textDest, p.km, p.minutes, p.suggested, p.hi], ['captain', true, 0, 0, 10, 1000], 'a typed destination: no distance, the captain names the price');
  p = await P(await tr(car.id), { textDest: true }); eq(p.hi, 200, 'the ceiling still applies to a typed destination');

  /* ---- estimate ---- */
  const est = (as, b) => call('POST /api/rides/estimate', { as, body: { from: { lat: 31.2, lng: 29.9 }, to: { lat: 31.25, lng: 29.95 }, ...b } });
  let e = await est(C, { typeId: bike.id }); eq([e.status, e.json.mode, e.json.price, e.json.bidding], [200, 'km', 30, false], 'estimate by km');
  e = await est(C, { typeId: tuk.id, fromRegionId: rid1, toRegionId: rid2 }); eq([e.json.mode, e.json.price], ['zones', 15], 'estimate by zones');
  e = await est(C, { typeId: car.id }); eq([e.json.mode, e.json.bidding, e.json.maxFee], ['captain', true, 200], 'estimate: the captain names it');
  e = await est(C, { typeId: bike.id, textDest: true, to: { text: 'قرية الصفا' } }); eq([e.status, e.json.textDest, e.json.km, e.json.bidding], [200, true, 0, true], 'estimate with a typed destination needs no map point');
  e = await call('POST /api/rides/estimate', { as: C, body: { from: { lat: 31.2, lng: 29.9 }, typeId: bike.id } }); eq(e.status, 400, 'no destination at all is refused');

  /* ---- ordering: zones ---- */
  const post = (as, b) => call('POST /api/rides', { as, body: { from: { lat: 31.2, lng: 29.9, text: 'من هنا' }, to: { lat: 31.25, lng: 29.95, text: 'لهنا' }, ...b } });
  let r = await post(C, { typeId: tuk.id, fromRegionId: rid1, toRegionId: rid2, price: 999 });
  eq([r.status, r.json.ride && r.json.ride.pricing, r.json.ride && r.json.ride.offered], [200, 'zones', 15], 'a zone ride is charged the owner price, whatever the app sent: ' + JSON.stringify(r.json).slice(0, 120));
  const zid = r.json.ride.id; eq(r.json.ride.bidding, false, 'not a bidding ride');
  await q("INSERT INTO captain_profiles(user_id, type_id, model, color, plate, status, can_counter) VALUES($1,$2,'توكتوك','أحمر','1 ب ت','approved',TRUE)", [cap, tuk.id]);
  await q("INSERT INTO courier_locations(courier_id, lat, lng, updated_at) VALUES($1,31.2,29.9,NOW()) ON CONFLICT (courier_id) DO UPDATE SET lat=31.2, lng=29.9, updated_at=NOW()", [cap]);
  eq((await call('POST /api/captain/requests/:id/offer', { as: D, params: { id: zid }, body: { price: 20 } })).status, 409, 'the captain cannot counter a fixed zone price');
  const acc = await call('POST /api/captain/requests/:id/offer', { as: D, params: { id: zid }, body: {} }); eq([acc.status, acc.json.accepted], [200, true], 'he accepts it as it is');
  eq(Number((await q('SELECT final_price FROM rides WHERE id=$1', [zid])).rows[0].final_price), 15, 'the final price is the owner price');
  await q("UPDATE rides SET status='completed' WHERE id=$1", [zid]);
  r = await post(C, { typeId: tuk.id, fromRegionId: rid1, toRegionId: rid3 }); eq([r.status, r.json.ride.pricing, r.json.ride.bidding], [200, 'captain', true], 'a way not in the table becomes a captain-priced ride');
  await q("UPDATE rides SET status='cancelled' WHERE id=$1", [r.json.ride.id]);

  /* ---- ordering: the captain names the price ---- */
  await q("UPDATE captain_profiles SET type_id=$2 WHERE user_id=$1", [cap, car.id]);
  r = await post(C, { typeId: car.id }); eq([r.status, r.json.ride.bidding, r.json.ride.pricing], [200, true, 'captain'], 'a captain-priced ride is a bidding ride');
  const bid = r.json.ride.id; eq(r.json.ride.maxFee, 200, 'the ceiling travels with the ride');
  eq((await call('POST /api/captain/requests/:id/offer', { as: D, params: { id: bid }, body: {} })).status, 400, 'he must write a price');
  eq((await call('POST /api/captain/requests/:id/offer', { as: D, params: { id: bid }, body: { price: 10 } })).status, 400, 'below the minimum refused');
  eq((await call('POST /api/captain/requests/:id/offer', { as: D, params: { id: bid }, body: { price: 250 } })).status, 400, 'above the owner ceiling refused');
  const o = await call('POST /api/captain/requests/:id/offer', { as: D, params: { id: bid }, body: { price: 120 } }); eq([o.status, o.json.accepted], [200, false], 'a price inside the range is an offer');
  const cur = (await call('GET /api/rides/current', { as: C })).json; eq(cur.offers.map(x => x.price), [120], 'the customer sees the offer');
  eq((await call('POST /api/rides/:id/accept-offer', { as: C, params: { id: bid }, body: { offerId: cur.offers[0].id } })).status, 200, 'and accepts it');
  eq(Number((await q('SELECT final_price FROM rides WHERE id=$1', [bid])).rows[0].final_price), 120, 'the ride is priced at his offer');
  await q("UPDATE rides SET status='completed' WHERE id=$1", [bid]);

  /* ---- ordering: a destination that is not on the map ---- */
  r = await post(C, { typeId: bike.id, textDest: true, to: { text: 'ق' } }); eq(r.status, 400, 'the written destination must say something');
  r = await post(C, { typeId: bike.id, textDest: true, to: { text: 'قرية الصفا بعد الكوبري التاني جنب المدرسة' } });
  eq([r.status, r.json.ride && r.json.ride.textDest, r.json.ride && r.json.ride.km, r.json.ride && r.json.ride.bidding], [200, true, 0, true], 'a ride with a written destination: ' + JSON.stringify(r.json).slice(0, 140));
  const td = r.json.ride.id; eq(r.json.ride.to.text, 'قرية الصفا بعد الكوبري التاني جنب المدرسة', 'the captain gets the text');
  const row = (await q('SELECT from_lat, to_lat, from_lng, to_lng, text_dest FROM rides WHERE id=$1', [td])).rows[0]; ok(row.text_dest && row.from_lat === row.to_lat && row.from_lng === row.to_lng, 'the stored destination point is the pickup (no fake place)');
  await q("UPDATE captain_profiles SET type_id=$2 WHERE user_id=$1", [cap, bike.id]);
  const reqs = (await call('GET /api/captain/requests', { as: D })).json.requests; ok(reqs.some(x => x.id === td && x.textDest && x.to.text.includes('الصفا')), 'the captain sees it in his requests with the written destination');
  eq((await call('POST /api/captain/requests/:id/offer', { as: D, params: { id: td }, body: { price: 70 } })).status, 200, 'he names a price for it');
  const cur2 = (await call('GET /api/rides/current', { as: C })).json; eq((await call('POST /api/rides/:id/accept-offer', { as: C, params: { id: td }, body: { offerId: cur2.offers[0].id } })).status, 200, 'the customer accepts');
  const live = (await call('GET /api/rides/:id/live', { as: C, params: { id: td } })).json; ok(live.active && live.textDest && live.trip === null && live.dest === null, 'live map: no trip line to an unknown place');
  ok(live.pickup && live.pickup.km >= 0, 'but the way of the captain to the customer is still shown');
  const cc = (await call('GET /api/captain/current', { as: D })).json.ride; eq([cc.textDest, cc.customer.phone ? true : false], [true, true], 'the captain has the customer phone to call');
  await q("UPDATE rides SET status='completed' WHERE id=$1", [td]);

  /* ---- ordering by areas: no map, optional notes, the pin is optional ---- */
  await q("UPDATE captain_profiles SET type_id=$2 WHERE user_id=$1", [cap, tuk.id]);
  r = await call('POST /api/rides', { as: C, body: { typeId: tuk.id, byRegion: true, fromRegionId: rid1 } }); eq(r.status, 400, 'by areas: both areas are needed');
  r = await call('POST /api/rides', { as: C, body: { typeId: tuk.id, byRegion: true, fromRegionId: rid1, toRegionId: 99999999 } }); eq(r.status, 400, 'by areas: an unknown area is refused');
  e = await est(C, { typeId: tuk.id, byRegion: true, from: undefined, to: undefined, fromRegionId: rid1, toRegionId: rid2 }); eq([e.status, e.json.mode, e.json.price], [200, 'zones', 15], 'estimate by areas needs no points');
  r = await call('POST /api/rides', { as: C, body: { typeId: tuk.id, byRegion: true, fromRegionId: rid1, toRegionId: rid2, from: { text: 'قدام الصيدلية' }, to: { text: 'جنب المسجد' } } });
  const br = r.json.ride; eq([r.status, br && br.byRegion, br && br.fromPin, br && br.offered, br && br.pricing], [200, true, false, 15, 'zones'], 'ordered by areas at the fixed price: ' + JSON.stringify(r.json).slice(0, 160));
  ok(br.from.text.includes('قدام الصيدلية') && br.to.text.includes('جنب المسجد'), 'the notes travel with the area names');
  ok((await call('GET /api/captain/requests', { as: D })).json.requests.some(x => x.id === br.id && x.byRegion && x.pickupKm === null), 'the captain sees it without a distance (no pin) even with no location');
  await q("UPDATE rides SET status='completed' WHERE id=$1", [br.id]);
  r = await call('POST /api/rides', { as: C, body: { typeId: tuk.id, byRegion: true, fromRegionId: rid1, toRegionId: rid2, from: { lat: 31.2, lng: 29.9 } } });
  eq([r.status, r.json.ride && r.json.ride.fromPin], [200, true], 'with a shared pin the captain gets the exact place');
  await q("UPDATE rides SET status='completed' WHERE id=$1", [r.json.ride.id]);

  /* ---- the owner closes the rides ---- */
  await q("INSERT INTO order_gates(key, closed, message) VALUES('ride', TRUE, 'مقفول') ON CONFLICT (key) DO UPDATE SET closed=TRUE, message='مقفول'");
  require('../src/gates.js').invalidate();
  r = await post(C2, { typeId: bike.id, price: 30 }); eq([r.status, r.json.error], [409, 'مقفول'], 'new rides are refused while closed');
  await q('DELETE FROM order_gates'); require('../src/gates.js').invalidate();
  r = await post(C2, { typeId: bike.id, price: 30 }); eq(r.status, 200, 'and work again when reopened');
  const bad = done('ridepricing'); await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
