const { Pool } = require('./shim');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const pass1 = (req, res, next) => next();
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  require('../src/orders.js')(app, { pool, auth: pass1, authAny: pass1, roles: () => pass1, asyncRoute, positiveId,
    maintenanceState: async () => ({ enabled: true }), loadSettings: async () => ({}), cleanUser: x => x, pushToUsers: async () => {} });
  const call = (key, as, body) => new Promise((resolve, reject) => {
    const res = { set() { return this; }, status(c) { this.c = c; return this; }, json(j) { resolve({ status: this.c || 200, json: j }); return this; } };
    routes[key][routes[key].length - 1]({ auth: as, params: {}, body: body || {}, query: {} }, res, reject);
  });
  const rA = (await q("INSERT INTO regions(name, delivery_fee) VALUES('منطقة اختبار أ'||random(), 12) RETURNING id, name")).rows[0];
  const rB = (await q("INSERT INTO regions(name, delivery_fee) VALUES('منطقة اختبار ب'||random(), 30) RETURNING id, name")).rows[0];
  const mk = async (n, role, region) => (await q("INSERT INTO users(name, phone, password_hash, role, status, region_id) VALUES($1,$2,'x',$3,'active',$4) RETURNING id", [n, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role, region])).rows[0].id;
  await q('INSERT INTO route_prices(from_region_id, to_region_id, price) VALUES($1,$2,30),($1,$1,12),($2,$2,30),($2,$1,30) ON CONFLICT DO NOTHING', [rA.id, rB.id]);
  const owner = await mk('م', 'provider', rA.id), cust = await mk('ع', 'customer', rB.id), owner2 = await mk('ص', 'provider', rA.id);
  const rest = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'restaurant','مطعم','01000000000','active',TRUE) RETURNING id", [owner])).rows[0].id;
  const sup = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'supermarket','سوبر','01000000000','active',TRUE) RETURNING id", [owner2])).rows[0].id;
  const pr = (await q("INSERT INTO products(provider_id,name,price) VALUES($1,'وجبة',40) RETURNING id", [rest])).rows[0].id;
  const ps = (await q("INSERT INTO products(provider_id,name,price) VALUES($1,'سكر',20) RETURNING id", [sup])).rows[0].id;
  const A = { sub: String(cust), role: 'customer', status: 'active' };
  const base = { name: 'عميل تجريبي', phone: '01012345678', address: 'شارع 5 عمارة 3 الدور 2', notes: '' };
  const r1 = await call('POST /api/orders/checkout', A, { ...base, lines: [{ productId: pr, qty: 1 }] });
  const o = r1.json.orders[0];
  ok(r1.status === 201, 'restaurant checkout works');
  ok(o.providerRegionName === rA.name, 'order carries the shop area');
  ok(o.regionName === rB.name, 'order carries the customer area');
  ok(o.deliveryFee === 30, 'delivery fee follows the customer area (owner price list)');
  ok(o.address === base.address, 'detailed address kept');
  const rj = await call('POST /api/orders/checkout', A, { ...base, lines: [{ productId: ps, qty: 1 }] });
  ok(rj.status === 409 && /اطلب بكتابة/.test(JSON.stringify(rj.json)), 'supermarket cart checkout is refused (written request only)');
  const r3 = await call('POST /api/orders/request', A, { providerId: sup, text: 'كيلو سكر وعلبة شاي', phone: '01012345678', address: base.address });
  ok(r3.status === 201 && r3.json.order.providerRegionName === rA.name, 'written request carries the shop area');
  console.log(`area tests: ${pass} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
