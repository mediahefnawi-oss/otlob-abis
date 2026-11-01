const { Pool } = require('./shim');
const comm = require('../src/commissions.js');
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
  require('../src/commissions.js')(app, { pool, auth, roles, asyncRoute, positiveId });
  await pool.query("DELETE FROM site_images WHERE key LIKE 'cat\\_%'");
  const adm = { sub: '1', role: 'admin', status: 'active' }, cu = { sub: '2', role: 'customer', status: 'active' };
  await pool.query("INSERT INTO users(id,name,phone,password_hash,role,status) VALUES(1,'a','01000000001','x','admin','active') ON CONFLICT (id) DO NOTHING");
  const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const r1 = await call('PUT /api/admin/cat-icon/:type', { as: adm, params: { type: 'maker' }, body: { image: png } });
  ok(r1.status === 200 && r1.json.type === 'maker' && r1.json.v > 0, 'owner saves a maker icon: ' + JSON.stringify(r1.json));
  const r2 = await call('PUT /api/admin/cat-icon/:type', { as: cu, params: { type: 'maker' }, body: { image: png } });
  ok(r2.status === 403, 'customer cannot');
  const r3 = await call('PUT /api/admin/cat-icon/:type', { as: adm, params: { type: 'bogus' }, body: { image: png } });
  ok(r3.status === 400, 'unknown type refused');
  const r4 = await call('PUT /api/admin/cat-icon/:type', { as: adm, params: { type: 'clinic' }, body: { image: 'data:text/html;base64,AAAA' } });
  ok(r4.status === 400, 'non-image refused');
  const g = await call('GET /api/cat-icon/:type', { params: { type: 'maker' } });
  ok(g.sent !== undefined && g.headers['Content-Type'] === 'image/png', 'public GET returns the picture');
  const d = await call('DELETE /api/admin/cat-icon/:type', { as: adm, params: { type: 'maker' } });
  ok(d.status === 200 && d.json.v === 0, 'owner removes it');
  console.log(`cat icon tests: ${pass} passed, ${failN} failed`); process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
