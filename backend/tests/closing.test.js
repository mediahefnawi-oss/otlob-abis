const { Pool } = require('./shim');
const comm = require('../src/commissions.js');
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
const near = (a, b, m) => ok(Math.abs(Number(a) - Number(b)) < 0.005, `${m}: got ${a} expected ${b}`);

const routes = {};
const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (path, ...chain) => { routes[`${m.toUpperCase()} ${path}`] = chain; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const auth = (req, res, next) => { if (!req.auth) return res.status(401).json({ error: 'auth' }); next(); };
const roles = (...allowed) => (req, res, next) => { if (!req.auth || !allowed.includes(req.auth.role)) return res.status(403).json({ error: 'forbidden' }); next(); };

async function call(key, { as, body, query, params } = {}) {
  const chain = routes[key];
  if (!chain) throw new Error('no route ' + key);
  const req = { auth: as, body: body || {}, query: query || {}, params: params || {} };
  const out = { status: 200, json: null, headers: {} };
  const res = { status(c) { out.status = c; return this; }, json(j) { out.json = j; return this; }, set(k, v) { out.headers[k] = v; return this; }, send(b) { out.sent = b; return this; }, end() { return this; } };
  let i = 0, err = null;
  const next = e => { if (e) { err = e; return; } const f = chain[i++]; if (f) return f(req, res, next); };
  next();
  const t0 = Date.now();
  while (!err && out.json === null && out.sent === undefined && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 2));
  if (err) throw err;
  return out;
}
(async () => {
  const pool = new Pool();
  const q = (t, p) => pool.query(t, p);
  await q(`TRUNCATE day_closings, commission_entries, commission_settlements, counter_resets, counter_schedules, audit_log, appointments, orders, products, providers, users RESTART IDENTITY CASCADE`);
  const user = async (name, role) => (await q("INSERT INTO users(name, phone, password_hash, role) VALUES($1,$2,'x',$3) RETURNING id", [name, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const adminId = await user('المالك', 'admin'), cust = await user('عميل', 'customer'), ownerA = await user('مالك أ', 'provider'), ownerB = await user('مالك ب', 'provider');
  const prov = async (o, name) => (await q("INSERT INTO providers(owner_user_id, type, name, phone, status, is_open) VALUES($1,'restaurant',$2,'01000000000','active',TRUE) RETURNING id", [o, name])).rows[0].id;
  const pA = await prov(ownerA, 'مطعم أ'), pB = await prov(ownerB, 'مطعم ب');
  const order = async (p, subtotal) => (await q("INSERT INTO orders(customer_user_id, provider_id, status, total, data) VALUES($1,$2,'on_the_way',$3,$4) RETURNING *", [cust, p, subtotal + 20, JSON.stringify({ subtotal, deliveryFee: 20 })])).rows[0];
  const deliver = async o => { const c = await pool.connect(); try { await c.query('BEGIN'); const r = (await c.query("UPDATE orders SET status='delivered' WHERE id=$1 RETURNING *", [o.id])).rows[0]; await comm.onOrderDelivered(c, r); await c.query('COMMIT'); } finally { c.release(); } };
  require('../src/commissions.js')(app, { pool, auth, roles, asyncRoute, positiveId });
  const A = { sub: String(adminId), role: 'admin' }, PA = { sub: String(ownerA), role: 'provider' }, PB = { sub: String(ownerB), role: 'provider' };
  const dueOf = async p => Number((await q("SELECT COALESCE(SUM(amount),0) s FROM commission_entries WHERE provider_id=$1 AND kind='provider' AND status='due'", [p])).rows[0].s);
  const row = async p => (await call('GET /api/admin/closings', { as: A })).json.providers.find(x => x.id === String(p));

  console.log('1) overview before closing');
  const o1 = await order(pA, 200); await deliver(o1); const o2 = await order(pA, 100); await deliver(o2);
  const o3 = await order(pA, 50); // still on the way
  const ob = await order(pB, 80); await deliver(ob);
  const due0 = await dueOf(pA);
  ok(due0 > 0, 'provider A has commission due: ' + due0);
  let r = await row(pA);
  near(r.sales, 300, 'sales 300'); eq(r.orders, 2, '2 finished orders'); near(r.due, due0, 'due matches ledger'); eq(r.since, null, 'no previous closing');

  console.log('2) validations');
  eq((await call('POST /api/admin/closings', { as: PA, body: { providerId: pA } })).status, 403, 'provider cannot close');
  eq((await call('POST /api/admin/closings', { as: A, body: {} })).status, 400, 'needs provider');
  eq((await call('POST /api/admin/closings', { as: A, body: { providerId: pA, received: due0 + 1 } })).status, 400, 'received above due refused');
  eq((await call('POST /api/admin/closings', { as: A, body: { providerId: pA, received: 0 } })).status, 400, 'zero received refused when something is due');
  eq((await call('POST /api/admin/closings', { as: A, body: { providerId: pA, received: -5 } })).status, 400, 'negative refused');
  eq(Number((await q('SELECT count(*) c FROM day_closings')).rows[0].c), 0, 'failed attempts changed nothing');
  eq(await dueOf(pA), due0, 'due untouched by failed attempts');

  console.log('3) partial payment closes, carries the rest');
  const part = Math.round((due0 - 4) * 100) / 100;
  const c1 = await call('POST /api/admin/closings', { as: A, body: { providerId: pA, received: part, note: 'اختبار' } });
  eq(c1.status, 201, 'closed (201) ' + JSON.stringify(c1.json));
  near(c1.json.closing.received, part, 'received saved'); near(c1.json.closing.carried, 4, 'carried 4'); near(c1.json.closing.due, due0, 'due saved'); eq(c1.json.closing.orders, 2, 'orders 2'); near(c1.json.closing.sales, 300, 'sales 300');
  near(await dueOf(pA), 4, 'only the shortfall is still due');
  const st = (await q('SELECT * FROM commission_settlements ORDER BY id DESC LIMIT 1')).rows[0];
  near(st.amount, part, 'settlement amount = received'); eq(String(st.provider_id), String(pA), 'settlement for A');
  eq(Number((await q("SELECT count(*) c FROM commission_entries WHERE entry_type='adjustment' AND provider_id=$1 AND status='due'", [pA])).rows[0].c), 1, 'one carry adjustment');
  r = await row(pA); near(r.sales, 0, 'sales back to 0'); eq(r.orders, 0, 'orders back to 0'); near(r.due, 4, 'overview shows carried due'); ok(r.since > 0, 'since set');
  const cnt = (await call('GET /api/counters', { as: PA })).json.providers[String(pA)];
  near(cnt.sales, 0, 'provider counters sales 0'); eq(cnt.orders, 0, 'orders counter restarted');
  eq((await call('POST /api/admin/closings', { as: A, body: { providerId: pA, received: 5 } })).status, 400, 'received above the carried 4 refused');
  const rB = await row(pB); near(rB.sales, 80, 'B untouched');
  ok(await dueOf(pB) > 0, 'B due untouched');

  console.log('4) next day: new order, full payment, carried debt included');
  const o4 = await order(pA, 100); await deliver(o4);
  r = await row(pA); near(r.sales, 100, 'new day sales 100'); eq(r.orders, 1, '1 order');
  const due1 = await dueOf(pA); near(due1, 4 + (due1 - 4), 'due includes carry'); ok(due1 > 4, 'due > carried');
  const c2 = await call('POST /api/admin/closings', { as: A, body: { providerId: pA } });
  eq(c2.status, 201, 'default = full amount'); near(c2.json.closing.carried, 0, 'nothing carried'); near(c2.json.closing.received, due1, 'received = due');
  near(await dueOf(pA), 0, 'A clean');
  eq((await call('POST /api/admin/closings', { as: A, body: { providerId: pA } })).status, 409, 'nothing to close now');

  console.log('5) provider history (my/days)');
  const d = await call('GET /api/my/days', { as: PA });
  eq(d.status, 200, 'days ok'); eq(d.json.days.length, 1, 'one Cairo day (all today)'); eq(d.json.days[0].orders, 3, '3 delivered'); near(d.json.days[0].sales, 400, 'sales 400'); eq(d.json.closings.length, 2, '2 closings listed');
  eq((await call('GET /api/my/days', { as: PB, query: { providerId: String(pA) } })).status, 403, 'B cannot read A');
  eq((await call('GET /api/my/days', { as: A })).status, 400, 'admin needs providerId');

  console.log('6) undo');
  eq((await call('POST /api/admin/closings/:id/undo', { as: A, params: { id: String(c1.json.closing.id) } })).status, 409, 'cannot undo older while newer exists');
  const u = await call('POST /api/admin/closings/:id/undo', { as: A, params: { id: String(c2.json.closing.id) } });
  eq(u.status, 200, 'undo newest'); eq(u.json.closing.undone, true, 'marked undone');
  r = await row(pA); near(r.sales, 100, 'sales of that day are back'); eq(r.orders, 1, 'orders back');
  eq((await call('POST /api/admin/closings/:id/undo', { as: A, params: { id: String(c2.json.closing.id) } })).status, 409, 'cannot undo twice');
  near(await dueOf(pA), 0, 'payment stays recorded after undo');

  console.log('7) provider order list hides closed orders (same SQL the app uses)');
  const scope = `o.provider_id IN (SELECT id FROM providers WHERE owner_user_id=$1) AND NOT (o.status IN ('delivered','rejected','cancelled','unavailable') AND COALESCE(o.delivered_at, o.updated_at) <= COALESCE((SELECT MAX(dc.closed_at) FROM day_closings dc WHERE dc.provider_id=o.provider_id AND dc.undone_at IS NULL), 'epoch'::timestamptz))`;
  const visible = async () => (await q(`SELECT o.id FROM orders o WHERE ${scope}`, [ownerA])).rows.map(x => Number(x.id)).sort((a, b) => a - b);
  eq(await visible(), [Number(o3.id), Number(o4.id)].sort((a, b) => a - b), 'after undo of c2: o1,o2 hidden by c1; o4 and the unfinished o3 visible');
  const tot = Number((await q('SELECT count(*) c FROM orders')).rows[0].c); eq(tot, 5, 'no order was deleted');

  console.log(failN ? `FAILED ${failN}` : 'ALL OK', 'pass=' + pass);
  await pool.end();
  process.exit(failN ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
