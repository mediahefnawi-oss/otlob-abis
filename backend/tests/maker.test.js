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
  const call = (key, as, body, params) => new Promise((resolve, reject) => {
    const res = { set() { return this; }, status(c) { this.c = c; return this; }, json(j) { resolve({ status: this.c || 200, json: j }); return this; } };
    const chain = routes[key];
    chain[chain.length - 1]({ auth: as, params: params || {}, body: body || {}, query: {} }, res, e => resolve({ status: e.status || 500, json: { error: e.message } }));
  });
  const mk = async (n, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status) VALUES($1,$2,'x',$3,'active') RETURNING id", [n, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const owner = await mk('صانع', 'provider'), cust = await mk('عميل', 'customer');
  const prov = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open,delivery_fee) VALUES($1,'maker','صانع','01000000000','active',TRUE,10) RETURNING id", [owner])).rows[0].id;
  const pr = (await q("INSERT INTO products(provider_id,name,price) VALUES($1,'شنطة',100) RETURNING id", [prov])).rows[0].id;
  const A = { sub: String(cust), role: 'customer', status: 'active' }, P = { sub: String(owner), role: 'provider', status: 'active' };
  const base = { name: 'عميل', phone: '01012345678', address: 'شارع 5 عمارة 3 الدور 2', notes: '' };
  const place = async () => (await call('POST /api/orders/checkout', A, { ...base, lines: [{ productId: pr, qty: 1 }] })).json.orders[0];
  // 1) ready now
  const o1 = await place(); ok(o1.status === 'pending' && o1.providerType === 'maker', 'maker product order is pending');
  const r1 = await call('POST /api/orders/:id/action', P, { action: 'accept', ready: true }, { id: o1.id });
  ok(r1.status === 200 && r1.json.order.status === 'ready', 'ready now -> status ready: ' + JSON.stringify(r1.json));
  // 2) scheduled
  const o2 = await place(); const day = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  const r2 = await call('POST /api/orders/:id/action', P, { action: 'accept', readyDate: day, readyTime: '15:30' }, { id: o2.id });
  ok(r2.status === 200 && r2.json.order.status === 'accepted' && r2.json.order.readyDate === day && r2.json.order.readyTime === '15:30', 'scheduled -> accepted with day/hour: ' + JSON.stringify(r2.json));
  // 3) bad date refused
  const o3 = await place();
  const r3 = await call('POST /api/orders/:id/action', P, { action: 'accept', readyDate: '2020-01-01', readyTime: '10:00' }, { id: o3.id });
  ok(r3.status === 400, 'past date refused');
  // 4) apologise
  const r4 = await call('POST /api/orders/:id/action', P, { action: 'reject', reason: 'اعتذار' }, { id: o3.id });
  ok(r4.status === 200 && r4.json.order.status === 'rejected', 'apologise -> rejected');
  console.log(`maker tests: ${pass} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
