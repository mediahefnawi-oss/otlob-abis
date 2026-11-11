// "شير اللقمة": neighbours share one delivery trip
const { Pool } = require('./shim');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const pass1 = (req, res, next) => next();
const pushes = [];
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const deps = { pool, auth: pass1, authAny: pass1, roles: () => pass1, asyncRoute, positiveId };
  require('../src/orders.js')(app, { ...deps, maintenanceState: async () => ({ enabled: true }), loadSettings: async () => ({}), cleanUser: x => x, pushToUsers: async (ids, p) => { pushes.push({ ids: ids.map(String), p }); } });
  require('../src/extras.js').register(app, { ...deps, services: require('../src/services.js'), clearCaches() {} });
  const call = (key, as, body, params, query) => new Promise(resolve => {
    const res = { set() { return this; }, status(c) { this.c = c; return this; }, json(j) { resolve({ status: this.c || 200, json: j }); return this; } };
    const chain = routes[key];
    chain[chain.length - 1]({ auth: as, params: params || {}, body: body || {}, query: query || {} }, res, e => resolve({ status: e.status || e.http || 500, json: { error: e.message } }));
  });
  const eq = (a, b, m) => ok(a === b, `${m}: got ${a}, want ${b}`);
  await q("UPDATE app_settings SET features='{}'::jsonb, auto_assign=FALSE WHERE id=1");
  await q("DELETE FROM invoices"); await q("DELETE FROM orders");
  const reg = (await q("INSERT INTO regions(name, delivery_fee) VALUES('منطقة شير'||floor(random()*1e6), 20) RETURNING id")).rows[0].id;
  const mk = async (n, role, region) => (await q("INSERT INTO users(name, phone, password_hash, role, status, region_id) VALUES($1,$2,'x',$3,'active',$4) RETURNING id", [n, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role, region || null])).rows[0].id;
  const adm = await mk('مالك', 'admin'), own = await mk('صاحب', 'provider', reg), cour = await mk('مندوب', 'courier', reg), cour2 = await mk('مندوب2', 'courier', reg);
  await q("UPDATE users SET available=TRUE WHERE id IN ($1,$2)", [cour, cour2]);
  const cs = []; for (let i = 0; i < 4; i++) cs.push(await mk('جار' + i, 'customer', reg));
  const asC = i => ({ sub: String(cs[i]), role: 'customer', status: 'active' });
  const A = { sub: String(adm), role: 'admin', status: 'active' }, P = { sub: String(own), role: 'provider', status: 'active' };
  const K = { sub: String(cour), role: 'courier', status: 'active' }, K2 = { sub: String(cour2), role: 'courier', status: 'active' };
  const shop = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open,delivery_fee) VALUES($1,'restaurant','مطعم','01000000000','active',TRUE,20) RETURNING id", [own])).rows[0].id;
  const shop2 = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open,delivery_fee) VALUES($1,'restaurant','مطعم٢','01000000001','active',TRUE,20) RETURNING id", [own])).rows[0].id;
  await q("INSERT INTO route_prices(from_region_id,to_region_id,price) VALUES($1,$1,20) ON CONFLICT DO NOTHING", [reg]).catch(() => {});
  const prod = (await q("INSERT INTO products(provider_id,name,price) VALUES($1,'وجبة',100) RETURNING id", [shop])).rows[0].id;
  const prod2 = (await q("INSERT INTO products(provider_id,name,price) VALUES($1,'وجبة',100) RETURNING id", [shop2])).rows[0].id;
  const base = (pid = prod) => ({ name: 'عميل', phone: '01012345678', address: 'شارع 5 عمارة 3 الدور 2', notes: '', lines: [{ productId: String(pid), qty: 1 }] });
  const row = async id => (await q('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
  let r;
  r = await call('POST /api/orders/checkout', asC(0), base()); eq(r.status, 201, 'baseline checkout works');
  const fee0 = r.json.orders[0].deliveryFee; ok(fee0 > 0, 'delivery fee is charged: ' + fee0);

  console.log('A) switch OFF');
  r = await call('POST /api/orders/checkout', asC(0), { ...base(), pool: true }); eq(r.status, 201, 'order with pool:true still works');
  ok(!r.json.orders[0].pool, 'OFF: no pool data');
  eq((await call('GET /api/pool/suggest', asC(1), {}, {}, { providerId: String(shop) })).json.on, false, 'suggest says off');
  await q("DELETE FROM invoices"); await q("DELETE FROM orders");
  await call('PATCH /api/admin/features', A, { key: 'pool', on: true });

  console.log('B) first order waits, second joins, fee shared');
  r = await call('POST /api/orders/checkout', asC(0), { ...base(), pool: true }); eq(r.status, 201, 'first pooled order');
  const o1 = r.json.orders[0]; eq(o1.pool && o1.pool.size, 1, 'alone: size 1'); eq(o1.deliveryFee, fee0, 'alone pays the full fee');
  r = await call('GET /api/pool/suggest', asC(1), {}, {}, { providerId: String(shop) }); eq(r.json.waiting, 1, 'neighbour sees 1 waiting');
  eq((await call('GET /api/pool/suggest', asC(0), {}, {}, { providerId: String(shop) })).json.waiting, 0, 'own order is not suggested to himself');
  eq((await call('GET /api/pool/suggest', asC(1), {}, {}, { providerId: String(shop2) })).json.waiting, 0, 'other shop: nothing');
  pushes.length = 0;
  r = await call('POST /api/orders/checkout', asC(1), { ...base(), pool: true }); eq(r.status, 201, 'second joins');
  const o2 = r.json.orders[0]; eq(o2.pool.size, 2, 'size 2'); eq(o2.deliveryFee, Math.ceil(fee0 / 2), 'half fee each');
  const a1 = await row(o1.id); eq(Number(a1.data.deliveryFee), Math.ceil(fee0 / 2), 'first one re-priced');
  eq(Number(a1.total), 100 + Math.ceil(fee0 / 2), 'first total follows');
  const inv = (await q('SELECT * FROM invoices WHERE id=$1', [a1.data.invoiceId])).rows[0];
  eq(Number(inv.total), 100 + Math.ceil(fee0 / 2), 'first invoice total follows'); eq(Number(inv.data.parts[0].deliveryFee), Math.ceil(fee0 / 2), 'invoice part follows');
  ok(pushes.some(p => p.ids.includes(String(cs[0])) && /قرّب/.test((p.p || {}).title || '')), 'first member told a neighbour joined');
  ok(!pushes.some(p => JSON.stringify(p).includes('جار1')), 'and no name is leaked');
  eq(a1.data.pool.groupId, (await row(o2.id)).data.pool.groupId, 'same group id');

  console.log('C) third joins, fourth does not');
  r = await call('POST /api/orders/checkout', asC(2), { ...base(), pool: true }); eq(r.json.orders[0].pool.size, 3, 'size 3'); eq(r.json.orders[0].deliveryFee, Math.ceil(fee0 / 3), 'third each');
  r = await call('POST /api/orders/checkout', asC(3), { ...base(), pool: true }); eq(r.json.orders[0].pool.size, 1, 'a 4th starts a new group'); eq(r.json.orders[0].deliveryFee, fee0, 'pays full');
  const o4 = r.json.orders[0];

  console.log('D) member cancels -> the rest re-priced (no courier yet)');
  const g3 = (await row(o1.id)).data.pool.groupId;
  const third = (await q("SELECT id FROM orders WHERE data->'pool'->>'groupId'=$1 AND customer_user_id=$2", [g3, cs[2]])).rows[0].id;
  r = await call('POST /api/orders/:id/action', asC(2), { action: 'cancel' }, { id: String(third) }); eq(r.status, 200, 'cancel works: ' + JSON.stringify(r.json).slice(0, 80));
  eq(Number((await row(o1.id)).data.deliveryFee), Math.ceil(fee0 / 2), 'back to half fee for the remaining two');

  console.log('E) shop accepts both, ONE courier takes both');
  await call('POST /api/orders/:id/action', P, { action: 'accept' }, { id: String(o1.id) });
  r = await call('POST /api/orders/:id/action', K, { action: 'courier_accept' }, { id: String(o1.id) }); eq(r.status, 200, 'courier accepts the first: ' + JSON.stringify(r.json).slice(0, 80));
  ok((await row(o2.id)).courier_user_id == null, 'second still pending at shop: no courier yet');
  await call('POST /api/orders/:id/action', P, { action: 'accept' }, { id: String(o2.id) });
  const b2 = await row(o2.id); eq(String(b2.courier_user_id), String(cour), 'when the shop accepts the second, it gets the SAME courier');
  eq(b2.data.courierName, 'مندوب', 'with his name on it');
  r = await call('POST /api/orders/:id/action', K2, { action: 'courier_accept' }, { id: String(o2.id) }); eq(r.status, 409, 'another courier cannot take it');
  eq(Number((await row(o2.id)).data.deliveryFee), Math.ceil(fee0 / 2), 'prices frozen');

  console.log('F) no sharing across other shops / scheduled / without opt-in');
  await q("DELETE FROM invoices"); await q("DELETE FROM orders");
  await call('POST /api/orders/checkout', asC(0), { ...base(), pool: true });
  r = await call('POST /api/orders/checkout', asC(1), { ...base(prod2), pool: true }); eq(r.json.orders[0].pool.size, 1, 'different shop: no group');
  r = await call('POST /api/orders/checkout', asC(2), base()); ok(!r.json.orders[0].pool, 'no opt-in: never grouped');
  r = await call('POST /api/orders/checkout', asC(3), { ...base(), pool: true }); eq(r.json.orders[0].pool.size, 2, 'opt-in neighbour joins the waiting one');
  await q("UPDATE orders SET created_at = NOW() - INTERVAL '30 minutes'");
  r = await call('POST /api/orders/checkout', asC(2), { ...base(), pool: true }); eq(r.json.orders[0].pool.size, 1, 'old orders (past the window) are not joined');
  r = await call('POST /api/orders/checkout', asC(0), { ...base(), pool: true }); eq(r.json.orders[0].pool.size, 2, 'same customer cannot pool with himself, but joins another waiting one');
  const same = (await q("SELECT COUNT(DISTINCT customer_user_id)::int AS n, COUNT(*)::int AS m FROM orders WHERE data->'pool'->>'groupId' = $1", [r.json.orders[0].pool ? (await row(r.json.orders[0].id)).data.pool.groupId : ''])).rows[0];
  eq(same.n, same.m, 'a group never holds two orders of the same customer');

  console.log(bad ? `FAILED ${bad}` : 'ALL OK', 'pass=' + pass);
  await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
