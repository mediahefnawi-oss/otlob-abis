process.env.NO_SWEEP = '1';
const { Pool } = require('./shim');
const G = require('../src/group.js'), M = require('../src/market.js'), extrasLib = require('../src/extras.js');
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
  G.register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib });
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
  const [aId, mId, sId, hId, poId] = [await u('admin', 'admin'), await u('محمود', 'customer'), await u('ساره', 'customer'), await u('أحمد', 'customer'), await u('محل', 'provider')];
  const A = { sub: String(aId), role: 'admin' }, Mh = { sub: String(mId), role: 'customer' }, Sa = { sub: String(sId), role: 'customer' }, Ah = { sub: String(hId), role: 'customer' };
  const shop = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'supermarket','الأمل','01000000000','active',TRUE) RETURNING id", [poId])).rows[0].id;
  const other = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'supermarket','تاني','01000000000','active',TRUE) RETURNING id", [poId])).rows[0].id;
  const pr = async (prov, n, price, av = true) => (await q('INSERT INTO products(provider_id,name,price,available) VALUES($1,$2,$3,$4) RETURNING id', [prov, n, price, av])).rows[0].id;
  const juice = await pr(shop, 'عصير', 15), rice = await pr(shop, 'أرز', 40), yog = await pr(shop, 'زبادي', 35), off = await pr(shop, 'نفد', 5, false), foreign = await pr(other, 'غريب', 9);

  // ---- group order
  await feat('groupOrder', false);
  eq((await call('POST /api/group-carts', { as: Mh, body: { providerId: shop } })).status, 404, 'closed while OFF');
  await feat('groupOrder', true);
  eq((await call('POST /api/group-carts', { as: A, body: { providerId: shop } })).status, 403, 'only customers');
  const c1 = await call('POST /api/group-carts', { as: Mh, body: { providerId: shop } });
  ok(c1.status === 201 && /^[A-Za-z0-9]{8}$/.test(c1.json.code), 'cart opened: ' + JSON.stringify(c1.json));
  const code = c1.json.code;
  eq((await call('POST /api/group-carts', { as: Mh, body: { providerId: shop } })).json, { code, reused: true }, 'same open cart reused');
  const add = (as, product, qty) => call('PUT /api/group-carts/:code/items', { as, params: { code }, body: { productId: product, qty } });
  eq((await add(Mh, juice, 2)).status, 200, 'owner adds');
  eq((await add(Sa, yog, 1)).status, 200, 'friend adds from her own account');
  eq((await add(Ah, rice, 1)).status, 200, 'second friend adds');
  eq((await add(Sa, foreign, 1)).status, 404, 'product of another shop refused');
  eq((await add(Sa, off, 1)).status, 409, 'unavailable product refused');
  eq((await add(Sa, yog, 99)).status, 400, 'bad qty');
  eq((await add(Sa, yog, 3)).status, 200, 'friend changes her qty');
  const v = (await call('GET /api/group-carts/:code', { as: Ah, params: { code } })).json.cart;
  eq(v.members.map(m => [m.name, m.subtotal]), [['محمود', 30], ['ساره', 105], ['أحمد', 40]], 'each person with his own subtotal');
  eq(v.total, 175, 'total'); ok(v.lines === undefined, 'a friend does not get the checkout lines');
  const vo = (await call('GET /api/group-carts/:code', { as: Mh, params: { code } })).json.cart;
  ok(vo.isOwner && vo.lines.length === 3, 'owner gets the merged lines');
  const sIt = vo.members[1].items[0];
  eq((await call('DELETE /api/group-carts/:code/items/:itemId', { as: Ah, params: { code, itemId: sIt.id } })).status, 403, 'a friend cannot remove another friend item');
  eq((await call('DELETE /api/group-carts/:code/items/:itemId', { as: Mh, params: { code, itemId: sIt.id } })).status, 200, 'the owner removes any item');
  eq((await call('GET /api/group-carts/:code', { as: Mh, params: { code } })).json.cart.total, 70, 'total after the removal');
  eq((await call('POST /api/group-carts/:code/done', { as: Sa, params: { code } })).status, 403, 'a friend cannot confirm');
  eq((await call('POST /api/group-carts/:code/done', { as: Mh, params: { code } })).status, 200, 'owner confirms');
  eq((await add(Sa, juice, 1)).status, 410, 'a confirmed cart is closed to new items');
  eq((await call('GET /api/group-carts/:code', { as: Sa, params: { code: 'nope1234' } })).status, 404, 'unknown code');
  // expiry
  const c2 = (await call('POST /api/group-carts', { as: Mh, body: { providerId: shop } })).json.code;
  await q("UPDATE group_carts SET expires_at = NOW() - INTERVAL '1 minute' WHERE code=$1", [c2]);
  eq((await call('PUT /api/group-carts/:code/items', { as: Sa, params: { code: c2 }, body: { productId: juice, qty: 1 } })).status, 410, 'expired cart is closed');

  // ---- market: owner's catalogue
  await feat('market', false);
  const mp = (await call('POST /api/admin/market-products', { as: A, body: { name: 'حليب', price: 30, category: 'ألبان', emoji: '🥛' } })).json.product;
  ok(mp && mp.id && mp.price === 30, 'market product added (owner works while OFF)');
  const mp2 = (await call('POST /api/admin/market-products', { as: A, body: { name: 'مياه', price: 5 } })).json.product;
  eq((await call('POST /api/admin/market-products', { as: Mh, body: { name: 'x', price: 1 } })).status, 403, 'customer cannot add');
  eq((await call('POST /api/admin/market-products', { as: A, body: { name: 'x', price: -1 } })).status, 400, 'bad price');
  eq((await call('GET /api/market-products', { as: Mh })).status, 404, 'catalogue closed while OFF');
  await feat('market', true);
  await call('PATCH /api/admin/market-products/:id', { as: A, params: { id: mp2.id }, body: { available: false } });
  const cat = (await call('GET /api/market-products', { as: Mh })).json;
  eq(cat.products.map(p => p.name), ['حليب'], 'stopped product hidden');
  eq((await call('PATCH /api/admin/market-settings', { as: A, body: { fee: 20 } })).status, 200, 'fee changed');

  // ---- market: the order goes straight to couriers
  const body = { address: 'شارع التحرير 12 أبيس', phone: '01012345678', lines: [{ productId: String(mp.id), qty: 2 }] };
  const oc = await call('POST /api/orders/market', { as: Mh, body, table: oroutes });
  ok(oc.status === 201, 'market order created: ' + JSON.stringify(oc.json).slice(0, 200));
  const od = (await q("SELECT status, total, provider_id, data FROM orders WHERE customer_user_id=$1 ORDER BY id DESC LIMIT 1", [mId])).rows[0];
  ok(od && od.provider_id === null && od.status === 'accepted', 'no shop in between: straight to the couriers');
  eq(Number(od.total), 0, 'no fixed fee: the total waits for the courier'); eq(od.data.items[0].name, 'حليب', 'priced by the server');
  ok(od.data.providerType === 'custom' && od.data.market === true && od.data.errandQuote === 'open', 'handled like an errand: the courier quotes, the customer approves');
  eq(od.data.marketBase, 60, 'the priced products (2 x 30) are the minimum'); eq(od.data.deliveryFee, 0, 'no delivery fee set by us');
  // a product with no price: the courier prices it
  const mp3 = (await call('POST /api/admin/market-products', { as: A, body: { name: 'طماطم', price: null } })).json.product;
  ok(mp3 && mp3.price === null, 'product without a price accepted');
  const mp4 = (await call('POST /api/admin/market-products', { as: A, body: { name: 'خيار', price: '' } })).json.product;
  ok(mp4 && mp4.price === null, 'empty price = no price');
  const oc2 = await call('POST /api/orders/market', { as: Mh, body: { ...body, lines: [{ productId: String(mp.id), qty: 1 }, { productId: String(mp3.id), qty: 3 }] }, table: oroutes });
  eq(oc2.status, 201, 'mixed priced + unpriced order accepted: ' + JSON.stringify(oc2.json).slice(0, 150));
  const od2 = (await q("SELECT data FROM orders WHERE customer_user_id=$1 ORDER BY id DESC LIMIT 1", [mId])).rows[0].data;
  eq(od2.marketBase, 30, 'only the priced product counts as the base'); eq(od2.items[1].price, null, 'unpriced item has no price'); ok(/سعّره يا مندوب/.test(od2.customText), 'the courier sees which items to price');
  eq((await call('POST /api/orders/market', { as: Mh, body: { ...body, lines: [{ productId: String(mp2.id), qty: 1 }] }, table: oroutes })).status, 409, 'stopped product refused');
  eq((await call('POST /api/orders/market', { as: Mh, body: { ...body, lines: [] }, table: oroutes })).status, 400, 'empty cart refused');
  await feat('market', false);
  eq((await call('POST /api/orders/market', { as: Mh, body, table: oroutes })).status, 404, 'closed while OFF');

  // ---- look of the new services
  eq((await call('PATCH /api/admin/svc-meta/:key', { as: Mh, params: { key: 'market' }, body: { sub: 'x' } })).status, 403, 'customer cannot edit the look');
  eq((await call('PATCH /api/admin/svc-meta/:key', { as: A, params: { key: 'nope' }, body: { sub: 'x' } })).status, 404, 'unknown service');
  eq((await call('PATCH /api/admin/svc-meta/:key', { as: A, params: { key: 'market' }, body: { sub: 'كل احتياجاتك لحد بابك' } })).status, 200, 'description saved');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  eq((await call('PUT /api/admin/svc-image/:key/:kind', { as: A, params: { key: 'market', kind: 'icon' }, body: { image: png } })).status, 200, 'icon saved');
  eq((await call('PUT /api/admin/svc-image/:key/:kind', { as: A, params: { key: 'market', kind: 'cover' }, body: { image: png } })).status, 200, 'cover saved');
  eq((await call('PUT /api/admin/svc-image/:key/:kind', { as: A, params: { key: 'market', kind: 'weird' }, body: { image: png } })).status, 404, 'bad kind');
  eq((await call('PUT /api/admin/svc-image/:key/:kind', { as: A, params: { key: 'rides', kind: 'icon' }, body: { image: 'data:text/html;base64,AAAA' } })).status, 400, 'non-image refused');
  const meta = (await call('GET /api/svc-meta')).json;
  ok(meta.market.sub === 'كل احتياجاتك لحد بابك' && meta.market.icon > 0 && meta.market.cover > 0 && meta.rides.icon === 0, 'meta: ' + JSON.stringify(meta));
  const img = await call('GET /api/svc-image/:key/:kind', { params: { key: 'market', kind: 'cover' } });
  ok(img.sent && img.headers['Content-Type'] === 'image/png', 'cover served');
  eq((await call('DELETE /api/admin/svc-image/:key/:kind', { as: A, params: { key: 'market', kind: 'icon' } })).status, 200, 'icon removed');
  eq((await call('GET /api/svc-meta')).json.market.icon, 0, 'removed');
  console.log(`group+market: ${pass} passed, ${bad} failed`);
  await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
