const { Pool } = require('./shim');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const pass1 = (req, res, next) => next();
let PV = { on: true, minutes: 1 };
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  require('../src/orders.js')(app, { pool, auth: pass1, authAny: pass1, roles: () => pass1, asyncRoute, positiveId,
    maintenanceState: async () => ({ enabled: true }), loadSettings: async () => ({ privacy: PV }), cleanUser: x => x, pushToUsers: async () => {} });
  const call = async (key, as, query) => {
    const chain = routes[key]; const out = { json: null };
    const req = { auth: as, params: {}, body: {}, query: query || {} };
    const res = { set() { return this; }, status() { return this; }, json(j) { out.json = j; return this; } };
    let err = null; chain[chain.length - 1](req, res, e => { err = e; });
    const t0 = Date.now(); while (!err && out.json === null && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 2));
    if (err) throw err; return out.json;
  };
  const u = async (n, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',TRUE) RETURNING id", [n, '011' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const cust = await u('أحمد', 'customer'), po = await u('ص', 'provider'), cour = await u('م', 'courier'), adm = await u('أ', 'admin');
  const p = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'supermarket','س','01000000000','active',TRUE) RETURNING id", [po])).rows[0].id;
  const A = (id, role) => ({ sub: String(id), role, status: 'active' });
  const data = JSON.stringify({ customerName: 'أحمد', phone: '01012345678', phone2: '0111', address: 'شارع النيل', notes: 'الدور 3', history: [] });
  const o = (await q("INSERT INTO orders(customer_user_id, provider_id, courier_user_id, status, total, data, delivered_at) VALUES($1,$2,$3,'delivered',50,$4,NOW()) RETURNING id", [cust, p, cour, data])).rows[0].id;
  await q("INSERT INTO messages(order_id,sender_user_id,body) VALUES($1,$2,'العنوان كذا')", [o, cust]);
  const get = async (id, role) => (await call('GET /api/sync', A(id, role))).orders.find(x => x.id === String(o));

  let x = await get(po, 'provider');
  ok(x.phone === '01012345678' && x.address === 'شارع النيل' && !x.privacyMasked, 'within the first minute the shop still sees the customer');
  ok((await call('GET /api/sync', A(po, 'provider'))).messages.filter(m => m.orderId === String(o)).length === 1, 'chat visible within the minute');
  await q("UPDATE orders SET delivered_at = NOW() - interval '2 minutes' WHERE id=$1", [o]);
  for (const [id, role] of [[po, 'provider'], [cour, 'courier']]) {
    x = await get(id, role);
    ok(x.phone === '' && x.phone2 === '' && x.address === '' && x.notes === '' && x.customerName === 'عميل' && x.privacyMasked === true, role + ' no longer sees the customer data');
    ok(x.total === 50 && x.status === 'delivered' && x.number > 0, role + ' keeps the money and the status');
    { const mm = (await call('GET /api/sync', A(id, role))).messages.filter(m => m.orderId === String(o)); ok(mm.length === 0, role + ' no longer sees the chat ' + JSON.stringify(mm)); }
  }
  x = await get(cust, 'customer'); ok(x.phone === '01012345678' && !x.privacyMasked, 'the customer sees his own data');
  x = await get(adm, 'admin'); ok(x.phone === '01012345678' && !x.privacyMasked, 'the owner sees everything');
  // the fingerprint changes when the minute passes, so an app holding the old copy refreshes
  await q("UPDATE orders SET delivered_at = NOW() - interval '30 seconds' WHERE id=$1", [o]);
  const tag0 = (await call('GET /api/sync', A(po, 'provider'))).tag;
  await q("UPDATE orders SET delivered_at = NOW() - interval '3 minutes' WHERE id=$1", [o]);
  ok(!(await call('GET /api/sync', A(po, 'provider'), { tag: tag0 })).unchanged, 'masking changes the shop fingerprint');
  // 5 minute delay and switched off
  PV = { on: true, minutes: 5 };
  ok((await get(po, 'provider')).phone === '01012345678', 'a 5 minute delay keeps data at 3 minutes');
  PV = { on: false, minutes: 1 };
  ok((await get(po, 'provider')).phone === '01012345678', 'switched off: data stays');
  // running orders are never masked
  PV = { on: true, minutes: 1 };
  await q("UPDATE orders SET status='on_the_way' WHERE id=$1", [o]);
  ok((await get(cour, 'courier')).phone === '01012345678', 'running order is never masked');
  console.log(`privacy: ${pass} passed, ${bad} failed`); await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
