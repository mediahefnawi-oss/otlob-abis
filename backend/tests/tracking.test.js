const { Pool } = require('./shim');
const coms = require('../src/tracking.js');
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
const near = (a, b, m) => ok(Math.abs(Number(a) - Number(b)) < 0.005, `${m}: got ${a} expected ${b}`);

const routes = {};
const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (path, ...chain) => { routes[`${m.toUpperCase()} ${path}`] = chain; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const auth = (req, res, next) => { if (!req.auth) return res.status(401).json({ error: 'auth' }); next(); };
const roles = (...allowed) => (req, res, next) => { if (!req.auth || !allowed.includes(req.auth.role)) return res.status(403).json({ error: 'forbidden' }); next(); };

async function call(key, { as, body, query, params } = {}) {
  const chain = routes[key];
  if (!chain) throw new Error('no route ' + key);
  const req = { auth: as, body: body || {}, query: query || {}, params: params || {} };
  const out = { status: 200, json: null, headers: {} };
  const res = { status(c) { out.status = c; return this; }, json(j) { out.json = j; return this; }, set(k, v) { out.headers[k] = v; return this; }, send(b) { out.sent = b; return this; }, end() { return this; } };
  let i = 0, err = null;
  const next = e => { if (e) { err = e; return; } const f = chain[i++]; if (f) return f(req, res, next); };
  next();
  const t0 = Date.now();
  while (!err && out.json === null && out.sent === undefined && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 2));
  if (err) throw err;
  return out;
}
(async () => {
  const pool = new Pool();
  const q = (t, p) => pool.query(t, p);
  await q(`TRUNCATE courier_locations, commission_entries, commission_settlements, counter_resets, audit_log, appointments, orders, products, providers, users RESTART IDENTITY CASCADE`);
  const user = async (name, role, extra = '') => (await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',$4) RETURNING id", [name, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role, extra === 'avail'])).rows[0].id;
  const admin = await user('م', 'admin'), c1 = await user('ع1', 'customer'), c2 = await user('ع2', 'customer'), shopU = await user('محل', 'provider'), shopU2 = await user('محل2', 'provider'), cour = await user('مندوب', 'courier', 'avail'), cour2 = await user('مندوب2', 'courier'), sup = await user('مشرف', 'supervisor');
  const rid = (await q("INSERT INTO regions(name) VALUES('t'||floor(random()*1e9)) RETURNING id")).rows[0].id; await q('UPDATE users SET sup_regions=$1 WHERE id=$2', [String(rid), sup]);
  const prov = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'restaurant','مطعم','010','active',true) RETURNING id", [shopU])).rows[0].id;
  const ord = async (cust, status, courier, region) => (await q("INSERT INTO orders(customer_user_id,provider_id,status,total,region_id,courier_user_id,data) VALUES($1,$2,$3,10,$4,$5,$6) RETURNING id", [cust, prov, status, region, courier, JSON.stringify({ destLat: 31.1, destLng: 30.0 })])).rows[0].id;
  coms(app, { pool, auth, roles, asyncRoute, positiveId });
  const A = { sub: String(admin), role: 'admin' }, C1 = { sub: String(c1), role: 'customer' }, C2 = { sub: String(c2), role: 'customer' }, SH = { sub: String(shopU), role: 'provider' }, SH2 = { sub: String(shopU2), role: 'provider' }, CO = { sub: String(cour), role: 'courier' }, CO2 = { sub: String(cour2), role: 'courier' }, S1 = { sub: String(sup), role: 'supervisor' };
  let r;
  // customer spot
  r = await call('PUT /api/me/location', { as: C1, body: { lat: 31.05, lng: 29.9 } }); eq(r.status, 200, 'save spot');
  r = await call('GET /api/me/location', { as: C1 }); near(r.json.location.lat, 31.05, 'spot back');
  r = await call('PUT /api/me/location', { as: C1, body: { lat: 0, lng: 0 } }); eq(r.status, 400, 'outside Egypt refused');
  r = await call('PUT /api/me/location', { as: C1, body: { lat: 'x', lng: 1 } }); eq(r.status, 400, 'garbage refused');
  r = await call('PUT /api/me/location', { as: CO, body: { lat: 31, lng: 30 } }); eq(r.status, 403, 'courier cannot set customer spot');
  r = await call('PUT /api/me/location', { as: C1, body: { clear: true } }); eq(r.json.location, null, 'cleared');
  // shop spot
  r = await call('PUT /api/provider/location', { as: SH, body: { lat: 31.0, lng: 29.95 } }); eq(r.status, 200, 'shop spot');
  r = await call('PUT /api/provider/location', { as: SH2, body: { lat: 31.0, lng: 29.95 } }); eq(r.status, 404, 'user without shop');
  // courier
  r = await call('POST /api/courier/location', { as: CO, body: { lat: 31.02, lng: 29.97, accuracy: 12, heading: 90 } }); eq(r.status, 200, 'courier sends');
  r = await call('POST /api/courier/location', { as: CO2, body: { lat: 31.02, lng: 29.97 } }); eq(r.status, 409, 'offline courier without order refused');
  r = await call('POST /api/courier/location', { as: C1, body: { lat: 31.02, lng: 29.97 } }); eq(r.status, 403, 'customer cannot send courier position');
  await call('POST /api/courier/location', { as: CO, body: { lat: 31.03, lng: 29.98 } });
  eq(Number((await q('SELECT COUNT(*) n FROM courier_locations')).rows[0].n), 1, 'only the last position is kept');
  // orders
  const oPending = await ord(c1, 'pending', null, rid), oLive = await ord(c1, 'on_the_way', cour, rid), oDone = await ord(c1, 'delivered', cour, rid), oOther = await ord(c2, 'on_the_way', cour, rid);
  r = await call('GET /api/orders/:id/tracking', { as: C1, params: { id: oPending } }); eq(r.status, 200, 'customer sees map from the start'); eq(r.json.courier, null, 'no courier yet'); ok(r.json.shop && r.json.dest, 'shop and destination shown before any courier');
  r = await call('GET /api/orders/:id/tracking', { as: C1, params: { id: oLive } }); ok(r.json.courier && r.json.courier.fresh, 'customer sees live courier'); ok(r.json.distanceKm > 0 && r.json.etaMin >= 1, 'distance and eta');
  r = await call('GET /api/orders/:id/tracking', { as: C1, params: { id: oDone } }); eq(r.json.courier, null, 'courier hidden after delivery');
  r = await call('GET /api/orders/:id/tracking', { as: C1, params: { id: oOther } }); eq(r.status, 403, 'customer cannot see another order');
  r = await call('GET /api/orders/:id/tracking', { as: C2, params: { id: oLive } }); eq(r.status, 403, 'another customer refused');
  r = await call('GET /api/orders/:id/tracking', { as: SH, params: { id: oLive } }); ok(r.json.courier, 'order shop sees courier');
  r = await call('GET /api/orders/:id/tracking', { as: SH2, params: { id: oLive } }); eq(r.status, 403, 'other shop refused');
  r = await call('GET /api/orders/:id/tracking', { as: CO, params: { id: oLive } }); eq(r.json.courier, null, 'courier gets no courier marker');
  r = await call('GET /api/orders/:id/tracking', { as: CO2, params: { id: oLive } }); eq(r.status, 403, 'other courier refused');
  r = await call('GET /api/orders/:id/tracking', { as: A, params: { id: oLive } }); ok(r.json.courier, 'owner sees');
  r = await call('GET /api/orders/:id/tracking', { as: S1, params: { id: oLive } }); ok(r.json.courier, 'supervisor of the area sees');
  await q('UPDATE users SET sup_regions=$1 WHERE id=$2', ['9', sup]);
  r = await call('GET /api/orders/:id/tracking', { as: S1, params: { id: oLive } }); eq(r.status, 403, 'supervisor of another area refused');
  r = await call('GET /api/staff/courier-locations', { as: S1 }); eq(r.json.couriers.length, 0, 'supervisor list limited to his areas');
  r = await call('GET /api/staff/courier-locations', { as: A }); eq(r.json.couriers.length, 1, 'owner list'); eq(r.json.couriers[0].busy, 2, 'busy count');
  r = await call('GET /api/staff/courier-locations', { as: C1 }); eq(r.status, 403, 'customer refused list');
  await call('DELETE /api/courier/location', { as: CO });
  r = await call('GET /api/orders/:id/tracking', { as: C1, params: { id: oLive } }); eq(r.json.courier, null, 'no marker after courier stops sharing');
  near(coms.km(30, 31, 30, 31), 0, 'km zero'); near(coms.km(30.0, 31.0, 30.0, 32.0), 96.3, 'km 1 degree lng at 30N');
  console.log(`tracking: ${pass} passed, ${failN} failed`);
  await pool.end(); process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
