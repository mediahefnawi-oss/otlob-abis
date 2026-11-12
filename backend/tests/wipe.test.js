// wiping trial data from the owner's panel (switch "dataWipe")
const { Pool } = require('./shim');
const bcrypt = require('bcryptjs');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m}: got ${a}, want ${b}`);
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const roles = (...allowed) => (req, res, next) => (allowed.includes(req.auth.role) ? next() : next(Object.assign(new Error('no'), { http: 403 })));
  const pass1 = (req, res, next) => next();
  const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
  const deps = { pool, auth: pass1, roles, asyncRoute, positiveId, services: require('../src/services.js'), clearCaches() {}, pushToUsers: async () => {} };
  require('../src/wipe.js').register(app, deps); require('../src/extras.js').register(app, deps);
  const call = (key, as, body) => new Promise(resolve => {
    const chain = routes[key]; if (!chain) throw new Error('no route ' + key);
    const res = { set() { return this; }, status(c) { this.c = c; return this; }, json(j) { resolve({ status: this.c || 200, json: j }); return this; } };
    const req = { auth: as, params: {}, body: body || {}, query: {} };
    const run = i => { const f = chain[i]; if (i === chain.length - 1) return f(req, res, e => resolve({ status: e.http || 500, json: { error: e.message } })); f(req, res, e => (e ? resolve({ status: e.http || 500, json: { error: e.message } }) : run(i + 1))); };
    run(0);
  });
  await q("UPDATE app_settings SET features='{}'::jsonb WHERE id=1");
  const hash = await bcrypt.hash('OwnerPass#1', 4);
  const mk = async (n, role, h) => (await q("INSERT INTO users(name, phone, password_hash, role, status) VALUES($1,$2,$3,$4,'active') RETURNING id", [n, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), h || 'x', role])).rows[0].id;
  const adm = await mk('مالك', 'admin', hash), cus = await mk('عميل', 'customer'), own = await mk('صاحب', 'provider'), own2 = await mk('عيادة', 'provider');
  const A = { sub: String(adm), role: 'admin' }, C = { sub: String(cus), role: 'customer' }, P = { sub: String(own), role: 'provider' };
  const shop = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'restaurant','مطعم','01000000000','active',TRUE) RETURNING id", [own])).rows[0].id;
  const clinic = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'clinic','عيادة','01000000001','active',TRUE) RETURNING id", [own2])).rows[0].id;
  const seed = async () => {
    await q("DELETE FROM commission_entries"); await q("DELETE FROM coupon_uses"); await q("DELETE FROM prescriptions"); await q("DELETE FROM invoices"); await q("DELETE FROM orders"); await q("DELETE FROM appointments");
    const o1 = (await q("INSERT INTO orders(customer_user_id, provider_id, status, total, data) VALUES($1,$2,'pending',100,'{}') RETURNING id", [cus, shop])).rows[0].id;
    await q("INSERT INTO orders(customer_user_id, provider_id, status, total, data) VALUES($1,$2,'delivered',50,'{}')", [cus, shop]);
    await q("INSERT INTO messages(order_id, sender_user_id, sender_name, sender_role, body) VALUES($1,NULL,'النظام','system','x')", [o1]);
    await q("INSERT INTO invoices(customer_user_id, order_id, kind, total, data) VALUES($1,$2,'delivery',100,'{}')", [cus, o1]);
    await q("INSERT INTO commission_entries(entry_type, kind, order_id, provider_id, base_amount, amount) VALUES('accrual','provider',$1,$2,100,10)", [o1, shop]);
    const a1 = (await q("INSERT INTO appointments(customer_user_id, provider_id, appointment_date, appointment_time, status, data) VALUES($1,$2,CURRENT_DATE,'10:00','confirmed','{}') RETURNING id", [cus, clinic])).rows[0].id;
    await q("INSERT INTO invoices(customer_user_id, appointment_id, kind, total, data) VALUES($1,$2,'booking',80,'{}')", [cus, a1]);
    await q("INSERT INTO commission_entries(entry_type, kind, appointment_id, provider_id, base_amount, amount) VALUES('accrual','provider',$1,$2,80,8)", [a1, clinic]);
    const x1 = (await q("INSERT INTO prescriptions(patient_user_id, clinic_provider_id, appointment_id, meds) VALUES($1,$2,$3,'دواء') RETURNING id", [cus, clinic, a1])).rows[0].id;
    await q("INSERT INTO commission_entries(entry_type, kind, rx_id, provider_id, base_amount, amount) VALUES('accrual','provider',$1,$2,50,5)", [x1, shop]);
  };
  const n = async t => Number((await q(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
  const body = (o = {}) => ({ password: 'OwnerPass#1', confirm: 'مسح', what: ['orders', 'bookings', 'rx'], ...o });
  let r;

  console.log('A) switch OFF + who may');
  await seed();
  eq((await call('POST /api/admin/wipe', A, body())).status, 409, 'OFF: refused');
  eq(await n('orders'), 2, 'OFF: nothing deleted');
  eq((await call('GET /api/admin/wipe/preview', A)).json.enabled, false, 'preview says off');
  eq((await call('GET /api/admin/wipe/preview', C)).status, 403, 'a customer cannot see it');
  eq((await call('POST /api/admin/wipe', P, body())).status, 403, 'a shop owner cannot wipe');
  await call('PATCH /api/admin/features', A, { key: 'dataWipe', on: true });

  console.log('B) preview');
  r = await call('GET /api/admin/wipe/preview', A); eq(r.json.enabled, true, 'enabled'); eq(r.json.counts.orders, 2, '2 orders'); eq(r.json.counts.openOrders, 1, '1 still open'); eq(r.json.counts.bookings, 1, '1 booking'); eq(r.json.counts.rx, 1, '1 rx'); eq(r.json.counts.invoices, 2, '2 invoices'); eq(r.json.counts.commissions, 3, '3 commission entries');

  console.log('C) every guard');
  eq((await call('POST /api/admin/wipe', A, body({ password: 'wrong' }))).status, 403, 'wrong password refused');
  eq((await call('POST /api/admin/wipe', A, body({ password: '' }))).status, 403, 'empty password refused');
  eq((await call('POST /api/admin/wipe', A, body({ confirm: 'yes' }))).status, 400, 'wrong confirmation word refused');
  eq((await call('POST /api/admin/wipe', A, body({ confirm: '' }))).status, 400, 'empty confirmation refused');
  eq((await call('POST /api/admin/wipe', A, body({ what: [] }))).status, 400, 'nothing chosen refused');
  eq((await call('POST /api/admin/wipe', A, body({ what: ['users'] }))).status, 400, 'an unknown target refused');
  eq(await n('orders'), 2, 'after every refusal nothing is deleted'); eq(await n('users'), (await n('users')), 'users intact');

  console.log('D) only what was chosen');
  r = await call('POST /api/admin/wipe', A, body({ what: ['orders'] })); eq(r.status, 200, 'wipe orders');
  eq(await n('orders'), 0, 'orders gone'); eq(await n('messages WHERE order_id IS NOT NULL'), 0, 'their chats gone');
  eq(await n("invoices WHERE kind='delivery'"), 0, 'delivery invoices gone'); eq(await n('commission_entries WHERE order_id IS NOT NULL'), 0, 'order commissions gone');
  eq(await n('appointments'), 1, 'booking kept'); eq(await n("invoices WHERE kind='booking'"), 1, 'booking invoice kept'); eq(await n('prescriptions'), 1, 'rx kept');
  eq(await n('commission_entries'), 2, 'other commissions kept');

  console.log('E) everything, with renumbering');
  await seed();
  r = await call('POST /api/admin/wipe', A, body({ renumber: true })); eq(r.status, 200, 'wipe all');
  eq(r.json.before.orders, 2, 'reports before'); eq(r.json.after.orders, 0, 'reports after');
  for (const t of ['orders', 'appointments', 'prescriptions', 'invoices', 'commission_entries']) eq(await n(t), 0, t + ' empty');
  const o = (await q("INSERT INTO orders(customer_user_id, provider_id, status, total, data) VALUES($1,$2,'pending',10,'{}') RETURNING id, order_number", [cus, shop])).rows[0];
  eq(Number(o.id), 1, 'the first new order has id 1'); eq(Number(o.order_number), 1, 'and number 1');
  const a = (await q("INSERT INTO appointments(customer_user_id, provider_id, appointment_date, appointment_time, status, data) VALUES($1,$2,CURRENT_DATE,'11:00','pending','{}') RETURNING id", [cus, clinic])).rows[0];
  eq(Number(a.id), 1, 'the first new booking is 1');
  eq(await n("users WHERE id=" + adm), 1, 'the owner account is intact'); eq(await n('providers WHERE id=' + shop), 1, 'shops intact');

  console.log('F) numbering continues without renumber, and never restarts a table that still has rows');
  await seed(); await q("SELECT setval('orders_order_number_seq', 500)");
  await call('POST /api/admin/wipe', A, body({ what: ['orders'] }));
  const o2 = (await q("INSERT INTO orders(customer_user_id, provider_id, status, total, data) VALUES($1,$2,'pending',10,'{}') RETURNING order_number", [cus, shop])).rows[0];
  ok(Number(o2.order_number) > 500, 'without renumber the numbers continue: ' + o2.order_number);
  await q("DELETE FROM orders");
  await seed(); await call('POST /api/admin/wipe', A, body({ what: ['rx'], renumber: true }));
  ok((await n('orders')) === 2, 'orders were not chosen: kept'); const o3 = (await q("INSERT INTO orders(customer_user_id, provider_id, status, total, data) VALUES($1,$2,'pending',10,'{}') RETURNING order_number", [cus, shop])).rows[0];
  ok(Number(o3.order_number) > 2, 'a table that still has rows is never renumbered: ' + o3.order_number);

  console.log(bad ? `FAILED ${bad}` : 'ALL OK', 'pass=' + pass);
  await q("DELETE FROM commission_entries"); await q("DELETE FROM prescriptions"); await q("DELETE FROM invoices"); await q("DELETE FROM orders"); await q("DELETE FROM appointments");
  await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
