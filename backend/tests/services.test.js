const { Pool } = require('./shim');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const pass1 = (req, res, next) => next();
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const deps = { pool, auth: pass1, authAny: pass1, roles: () => pass1, asyncRoute, positiveId, maintenanceState: async () => ({ enabled: true }), loadSettings: async () => ({}), cleanUser: x => x, pushToUsers: async () => {} };
  require('../src/orders.js')(app, deps);
  require('../src/commissions.js')(app, deps);
  const services = require('../src/services.js');
  services.register(app, deps);
  const call = (key, as, body, params) => new Promise((resolve, reject) => {
    const res = { set() { return this; }, status(c) { this.c = c; return this; }, json(j) { resolve({ status: this.c || 200, json: j }); return this; }, send(x) { resolve({ status: this.c || 200, body: x }); }, end() { resolve({ status: this.c || 200 }); } };
    const chain = routes[key];
    chain[chain.length - 1]({ auth: as, params: params || {}, body: body || {}, query: {} }, res, e => resolve({ status: e.status || e.http || 500, json: { error: e.message } }));
  });
  await q('DELETE FROM service_types');
  const rg = (await q("INSERT INTO regions(name, delivery_fee) VALUES('منطقة خدمات'||random(), 0) RETURNING id")).rows[0].id;
  await q('INSERT INTO route_prices(from_region_id, to_region_id, price) VALUES($1,$1,10) ON CONFLICT DO NOTHING', [rg]);
  const mk = async (n, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status, region_id) VALUES($1,$2,'x',$3,'active',$4) RETURNING id", [n, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role, rg])).rows[0].id;
  const adm = await mk('مدير', 'admin'), cust = await mk('ع', 'customer'), cour = await mk('م', 'courier');
  const A = { sub: String(adm), role: 'admin' }, C = { sub: String(cust), role: 'customer', status: 'active' }, K = { sub: String(cour), role: 'courier', status: 'active' };
  const prov = async (type, name) => { const o = await mk(name, 'provider'); return (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,$2,$3,'01000000000','active',TRUE) RETURNING id", [o, type, name])).rows[0].id; };
  const rest = await prov('restaurant', 'مطعم'), sup = await prov('supermarket', 'سوبر'), maker = await prov('maker', 'صانع'), clinic = await prov('clinic', 'عيادة');
  const pr = (await q("INSERT INTO products(provider_id,name,price) VALUES($1,'وجبة',40) RETURNING id", [rest])).rows[0].id;
  const base = { name: 'عميل', phone: '01012345678', address: 'شارع 5 عمارة 3 الدور 2', notes: '' };

  // before any change: the six + errand come from the built-in list
  let r = await call('GET /api/services', null);
  ok(r.json.services.length === 7 && r.json.services.some(s => s.key === 'errand' && s.template === 'errand'), 'built-in list is served before any change: ' + (r.json.services || []).length);
  // the order paths still work for the original services
  r = await call('POST /api/orders/checkout', C, { ...base, lines: [{ productId: pr, qty: 1 }] });
  ok(r.status === 201, 'restaurant basket works: ' + JSON.stringify(r.json));
  r = await call('POST /api/orders/request', C, { ...base, providerId: sup, text: 'سكر وزيت' });
  ok(r.status === 201, 'supermarket written request works: ' + JSON.stringify(r.json));
  r = await call('POST /api/orders/request', C, { ...base, providerId: maker, text: 'تورتة' });
  ok(r.status === 201, 'maker written request works: ' + JSON.stringify(r.json));
  r = await call('POST /api/orders/request', C, { ...base, providerId: rest, text: 'عايز علبة عصير من السوبر' });
  ok(r.status === 400, 'a restaurant refuses written requests');
  r = await call('POST /api/orders/custom', C, { ...base, text: 'عايز دواء' });
    ok(r.status === 201, 'errand works');
  const errandId = (r.json.orders && r.json.orders[0] ? r.json.orders[0].id : r.json.order && r.json.order.id);
  await q("UPDATE users SET available=TRUE WHERE id=$1", [cour]);
  const acc = await call('POST /api/orders/:id/action', K, { action: 'courier_accept' }, { id: String(errandId) });
  ok(acc.status === 200, 'courier takes the errand: ' + JSON.stringify(acc.json).slice(0, 100));
  const rq = await call('POST /api/orders/:id/errand-quote', K, { subtotal: 100, fee: 20 }, { id: String(errandId) });
  ok(rq.status === 200 || rq.status === 201, 'courier prices the errand: ' + JSON.stringify(rq.json).slice(0, 100));

  // owner adds a new service (basket template)
  r = await call('POST /api/admin/services', A, { label: 'توصيل مياه', single: 'مورد مياه', emoji: '💧', template: 'cart', size: 'large', canProducts: true, showHome: true });
  ok(r.status === 201 && r.json.services.length === 8, 'new service added: ' + JSON.stringify(r.json).slice(0, 100));
  const key = r.json.key;
  const n = Number((await q('SELECT COUNT(*)::int AS n FROM service_types')).rows[0].n);
  ok(n === 8, 'the 7 built-ins were stored with the new one: ' + n);
  const water = await prov(key, 'مياه أبيس');
  const pw = (await q("INSERT INTO products(provider_id,name,price) VALUES($1,'جركن',25) RETURNING id", [water])).rows[0].id;
  r = await call('POST /api/orders/checkout', C, { ...base, lines: [{ productId: pw, qty: 2 }] });
  ok(r.status === 201 && r.json.orders[0].providerType === key, 'basket order from the new service works: ' + JSON.stringify(r.json).slice(0, 100));
  // rename / resize / order
  r = await call('PATCH /api/admin/services/:key', A, { label: 'المطاعم الجديدة', size: 'medium' }, { key: 'restaurant' });
  ok(r.status === 200 && r.json.services.find(s => s.key === 'restaurant').label === 'المطاعم الجديدة', 'rename works');
  r = await call('PATCH /api/admin/services/:key', A, { size: 'huge' }, { key: 'restaurant' });
  ok(r.status === 400, 'bad size refused');
  const order = r.status && (await call('GET /api/services', null)).json.services.map(s => s.key);
  const rev = [...order].reverse();
  r = await call('PUT /api/admin/services-order', A, { keys: rev });
  ok(r.status === 200 && r.json.services[0].key === rev[0], 'reorder works');
  r = await call('PUT /api/admin/services-order', A, { keys: ['nope'] });
  ok(r.status === 400, 'reorder with an unknown key refused');
  // stop a service: no more orders from it
  r = await call('PATCH /api/admin/services/:key', A, { active: false }, { key });
  ok(r.status === 200, 'stop service');
  r = await call('POST /api/orders/checkout', C, { ...base, lines: [{ productId: pw, qty: 1 }] });
  ok(r.status === 409, 'a stopped service refuses orders: ' + r.status + ' ' + JSON.stringify(r.json).slice(0, 80));
  r = await call('DELETE /api/admin/services/:key', A, null, { key });
  ok(r.status === 409, 'a service with providers cannot be deleted');
  r = await call('DELETE /api/admin/services/:key', A, null, { key: 'restaurant' });
  ok(r.status === 400, 'a built-in service cannot be deleted');
  await q('DELETE FROM products WHERE provider_id=$1', [water]);
  await q('UPDATE providers SET deleted_at=NOW() WHERE id=$1', [water]);
  r = await call('DELETE /api/admin/services/:key', A, null, { key });
  ok(r.status === 200 && r.json.services.length === 7, 'an empty custom service can be deleted: ' + r.status);
  // stop the errand service
  r = await call('PATCH /api/admin/services/:key', A, { active: false }, { key: 'errand' });
  ok(r.status === 200, 'stop errand');
  r = await call('POST /api/orders/custom', C, { ...base, text: 'عايز علبة عصير من السوبر' });
  ok(r.status === 409, 'a stopped errand service refuses orders');
  r = await call('PATCH /api/admin/services/:key', A, { active: true }, { key: 'errand' });
  r = await call('POST /api/orders/custom', C, { ...base, text: 'عايز علبة عصير من السوبر' });
  ok(r.status === 201, 'errand works again');
  // commission rules: a courier rule for the errand service, and a provider rule for a new service
  r = await call('POST /api/admin/commissions/rules', A, { target: 'courier', scope: 'type', providerType: 'custom', kind: 'fixed', value: 3 });
  ok(r.status === 201 || r.status === 200, 'courier errand rule accepted: ' + r.status + JSON.stringify(r.json).slice(0, 100));
  r = await call('POST /api/admin/commissions/rules', A, { target: 'courier', scope: 'type', providerType: 'maker', kind: 'fixed', value: 3 });
  ok(r.status === 400, 'a courier rule cannot target a normal section');
  r = await call('POST /api/admin/commissions/rules', A, { target: 'provider', scope: 'type', providerType: 'custom', kind: 'fixed', value: 3 });
  ok(r.status === 400, 'a provider rule cannot target the errand');
  r = await call('POST /api/admin/commissions/rules', A, { target: 'provider', scope: 'type', providerType: 'restaurant', kind: 'percent', value: 5 });
  ok(r.status === 200 || r.status === 201, 'provider rule for a section accepted');
  // the errand commission is charged on the delivery fee the courier wrote (rule: fixed 3), not on the goods
  r = await call('POST /api/orders/custom', C, { ...base, text: 'عايز كيس سكر وزيت من السوق' });
  const e2 = r.json.orders[0].id;
  await call('POST /api/orders/:id/action', K, { action: 'courier_accept' }, { id: String(e2) });
  r = await call('POST /api/orders/:id/errand-quote', K, { subtotal: 100, fee: 20 }, { id: String(e2) });
  ok(r.status < 300, 'quote 2: ' + JSON.stringify(r.json).slice(0, 80));
  r = await call('POST /api/orders/:id/action', C, { action: 'approve_quote' }, { id: String(e2) });
  ok(r.status === 200, 'customer approves: ' + JSON.stringify(r.json).slice(0, 80));
  r = await call('POST /api/orders/:id/action', K, { action: 'pickup' }, { id: String(e2) });
  ok(r.status === 200, 'pickup: ' + JSON.stringify(r.json).slice(0, 80));
  await call('POST /api/orders/:id/action', K, { action: 'go' }, { id: String(e2) });
  r = await call('POST /api/orders/:id/action', K, { action: 'deliver' }, { id: String(e2) });
  ok(r.status === 200, 'deliver: ' + JSON.stringify(r.json).slice(0, 80));
  const ce = (await q("SELECT base_amount, amount FROM commission_entries WHERE order_id=$1 AND kind='courier'", [e2])).rows[0];
  ok(ce && Number(ce.base_amount) === 20 && Number(ce.amount) === 3, 'errand commission is 3 on a base of 20: ' + JSON.stringify(ce));
  console.log(`services tests: ${pass} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
