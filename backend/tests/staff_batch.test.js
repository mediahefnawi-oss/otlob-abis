process.env.NO_SWEEP = '1';
const { Pool } = require('./shim');
const H = require('./h26');
const M = require('../src/managers.js');
const { ok, eq, done } = H.counters();
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const notes = []; let cleared = 0;
  const { app, asyncRoute, positiveId, auth, roles, call } = H;
  M.register(app, { pool, auth, roles, asyncRoute, positiveId, hashPassword: async p => 'h' + p, clearAuth: () => { cleared++; }, freePhone: async () => {}, cleanUser: x => ({ id: String(x.id), role: x.role, supRegions: x.sup_regions, mgrPerms: x.mgr_perms }) });
  require('../src/orders.js')(app, { pool, auth, authAny: auth, roles, asyncRoute, positiveId, maintenanceState: async () => ({ enabled: true }), loadSettings: async () => ({}), cleanUser: x => x, pushToUsers: async (ids, p) => { notes.push({ ids: ids.map(Number), p }); } });
  const mk = async (n, role, status = 'active') => Number((await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,$4,TRUE) RETURNING id", [n, H.phone(), role, status])).rows[0].id);
  const reg = async n => Number((await q("INSERT INTO regions(name) VALUES($1||floor(random()*1e9)) RETURNING id", [n])).rows[0].id);
  const adm = await mk('owner', 'admin'), mg = await mk('مدير', 'manager'), cu = await mk('عميل للترقية', 'customer'), cu2 = await mk('عميل تاني', 'customer'), prov = await mk('صاحب محل', 'provider'), cour = await mk('مندوب', 'courier'), susp = await mk('موقوف', 'customer', 'suspended');
  const r1 = await reg('ر1'), r2 = await reg('ر2');
  const A = { sub: String(adm), role: 'admin' }, MG = { sub: String(mg), role: 'admin', baseRole: 'manager' }, CU = { sub: String(cu), role: 'customer' };

  /* ================= turning an account into a supervisor / manager ================= */
  const role = (as, id, body) => call('POST /api/admin/users/:id/role', { as, params: { id: String(id) }, body });
  eq((await role(CU, cu2, { role: 'manager', perms: ['orders'] })).status, 403, 'a customer cannot');
  eq((await role(MG, cu2, { role: 'manager', perms: ['orders'] })).status, 403, 'a manager cannot promote anybody (owner only)');
  eq(await M.gate(pool, 'POST', `/api/admin/users/${cu2}/role`, ['users', 'orders']), M.DENY, 'the manager gate blocks it even with every permission');
  eq((await role(A, cu, { role: 'boss' })).status, 400, 'an unknown role');
  eq((await role(A, cu, { role: 'supervisor', regions: [] })).status, 400, 'a supervisor needs at least one area');
  eq((await role(A, cu, { role: 'supervisor', regions: [99999999] })).status, 400, 'an unknown area is refused');
  eq((await role(A, cu, { role: 'manager', perms: [] })).status, 400, 'a manager needs at least one permission');
  eq((await role(A, cu, { role: 'manager', perms: ['nothing'] })).status, 400, 'only real permissions count');
  eq((await role(A, adm, { role: 'customer' })).status, 409, 'the owner cannot change his own account');
  eq((await role(A, prov, { role: 'supervisor', regions: [r1] })).status, 409, 'a shop owner keeps his type');
  eq((await role(A, cour, { role: 'manager', perms: ['orders'] })).status, 409, 'a courier keeps his type');
  eq((await role(A, mg, { role: 'customer' })).status, 200, 'a manager can be turned back into a customer');
  await q("UPDATE users SET role='manager', mgr_perms='orders' WHERE id=$1", [mg]);
  eq((await role(A, susp, { role: 'supervisor', regions: [r1] })).status, 409, 'a suspended account must be activated first');
  eq((await role(A, 99999999, { role: 'customer' })).status, 404, 'no such account');
  let r = await role(A, cu, { role: 'supervisor', regions: [r1, r2, r1] });
  eq([r.status, r.json.user.role, r.json.user.supRegions], [200, 'supervisor', `${r1},${r2}`], 'customer -> supervisor with two areas (duplicates dropped)');
  eq((await q('SELECT role, sup_regions, mgr_perms FROM users WHERE id=$1', [cu])).rows[0].mgr_perms, '', 'no manager permissions on a supervisor');
  ok(cleared >= 1, 'the login cache is cleared so the new role applies at once');
  r = await role(A, cu, { role: 'manager', perms: ['orders', 'finance_edit', 'bogus'] });
  eq([r.status, r.json.user.role, r.json.user.mgrPerms], [200, 'manager', 'orders,finance_edit,finance_view'], 'supervisor -> manager (finance_edit brings finance_view)');
  eq((await q('SELECT sup_regions FROM users WHERE id=$1', [cu])).rows[0].sup_regions, '', 'the areas are cleared when he becomes a manager');
  r = await role(A, cu, { role: 'customer' });
  eq([r.status, r.json.user.role], [200, 'customer'], 'and back to a normal customer');
  const back = (await q('SELECT sup_regions, mgr_perms FROM users WHERE id=$1', [cu])).rows[0]; eq([back.sup_regions, back.mgr_perms], ['', ''], 'nothing is left behind');

  /* ================= linking 1-3 orders to one courier ================= */
  const sup = await mk('مشرف المنطقة', 'supervisor'), c1 = await mk('مندوب أ', 'courier'), c2 = await mk('مندوب ب', 'courier'), c3 = await mk('مندوب غير مفعل', 'courier', 'suspended'), cust = await mk('عميل الطلبات', 'customer');
  await q('UPDATE users SET sup_regions=$1 WHERE id=$2', [String(r1), sup]);
  const p = Number((await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'supermarket','سوبر','01000000000','active',TRUE) RETURNING id", [prov])).rows[0].id);
  const S = { sub: String(sup), role: 'supervisor' };
  const order = async (status, region = r1, courier = null) => Number((await q("INSERT INTO orders(customer_user_id, provider_id, courier_user_id, status, total, region_id, data) VALUES($1,$2,$3,$4,100,$5,$6) RETURNING id", [cust, p, courier, status, region, JSON.stringify({ providerType: 'supermarket', history: [], providerName: 'سوبر' })])).rows[0].id);
  const dispatch = (as, orderIds, courierId) => call('POST /api/staff/dispatch', { as, body: { orderIds: orderIds.map(String), courierId: courierId && String(courierId) } });
  const owner = async id => (await q('SELECT courier_user_id, status, data FROM orders WHERE id=$1', [id])).rows[0];
  const o1 = await order('accepted'), o2 = await order('ready'), o3 = await order('accepted'), o4 = await order('accepted');
  eq((await dispatch(CU, [o1], c1)).status, 403, 'a customer cannot link orders');
  eq((await dispatch(S, [], c1)).status, 400, 'no orders'); eq((await dispatch(S, [o1], null)).status, 400, 'no courier');
  eq((await dispatch(S, [o1, o2, o3, o4], c1)).status, 400, 'at most 3 orders for one courier');
  eq((await dispatch(S, [o1], 99999999)).status, 404, 'a courier that does not exist'); eq((await dispatch(S, [o1], c3)).status, 404, 'a suspended courier is not available');
  // a supervisor of ANOTHER area / orders of mixed areas: nothing is linked at all
  const other = await order('accepted', r2); eq((await dispatch(S, [o1, other], c1)).status, 403, 'an order outside his areas refuses the whole batch');
  eq((await owner(o1)).courier_user_id, null, '... and o1 was not linked (all or nothing)');
  const mixed = await dispatch(A, [o1, other], c1); eq(mixed.status, 409, 'the owner too: one batch = one area');
  const newOne = await order('pending'), carried = await order('picked_up', r1, c2);
  eq((await dispatch(S, [newOne], c1)).status, 409, 'a pending order cannot be linked yet'); eq((await dispatch(S, [carried], c1)).status, 409, 'an order already picked up cannot be linked');
  // the real thing: two orders, the shop is NOT stuck (a plain accepted/ready order) - the supervisor may still link them
  notes.length = 0;
  r = await dispatch(S, [o1, o2], c1);
  eq([r.status, r.json.orders.length], [200, 2], 'a supervisor links two orders of his area to one courier: ' + JSON.stringify(r.json).slice(0, 100));
  const a = await owner(o1), b = await owner(o2);
  eq([Number(a.courier_user_id), Number(b.courier_user_id)], [c1, c1], 'both belong to the courier'); eq([a.status, b.status], ['accepted', 'ready'], 'their status is unchanged');
  ok(a.data.dispatch && a.data.dispatch.batchId === b.data.dispatch.batchId && a.data.dispatch.n === 2, 'they share a batch id (the courier sees them as one job)');
  eq([a.data.courierName, a.data.courierPhone ? true : false], ['مندوب أ', true], 'the courier details are on the order for the customer');
  ok(notes.filter(n => n.ids.includes(c1)).length === 1 && notes.find(n => n.ids.includes(c1)).p.body.includes('+'), 'the courier gets ONE notification for the batch');
  ok(notes.filter(n => n.ids.includes(cust)).length === 2, 'each customer is told');
  ok((await q("SELECT 1 FROM audit_log WHERE action='order.dispatch'")).rowCount >= 2, 'audited');
  ok((await q('SELECT 1 FROM order_messages WHERE order_id=$1', [o1]).catch(() => ({ rowCount: 1 }))).rowCount >= 1, 'a message in the order chat');
  // the courier already has 2: one more is fine (3), two more are not
  eq((await dispatch(S, [o3, o4], c1)).status, 409, 'the courier already carries 2: a third and fourth are refused');
  eq((await dispatch(S, [o3], c1)).status, 200, 'but one more makes 3');
  eq((await dispatch(S, [o4], c1)).status, 409, 'a fourth in total is refused');
  // repeat on the same pair is harmless; moving to another courier tells the old one
  eq((await dispatch(S, [o1], c1)).status, 200, 'linking an already linked order to the same courier is harmless');
  notes.length = 0;
  r = await dispatch(S, [o4], c2); eq(r.status, 200, 'another courier takes o4');
  r = await dispatch(S, [o1], c2); eq(r.status, 200, 'o1 moves from the first courier to the second (not picked up yet)');
  ok(notes.some(n => n.ids.includes(c1) && n.p.title.includes('سحب')), 'the first courier is told it was taken from him');
  eq(Number((await owner(o1)).courier_user_id), c2, 'now it belongs to the second one');
  const o5 = await order('accepted');
  eq((await dispatch(A, [o5], c1)).status, 200, 'the owner can link too');
  eq((await dispatch(A, [o2], c2)).status, 409, 'and the same limit of 3 applies to him');
  const bad = done('staff_batch'); await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
