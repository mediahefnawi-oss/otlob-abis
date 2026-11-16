const { Pool } = require('./shim');
const R = require('../src/rides.js');
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (path, ...chain) => { routes[`${m.toUpperCase()} ${path}`] = chain; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const auth = (req, res, next) => { if (!req.auth) return res.status(401).json({ error: 'auth' }); next(); };
const roles = (...allowed) => (req, res, next) => { if (!req.auth || !allowed.includes(req.auth.role)) return res.status(403).json({ error: 'forbidden' }); next(); };
async function call(key, { as, body, params } = {}) {
  const chain = routes[key]; if (!chain) throw new Error('no route ' + key);
  const req = { auth: as, body: body || {}, query: {}, params: params || {} };
  const out = { status: 200, json: null, headers: {} };
  const res = { status(c) { out.status = c; return this; }, json(j) { out.json = j; return this; }, set(k, v) { out.headers[k] = v; return this; }, send(b) { out.sent = b; return this; }, end() { out.ended = true; return this; } };
  let i = 0, err = null;
  const next = e => { if (e) { err = e; return; } const f = chain[i++]; if (f) return f(req, res, next); };
  next();
  const t0 = Date.now();
  while (!err && out.json === null && out.sent === undefined && !out.ended && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 2));
  if (err) throw err;
  return out;
}
const R2 = require('../src/rides2.js');
(async () => {
  // ---- pure
  eq(R2.commissionFor(100, { captainPct: null, typePct: null, defaultPct: 15, minFee: 5 }), 15, 'default 15%');
  eq(R2.commissionFor(100, { captainPct: 10, typePct: 20, defaultPct: 15, minFee: 5 }), 10, 'captain % wins');
  eq(R2.commissionFor(100, { captainPct: null, typePct: 20, defaultPct: 15, minFee: 5 }), 20, 'type % beats default');
  eq(R2.commissionFor(20, { captainPct: null, typePct: null, defaultPct: 10, minFee: 5 }), 5, 'minimum applies');
  eq(R2.commissionFor(3, { captainPct: null, typePct: null, defaultPct: 10, minFee: 5 }), 3, 'never more than the price');
  eq(R2.commissionFor(100, { captainPct: 0, typePct: 20, defaultPct: 15, minFee: 5 }), 0, '0% is exempt even with a minimum');
  ok(R2.canReceive(-50, -50) && !R2.canReceive(-50.01, -50), 'balance threshold');

  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  await q('TRUNCATE ride_types, rides, captain_profiles, captain_ledger RESTART IDENTITY CASCADE');
  await q("UPDATE app_settings SET ride_commission_pct=15, ride_commission_min=5, ride_min_balance=-50, ride_auto_dispatch=FALSE, ride_radius_km=5 WHERE id=1");
  let switchOn = true; const pushes = [];
  const extrasLib = { featureOn: async () => switchOn };
  const pushToUsers = async (ids, p) => { pushes.push({ ids, p }); };
  R.register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib, clearCaches() {} });
  R2.register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib, pushToUsers });
  const mk = async (n, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',TRUE) RETURNING id", [n, '012' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const aId = await mk('admin', 'admin'), cId = await mk('cust', 'customer'), c2Id = await mk('cust2', 'customer'), d1 = await mk('cap1', 'courier'), d2 = await mk('cap2', 'courier');
  const A = { sub: aId, role: 'admin' }, C = { sub: cId, role: 'customer' }, C2 = { sub: c2Id, role: 'customer' }, D1 = { sub: d1, role: 'courier' }, D2 = { sub: d2, role: 'courier' };
  const t = (await call('POST /api/admin/ride-types', { as: A, body: { name: 'ملاكي', base_fee: 10, per_km: 9, min_fee: 30, adj_pct: 30 } })).json.type;
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  // ---- captain registration
  eq((await call('PUT /api/captain/profile', { as: C, body: {} })).status, 403, 'customer cannot register as captain');
  eq((await call('PUT /api/captain/photos/:kind', { as: D1, params: { kind: 'car' }, body: { image: png } })).status, 409, 'photo before profile refused');
  eq((await call('PUT /api/captain/profile', { as: D1, body: { typeId: t.id, model: '', color: 'أبيض', plate: 'أ ب ج 123' } })).status, 400, 'missing model refused');
  eq((await call('PUT /api/captain/profile', { as: D1, body: { typeId: t.id, model: 'هيونداي النترا', color: 'أبيض', plate: 'أ ب ج 123' } })).json.status, 'pending', 'profile pending');
  await call('PUT /api/captain/profile', { as: D2, body: { typeId: t.id, model: 'كيا', color: 'أسود', plate: 'س ص ع 456' } });
  for (const k of ['car', 'license', 'driver', 'selfie']) eq((await call('PUT /api/captain/photos/:kind', { as: D1, params: { kind: k }, body: { image: png } })).status, 200, 'photo ' + k);
  eq((await call('PUT /api/captain/photos/:kind', { as: D1, params: { kind: 'x' }, body: { image: png } })).status, 400, 'bad kind');
  eq((await call('PUT /api/captain/photos/:kind', { as: D1, params: { kind: 'car' }, body: { image: 'data:text/html;base64,AAAA' } })).status, 400, 'non-image refused');

  // pending captain cannot take rides
  eq((await call('GET /api/captain/requests', { as: D1 })).status, 403, 'pending captain gets no requests');

  // ---- admin review
  eq((await call('GET /api/admin/captains', { as: D1 })).status, 403, 'captain cannot open the review list');
  const list = (await call('GET /api/admin/captains', { as: A })).json.captains;
  ok(list.length === 2 && list[0].photos !== undefined, 'review list');
  const ph = await call('GET /api/admin/captains/:id/photo/:kind', { as: A, params: { id: d1, kind: 'car' } });
  ok(ph.sent && ph.headers['Content-Type'] === 'image/png', 'admin sees the photo');
  await call('PATCH /api/admin/captains/:id', { as: A, params: { id: d2 }, body: { status: 'needs_photo', note: 'صورة الرخصة غير واضحة' } });
  eq((await q('SELECT status FROM captain_profiles WHERE user_id=$1', [d2])).rows[0].status, 'needs_photo', 'asked for a clearer photo');
  ok(pushes.some(x => Number(x.ids[0]) === Number(d2) && /غير واضحة/.test(x.p.body)), 'captain told why');
  await call('PUT /api/captain/photos/:kind', { as: D2, params: { kind: 'license' }, body: { image: png } });
  eq((await q('SELECT status FROM captain_profiles WHERE user_id=$1', [d2])).rows[0].status, 'pending', 'new photo sends it back to review');
  eq((await call('PATCH /api/admin/captains/:id', { as: A, params: { id: d1 }, body: { status: 'weird' } })).status, 400, 'bad status');
  eq((await call('PATCH /api/admin/captains/:id', { as: A, params: { id: d1 }, body: { status: 'approved', commissionPct: 150 } })).status, 400, 'bad commission');
  eq((await call('PATCH /api/admin/captains/:id', { as: A, params: { id: d1 }, body: { status: 'approved' } })).status, 200, 'approved');
  await call('PATCH /api/admin/captains/:id', { as: A, params: { id: d2 }, body: { status: 'approved' } });
  eq((await call('POST /api/admin/captains/:id/balance', { as: A, params: { id: d1 }, body: { amount: 200, note: 'شحن' } })).json.balance, 200, 'recharged 200');
  eq((await call('POST /api/admin/captains/:id/balance', { as: A, params: { id: d1 }, body: { amount: 0 } })).status, 400, 'zero refused');
  eq((await call('GET /api/admin/captains/:id/ledger', { as: A, params: { id: d1 } })).json.ledger.length, 1, 'ledger entry');

  // ---- settings
  eq((await call('PATCH /api/admin/rides/settings', { as: A, body: { commissionPct: 120 } })).status, 400, 'bad pct');
  eq((await call('PATCH /api/admin/rides/settings', { as: A, body: { commissionPct: 10, offerSecs: 30 } })).status, 200, 'settings saved');
  eq((await call('GET /api/admin/rides/settings', { as: A })).json.commissionPct, 10, 'settings read back');

  // ---- a ride
  await q("INSERT INTO courier_locations(courier_id, lat, lng) VALUES($1,31.0,30.0),($2,31.0,30.01) ON CONFLICT (courier_id) DO UPDATE SET updated_at=NOW()", [d1, d2]);
  const body = { from: { lat: 31, lng: 30, text: 'أ' }, to: { lat: 31, lng: 30.1, text: 'ب' }, typeId: t.id };
  const est = (await call('POST /api/rides/estimate', { as: C, body })).json;
  eq((await call('POST /api/rides', { as: C, body: { ...body, price: est.hi + 100 } })).status, 400, 'price outside the range refused');
  const cr = await call('POST /api/rides', { as: C, body: { ...body, price: est.price } });
  ok(cr.status === 200 && cr.json.ride.status === 'searching' && cr.json.notified === 2, 'ride created, both captains notified: ' + JSON.stringify(cr.json));
  eq((await call('POST /api/rides', { as: C, body: { ...body, price: est.price } })).status, 409, 'one live ride per customer');
  const rid = cr.json.ride.id;
  const reqs = (await call('GET /api/captain/requests', { as: D1 })).json.requests;
  ok(reqs.length === 1 && reqs[0].id === rid && reqs[0].pickupKm === 0, 'captain sees the request');

  // counter offer, then the customer accepts it
  eq((await call('POST /api/captain/requests/:id/offer', { as: D2, params: { id: rid }, body: { price: est.hi + 50 } })).status, 400, 'counter outside range refused');
  const co = await call('POST /api/captain/requests/:id/offer', { as: D2, params: { id: rid }, body: { price: est.hi } });
  ok(co.json.accepted === false, 'counter-offer stored');
  const cur = (await call('GET /api/rides/current', { as: C })).json;
  ok(cur.offers.length === 1 && cur.offers[0].price === est.hi && cur.offers[0].driver.plate, 'customer sees the offer with the car');
  // the other captain simply accepts the customer's price first
  const acc = await call('POST /api/captain/requests/:id/offer', { as: D1, params: { id: rid }, body: {} });
  ok(acc.json.accepted === true, 'captain 1 accepted the customer price');
  eq((await call('POST /api/captain/requests/:id/offer', { as: D2, params: { id: rid }, body: {} })).status, 404, 'second captain too late');
  eq((await call('POST /api/rides/:id/accept-offer', { as: C, params: { id: rid }, body: { offerId: cur.offers[0].id } })).status, 404, 'old offer is closed (rejected)');

  // status flow + commission
  const cc = await call('GET /api/captain/current', { as: D1 });
  ok(cc.status === 200 && cc.json.ride && Number(cc.json.ride.id) === Number(rid) && cc.json.ride.customer && cc.json.ride.from.lat !== undefined, 'captain sees the accepted ride with both points and the customer');
  eq((await call('GET /api/captain/current', { as: D2 })).json.ride, null, 'another captain sees nothing');
  eq((await call('POST /api/captain/rides/:id/status', { as: D1, params: { id: rid }, body: { status: 'completed' } })).status, 409, 'cannot skip steps');
  eq((await call('POST /api/captain/rides/:id/status', { as: D2, params: { id: rid }, body: { status: 'arrived' } })).status, 409, 'another captain cannot move it');
  for (const s of ['arrived', 'started']) eq((await call('POST /api/captain/rides/:id/status', { as: D1, params: { id: rid }, body: { status: s } })).status, 200, s);
  const done = await call('POST /api/captain/rides/:id/status', { as: D1, params: { id: rid }, body: { status: 'completed' } });
  const expectComm = R2.commissionFor(est.price, { defaultPct: 10, minFee: 5 });
  eq(done.json.commission, expectComm, 'commission = 10% of the price');
  eq(Number((await q('SELECT balance FROM captain_profiles WHERE user_id=$1', [d1])).rows[0].balance), 200 - expectComm, 'balance reduced');
  eq((await call('POST /api/captain/rides/:id/status', { as: D1, params: { id: rid }, body: { status: 'completed' } })).status, 409, 'cannot complete twice (no double commission)');
  eq((await call('GET /api/admin/captains/:id/ledger', { as: A, params: { id: d1 } })).json.ledger.length, 2, 'commission in the ledger');

  // per-type and per-captain commission
  await call('PATCH /api/admin/ride-types/:id/commission', { as: A, params: { id: t.id }, body: { commissionPct: 20 } });
  await call('PATCH /api/admin/captains/:id', { as: A, params: { id: d1 }, body: { commissionPct: 0 } });
  // auto dispatch: nearest captain with auto receive
  await call('PATCH /api/admin/rides/settings', { as: A, body: { autoDispatch: true } });
  const r2 = (await call('POST /api/rides', { as: C, body: { ...body, price: est.price } })).json.ride;
  eq(r2.status, 'assigned', 'auto dispatch assigns at once');
  eq(String(r2.driverId), String(d1), 'the nearest captain got it');
  for (const s of ['arrived', 'started', 'completed']) await call('POST /api/captain/rides/:id/status', { as: D1, params: { id: r2.id }, body: { status: s } });
  eq(Number((await q('SELECT commission FROM rides WHERE id=$1', [r2.id])).rows[0].commission), 0, "the captain's own 0% beats the type's 20%");
  // a captain with auto-receive OFF is skipped by auto dispatch
  await call('PATCH /api/admin/captains/:id', { as: A, params: { id: d1 }, body: { autoReceive: false } });
  await call('PATCH /api/admin/captains/:id', { as: A, params: { id: d2 }, body: { autoReceive: false } });
  const r3 = (await call('POST /api/rides', { as: C, body: { ...body, price: est.price } })).json.ride;
  eq(r3.status, 'searching', 'no auto-receive captain -> stays searching for offers');
  // the owner assigns by hand
  eq((await call('POST /api/admin/rides/:id/assign', { as: A, params: { id: r3.id }, body: { driverId: d2 } })).status, 200, 'manual assign');
  eq((await call('GET /api/admin/rides', { as: A })).json.rides.find(x => x.id === r3.id).driverId, Number(d2), 'assigned to captain 2');
  eq((await call('POST /api/rides/:id/cancel', { as: C, params: { id: r3.id } })).status, 200, 'customer cancels');
  eq((await call('POST /api/rides/:id/cancel', { as: C, params: { id: r3.id } })).status, 409, 'cannot cancel twice');
  eq((await call('POST /api/admin/rides/:id/assign', { as: A, params: { id: r3.id }, body: { driverId: d2 } })).status, 409, 'cancelled ride cannot be reassigned');

  // low balance -> auto suspend + no requests
  await call('PATCH /api/admin/rides/settings', { as: A, body: { autoDispatch: false } });
  await q("UPDATE captain_profiles SET balance=-49, commission_pct=50 WHERE user_id=$1", [d2]);
  const r4 = (await call('POST /api/rides', { as: C2, body: { ...body, price: est.price } })).json.ride;
  await call('POST /api/admin/rides/:id/assign', { as: A, params: { id: r4.id }, body: { driverId: d2 } });
  for (const s of ['arrived', 'started', 'completed']) await call('POST /api/captain/rides/:id/status', { as: D2, params: { id: r4.id }, body: { status: s } });
  eq((await q('SELECT status FROM captain_profiles WHERE user_id=$1', [d2])).rows[0].status, 'suspended', 'auto-suspended below the threshold');
  eq((await call('GET /api/captain/requests', { as: D2 })).status, 403, 'suspended captain gets nothing');

  // ---- bidding mode: no price from the customer, every captain names his own
  eq((await call('PATCH /api/admin/rides/settings', { as: A, body: { pricing: 'weird' } })).status, 400, 'bad pricing mode refused');
  eq((await call('PATCH /api/admin/rides/settings', { as: A, body: { pricing: 'bidding' } })).status, 200, 'owner switches to bidding');
  eq((await call('GET /api/admin/rides/settings', { as: A })).json.pricing, 'bidding', 'mode is saved');
  eq((await call('POST /api/rides/estimate', { as: C, body })).json.bidding, true, 'estimate tells the customer it is bidding');
  const bd1 = await call('POST /api/rides', { as: C, body });
  eq(bd1.status, 200, 'customer sends a ride with no price'); ok(bd1.json.ride.bidding === true, 'the ride is marked bidding');
  const bid = bd1.json.ride.id;
  eq((await call('POST /api/captain/requests/:id/offer', { as: D1, params: { id: bid }, body: {} })).status, 400, 'captain cannot just accept: he must name a price');
  eq((await call('POST /api/captain/requests/:id/offer', { as: D1, params: { id: bid }, body: { price: 1 } })).status, 400, 'a price below the minimum is refused');
  eq((await call('POST /api/captain/requests/:id/offer', { as: D1, params: { id: bid }, body: { price: 100000 } })).status, 400, 'a crazy high price is refused');
  eq((await call('POST /api/captain/requests/:id/offer', { as: D1, params: { id: bid }, body: { price: 90 } })).status, 200, 'captain names 90');
  const bc = await call('GET /api/rides/current', { as: C });
  ok(bc.json.offers.length === 1 && bc.json.offers[0].price === 90, 'customer sees the captain price');
  eq((await call('POST /api/rides/:id/accept-offer', { as: C, params: { id: bid }, body: { offerId: bc.json.offers[0].id } })).status, 200, 'customer accepts the offer');
  eq(Number((await q('SELECT final_price FROM rides WHERE id=$1', [bid])).rows[0].final_price), 90, 'final price = the accepted bid');
  await call('POST /api/rides/:id/cancel', { as: C, params: { id: bid } });
  await call('PATCH /api/admin/rides/settings', { as: A, body: { pricing: 'fixed' } });

  // switch OFF closes the customer/captain side, the owner's panel still works
  switchOn = false;
  eq((await call('POST /api/rides', { as: C, body: { ...body, price: est.price } })).status, 404, 'closed when OFF');
  eq((await call('GET /api/admin/captains', { as: A })).status, 200, 'owner panel still works when OFF');


  // ---- the first-time seed of the six types
  await q('TRUNCATE ride_types RESTART IDENTITY CASCADE'); await q("DELETE FROM service_meta WHERE key='rides_seeded'");
  eq(await R.seedTypes(pool), 6, 'six types seeded');
  const sd = (await q('SELECT name, (image IS NOT NULL) AS img FROM ride_types ORDER BY sort_order')).rows;
  eq(sd.map(x => x.name), ['توكتوك', 'دراجة نارية', 'ملاكي', 'تونية', 'سقف عالي', 'عربية نقل'], 'names in order'); ok(sd.every(x => x.img), 'every type has its photo');
  eq(await R.seedTypes(pool), 0, 'second run adds nothing');
  await q('DELETE FROM ride_types'); eq(await R.seedTypes(pool), 0, 'what the owner deleted is not added back'); eq((await q('SELECT COUNT(*)::int c FROM ride_types')).rows[0].c, 0, 'still empty');
  console.log(`rides2: ${pass} passed, ${failN} failed`);
  await pool.end(); process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
