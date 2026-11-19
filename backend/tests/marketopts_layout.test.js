process.env.NO_SWEEP = '1';
const { Pool } = require('./shim');
const H = require('./h26');
const M = require('../src/market.js'), L = require('../src/homelayout.js'), extrasLib = require('../src/extras.js');
const { ok, eq, done } = H.counters();
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const { app, asyncRoute, positiveId, auth, roles, call, routes } = H;
  await q('TRUNCATE market_products RESTART IDENTITY'); await q('UPDATE app_settings SET market_fee=15 WHERE id=1');
  let cleared = 0;
  M.register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib });
  L.register(app, { pool, auth, roles, asyncRoute, clearCaches: () => { cleared++; } });
  const oroutes = {}; const oapp = { use() {} };
  for (const m of ['get', 'post', 'patch', 'put', 'delete']) oapp[m] = (p, ...c) => { oroutes[`${m.toUpperCase()} ${p}`] = c; };
  require('../src/orders.js')(oapp, { pool, auth, authAny: auth, roles, asyncRoute, positiveId, maintenanceState: async () => ({ enabled: true }), loadSettings: async () => ({}), cleanUser: x => x, pushToUsers: async () => {} });
  const mk = async (n, role) => Number((await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',TRUE) RETURNING id", [n, H.phone(), role])).rows[0].id);
  const aId = await mk('admin', 'admin'), cId = await mk('عميل', 'customer');
  const A = { sub: String(aId), role: 'admin' }, C = { sub: String(cId), role: 'customer' };
  await q("UPDATE app_settings SET features = COALESCE(features,'{}'::jsonb) || '{\"market\":true}'::jsonb WHERE id=1");
  require('../src/gates.js').invalidate(); await q('DELETE FROM order_gates');

  /* ================= product options ================= */
  eq(M.cleanOptions([{ label: 'ناضجة' }, { label: 'ناضجة' }]), null, 'option names are unique');
  eq(M.cleanOptions([{ label: '' }]), null, 'an option needs a name'); eq(M.cleanOptions([{ label: 'x', price: -1 }]), null, 'no negative price');
  eq(M.cleanOptions(Array.from({ length: 13 }, (_, i) => ({ label: 'o' + i }))), null, 'at most 12'); eq(M.cleanOptions([{ label: 'x'.repeat(31) }]), null, 'name length');
  eq(M.cleanOptions([{ label: 'ناضجة' }, { label: 'تنضيف', price: '3' }]), [{ label: 'ناضجة', price: 0 }, { label: 'تنضيف', price: 3 }], 'free by default, prices as numbers');
  const add = async b => (await call('POST /api/admin/market-products', { as: A, body: b })).json;
  eq((await call('POST /api/admin/market-products', { as: A, body: { name: 'x', price: 1, options: [{ label: '' }] } })).status, 400, 'a bad option refuses the product');
  const tom = (await add({ name: 'طماطم', category: 'خضار', price: 20, sizes: [{ label: 'نص كيلو', price: 12 }, { label: 'كيلو', price: 20 }], options: [{ label: 'ناضجة', price: 0 }, { label: 'تنضيف وتقطيع', price: 3 }] })).product;
  eq(tom.options, [{ label: 'ناضجة', price: 0 }, { label: 'تنضيف وتقطيع', price: 3 }], 'options saved and returned'); eq(tom.soldOut, false, 'not sold out');
  const plain = (await add({ name: 'خيار', price: 10 })).product; eq(plain.options, [], 'a plain product has none');
  eq((await call('PATCH /api/admin/market-products/:id', { as: A, params: { id: plain.id }, body: { options: [{ label: 'مقشر', price: 2 }] } })).json.product.options, [{ label: 'مقشر', price: 2 }], 'options can be added later');
  eq((await call('PATCH /api/admin/market-products/:id', { as: A, params: { id: plain.id }, body: { name: 'خيار بلدي', category: 'خضار طازة', description: 'جديد' } })).json.product.name, 'خيار بلدي', 'the name is editable');
  eq((await call('PATCH /api/admin/market-products/:id', { as: A, params: { id: plain.id }, body: { options: [] } })).json.product.options, [], 'and removable');
  await call('PATCH /api/admin/market-products/:id', { as: A, params: { id: plain.id }, body: { options: [{ label: 'مقشر', price: 2 }] } });
  const cat = (await call('GET /api/market-products', { as: C })).json.products; eq(cat.find(p => p.name === 'طماطم').options.length, 2, 'the customer catalogue carries the options');
  /* ordering with options */
  const body = { address: 'شارع التحرير 12 أبيس', phone: '01012345678' };
  const order = lines => call('POST /api/orders/market', { as: C, body: { ...body, lines }, table: oroutes });
  const last = async () => (await q("SELECT data FROM orders WHERE customer_user_id=$1 ORDER BY id DESC LIMIT 1", [cId])).rows[0].data;
  let o = await order([{ productId: String(tom.id), qty: 2, size: 'كيلو', opts: ['ناضجة', 'تنضيف وتقطيع'] }]); eq(o.status, 201, 'an order with options is accepted: ' + JSON.stringify(o.json).slice(0, 100));
  let d = await last(); eq(d.items[0].price, 23, 'price = size 20 + option 3, set by the server'); eq(d.items[0].name, 'طماطم — كيلو (ناضجة، تنضيف وتقطيع)', 'the courier reads the choices in the name');
  eq(d.items[0].opts, ['ناضجة', 'تنضيف وتقطيع'], 'and as a list'); eq(d.marketBase, 46, '2 x 23');
  o = await order([{ productId: String(tom.id), qty: 1, size: 'كيلو', opts: ['ناضجة'] }, { productId: String(tom.id), qty: 1, size: 'كيلو', opts: ['تنضيف وتقطيع'] }]); eq(o.status, 201, 'the same product with different choices = two lines');
  d = await last(); eq(d.items.map(i => i.price), [20, 23], 'each line priced on its own'); eq(d.marketBase, 43, 'total 20 + 23');
  eq((await order([{ productId: String(tom.id), qty: 1, size: 'كيلو', opts: ['شيء غير موجود'] }])).status, 400, 'a choice the owner never defined is refused');
  o = await order([{ productId: String(tom.id), qty: 1, size: 'كيلو', opts: ['ناضجة', 'ناضجة'] }]); eq((await last()).items[0].price, 20, 'a repeated choice counts once');
  await order([{ productId: String(plain.id), qty: 1, opts: ['مقشر'] }]); eq((await last()).items[0].price, 12, 'a one-price product with a choice: 10 + 2');
  // a discount applies to the product, not to the extra
  await call('PATCH /api/admin/market-products/:id', { as: A, params: { id: tom.id }, body: { discountPct: 10 } });
  await order([{ productId: String(tom.id), qty: 1, size: 'كيلو', opts: ['تنضيف وتقطيع'] }]); d = await last(); eq([d.items[0].price, d.items[0].was], [21, 23], '20 - 10% = 18, + 3 = 21 (was 23)');
  // no price: the courier prices it, the choices are still written
  const free = (await add({ name: 'جبنة', options: [{ label: 'مقطعة', price: 0 }] })).product;
  await order([{ productId: String(free.id), qty: 1, opts: ['مقطعة'] }]); d = await last(); eq([d.items[0].price, d.items[0].name], [null, 'جبنة (مقطعة)'], 'an unpriced product keeps the choice for the courier');
  /* sold out / hidden */
  await call('PATCH /api/admin/market-products/:id', { as: A, params: { id: tom.id }, body: { soldOut: true } });
  const c3 = (await call('GET /api/market-products', { as: C })).json.products.find(p => p.name === 'طماطم'); eq(c3.soldOut, true, 'sold out stays in the list, marked');
  const so = await order([{ productId: String(tom.id), qty: 1, size: 'كيلو' }]); eq([so.status, /نفد/.test(so.json.error)], [409, true], 'but cannot be ordered');
  await call('PATCH /api/admin/market-products/:id', { as: A, params: { id: tom.id }, body: { soldOut: false, available: false } });
  eq((await call('GET /api/market-products', { as: C })).json.products.some(p => p.name === 'طماطم'), false, 'hidden leaves the list');
  eq((await order([{ productId: String(tom.id), qty: 1, size: 'كيلو' }])).status, 409, 'and cannot be ordered either');
  // the owner closed the market: nothing new
  await q("INSERT INTO order_gates(key, closed, message) VALUES('market', TRUE, 'الماركت واقف') ON CONFLICT (key) DO UPDATE SET closed=TRUE, message='الماركت واقف'"); require('../src/gates.js').invalidate();
  const cl = await order([{ productId: String(plain.id), qty: 1 }]); eq([cl.status, cl.json.error], [409, 'الماركت واقف'], 'a closed market refuses new orders');
  await q('DELETE FROM order_gates'); require('../src/gates.js').invalidate();
  eq((await order([{ productId: String(plain.id), qty: 1 }])).status, 201, 'and takes them again when reopened');
  await q("INSERT INTO order_gates(key, closed) VALUES('*', TRUE) ON CONFLICT (key) DO UPDATE SET closed=TRUE"); require('../src/gates.js').invalidate();
  eq((await order([{ productId: String(plain.id), qty: 1 }])).status, 409, 'closing the whole app refuses too'); await q('DELETE FROM order_gates'); require('../src/gates.js').invalidate();

  /* ================= home layout ================= */
  eq(L.cleanLayout(null), null, 'nothing'); eq(L.cleanLayout([]), null, 'an array is not a layout'); eq(L.cleanLayout({}), {}, 'an empty layout = the original home');
  eq(L.cleanLayout({ order: ['top', 'ads', 'ads', 'bogus', 'ban:abcd1234', 'ban:../x'] }), { order: ['top', 'ads', 'ban:abcd1234'] }, 'order: known ids only, no duplicates');
  eq(L.cleanLayout({ view: 'g3' }), { view: 'g3' }, 'service view: 3 per row'); eq(L.cleanLayout({ view: 'zig' }), null, 'an unknown view is refused');
  eq(L.cleanLayout({ order: 'x' }), null, 'order must be a list'); eq(L.cleanLayout({ hidden: ['rides', 'zzz'] }), { hidden: ['rides'] }, 'hidden: known ids only');
  eq(L.cleanLayout({ mode: 'row' }), { mode: 'row' }, 'row mode'); eq(L.cleanLayout({ mode: 'diagonal' }), null, 'unknown mode');
  eq(L.cleanLayout({ svc: { pharmacy: { shape: 'wide' }, store: { shape: 'round' } } }), { svc: { pharmacy: { shape: 'wide' }, store: { shape: 'round' } } }, 'service shapes');
  eq(L.cleanLayout({ svc: { pharmacy: { shape: 'triangle' } } }), null, 'unknown shape'); eq(L.cleanLayout({ svc: { 'bad key!': { shape: 'wide' } } }), null, 'bad service key');
  eq(L.cleanLayout({ svc: { a: { shape: 'wide', color: '<script>' } } }), { svc: { a: { shape: 'wide' } } }, 'only the shape is kept');
  eq((await call('PUT /api/admin/home-layout', { as: C, body: { layout: {} } })).status, 403, 'only the owner designs the home');
  eq((await call('PUT /api/admin/home-layout', { as: A, body: { layout: { mode: 'x' } } })).status, 400, 'a bad layout is refused');
  const saved = await call('PUT /api/admin/home-layout', { as: A, body: { layout: { order: ['services', 'ads'], hidden: ['top'], mode: 'row', svc: { clinic: { shape: 'rect' } } } } });
  eq([saved.status, saved.json.layout.order, saved.json.layout.mode], [200, ['services', 'ads'], 'row'], 'saved'); ok(cleared >= 1, 'the public settings cache is cleared so customers see it');
  eq((await call('GET /api/admin/home-layout', { as: A })).json.layout.svc.clinic.shape, 'rect', 'and read back');
  await call('PUT /api/admin/home-layout', { as: A, body: { layout: {} } }); eq((await call('GET /api/admin/home-layout', { as: A })).json.layout, {}, 'reset = original home');
  const bad = done('market options + layout'); await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
