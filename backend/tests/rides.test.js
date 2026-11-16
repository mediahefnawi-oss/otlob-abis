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
(async () => {
  // ---- pure parts
  eq(R.priceFor({ base_fee: 10, per_km: 9, min_fee: 30 }, 7.4), 80, 'price 10 + 7.4*9 = 76.6 -> 80');
  eq(R.priceFor({ base_fee: 10, per_km: 9, min_fee: 30 }, 0.5), 30, 'never below the minimum');
  eq(R.priceFor({ base_fee: 5, per_km: 6, min_fee: 0 }, 2.1), 20, '5 + 12.6 = 17.6 -> 20');
  eq(R.bounds(80, 30), { lo: 55, hi: 105 }, 'bounds 30%');
  eq(R.bounds(80, 0), { lo: 80, hi: 80 }, 'bounds 0%');
  ok(R.cleanType({ name: '', base_fee: 1, per_km: 1, min_fee: 1 }) === null, 'empty name refused');
  ok(R.cleanType({ name: 'x', base_fee: -1, per_km: 1, min_fee: 1 }) === null, 'negative refused');
  ok(R.cleanType({ name: 'x', base_fee: 1, per_km: 1, min_fee: 1, adj_pct: 95 }) === null, 'adj over 90 refused');
  ok(R.cleanType({ name: 'ملاكي', base_fee: 10, per_km: 9, min_fee: 30, adj_pct: 30, sort_order: 1 }) !== null, 'good type accepted');
  eq(R.cleanType({ per_km: 12 }, true), { per_km: 12 }, 'partial update');
  const d1 = await R.roadDistance({ lat: 31, lng: 30 }, { lat: 31, lng: 30.1 }, async () => { throw new Error('offline'); });
  ok(d1.source === 'line' && d1.km > 9 && d1.km < 13, 'falls back to a straight line x 1.3 when the router is down: ' + JSON.stringify(d1));
  const d2 = await R.roadDistance({ lat: 31, lng: 30 }, { lat: 31, lng: 30.1 }, async () => ({ ok: true, json: async () => ({ routes: [{ distance: 12345, duration: 600 }] }) }));
  eq(d2, { km: 12.3, min: 10, source: 'road' }, 'uses the road distance when the router answers');

  // ---- routes
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  await q('TRUNCATE ride_types RESTART IDENTITY CASCADE');
  let switchOn = false;
  const extrasLib = { featureOn: async () => switchOn };
  R.register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib, clearCaches() {} });
  const A = { sub: 1, role: 'admin' }, C = { sub: 2, role: 'customer' };

  eq((await call('POST /api/admin/ride-types', { as: C, body: {} })).status, 403, 'customer cannot create types');
  const bad = await call('POST /api/admin/ride-types', { as: A, body: { name: 'x', base_fee: -5, per_km: 1, min_fee: 1 } });
  eq(bad.status, 400, 'bad numbers refused');
  const t1 = (await call('POST /api/admin/ride-types', { as: A, body: { name: 'ملاكي', base_fee: 10, per_km: 9, min_fee: 30, adj_pct: 30, sort_order: 2 } })).json.type;
  const t2 = (await call('POST /api/admin/ride-types', { as: A, body: { name: 'توكتوك', base_fee: 5, per_km: 6, min_fee: 15, sort_order: 1 } })).json.type;
  ok(t1 && t1.id && t1.baseFee === 10 && t1.adjPct === 30 && t1.active, 'type created');
  eq((await call('GET /api/admin/ride-types', { as: A })).json.types.map(t => t.name), ['توكتوك', 'ملاكي'], 'listed by sort order');

  eq((await call('GET /api/ride-types', { as: C })).status, 404, 'customers see nothing while the switch is OFF');
  eq((await call('POST /api/rides/estimate', { as: C, body: {} })).status, 404, 'estimate closed while OFF');
  switchOn = true;
  eq((await call('GET /api/ride-types', { as: C })).json.types.length, 2, 'both types once ON');

  const p = (await call('PATCH /api/admin/ride-types/:id', { as: A, params: { id: t2.id }, body: { active: false, per_km: 7 } })).json.type;
  ok(p.active === false && p.perKm === 7, 'edit + stop');
  eq((await call('GET /api/ride-types', { as: C })).json.types.map(t => t.name), ['ملاكي'], 'stopped type hidden from customers');
  eq((await call('PATCH /api/admin/ride-types/:id', { as: A, params: { id: 99999 }, body: { per_km: 1 } })).status, 404, 'unknown id');

  const est = await call('POST /api/rides/estimate', { as: C, body: { from: { lat: 31, lng: 30 }, to: { lat: 31, lng: 30.1 }, typeId: t1.id } });
  ok(est.status === 200 && est.json.price >= 30 && est.json.lo <= est.json.price && est.json.hi >= est.json.price, 'estimate: ' + JSON.stringify(est.json));
  eq((await call('POST /api/rides/estimate', { as: C, body: { from: { lat: 31, lng: 30 }, to: { lat: 999, lng: 30 }, typeId: t1.id } })).status, 400, 'bad point');
  eq((await call('POST /api/rides/estimate', { as: C, body: { from: { lat: 31, lng: 30 }, to: { lat: 31, lng: 30.1 }, typeId: t2.id } })).status, 404, 'stopped type cannot be estimated');

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const im = (await call('PUT /api/admin/ride-types/:id/image', { as: A, params: { id: t1.id }, body: { image: png } })).json.type;
  ok(im.image && im.image.startsWith('/api/ride-type-image/' + t1.id), 'image saved');
  const g = await call('GET /api/ride-type-image/:id', { params: { id: t1.id } });
  ok(g.sent && g.headers['Content-Type'] === 'image/png', 'image served');
  eq((await call('PUT /api/admin/ride-types/:id/image', { as: A, params: { id: t1.id }, body: { image: 'data:text/html;base64,AAAA' } })).status, 400, 'non-image refused');

  eq((await call('DELETE /api/admin/ride-types/:id', { as: A, params: { id: t2.id } })).json, { ok: true }, 'deleted');
  eq((await call('GET /api/admin/ride-types', { as: A })).json.types.length, 1, 'one left');
  console.log(`rides: ${pass} passed, ${failN} failed`);
  await pool.end(); process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
