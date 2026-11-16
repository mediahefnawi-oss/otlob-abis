process.env.OSRM_URL = 'http://127.0.0.1:9'; // no routing service in the test: the straight line is used
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
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  await q('TRUNCATE ride_types, rides, captain_profiles, captain_ledger RESTART IDENTITY CASCADE');
  const extrasLib = { featureOn: async () => true };
  R.register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib, clearCaches() {} });
  R2.register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib, pushToUsers: async () => {}, hashPassword: async (p) => 'h:' + p });
  const mk = async (n, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',TRUE) RETURNING id", [n, '012' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const cId = await mk('عميل أحمد', 'customer'), c2 = await mk('عميل تاني', 'customer'), dId = await mk('كابتن محمود علي', 'courier');
  const t = (await q("INSERT INTO ride_types(name, base_fee, per_km, min_fee, adj_pct) VALUES('توكتوك',5,3,10,30) RETURNING id")).rows[0].id;
  await q("INSERT INTO captain_profiles(user_id, type_id, model, color, plate, status) VALUES($1,$2,'هوندا','أسود','4521 س ن ع','approved')", [dId, t]);
  const ride = async st => (await q(`INSERT INTO rides(customer_id, type_id, from_lat, from_lng, from_text, to_lat, to_lng, to_text, km, minutes, suggested, offered, bidding, driver_id, status, expires_at)
    VALUES($1,$2,31.20,29.90,'أ',31.25,29.95,'ب',5,10,30,30,FALSE,$3,$4, NOW() + INTERVAL '10 minutes') RETURNING id`, [cId, t, dId, st])).rows[0].id;
  const C = { sub: String(cId), role: 'customer' }, C2 = { sub: String(c2), role: 'customer' }, D = { sub: String(dId), role: 'courier' };
  const live = (as, id) => call('GET /api/rides/:id/live', { as, params: { id: String(id) } });

  const r1 = await ride('assigned');
  eq((await live(C2, r1)).status, 404, 'a stranger cannot watch the trip');
  eq((await live({ sub: '1', role: 'admin' }, r1)).status, 403, 'only the customer and the captain');
  let l = (await live(C, r1)).json;
  eq([l.active, l.driver, l.pickup], [true, null, null], 'no captain position yet: no way to the customer, but the trip is there');
  ok(l.trip && l.trip.route.length >= 2 && l.trip.km > 0, 'the trip route (at least the straight line)');
  await q("INSERT INTO courier_locations(courier_id, lat, lng, updated_at) VALUES($1,31.19,29.89,NOW()) ON CONFLICT (courier_id) DO UPDATE SET lat=31.19, lng=29.89, updated_at=NOW()", [dId]);
  l = (await live(C, r1)).json;
  ok(l.driver && Math.abs(l.driver.lat - 31.19) < 1e-6 && l.driver.ageSec < 5, 'the captain position is returned');
  ok(l.pickup && l.pickup.km > 0 && l.pickup.minutes >= 1 && l.pickup.route.length >= 2, 'way to the customer with distance and minutes');
  ok(l.trip && !l.dest, 'while going to the customer: the trip is shown, not the rest');
  const ld = (await live(D, r1)).json;
  eq([ld.active, ld.status], [true, 'assigned'], 'the captain sees the same trip');
  // he moves: the way to the customer follows him
  await q("UPDATE courier_locations SET lat=31.199, lng=29.899, updated_at=NOW() WHERE courier_id=$1", [dId]);
  const l2 = (await live(C, r1)).json;
  ok(l2.pickup.km < l.pickup.km, 'closer to the customer: a shorter way');
  // arrived: only the trip
  await q("UPDATE rides SET status='arrived' WHERE id=$1", [r1]);
  l = (await live(C, r1)).json; ok(l.trip && !l.pickup && !l.dest, 'arrived: the trip only');
  // started: what is left to the destination
  await q("UPDATE rides SET status='started' WHERE id=$1", [r1]);
  await q("UPDATE courier_locations SET lat=31.22, lng=29.92, updated_at=NOW() WHERE courier_id=$1", [dId]);
  l = (await live(C, r1)).json; ok(l.dest && l.dest.km > 0 && !l.pickup && !l.trip, 'started: the way that is left to the destination');
  // a stale position (older than 10 minutes) is not shown as live
  await q("UPDATE courier_locations SET updated_at=NOW() - INTERVAL '11 minutes' WHERE courier_id=$1", [dId]);
  l = (await live(C, r1)).json; eq(l.driver, null, 'old position is dropped');
  // finished trips are not live
  await q("UPDATE rides SET status='completed' WHERE id=$1", [r1]);
  eq((await live(C, r1)).json, { active: false, status: 'completed' }, 'finished: nothing to draw');
  // current: the customer gets the captain's details once assigned
  const r2 = await ride('assigned');
  const cur = (await call('GET /api/rides/current', { as: C })).json;
  eq(Number(cur.ride.id), Number(r2), 'current ride'); eq([cur.driver.name, cur.driver.model, cur.driver.plate], ['كابتن محمود', 'هوندا', '4521 س ن ع'], 'captain details (first two names only)');
  ok(!!cur.driver.phone, 'phone for the call button');
  console.log(`ridelive: ${pass} pass, ${failN} fail`); process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
