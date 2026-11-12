// temporary closing of a delivery area (switch "regionClose")
const { Pool } = require('./shim');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m}: got ${a}, want ${b}`);
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const pass1 = (req, res, next) => next();
const pushes = [];
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const rc = require('../src/regionclose.js');
  const deps = { pool, auth: pass1, authAny: pass1, roles: () => pass1, asyncRoute, positiveId };
  require('../src/orders.js')(app, { ...deps, maintenanceState: async () => ({ enabled: true }), loadSettings: async () => ({}), cleanUser: x => x, pushToUsers: async (ids, p) => { pushes.push({ ids: ids.map(String), p }); } });
  require('../src/extras.js').register(app, { ...deps, services: require('../src/services.js'), clearCaches() {} });
  const call = (key, as, body, params, query) => new Promise(resolve => {
    const res = { set() { return this; }, status(c) { this.c = c; return this; }, json(j) { resolve({ status: this.c || 200, json: j }); return this; } };
    const chain = routes[key];
    chain[chain.length - 1]({ auth: as, params: params || {}, body: body || {}, query: query || {} }, res, e => resolve({ status: e.status || e.http || 500, json: { error: e.message } }));
  });
  await q("UPDATE app_settings SET features='{}'::jsonb, auto_assign=FALSE WHERE id=1");
  await q("DELETE FROM invoices"); await q("DELETE FROM orders");
  const mkReg = async n => (await q("INSERT INTO regions(name, delivery_fee) VALUES($1||floor(random()*1e6), 20) RETURNING id", [n])).rows[0].id;
  const regA = await mkReg('منطقة مقفولة'), regB = await mkReg('منطقة مفتوحة');
  const mk = async (n, role, region) => (await q("INSERT INTO users(name, phone, password_hash, role, status, region_id) VALUES($1,$2,'x',$3,'active',$4) RETURNING id", [n, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role, region || null])).rows[0].id;
  const adm = await mk('مالك', 'admin'), own = await mk('صاحب', 'provider', regB), cA = await mk('عميل أ', 'customer', regA), cB = await mk('عميل ب', 'customer', regB), cN = await mk('بلا منطقة', 'customer');
  const A = { sub: String(adm), role: 'admin', status: 'active' };
  const asC = id => ({ sub: String(id), role: 'customer', status: 'active' });
  const shop = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open,delivery_fee) VALUES($1,'restaurant','مطعم','01000000000','active',TRUE,20) RETURNING id", [own])).rows[0].id;
  await q("INSERT INTO route_prices(from_region_id,to_region_id,price) VALUES($1,$2,20),($1,$1,20) ON CONFLICT DO NOTHING", [regB, regA]).catch(() => {});
  const prod = (await q("INSERT INTO products(provider_id,name,price) VALUES($1,'وجبة',100) RETURNING id", [shop])).rows[0].id;
  const body = { name: 'عميل', phone: '01012345678', address: 'شارع 5 عمارة 3 الدور 2', notes: '', lines: [{ productId: String(prod), qty: 1 }] };
  const close = (id, o = {}) => q('UPDATE regions SET closed=TRUE, closed_message=$2, closed_until=$3 WHERE id=$1', [id, o.msg || '', o.until || null]);
  let r;

  console.log('A) switch OFF: nothing changes even if a row says closed');
  await close(regA);
  eq((await call('POST /api/orders/checkout', asC(cA), body)).status, 201, 'OFF: the closed area still orders');
  eq(await rc.closure(pool, cA), null, 'OFF: no closure');
  await q("DELETE FROM invoices"); await q("DELETE FROM orders");
  await call('PATCH /api/admin/features', A, { key: 'regionClose', on: true });

  console.log('B) switch ON: the closed area cannot order');
  r = await call('POST /api/orders/checkout', asC(cA), body); eq(r.status, 409, 'checkout refused'); ok(/متوقف مؤقتًا/.test(r.json.error) && /منطقة مقفولة/.test(r.json.error), 'default message names the area: ' + r.json.error);
  eq((await call('POST /api/orders/request', asC(cA), { providerId: String(shop), text: 'عايز حاجة', name: 'ع', phone: '01012345678', address: 'شارع 5 عمارة 3 الدور 2' })).status, 409, 'written request refused');
  eq((await call('POST /api/orders/custom', asC(cA), { text: 'هات لي حاجة من السوق', name: 'ع', phone: '01012345678', address: 'شارع 5 عمارة 3 الدور 2' })).status, 409, 'errand refused');
  eq((await q('SELECT COUNT(*)::int n FROM orders')).rows[0].n, 0, 'nothing was saved');
  eq((await call('POST /api/orders/checkout', asC(cB), body)).status, 201, 'another area is not affected');
  eq((await call('POST /api/orders/checkout', asC(cN), body)).status, 201, 'a customer with no area is not affected');
  await q("DELETE FROM invoices"); await q("DELETE FROM orders");

  console.log('C) the owner\'s message');
  await close(regA, { msg: 'مفيش مناديب النهارده' });
  r = await call('POST /api/orders/checkout', asC(cA), body); eq(r.json.error, 'مفيش مناديب النهارده', 'custom message shown as is');

  console.log('D) end time');
  await close(regA, { msg: 'قفل مؤقت', until: new Date(Date.now() + 3600e3) });
  eq((await call('POST /api/orders/checkout', asC(cA), body)).status, 409, 'still closed before the end time');
  await q('UPDATE regions SET closed_until = NOW() - INTERVAL \'1 minute\' WHERE id=$1', [regA]);
  eq(await rc.closure(pool, cA), null, 'an ended closing no longer applies');
  eq((await call('POST /api/orders/checkout', asC(cA), body)).status, 201, 'orders work right after the end time');
  await q("DELETE FROM invoices"); await q("DELETE FROM orders");

  console.log('E) automatic reopening + push');
  pushes.length = 0;
  eq(await rc.sweep(pool, async (ids, p) => { pushes.push({ ids: ids.map(String), p }); }), 1, 'the sweep reopens one area');
  const row = (await q('SELECT closed, closed_until, closed_message FROM regions WHERE id=$1', [regA])).rows[0];
  eq(row.closed, false, 'closed=false'); eq(row.closed_until, null, 'end time cleared'); eq(row.closed_message, '', 'message cleared');
  ok(pushes.length === 1 && pushes[0].ids.includes(String(cA)) && !pushes[0].ids.includes(String(cB)) && /رجع التوصيل/.test(pushes[0].p.title), 'customers of that area only get the reopening push');
  eq(await rc.sweep(pool, async () => {}), 0, 'a second sweep does nothing');

  console.log('F) the lists and the owner\'s patch rules');
  await close(regA, { msg: 'x' });
  const v = rc.view((await q('SELECT * FROM regions WHERE id=$1', [regA])).rows[0], false, true);
  eq(v.closed, true, 'customer view: closed'); eq(v.closedMessage, 'x', 'customer view: message'); ok(!('closedRaw' in v), 'customer view hides raw fields');
  const va = rc.view((await q('SELECT * FROM regions WHERE id=$1', [regA])).rows[0], true, true); eq(va.closedRaw, true, 'owner view has raw fields');
  eq(rc.view((await q('SELECT * FROM regions WHERE id=$1', [regA])).rows[0], false, false).closed, false, 'switch OFF: customers see it open');
  const fail = (http, error) => Object.assign(new Error(error), { http });
  const old = (await q('SELECT * FROM regions WHERE id=$1', [regA])).rows[0];
  let e1 = null; try { rc.parsePatch({ closedUntil: Date.now() - 1000 }, old, fail); } catch (e) { e1 = e; } eq(e1 && e1.http, 400, 'an end time in the past is refused');
  const p1 = rc.parsePatch({ closed: true, closedMessage: 'ي'.repeat(500), closedUntil: Date.now() + 3600e3 }, { ...old, closed: false }, fail);
  eq(p1.closed, true, 'closed'); eq(p1.msg.length, 200, 'message capped at 200'); ok(p1.until instanceof Date, 'end time kept');
  const p2 = rc.parsePatch({ closed: false }, old, fail); eq(p2.closed, false, 'reopened'); eq(p2.until, null, 'end time dropped when reopened'); eq(p2.msg, '', 'message dropped when reopened');

  console.log(bad ? `FAILED ${bad}` : 'ALL OK', 'pass=' + pass);
  await q("DELETE FROM invoices"); await q("DELETE FROM orders"); await q("UPDATE regions SET closed=FALSE WHERE id IN ($1,$2)", [regA, regB]);
  await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
