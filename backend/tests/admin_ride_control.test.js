process.env.NO_SWEEP = '1';
const { Pool } = require('./shim');
const H = require('./h26');
const T = require('../src/trips.js'), R2 = require('../src/rides2.js');
const { ok, eq, done } = H.counters();
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  await q('DELETE FROM trip_seats'); await q('DELETE FROM trips'); await q('TRUNCATE ride_types, rides, captain_profiles, captain_ledger RESTART IDENTITY CASCADE');
  const pushes = []; const extrasLib = { featureOn: async () => true };
  const { app, asyncRoute, positiveId, auth, roles, call } = H;
  const deps = { pool, auth, roles, asyncRoute, positiveId, extrasLib, pushToUsers: async (ids, p) => { pushes.push({ ids: ids.map(Number), p }); } };
  R2.register(app, deps); T.register(app, deps);
  const mk = async (n, role) => Number((await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',TRUE) RETURNING id", [n, H.phone(), role])).rows[0].id);
  const adm = await mk('owner', 'admin'), c1 = await mk('عميل', 'customer'), c2 = await mk('عميل2', 'customer'), d1 = await mk('كابتن1', 'courier'), d2 = await mk('كابتن2', 'courier'), d3 = await mk('معلّق', 'courier');
  const ty = (await q("INSERT INTO ride_types(name, base_fee, per_km, min_fee, adj_pct) VALUES('ملاكي',5,3,10,30) RETURNING id")).rows[0].id;
  for (const [u, st] of [[d1, 'approved'], [d2, 'approved'], [d3, 'pending']]) await q("INSERT INTO captain_profiles(user_id, type_id, model, color, plate, status) VALUES($1,$2,'لانسر','أبيض','1','" + st + "')", [u, ty]);
  const A = { sub: String(adm), role: 'admin' }, C1 = { sub: String(c1), role: 'customer' }, D1 = { sub: String(d1), role: 'courier' };
  const ride = async (status = 'searching', extra = '') => Number((await q(`INSERT INTO rides(customer_id,type_id,from_lat,from_lng,from_text,to_lat,to_lng,to_text,km,minutes,suggested,offered,expires_at,status${extra ? ',' + extra.split('=')[0] : ''}) VALUES($1,$2,30,31,'أ',30.1,31.1,'ب',5,10,40,40,NOW()+INTERVAL '10 minutes',$3${extra ? ',' + extra.split('=')[1] : ''}) RETURNING id`, [c1, ty, status])).rows[0].id);

  /* permissions: only the owner */
  for (const k of ['GET /api/admin/ride-captains', 'GET /api/admin/rides/offers']) { eq((await call(k, { as: C1 })).status, 403, k + ' customer refused'); eq((await call(k, { as: D1 })).status, 403, k + ' captain refused'); }
  eq((await call('PATCH /api/admin/rides/:id/price', { as: C1, params: { id: 1 }, body: { price: 50 } })).status, 403, 'customer cannot set price');
  eq((await call('PATCH /api/admin/trips/:id', { as: D1, params: { id: 1 }, body: { price: 50 } })).status, 403, 'captain cannot edit via admin');

  /* captain list: approved only */
  const cl = (await call('GET /api/admin/ride-captains', { as: A })).json.captains.map(x => x.id).sort();
  eq(cl, [d1, d2].sort(), 'only approved captains listed');

  /* price */
  const r1 = await ride();
  for (const bad of [0, -5, 'x', 99999, null]) eq((await call('PATCH /api/admin/rides/:id/price', { as: A, params: { id: r1 }, body: { price: bad } })).status, 400, 'bad price ' + bad);
  eq((await call('PATCH /api/admin/rides/:id/price', { as: A, params: { id: r1 }, body: { price: 55 } })).json.ok, true, 'set price on searching ride');
  eq(Number((await q('SELECT offered FROM rides WHERE id=$1', [r1])).rows[0].offered), 55, 'offered updated');
  eq((await q('SELECT final_price FROM rides WHERE id=$1', [r1])).rows[0].final_price, null, 'final price untouched while searching');
  ok((await q("SELECT 1 FROM audit_log WHERE action='ride.price' AND entity_id=$1", [String(r1)])).rowCount === 1, 'audited');
  const rDone = await ride('completed'); eq((await call('PATCH /api/admin/rides/:id/price', { as: A, params: { id: rDone }, body: { price: 60 } })).status, 409, 'finished ride price is locked');
  const rStart = await ride('started'); eq((await call('PATCH /api/admin/rides/:id/price', { as: A, params: { id: rStart }, body: { price: 60 } })).status, 409, 'started ride price is locked');

  /* assign then price updates final_price */
  eq((await call('POST /api/admin/rides/:id/assign', { as: A, params: { id: r1 }, body: { driverId: d1 } })).json.ok, true, 'assign');
  await call('PATCH /api/admin/rides/:id/price', { as: A, params: { id: r1 }, body: { price: 70 } });
  eq(Number((await q('SELECT final_price FROM rides WHERE id=$1', [r1])).rows[0].final_price), 70, 'assigned ride: final price follows');

  /* accept offer */
  const r2 = await ride('searching', 'bidding=TRUE');
  const oid = Number((await q("INSERT INTO ride_offers(ride_id, driver_id, price) VALUES($1,$2,48) RETURNING id", [r2, d2])).rows[0].id);
  const oid1 = Number((await q("INSERT INTO ride_offers(ride_id, driver_id, price) VALUES($1,$2,52) RETURNING id", [r2, d1])).rows[0].id);
  eq((await call('GET /api/admin/rides/offers', { as: A })).json.offers.filter(o => o.rideId === r2).length, 2, 'offers listed');
  eq((await call('POST /api/admin/rides/:id/accept-offer', { as: A, params: { id: r2 }, body: { offerId: 99999 } })).status, 404, 'unknown offer');
  eq((await call('POST /api/admin/rides/:id/accept-offer', { as: A, params: { id: r2 }, body: { offerId: oid } })).json.ok, true, 'accept offer');
  const row = (await q('SELECT status, driver_id, final_price FROM rides WHERE id=$1', [r2])).rows[0];
  eq([row.status, Number(row.driver_id), Number(row.final_price)], ['assigned', d2, 48], 'ride assigned at the offer price');
  eq((await q('SELECT status FROM ride_offers WHERE id=$1', [oid1])).rows[0].status, 'rejected', 'other offers rejected');
  eq((await call('POST /api/admin/rides/:id/accept-offer', { as: A, params: { id: r2 }, body: { offerId: oid1 } })).status, 404, 'cannot accept twice');

  /* reopen */
  eq((await call('POST /api/admin/rides/:id/reopen', { as: A, params: { id: r2 } })).json.ok, true, 'reopen an assigned ride');
  const ro = (await q('SELECT status, driver_id, final_price FROM rides WHERE id=$1', [r2])).rows[0];
  eq([ro.status, ro.driver_id, ro.final_price], ['searching', null, null], 'back to searching, captain released');
  ok(pushes.some(p => p.ids.includes(d2) && p.p.title === 'رحلة ملغاة'), 'released captain told');
  eq((await call('POST /api/admin/rides/:id/reopen', { as: A, params: { id: rStart } })).status, 409, 'cannot reopen a started ride');
  eq((await call('POST /api/admin/rides/:id/reopen', { as: A, params: { id: rDone } })).status, 409, 'cannot reopen a finished ride');
  ok((await q("SELECT 1 FROM audit_log WHERE action='ride.reopen'")).rowCount >= 1, 'reopen audited');

  /* ---------------- trips ---------------- */
  const dep = new Date(Date.now() + 3 * 86400000).toISOString();
  const trip = Number((await q("INSERT INTO trips(driver_id,dest,from_text,depart_at,seats,price) VALUES($1,'القاهرة','موقف',$2,4,100) RETURNING id", [d1, dep])).rows[0].id);
  eq((await call('POST /api/admin/trips/:id/book', { as: A, params: { id: trip }, body: { customerId: c1, count: 2 } })).json.seats, [1, 2], 'admin books 2 seats');
  eq((await call('POST /api/admin/trips/:id/book', { as: A, params: { id: trip }, body: { customerId: c2, count: 3 } })).status, 409, 'not enough free seats');
  eq((await call('POST /api/admin/trips/:id/book', { as: A, params: { id: trip }, body: { customerId: adm, count: 1 } })).status, 404, 'only customers can be booked');
  eq((await call('PATCH /api/admin/trips/:id', { as: A, params: { id: trip }, body: { seats: 1 } })).status, 409, 'cannot cut seats below a booked one');
  eq((await call('PATCH /api/admin/trips/:id', { as: A, params: { id: trip }, body: { price: -1 } })).status, 400, 'bad price');
  eq((await call('PATCH /api/admin/trips/:id', { as: A, params: { id: trip }, body: { departAt: new Date(Date.now() - 1e6).toISOString() } })).status, 400, 'past time refused');
  eq((await call('PATCH /api/admin/trips/:id', { as: A, params: { id: trip }, body: { driverId: d3 } })).status, 409, 'unapproved captain refused');
  eq((await call('PATCH /api/admin/trips/:id', { as: A, params: { id: trip }, body: {} })).status, 400, 'empty edit refused');
  pushes.length = 0;
  eq((await call('PATCH /api/admin/trips/:id', { as: A, params: { id: trip }, body: { price: 120, seats: 6, driverId: d2 } })).json.ok, true, 'edit price, seats, captain');
  const tr = (await q('SELECT price, seats, driver_id FROM trips WHERE id=$1', [trip])).rows[0];
  eq([Number(tr.price), tr.seats, Number(tr.driver_id)], [120, 6, d2], 'trip updated');
  ok(pushes.some(p => p.ids.includes(c1)), 'booked customer told'); ok(pushes.some(p => p.ids.includes(d2)), 'new captain told');
  const at = (await call('GET /api/admin/trips', { as: A })).json.trips.find(t => t.id === trip);
  eq([at.driverId, at.passengers.length, at.passengers[0].customerId], [d2, 2, c1], 'admin list shows passengers with ids');
  eq((await call('POST /api/admin/trips/:id/unbook', { as: A, params: { id: trip }, body: { customerId: c2 } })).status, 404, 'unbook a non-passenger');
  eq((await call('POST /api/admin/trips/:id/unbook', { as: A, params: { id: trip }, body: { customerId: c1 } })).json.ok, true, 'unbook');
  eq((await q('SELECT COUNT(*)::int n FROM trip_seats WHERE trip_id=$1', [trip])).rows[0].n, 0, 'seats freed');
  await call('POST /api/admin/trips/:id/cancel', { as: A, params: { id: trip } });
  eq((await call('PATCH /api/admin/trips/:id', { as: A, params: { id: trip }, body: { price: 5 } })).status, 409, 'cancelled trip is locked');
  eq((await call('POST /api/admin/trips/:id/book', { as: A, params: { id: trip }, body: { customerId: c1 } })).status, 409, 'cannot book a cancelled trip');
  ok((await q("SELECT 1 FROM audit_log WHERE action IN ('trip.edit','trip.book','trip.unbook')")).rowCount >= 3, 'trip actions audited');
  const bad = await done('admin ride control'); await pool.end?.(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
