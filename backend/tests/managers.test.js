const { Pool } = require('./shim');
const M = require('../src/managers.js');
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  await q("DELETE FROM users WHERE phone='01012345678'");
  const mk = async (n, role) => Number((await q("INSERT INTO users(name, phone, password_hash, role, status) VALUES($1,$2,'x',$3,'active') RETURNING id", [n, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id);
  const cust = await mk('cust', 'customer'), sup = await mk('sup', 'supervisor'), adm = await mk('adm', 'admin'), mg = await mk('mg', 'manager');
  const g = (m, u, perms) => M.gate(pool, m, u, perms);
  eq(M.parsePerms('orders,bogus,finance_edit,orders'), ['orders', 'finance_edit', 'finance_view'], 'perms cleaned, finance_edit implies view');
  eq(M.parsePerms(null), [], 'empty perms');
  const OK = null;
  // nothing granted: every admin area is closed
  for (const [m, u] of [['GET', '/api/admin/users'], ['GET', '/api/orders'], ['GET', '/api/admin/providers/pending'], ['POST', '/api/admin/broadcasts'], ['GET', '/api/admin/commissions/overview'], ['GET', '/api/admin/captains'], ['GET', '/api/support/threads']])
    eq(await g(m, u, []), M.DENY, `no perms → ${m} ${u} refused`);
  // each permission opens its own area
  eq(await g('GET', '/api/admin/users?x=1', ['users']), OK, 'users perm lists users');
  eq(await g('GET', '/api/admin/users', ['couriers']), OK, 'any permission may read the user list');
  eq(await g('GET', '/api/admin/users', []), M.DENY, 'no permission, no list');
  eq(await g('PATCH', `/api/admin/users/${cust}/status`, ['couriers']), M.DENY, 'but changing users needs the users permission');
  eq(await g('PATCH', `/api/admin/users/${cust}/status`, ['users']), OK, 'users perm suspends a customer');
  eq(await g('PATCH', `/api/admin/users/${sup}/status`, ['users']), M.DENY, 'cannot suspend a supervisor');
  eq(await g('PATCH', `/api/admin/users/${adm}/status`, ['users']), M.DENY, 'cannot suspend the admin');
  eq(await g('PATCH', `/api/admin/users/${mg}/flag`, ['users']), M.DENY, 'cannot touch another manager');
  eq(await g('PATCH', `/api/admin/users/${cust}/password`, ['users']), M.DENY, 'never resets a password');
  eq(await g('GET', '/api/orders', ['orders']), OK, 'orders perm');
  eq(await g('POST', '/api/orders/5/assign', ['orders']), OK, 'orders perm: assign');
  eq(await g('POST', '/api/admin/rides/3/cancel', ['orders']), OK, 'orders perm: rides');
  eq(await g('PATCH', '/api/admin/rides/settings', ['orders']), M.DENY, 'ride settings are owner-only');
  eq(await g('GET', '/api/support/threads', ['support']), OK, 'support perm');
  eq(await g('GET', '/api/admin/chat-reports', ['support']), OK, 'support perm: chat reports');
  eq(await g('PATCH', '/api/admin/providers/4/decision', ['providers']), OK, 'providers perm');
  eq(await g('POST', '/api/admin/market-products', ['providers']), OK, 'providers perm: market products');
  eq(await g('PATCH', '/api/products/4', ['providers']), OK, 'providers perm: edit product');
  eq(await g('PATCH', '/api/products/4', []), M.DENY, 'no providers perm: edit product');
  eq(await g('GET', '/api/products', []), OK, 'public product list stays open');
  eq(await g('GET', '/api/admin/captains', ['couriers']), OK, 'couriers perm');
  eq(await g('DELETE', '/api/admin/couriers/9', ['couriers']), OK, 'couriers perm: delete');
  eq(await g('POST', '/api/admin/captains/9/balance', ['couriers']), M.DENY, 'captain balance needs finance_edit');
  eq(await g('POST', '/api/admin/captains/9/balance', ['finance_edit']), OK, 'finance_edit: captain balance');
  eq(await g('GET', '/api/admin/commissions/overview', ['finance_view']), OK, 'finance view reads');
  eq(await g('POST', '/api/admin/closings', ['finance_view']), M.DENY, 'finance view cannot close');
  eq(await g('POST', '/api/admin/commissions/settle', ['finance_view']), M.DENY, 'finance view cannot settle');
  eq(await g('POST', '/api/admin/closings', ['finance_edit']), OK, 'finance edit can close');
  eq(await g('POST', '/api/admin/broadcasts', ['notify']), OK, 'notify perm');
  eq(await g('POST', '/api/admin/broadcasts', ['users']), M.DENY, 'other perm does not notify');
  // owner-only areas, even with everything on
  const all = M.PERMS;
  for (const [m, u] of [['POST', '/api/admin/managers'], ['PATCH', '/api/admin/managers/1'], ['DELETE', '/api/admin/managers/1'], ['POST', '/api/admin/supervisors'], ['POST', '/api/admin/wipe'], ['GET', '/api/admin/wipe/preview'], ['POST', '/api/admin/replication'], ['PATCH', '/api/admin/settings'], ['PATCH', '/api/admin/features'], ['PATCH', '/api/admin/theme'], ['POST', '/api/admin/regions'], ['PATCH', '/api/admin/privacy'], ['PUT', '/api/admin/app-icon'], ['POST', '/api/admin/log/3/undo'], ['PATCH', '/api/admin/ride-types/1/commission'], ['POST', '/api/admin/services'], ['PATCH', '/api/admin/supervisors/1']])
    eq(await g(m, u, all), M.DENY, `owner-only: ${m} ${u}`);
  eq(await g('GET', '/api/admin/log', []), OK, 'everyone can read the change log');
  eq(await g('GET', '/api/me', []), OK, 'own account stays open');
  eq(await g('GET', '/api/admin/unknown-thing', all), M.DENY, 'unknown admin routes are closed by default');

  // routes
  const routes = {}; const app = {};
  for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (path, ...chain) => { routes[`${m.toUpperCase()} ${path}`] = chain; };
  const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
  const authF = (req, res, next) => { if (!req.auth) return res.status(401).json({ error: 'auth' }); next(); };
  const roles = (...a) => (req, res, next) => (!req.auth || !a.includes(req.auth.role) ? res.status(403).json({ error: 'forbidden' }) : next());
  let cleared = 0;
  M.register(app, { pool, auth: authF, roles, asyncRoute, positiveId, hashPassword: async p => 'h' + p, clearAuth: () => { cleared++; }, freePhone: async (db, id) => { await db.query("UPDATE users SET deleted_at=NOW() WHERE id=$1", [id]); }, cleanUser: r => ({ id: String(r.id), name: r.name, role: 'admin', manager: true, mgrPerms: M.parsePerms(r.mgr_perms) }) });
  async function call(key, { as, body, params } = {}) {
    const chain = routes[key]; const req = { auth: as, body: body || {}, query: {}, params: params || {} };
    const out = { status: 200, json: null }; const res = { status(c) { out.status = c; return this; }, json(j) { out.json = j; return this; } };
    let i = 0, err = null; const next = e => { if (e) { err = e; return; } const f = chain[i++]; if (f) return f(req, res, next); }; next();
    const t0 = Date.now(); while (!err && out.json === null && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 2));
    if (err) throw err; return out;
  }
  const A = { sub: String(adm), role: 'admin', baseRole: 'admin' }, MG = { sub: String(mg), role: 'admin', baseRole: 'manager' };
  eq((await call('POST /api/admin/managers', { as: MG, body: { name: 'شخص ما', phone: '01012345678', password: '12345678' } })).status, 403, 'a manager cannot create managers');
  eq((await call('POST /api/admin/managers', { as: { sub: String(cust), role: 'customer' }, body: {} })).status, 403, 'customer cannot');
  eq((await call('POST /api/admin/managers', { as: A, body: { name: 'ab', phone: '01012345678', password: '12345678' } })).status, 400, 'name too short');
  eq((await call('POST /api/admin/managers', { as: A, body: { name: 'أحمد محمد', phone: '123', password: '12345678' } })).status, 400, 'bad phone');
  eq((await call('POST /api/admin/managers', { as: A, body: { name: 'أحمد محمد', phone: '01012345678', password: '123' } })).status, 400, 'short password');
  const c = await call('POST /api/admin/managers', { as: A, body: { name: 'أحمد محمد', phone: '01012345678', password: '12345678', perms: ['orders', 'finance_edit', 'hack'] } });
  eq(c.status, 201, 'created');
  eq(c.json.user.mgrPerms, ['orders', 'finance_edit', 'finance_view'], 'perms stored clean');
  const row = (await q('SELECT role, status, mgr_perms, password_hash FROM users WHERE id=$1', [c.json.user.id])).rows[0];
  eq([row.role, row.status, row.password_hash], ['manager', 'active', 'h12345678'], 'row is a manager with a hashed password');
  eq((await call('POST /api/admin/managers', { as: A, body: { name: 'أحمد محمد', phone: '01012345678', password: '12345678' } })).status, 409, 'duplicate phone');
  const u = await call('PATCH /api/admin/managers/:id', { as: A, params: { id: c.json.user.id }, body: { perms: ['support'], name: 'أحمد علي' } });
  eq([u.status, u.json.user.mgrPerms, u.json.user.name], [200, ['support'], 'أحمد علي'], 'perms replaced');
  ok(cleared >= 1, 'auth cache cleared so the change is immediate');
  eq((await call('PATCH /api/admin/managers/:id', { as: A, params: { id: String(cust) }, body: { perms: ['orders'] } })).status, 404, 'only manager accounts');
  eq((await call('DELETE /api/admin/managers/:id', { as: A, params: { id: c.json.user.id } })).status, 200, 'deleted');
  eq((await call('DELETE /api/admin/managers/:id', { as: A, params: { id: c.json.user.id } })).status, 404, 'already gone');
  console.log(`managers: ${pass} pass, ${failN} fail`); process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
