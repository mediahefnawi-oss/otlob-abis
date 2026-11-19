process.env.NO_SWEEP = '1';
const { Pool } = require('./shim');
const H = require('./h26');
const G = require('../src/gates.js'), T = require('../src/trips.js'), services = require('../src/services.js');
const { ok, eq, done } = H.counters();
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  await q('UPDATE ride_types SET trips_enabled=FALSE');   // a previous run on the same database must not leave types ticked
  await q('DELETE FROM order_gates'); await q('DELETE FROM trip_seats'); await q('DELETE FROM trips');
  const pushes = [];
  const extrasLib = { featureOn: async () => true };
  const { app, asyncRoute, positiveId, auth, roles, call } = H;
  G.register(app, { pool, auth, roles, asyncRoute, services });
  T.register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib, pushToUsers: async (ids, p) => { pushes.push({ ids: ids.map(Number), p }); } });
  const mk = async (n, role) => Number((await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',TRUE) RETURNING id", [n, H.phone(), role])).rows[0].id);
  const adm = await mk('owner', 'admin'), c1 = await mk('عميل واحد', 'customer'), c2 = await mk('عميل اتنين', 'customer'), d = await mk('كابتن مصطفى', 'courier'), d2 = await mk('كابتن غير مفعل', 'courier');
  const ty = (await q("INSERT INTO ride_types(name, base_fee, per_km, min_fee, adj_pct) VALUES('ملاكي',5,3,10,30) RETURNING id")).rows[0].id;
  await q("INSERT INTO captain_profiles(user_id, type_id, model, color, plate, status) VALUES($1,$2,'لانسر','أبيض','1234 أ ب ج','approved')", [d, ty]);
  await q("INSERT INTO captain_profiles(user_id, type_id, model, color, plate, status) VALUES($1,$2,'لانسر','أبيض','9999 أ ب ج','pending')", [d2, ty]);
  const A = { sub: String(adm), role: 'admin' }, C1 = { sub: String(c1), role: 'customer' }, C2 = { sub: String(c2), role: 'customer' }, D = { sub: String(d), role: 'courier' }, D2 = { sub: String(d2), role: 'courier' };
  const fail = (s, e) => Object.assign(new Error(e), { http: s });

  /* ---------------- gates ---------------- */
  ok(G.isClosed({ closed: true, until: null }), 'closed without an end time');
  ok(!G.isClosed({ closed: true, until: new Date(Date.now() - 1000) }), 'a closing whose end passed is open');
  ok(!G.isClosed({ closed: false }) && !G.isClosed(undefined), 'open / missing = open');
  ok(G.messageOf({ message: '' }, 'التوصيلة').includes('التوصيلة'), 'default message names the service');
  eq(G.messageOf({ message: 'راجعين بكرة' }, 'x'), 'راجعين بكرة', 'the owner message wins');
  const gl = (await call('GET /api/admin/gates', { as: A })).json.gates;
  ok(['*', 'market', 'ride', 'trips', 'restaurant', 'supermarket'].every(k => gl.some(g => g.key === k)), 'the list has the whole app, the special services and the shops: ' + gl.map(g => g.key).join());
  ok(gl.every(g => g.closed === false), 'everything open at the start');
  eq((await call('PUT /api/admin/gates/:key', { as: A, params: { key: 'nope' }, body: { closed: true } })).status, 404, 'unknown service');
  eq((await call('PUT /api/admin/gates/:key', { as: A, params: { key: 'ride' }, body: {} })).status, 400, 'open or close must be said');
  eq((await call('PUT /api/admin/gates/:key', { as: A, params: { key: 'ride' }, body: { closed: true, until: new Date(Date.now() - 5000).toISOString() } })).status, 400, 'end time must be in the future');
  eq((await call('PUT /api/admin/gates/:key', { as: C1, params: { key: 'ride' }, body: { closed: true } })).status, 403, 'a customer cannot close anything');
  G.invalidate(); let c = await G.check(pool, ['ride'], services.listJson()); eq(c, null, 'open at first');
  eq((await call('PUT /api/admin/gates/:key', { as: A, params: { key: 'ride' }, body: { closed: true, message: 'التوصيلة واقفة النهاردة' } })).json.ok, true, 'close rides');
  c = await G.check(pool, ['ride'], services.listJson()); eq(c && c.message, 'التوصيلة واقفة النهاردة', 'closed with the message');
  eq(await G.check(pool, ['market'], services.listJson()), null, 'another service is still open');
  let threw = null; try { await G.assertOpen(pool, ['ride'], fail); } catch (e) { threw = e; } eq([threw && threw.http, threw && threw.message], [409, 'التوصيلة واقفة النهاردة'], 'assertOpen throws the 409 the apps show');
  const pub = (await call('GET /api/gates', { as: C1 })).json.closed; eq(Object.keys(pub), ['ride'], 'the apps see which are closed'); eq(pub.ride.message, 'التوصيلة واقفة النهاردة', 'with the message');
  await call('PUT /api/admin/gates/:key', { as: A, params: { key: '*' }, body: { closed: true } });
  c = await G.check(pool, ['market'], services.listJson()); ok(c && c.key === '*', 'closing the whole app closes every service');
  await call('PUT /api/admin/gates/:key', { as: A, params: { key: '*' }, body: { closed: false } });
  eq(await G.check(pool, ['market'], services.listJson()), null, 'reopened');
  await call('PUT /api/admin/gates/:key', { as: A, params: { key: 'market' }, body: { closed: true, until: new Date(Date.now() + 3600e3).toISOString() } });
  c = await G.check(pool, ['market'], services.listJson()); ok(c && c.until > Date.now(), 'closed until a time');
  await q("UPDATE order_gates SET until = NOW() - INTERVAL '1 second' WHERE key='market'"); G.invalidate();
  eq(await G.check(pool, ['market'], services.listJson()), null, 'opens by itself when the time passes');
  await call('PUT /api/admin/gates/:key', { as: A, params: { key: 'ride' }, body: { closed: false } });
  eq((await q("SELECT message FROM order_gates WHERE key='ride'")).rows[0].message, '', 'reopening clears the message');

  /* ---------------- trips: the pure parts ---------------- */
  const now = Date.now(), day = 86400000, future = new Date(now + 2 * day).toISOString();
  const good = { dest: 'القاهرة', fromText: 'موقف أبيس', departAt: future, seats: 4, price: 250 };
  ok(T.cleanTrip(good).value, 'a good trip passes');
  for (const [bad, why] of [[{ ...good, dest: 'ق' }, 'short destination'], [{ ...good, departAt: 'x' }, 'bad date'], [{ ...good, departAt: new Date(now + 10 * 60e3).toISOString() }, 'less than 30 min ahead'],
    [{ ...good, departAt: new Date(now + 90 * day).toISOString() }, 'too far ahead'], [{ ...good, seats: 0 }, '0 seats'], [{ ...good, seats: 51 }, '51 seats'], [{ ...good, seats: 2.5 }, 'fraction seats'],
    [{ ...good, price: -1 }, 'negative price'], [{ ...good, price: 'abc' }, 'price not a number']]) ok(T.cleanTrip(bad).error, 'refused: ' + why);
  eq(T.cleanSeats([3, 1, 3], 4), [1, 3], 'seats sorted and unique'); eq(T.cleanSeats(2, 4), [2], 'a single seat'); eq(T.cleanSeats([5], 4), null, 'seat beyond the car'); eq(T.cleanSeats([0], 4), null, 'seat 0');
  eq(T.cleanSeats([1, 2, 3, 4, 5, 6, 7], 9), [1, 2, 3, 4, 5, 6, 7], 'seven at once'); eq(T.cleanSeats([1, 2, 3, 4, 5, 6, 7, 8], 9), null, 'more than 7 at once'); eq(T.cleanSeats([], 4), null, 'none');

  /* ---------------- trips: the flow ---------------- */
  const mkTrip = (as, b = {}) => call('POST /api/captain/trips', { as, body: { ...good, ...b } });
  eq((await mkTrip(C1)).status, 403, 'a customer cannot announce a trip');
  eq((await mkTrip(D2)).status, 403, 'a captain who is not approved cannot');
  eq((await mkTrip(D, { seats: 0 })).status, 400, 'bad data refused');
  pushes.length = 0;
  const r1 = await mkTrip(D); eq(r1.status, 201, 'the captain announces a trip: ' + JSON.stringify(r1.json).slice(0, 100));
  const tid = r1.json.trip.id; eq([r1.json.trip.free, r1.json.trip.booked], [4, []], 'four free seats');
  const nCust = Number((await q("SELECT COUNT(*) AS n FROM users WHERE role='customer' AND status='active' AND deleted_at IS NULL")).rows[0].n);
  ok(pushes.length === 1 && pushes[0].ids.includes(c1) && pushes[0].ids.includes(c2) && pushes[0].ids.length === nCust, 'every active customer is notified (' + nCust + ')');
  ok(pushes[0].p.title.includes('القاهرة') && pushes[0].p.body.includes('4'), 'the notification names the place and the seats: ' + pushes[0].p.title + ' / ' + pushes[0].p.body);
  // customers list
  let lst = (await call('GET /api/trips', { as: C1 })).json.trips; eq(lst.length >= 1 && lst.find(t => t.id === tid).free, 4, 'customer sees the trip with 4 free');
  eq(lst.find(t => t.id === tid).driver.plate, '1234 أ ب ج', 'and the car');
  eq((await call('GET /api/trips', { as: D })).status, 403, 'the captain does not use the customer list');
  // booking
  eq((await call('POST /api/trips/:id/book', { as: C1, params: { id: tid }, body: { seats: [5] } })).status, 400, 'a seat that does not exist');
  pushes.length = 0;
  let b = await call('POST /api/trips/:id/book', { as: C1, params: { id: tid }, body: { seats: [2] } }); eq([b.status, b.json.seats], [200, [2]], 'customer one books seat 2');
  ok(pushes.some(x => x.ids.includes(d) && x.p.title.includes('حجز')), 'the captain is told about the booking');
  b = await call('POST /api/trips/:id/book', { as: C2, params: { id: tid }, body: { seats: [2] } }); eq(b.status, 409, 'seat 2 is taken: ' + (b.json && b.json.error));
  b = await call('POST /api/trips/:id/book', { as: C2, params: { id: tid }, body: { seats: [1, 2] } }); eq(b.status, 409, 'one taken seat refuses the whole booking');
  eq(Number((await q('SELECT COUNT(*) AS n FROM trip_seats WHERE trip_id=$1', [tid])).rows[0].n), 1, '... and nothing of it was saved (all or nothing)');
  b = await call('POST /api/trips/:id/book', { as: C2, params: { id: tid }, body: { seats: [3] } }); eq(b.status, 200, 'customer two takes seat 3');
  lst = (await call('GET /api/trips', { as: C1 })).json.trips.find(t => t.id === tid); eq([lst.free, lst.booked, lst.mine], [2, [2, 3], [2]], 'seat map: 2 free, booked 2 and 3, mine = 2');
  eq((await call('GET /api/trips', { as: C2 })).json.trips.find(t => t.id === tid).mine, [3], 'each customer sees only his own seat as his');
  // limit per customer: 4
  const big = (await mkTrip(D, { seats: 10 })).json.trip.id;
  eq((await call('POST /api/trips/:id/book', { as: C1, params: { id: big }, body: { seats: [1, 2, 3, 4] } })).status, 200, 'four seats at once is fine');
  // by headcount: the server picks the free seats, the owner's limit (default 7) is respected
  const bk = id => (as, count) => call('POST /api/trips/:id/book', { as, params: { id }, body: { count } });
  const hc = (await mkTrip(D, { seats: 10 })).json.trip.id;
  let r = await bk(hc)(C1, 3); eq([r.status, r.json.seats], [200, [1, 2, 3]], 'three persons take the first free seats');
  eq((await bk(hc)(C1, 5)).status, 409, 'a customer cannot pass the limit in total (3+5>7)');
  eq((await bk(hc)(C2, 8)).status, 400, 'eight persons in one booking is refused');
  eq((await bk(hc)(C2, 0)).status, 400, 'zero persons is refused');
  r = await bk(hc)(C2, 7); eq([r.status, r.json.seats], [200, [4, 5, 6, 7, 8, 9, 10]], 'seven persons fill the rest in order');
  eq((await bk(hc)(C1, 1)).status, 409, 'no room left');
  await call('POST /api/admin/trips-settings', { as: A, body: { maxPersons: 4 } });
  const hc2 = (await mkTrip(D, { seats: 10 })).json.trip.id;
  eq((await bk(hc2)(C1, 5)).status, 400, 'the owner lowered the limit to 4: five is refused');
  eq((await bk(hc2)(C1, 4)).status, 200, 'and four is fine');
  eq((await call('GET /api/trips', { as: C1 })).json.maxPersons, 4, 'the customer app receives the limit');
  eq((await call('POST /api/admin/trips-settings', { as: A, body: { maxPersons: 9 } })).status, 400, 'owner limit must be 1..7');
  await call('POST /api/admin/trips-settings', { as: A, body: { maxPersons: 7 } });
  // per captain: own limit and own switch
  await q('UPDATE captain_profiles SET trips_max=3 WHERE user_id=$1', [d]);
  eq((await bk(hc2)(C2, 4)).status, 400, 'captain limit 3: four persons refused');
  eq((await call('GET /api/trips', { as: C1 })).json.trips.find(t => t.id === hc2).maxPersons, 3, 'the trip carries the captain limit');
  await q('UPDATE captain_profiles SET trips_max=NULL WHERE user_id=$1', [d]);
  await q("UPDATE captain_profiles SET trips_mode='never' WHERE user_id=$1", [d]);
  eq((await call('GET /api/captain/trips', { as: D })).json.allowed, false, 'blocked captain sees allowed=false');
  eq((await mkTrip(D, {})).status, 403, 'blocked captain cannot announce');
  await q("UPDATE captain_profiles SET trips_mode='always' WHERE user_id=$1", [d]);
  eq((await call('GET /api/captain/trips', { as: D })).json.allowed, true, 'always = allowed even with a type that is not ticked');
  await q("UPDATE captain_profiles SET trips_mode='type' WHERE user_id=$1", [d]);
  await q('DELETE FROM trips WHERE id = ANY($1::bigint[])', [[hc, hc2]]);
  // two customers fight for one seat at the same moment: exactly one wins
  const race = await Promise.all([C1, C2].map(as => call('POST /api/trips/:id/book', { as, params: { id: big }, body: { seats: [9] } })));
  eq(race.map(x => x.status).sort(), [200, 409], 'a race for the same seat: one wins, one is told');
  eq(Number((await q('SELECT COUNT(*) AS n FROM trip_seats WHERE trip_id=$1 AND seat_no=9', [big])).rows[0].n), 1, 'and only one booking exists');
  // mine
  const mine = (await call('GET /api/trips/mine', { as: C1 })).json.trips; ok(mine.some(t => t.id === tid && t.mySeats.join() === '2' && t.driver.phone), 'my bookings list shows the seat and the captain to call');
  // captain's view
  const cap = (await call('GET /api/captain/trips', { as: D })).json.trips.find(t => t.id === tid);
  eq([cap.passengers.length, cap.passengers.map(p => p.seat), cap.free], [2, [2, 3], 2], 'the captain sees who booked which seat'); ok(cap.passengers.every(p => p.name && p.phone), '... with names and phones');
  // cancel a booking
  pushes.length = 0;
  eq((await call('POST /api/trips/:id/cancel-booking', { as: C2, params: { id: tid } })).status, 200, 'customer two cancels');
  eq((await call('GET /api/trips', { as: C1 })).json.trips.find(t => t.id === tid).free, 3, 'the seat is free again'); ok(pushes.some(x => x.ids.includes(d)), 'the captain is told');
  eq((await call('POST /api/trips/:id/cancel-booking', { as: C2, params: { id: tid } })).status, 404, 'nothing left to cancel');
  // limit of open trips: 5 (two exist now)
  for (let i = 0; i < 3; i++) eq((await mkTrip(D)).status, 201, 'trip #' + (i + 3));
  eq((await mkTrip(D)).status, 409, 'at most 5 open trips per captain');
  // status flow
  eq((await call('POST /api/captain/trips/:id/status', { as: D, params: { id: tid }, body: { status: 'done' } })).status, 409, 'cannot finish before starting');
  pushes.length = 0;
  eq((await call('POST /api/captain/trips/:id/status', { as: D, params: { id: tid }, body: { status: 'started' } })).status, 200, 'start the trip'); ok(pushes.some(x => x.ids.includes(c1)), 'the passengers are told it started');
  eq((await call('POST /api/trips/:id/book', { as: C2, params: { id: tid }, body: { seats: [4] } })).status, 404, 'no booking on a trip that started');
  eq((await call('GET /api/trips', { as: C2 })).json.trips.some(t => t.id === tid), false, 'a started trip leaves the list');
  eq((await call('POST /api/captain/trips/:id/status', { as: D2, params: { id: tid }, body: { status: 'done' } })).status, 403, 'another captain cannot touch it');
  eq((await call('POST /api/captain/trips/:id/status', { as: D, params: { id: tid }, body: { status: 'done' } })).status, 200, 'finish');
  // cancel by the captain tells the passengers; the owner can cancel too
  pushes.length = 0;
  eq((await call('POST /api/captain/trips/:id/cancel', { as: D, params: { id: big } })).status, 200, 'captain cancels a trip with bookings');
  ok(pushes.some(x => x.ids.includes(c1) && x.p.title.includes('إلغاء')), 'the passengers are told it was cancelled');
  eq((await call('POST /api/captain/trips/:id/cancel', { as: D, params: { id: big } })).status, 409, 'cannot cancel twice');
  const other = (await call('GET /api/captain/trips', { as: D })).json.trips.find(t => t.status === 'open');
  eq((await call('POST /api/admin/trips/:id/cancel', { as: A, params: { id: other.id } })).status, 200, 'the owner cancels a trip');
  eq((await call('POST /api/admin/trips/:id/cancel', { as: C1, params: { id: other.id } })).status, 403, 'a customer cannot');
  ok((await call('GET /api/admin/trips', { as: A })).json.trips.length >= 5, 'the owner lists the trips');
  // the owner closed the trips: nobody announces or books
  await call('PUT /api/admin/gates/:key', { as: A, params: { key: 'trips' }, body: { closed: true, message: 'الحجز واقف' } });
  const open2 = (await call('GET /api/captain/trips', { as: D })).json.trips.find(t => t.status === 'open');
  const gc = await mkTrip(D); eq([gc.status, gc.json.error], [409, 'الحجز واقف'], 'closed trips: no new announcement');
  if (open2) eq((await call('POST /api/trips/:id/book', { as: C2, params: { id: open2.id }, body: { seats: [1] } })).status, 409, 'closed trips: no booking');
  /* ---- the owner picks the vehicle types that run intercity trips ---- */
  const ty2 = (await q("INSERT INTO ride_types(name, base_fee, per_km, min_fee, adj_pct) VALUES('توكتوك',5,3,10,30) RETURNING id")).rows[0].id;
  await q("DELETE FROM order_gates"); require('../src/gates.js').invalidate();
  let al = (await call('GET /api/captain/trips', { as: D })).json; eq(al.allowed, true, 'nothing ticked: every captain may run trips (as before)');
  await q('UPDATE ride_types SET trips_enabled=TRUE WHERE id=$1', [ty2]);
  al = (await call('GET /api/captain/trips', { as: D })).json; eq(al.allowed, false, 'a captain of another type is not allowed now');
  const blocked = await mkTrip(D, { dest: 'القاهرة' }); eq([blocked.status, blocked.json.error], [403, 'نوع مركبتك مش مسموح له برحلات المحافظات'], 'and cannot announce a trip');
  await q('UPDATE ride_types SET trips_enabled=TRUE WHERE id=$1', [ty]);
  const okT = await mkTrip(D, { dest: 'القاهرة' }); eq(okT.status, 201, 'a captain of a ticked type can: ' + JSON.stringify(okT.json).slice(0, 80));
  ok(okT.json.trip.vehicle && okT.json.trip.vehicle.name === 'ملاكي', 'the trip carries its vehicle type');
  const lst2 = (await call('GET /api/trips', { as: C1 })).json.trips.find(t => t.id === okT.json.trip.id); ok(lst2 && lst2.vehicle && lst2.vehicle.name === 'ملاكي', 'the customer list shows the vehicle');
  console.log('');
  const bad = done('gates+trips'); await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
