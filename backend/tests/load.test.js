const { Pool } = require('./shim');
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const pass1 = (req, res, next) => next();
const pct = (a, p) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  require('../src/orders.js')(app, { pool, auth: pass1, authAny: pass1, roles: () => pass1, asyncRoute, positiveId,
    maintenanceState: async () => ({ enabled: true }), loadSettings: async () => ({}), cleanUser: x => x, pushToUsers: async () => {} });
  const call = (key, as, body, query) => new Promise((resolve, reject) => {
    const out = { status: 200, json: null };
    const res = { set() { return this; }, status(c) { out.status = c; return this; }, json(j) { out.json = j; resolve(out); return this; } };
    routes[key][routes[key].length - 1]({ auth: as, params: {}, body: body || {}, query: query || {} }, res, reject);
  });
  const mk = async (n, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',TRUE) RETURNING id", [n, '012' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  // 20 shops with 10 products, 300 customers, 10 couriers, plus history so that queries are not trivially empty
  const shops = [], prods = [];
  for (let i = 0; i < 20; i++) { const o = await mk('shop' + i, 'provider'); const p = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'supermarket','س'||$2,'01000000000','active',TRUE) RETURNING id", [o, i])).rows[0].id; shops.push(p); for (let j = 0; j < 10; j++) prods.push((await q("INSERT INTO products(provider_id,name,price) VALUES($1,'م'||$2,25) RETURNING id", [p, j])).rows[0].id); }
  const custs = []; for (let i = 0; i < 300; i++) custs.push(await mk('c' + i, 'customer'));
  for (let i = 0; i < 10; i++) await mk('d' + i, 'courier');
  const A = id => ({ sub: String(id), role: 'customer', status: 'active' });
  const body = c => ({ name: 'عميل تجريبي', phone: '01012345678', address: 'شارع التجربة', notes: '', lines: [{ productId: prods[c % prods.length], qty: 2 }, { productId: prods[(c * 7 + 3) % prods.length], qty: 1 }] });
  async function run(label, total, conc, fn) {
    const lat = []; let i = 0, errs = 0; const t0 = Date.now();
    await Promise.all(Array.from({ length: conc }, async () => { while (i < total) { const k = i++; const s = Date.now(); try { const r = await fn(k); if (r.status >= 400) { errs++; if (!global.shown) { global.shown = 1; console.log('sample error:', r.status, JSON.stringify(r.json)); } } } catch (e) { errs++; if (!global.shown) { global.shown = 1; console.log('sample error:', e && (e.status || e.statusCode), e && e.message); } } lat.push(Date.now() - s); } }));
    const sec = (Date.now() - t0) / 1000;
    console.log(`${label}: ${total} in ${sec.toFixed(1)}s = ${(total / sec).toFixed(0)}/s | p50 ${pct(lat, .5)}ms p95 ${pct(lat, .95)}ms max ${Math.max(...lat)}ms | errors ${errs}`);
  }
  for (const c of [5, 10, 25]) await run(`checkout, ${c} at once`, 200, c, k => call('POST /api/orders/checkout', A(custs[k % custs.length]), body(k)));
  const n = (await q('SELECT count(*) c FROM orders')).rows[0].c; console.log('orders in db now:', n);
  const tag = (await call('GET /api/sync', A(custs[0]))).json.tag;
  for (const c of [10, 25]) await run(`sync "anything new?" check, ${c} at once`, 1500, c, k => call('GET /api/sync', A(custs[k % custs.length]), null, {}));
  await run('full sync (someone has news), 10 at once', 300, 10, k => call('GET /api/sync', A(custs[k % custs.length]), null, { tag: 'x' }));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
