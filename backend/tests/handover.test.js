const { Pool } = require('./shim');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const pass1 = (req, res, next) => next();
(async () => {
  const pool = new Pool();
  const q = (t, p) => pool.query(t, p);
  const notes = [];
  require('../src/orders.js')(app, { pool, auth: pass1, authAny: pass1, roles: () => pass1, asyncRoute, positiveId,
    maintenanceState: async () => ({ enabled: true }), loadSettings: async () => ({}), cleanUser: x => x, pushToUsers: async (ids, p) => { notes.push({ ids: ids.map(Number), p }); } });
  const call = async (key, as, params, body) => {
    const chain = routes[key]; const out = { status: 200, json: null };
    const req = { auth: as, params, body: body || {}, query: {} };
    const res = { status(c) { out.status = c; return this; }, json(j) { out.json = j; return this; } };
    let err = null; chain[chain.length - 1](req, res, e => { err = e; });
    const t0 = Date.now(); while (!err && out.json === null && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 2));
    if (err) throw err; return out;
  };
  const u = async (n, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',TRUE) RETURNING id", [n, '011' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const admin = await u('مالك', 'admin'), sup = await u('مشرف', 'supervisor'), cust = await u('ع', 'customer'), c1 = await u('مندوب1', 'courier'), c2 = await u('مندوب2', 'courier'), po = await u('ص', 'provider');
  const rid = (await q("INSERT INTO regions(name) VALUES('h'||floor(random()*1e9)) RETURNING id")).rows[0].id;
  await q('UPDATE users SET sup_regions=$1 WHERE id=$2', [String(rid), sup]);
  const p = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'supermarket','س','01000000000','active',TRUE) RETURNING id", [po])).rows[0].id;
  const mk = async status => (await q("INSERT INTO orders(customer_user_id, provider_id, courier_user_id, status, total, region_id, data) VALUES($1,$2,$3,$4,250,$5,$6) RETURNING id", [cust, p, c1, status, rid, JSON.stringify({ subtotal: 230, deliveryFee: 20, courierName: 'مندوب1', providerOwnerId: String(po), providerType: 'supermarket', history: [] })])).rows[0].id;
  const A = { sub: String(admin), role: 'admin' }, S = { sub: String(sup), role: 'supervisor' };
  const oWay = await mk('on_the_way');
  // normal assign is still refused after pickup
  let r = await call('POST /api/orders/:id/assign', A, { id: String(oWay) }, { courierId: String(c2) });
  ok(r.status === 409, 'normal assign refused after pickup');
  // breakdown: owner hands it over
  r = await call('POST /api/orders/:id/assign', A, { id: String(oWay) }, { courierId: String(c2), breakdown: true });
  ok(r.status === 200 && r.json.order.status === 'ready', 'breakdown hands over and returns to ready: ' + JSON.stringify(r.json).slice(0, 120));
  let row = (await q('SELECT courier_user_id, status, data FROM orders WHERE id=$1', [oWay])).rows[0];
  ok(Number(row.courier_user_id) === Number(c2), 'new courier owns it'); ok(row.data.courierName === 'مندوب2', 'courier name updated'); ok(row.data.handover && row.data.handover.from === 'مندوب1', 'handover recorded');
  ok(notes.some(n => n.ids.includes(Number(c1))) && notes.some(n => n.ids.includes(Number(c2))) && notes.some(n => n.ids.includes(Number(po))), 'old courier, new courier and the shop are notified');
  const au = (await q('SELECT action FROM audit_log')).rows.map(x => x.action); ok(au.includes('order.handover'), 'audited: ' + JSON.stringify(au));
  // the new courier can take it and deliver
  r = await call('POST /api/orders/:id/action', { sub: String(c2), role: 'courier' }, { id: String(oWay) }, { action: 'pickup' });
  ok(r.status === 200 && r.json.order.status === 'picked_up', 'new courier picks it up: ' + JSON.stringify(r.json).slice(0, 100));
  // same courier again refused
  r = await call('POST /api/orders/:id/assign', A, { id: String(oWay) }, { courierId: String(c2), breakdown: true });
  ok(r.status === 409, 'same courier refused');
  // supervisor of the area may do it even when the shop order is moving normally
  r = await call('POST /api/orders/:id/assign', S, { id: String(oWay) }, { courierId: String(c1), breakdown: true });
  ok(r.status === 200, 'supervisor of the area hands over: ' + JSON.stringify(r.json).slice(0, 100));
  await q("UPDATE users SET sup_regions='999999' WHERE id=$1", [sup]);
  r = await call('POST /api/orders/:id/assign', S, { id: String(oWay) }, { courierId: String(c2), breakdown: true });
  ok(r.status === 403, 'supervisor of another area refused');
  // not for an order nobody carries, and not for finished orders
  const oNone = (await q("INSERT INTO orders(customer_user_id, provider_id, status, total, region_id, data) VALUES($1,$2,'accepted',10,$3,'{}') RETURNING id", [cust, p, rid])).rows[0].id;
  r = await call('POST /api/orders/:id/assign', A, { id: String(oNone) }, { courierId: String(c2), breakdown: true });
  ok(r.status === 409, 'breakdown needs a courier on the order');
  const oDone = await mk('delivered');
  r = await call('POST /api/orders/:id/assign', A, { id: String(oDone) }, { courierId: String(c2), breakdown: true });
  ok(r.status === 409, 'delivered order cannot be handed over');
  console.log(`handover: ${pass} passed, ${bad} failed`); await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
