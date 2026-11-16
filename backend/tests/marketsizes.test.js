process.env.NO_SWEEP = '1';
const { Pool } = require('./shim');
const M = require('../src/market.js'), extrasLib = require('../src/extras.js');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const pass1 = (req, res, next) => next();
const auth = (req, res, next) => { if (!req.auth) return res.status(401).json({ error: 'auth' }); next(); };
const roles = (...a) => (req, res, next) => { if (!req.auth || !a.includes(req.auth.role)) return res.status(403).json({ error: 'forbidden' }); next(); };
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const notes = [];
  await q('TRUNCATE market_products RESTART IDENTITY'); await q('UPDATE app_settings SET market_fee=15 WHERE id=1'); // repeatable runs
  M.register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib });
  // the real orders module, with open auth, only to reach /api/orders/market (it uses the real roles check below)
  const ordersApp = {}; const oroutes = {};
  for (const m of ['get', 'post', 'patch', 'put', 'delete']) ordersApp[m] = (p, ...c) => { oroutes[`${m.toUpperCase()} ${p}`] = c; };
  ordersApp.use = () => {};
  require('../src/orders.js')(ordersApp, { pool, auth, authAny: auth, roles, asyncRoute, positiveId, maintenanceState: async () => ({ enabled: true }), loadSettings: async () => ({}), cleanUser: x => x, pushToUsers: async (ids, p) => { notes.push({ ids: ids.map(Number), p }); } });
  const call = async (key, { as, params, body, table } = {}) => {
    const chain = (table || routes)[key]; if (!chain) throw new Error('no route ' + key);
    const req = { auth: as, params: params || {}, body: body || {}, query: {} };
    const out = { status: 200, json: null, headers: {} };
    const res = { status(c) { out.status = c; return this; }, json(j) { out.json = j; return this; }, set(k, v) { out.headers[k] = v; return this; }, send(b) { out.sent = b; return this; }, end() { out.ended = true; return this; } };
    let i = 0, err = null; const next = e => { if (e) { err = e; return; } const f = chain[i++]; if (f) return f(req, res, next); }; next();
    const t0 = Date.now(); while (!err && out.json === null && out.sent === undefined && !out.ended && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 2));
    if (err) throw err; return out;
  };
  const feat = async (k, v) => { await q("UPDATE app_settings SET features = COALESCE(features,'{}'::jsonb) || $1::jsonb WHERE id=1", [JSON.stringify({ [k]: v })]); };
  const u = async (n, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',TRUE) RETURNING id", [n, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const aId = await u('admin', 'admin'), cId = await u('عميل', 'customer');
  const A = { sub: String(aId), role: 'admin' }, C = { sub: String(cId), role: 'customer' };
  await feat('market', true);
  const add = async b => (await call('POST /api/admin/market-products', { as: A, body: b })).json;
  // ---- the owner adds a product with sizes and details
  eq((await call('POST /api/admin/market-products', { as: A, body: { name: 'x', sizes: [{ label: '', price: 1 }] } })).status, 400, 'a size needs a name');
  eq((await call('POST /api/admin/market-products', { as: A, body: { name: 'x', sizes: [{ label: 'كيلو', price: 1 }, { label: 'كيلو', price: 2 }] } })).status, 400, 'size names are unique');
  eq((await call('POST /api/admin/market-products', { as: A, body: { name: 'x', sizes: [{ label: 'كيلو', price: -3 }] } })).status, 400, 'negative size price refused');
  eq((await call('POST /api/admin/market-products', { as: A, body: { name: 'x', sizes: Array.from({ length: 13 }, (_, i) => ({ label: 's' + i, price: 1 })) } })).status, 400, 'at most 12 sizes');
  const tom = (await add({ name: 'طماطم', category: 'خضار', description: 'طماطم بلدي طازة من المزرعة', sizes: [{ label: 'ربع كيلو', price: 8 }, { label: 'نص كيلو', price: 15 }, { label: 'كيلو', price: 28 }, { label: 'شوال', price: null }] })).product;
  eq(tom.sizes.map(z => z.label), ['ربع كيلو', 'نص كيلو', 'كيلو', 'شوال'], 'sizes kept in order');
  eq(tom.price, 8, 'the product shows the cheapest priced size ("من 8")'); eq(tom.description, 'طماطم بلدي طازة من المزرعة', 'details kept');
  const milk = (await add({ name: 'لبن', price: 35 })).product;
  eq([milk.sizes, milk.price, milk.description], [[], 35, ''], 'a plain product is unchanged');
  eq((await call('PATCH /api/admin/market-products/:id', { as: A, params: { id: milk.id }, body: { sizes: [{ label: 'لتر', price: 35 }, { label: 'نص لتر', price: 20 }], description: 'لبن كامل الدسم' } })).json.product.price, 20, 'turning a product into a sized one: the price follows the cheapest size');
  eq((await call('PATCH /api/admin/market-products/:id', { as: A, params: { id: milk.id }, body: { sizes: [], price: 33 } })).json.product.sizes, [], 'back to one price');
  await call('PATCH /api/admin/market-products/:id', { as: A, params: { id: milk.id }, body: { sizes: [{ label: 'لتر', price: 35 }, { label: 'نص لتر', price: 20 }] } });
  // ---- the customer sees them
  const cat = (await call('GET /api/market-products', { as: C })).json.products;
  eq(cat.find(p => p.name === 'طماطم').sizes.map(z => z.salePrice), [8, 15, 28, null], 'catalogue carries the sizes and their prices');
  // ---- ordering
  const body = { address: 'شارع التحرير 12 أبيس', phone: '01012345678' };
  const order = async lines => call('POST /api/orders/market', { as: C, body: { ...body, lines }, table: oroutes });
  eq((await order([{ productId: String(tom.id), qty: 1 }])).status, 400, 'a sized product needs a size');
  eq((await order([{ productId: String(tom.id), qty: 1, size: 'طن' }])).status, 400, 'an unknown size is refused');
  const o1 = await order([{ productId: String(tom.id), qty: 2, size: 'نص كيلو' }, { productId: String(milk.id), qty: 1, size: 'لتر' }, { productId: String(tom.id), qty: 1, size: 'شوال' }]);
  eq(o1.status, 201, 'sized order accepted: ' + JSON.stringify(o1.json).slice(0, 160));
  const d = (await q("SELECT data FROM orders WHERE customer_user_id=$1 ORDER BY id DESC LIMIT 1", [cId])).rows[0].data;
  eq(d.items.map(i => i.name), ['طماطم — نص كيلو', 'لبن — لتر', 'طماطم — شوال'], 'the courier sees the product and its size');
  eq(d.items.map(i => i.price), [15, 35, null], 'prices come from the server per size; no price = the courier prices it');
  eq(d.marketBase, 65, '2 x 15 + 35'); ok(/سعّره يا مندوب/.test(d.customText) && /نص كيلو/.test(d.customText), 'the text for the courier carries the sizes');
  eq(d.items[0].size, 'نص كيلو', 'size kept on the line');
  // a price the app claims is never trusted
  const o2 = await order([{ productId: String(tom.id), qty: 1, size: 'كيلو', price: 1 }]);
  eq((await q("SELECT data FROM orders WHERE customer_user_id=$1 ORDER BY id DESC LIMIT 1", [cId])).rows[0].data.items[0].price, 28, 'client price ignored');
  // a discount applies to every priced size
  await call('PATCH /api/admin/market-products/:id', { as: A, params: { id: tom.id }, body: { discountPct: 10 } });
  const c2 = (await call('GET /api/market-products', { as: C })).json.products.find(p => p.name === 'طماطم');
  eq(c2.sizes.map(z => z.salePrice), [7.2, 13.5, 25.2, null], 'discount on every priced size'); ok(c2.onOffer && c2.salePrice === 7.2, 'product shows "from" sale price');
  await order([{ productId: String(tom.id), qty: 1, size: 'نص كيلو' }]);
  const d3 = (await q("SELECT data FROM orders WHERE customer_user_id=$1 ORDER BY id DESC LIMIT 1", [cId])).rows[0].data.items[0];
  eq([d3.price, d3.was], [13.5, 15], 'the order is charged the discounted size price and keeps the old one');
  // a plain product ignores a stray size
  await order([{ productId: String(milk.id), qty: 1, size: 'نص لتر' }]);
  console.log(`marketsizes: ${pass} pass, ${bad} fail`); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
