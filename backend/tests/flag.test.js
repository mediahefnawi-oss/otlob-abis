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
  const call = (key, as, body, params, query) => new Promise((resolve, reject) => {
    const res = { set() { return this; }, status(c) { this.c = c; return this; }, json(j) { resolve({ status: this.c || 200, json: j }); return this; } };
    const chain = routes[key];
    chain[chain.length - 1]({ auth: as, params: params || {}, body: body || {}, query: query || {} }, res, e => resolve({ status: e.status || 500, json: { error: e.message } }));
  });
  const mk = async (n, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status) VALUES($1,$2,'x',$3,'active') RETURNING id", [n, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const owner = await mk('م', 'provider'), cust = await mk('ع', 'customer'), courier = await mk('مندوب', 'courier');
  const rest = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'restaurant','مطعم','01000000000','active',TRUE) RETURNING id", [owner])).rows[0].id;
  const pr = (await q("INSERT INTO products(provider_id,name,price) VALUES($1,'وجبة',40) RETURNING id", [rest])).rows[0].id;
  const C = { sub: String(cust), role: 'customer', status: 'active' }, P = { sub: String(owner), role: 'provider', status: 'active' }, K = { sub: String(courier), role: 'courier', status: 'active' };
  const base = { name: 'عميل', phone: '01012345678', address: 'شارع 5 عمارة 3 الدور 2', notes: '' };
  const rg = (await q("INSERT INTO regions(name, delivery_fee) VALUES('منطقة فلاج'||random(), 10) RETURNING id")).rows[0].id;
  await q('UPDATE users SET region_id=$1 WHERE id IN ($2,$3,$4)', [rg, owner, cust, courier]);
  await q('INSERT INTO route_prices(from_region_id, to_region_id, price) VALUES($1,$1,10) ON CONFLICT DO NOTHING', [rg]);
  await q("UPDATE users SET account_flag='fraud', flag_note='رفض الاستلام مرتين' WHERE id=$1", [cust]);
  const r = await call('POST /api/orders/checkout', C, { ...base, lines: [{ productId: pr, qty: 1 }] });
  const mine = r.json.orders[0];
  ok(mine.customerFlag === undefined, 'the customer never sees the label (checkout answer)');
  const sc = (await call('GET /api/sync', C, {}, {}, {})).json;
  ok(sc.orders.every(o => o.customerFlag === undefined && o.customerFlagNote === undefined), 'the customer never sees the label (sync)');
  const sp = (await call('GET /api/sync', P, {}, {}, {})).json;
  const po = sp.orders.find(o => o.id === mine.id);
  ok(po && po.customerFlag === 'fraud' && po.customerFlagNote === 'رفض الاستلام مرتين', 'the shop sees the label and the note: ' + JSON.stringify(po && [po.customerFlag, po.customerFlagNote]));
  await q("UPDATE orders SET status='accepted' WHERE id=$1", [mine.id]);
  const sk = (await call('GET /api/sync', K, {}, {}, {})).json;
  const ko = sk.orders.find(o => o.id === mine.id);
  ok(ko && ko.customerFlag === 'fraud', 'the courier sees the label');
  // changing the label later updates the open order
  await q("UPDATE users SET account_flag='trusted', flag_note='' WHERE id=$1", [cust]);
  await q("UPDATE orders SET data = data || $2::jsonb, updated_at=NOW() WHERE customer_user_id=$1", [cust, JSON.stringify({ customerFlag: 'trusted', customerFlagNote: '' })]);
  const sp2 = (await call('GET /api/sync', P, {}, {}, {})).json;
  ok(sp2.orders.find(o => o.id === mine.id).customerFlag === 'trusted', 'the shop sees the new label');
  // no label -> nothing extra
  await q("UPDATE users SET account_flag='' WHERE id=$1", [cust]);
  const r2 = await call('POST /api/orders/checkout', C, { ...base, lines: [{ productId: pr, qty: 1 }] });
  const sp3 = (await call('GET /api/sync', P, {}, {}, {})).json;
  ok(sp3.orders.find(o => o.id === r2.json.orders[0].id).customerFlag === undefined, 'no label -> none shown');
  console.log(`flag tests: ${pass} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
