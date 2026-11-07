const { Pool } = require('./shim');
const kf = require('../src/kmfee.js');
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
  await q(`TRUNCATE offers, courier_locations, commission_entries, commission_settlements, counter_resets, audit_log, appointments, orders, products, providers, users RESTART IDENTITY CASCADE`);
  const user = async (name, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status) VALUES($1,$2,'x',$3,'active') RETURNING id", [name, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const admin = await user('م', 'admin'), c1 = await user('ع', 'customer'), c2 = await user('ع2', 'customer'), s1 = await user('محل', 'provider');
  const prov = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open,lat,lng) VALUES($1,'restaurant','مطعم','010','active',true,31.0,30.0) RETURNING id", [s1])).rows[0].id;
  const prov2 = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'restaurant','بدون موقع','010','active',true) RETURNING id", [s1])).rows[0].id;
  await q('UPDATE users SET home_lat=31.0, home_lng=30.03 WHERE id=$1', [c1]);
  const settingsMemo = { clear() {} };
  kf.registerKmFeeRoutes(app, { pool, auth, roles, asyncRoute, settingsMemo });
  const A = { sub: String(admin), role: 'admin' }, SH = { sub: String(s1), role: 'provider' };
  const cfg = { mode: 'km', perKm: 5, min: 10, max: 40, factor: 1.3 };
  let r;
  eq(kf.feeFor({ ...cfg, mode: 'region' }, { lat: 31, lng: 30 }, { lat: 31, lng: 30.03 }), null, 'region mode = no km fee');
  eq(kf.feeFor(cfg, { lat: 31, lng: 30 }, { lat: null, lng: null }), null, 'missing spot = null');
  eq(kf.feeFor(cfg, { lat: 31, lng: 30 }, null), null, 'no spot at all = null');
  let f = kf.feeFor(cfg, { lat: 31, lng: 30 }, { lat: 31, lng: 30.03 });  // about 2.86 km straight, x1.3 = 3.7 km
  near(f.km, 3.7, 'km with road factor'); eq(f.fee, 19, '3.7 km x 5 = 18.6 -> 19');
  eq(kf.feeFor(cfg, { lat: 31, lng: 30 }, { lat: 31, lng: 30.0005 }).fee, 10, 'minimum applies');
  eq(kf.feeFor(cfg, { lat: 31, lng: 30 }, { lat: 31, lng: 30.5 }).fee, 40, 'maximum applies');
  // from the database
  eq(await kf.forOrder(pool, prov, c1), null, 'switch is off by default');
  r = await call('PATCH /api/admin/delivery-mode', { as: SH, body: { mode: 'km', perKm: 5, min: 10, max: 40, factor: 1.3 } }); eq(r.status, 403, 'shop cannot switch');
  r = await call('PATCH /api/admin/delivery-mode', { as: A, body: { mode: 'km', perKm: 'x', min: 10, max: 40, factor: 1.3 } }); eq(r.status, 400, 'bad number refused');
  r = await call('PATCH /api/admin/delivery-mode', { as: A, body: { mode: 'km', perKm: 5, min: 50, max: 40, factor: 1.3 } }); eq(r.status, 400, 'max below min refused');
  r = await call('PATCH /api/admin/delivery-mode', { as: A, body: { mode: 'km', perKm: 5, min: 10, max: 40, factor: 1.3 } }); eq(r.status, 200, 'owner switches on');
  f = await kf.forOrder(pool, prov, c1); eq(f.fee, 19, 'order fee from the database');
  eq(await kf.forOrder(pool, prov, c2), null, 'customer without a spot falls back to the area price');
  eq(await kf.forOrder(pool, prov2, c1), null, 'shop without a spot falls back to the area price');
  await call('PATCH /api/admin/delivery-mode', { as: A, body: { mode: 'region', perKm: 5, min: 10, max: 40, factor: 1.3 } });
  eq(await kf.forOrder(pool, prov, c1), null, 'switched back off');
  console.log(`kmfee: ${pass} passed, ${failN} failed`);
  await pool.end(); process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
