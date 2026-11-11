// owner activity log + feature switches for old features
const { Pool } = require('./shim');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const pass1 = (req, res, next) => next();
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const deps = { pool, auth: pass1, authAny: pass1, roles: () => pass1, asyncRoute, positiveId, clearCaches() {} };
  require('../src/orders.js')(app, { ...deps, maintenanceState: async () => ({ enabled: true }), loadSettings: async () => ({}), cleanUser: x => x, pushToUsers: async () => {} });
  require('../src/extras.js').register(app, { ...deps, services: require('../src/services.js') });
  require('../src/support.js')(app, deps);
  const log = require('../src/adminlog.js'); log.register(app, deps);
  const call = (key, as, body, params, query) => { const loc = {}; return new Promise(resolve => {
    const res = { locals: loc, set() { return this; }, status(c) { this.c = c; return this; }, json(j) { resolve({ status: this.c || 200, json: j, locals: loc }); return this; } };
    const chain = routes[key];
    chain[chain.length - 1]({ auth: as, params: params || {}, body: body || {}, query: query || {} }, res, e => resolve({ status: e.status || e.http || 500, json: { error: e.message }, locals: loc }));
  }); };
  const eq = (a, b, m) => ok(a === b, `${m}: got ${a}, want ${b}`);
  await q("UPDATE app_settings SET features='{}'::jsonb WHERE id=1"); await q('DELETE FROM admin_log');
  const mk = async (n, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status) VALUES($1,$2,'x',$3,'active') RETURNING id", [n, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const adm = await mk('المالك', 'admin'), cus = await mk('عميل', 'customer');
  const A = { sub: String(adm), role: 'admin', status: 'active' }, C = { sub: String(cus), role: 'customer', status: 'active' };
  const f = async () => Object.fromEntries((await call('GET /api/admin/features', A)).json.features.map(x => [x.key, x.on]));

  console.log('A) old features are ON by default');
  let feats = await f(); eq(feats.coupons, true, 'coupons on'); eq(feats.ratings, true, 'ratings on'); eq(feats.support, true, 'support on');

  console.log('B) switching one off blocks it');
  let r = await call('PATCH /api/admin/features', A, { key: 'coupons', on: false }); eq(r.status, 200, 'switch coupons off');
  eq(r.locals.undo && r.locals.undo.before, true, 'the route leaves an undo with the old value');
  await log.record(pool, { method: 'PATCH', path: '/api/admin/features', status: 200, auth: A, body: { key: 'coupons', on: false }, undo: r.locals.undo });
  eq((await call('POST /api/coupons/check', C, { code: 'X', lines: [] })).status, 409, 'coupon check refused');
  r = await call('POST /api/support/mine/messages', C, { text: 'مرحبا' }); await call('PATCH /api/admin/features', A, { key: 'support', on: false });
  eq((await call('POST /api/support/mine/messages', C, { text: 'مرحبا' })).status, 409, 'support refused when off');

  console.log('C) the log');
  r = await call('GET /api/admin/log', A); eq(r.status, 200, 'owner reads the log'); eq(r.json.entries.length, 1, 'one entry'); const e = r.json.entries[0];
  ok(/الكوبونات/.test(e.summary) && /إيقاف/.test(e.summary), 'plain Arabic summary: ' + e.summary); eq(e.canUndo, true, 'can undo'); eq(e.label, 'مفاتيح الميزات', 'label');
  await log.record(pool, { method: 'POST', path: '/api/admin/regions', status: 201, auth: A, body: { name: 'حي جديد', token: 'secret123', fee: 12 } });
  await log.record(pool, { method: 'POST', path: '/api/admin/regions', status: 400, auth: A, body: {} }); await log.record(pool, { method: 'GET', path: '/api/admin/regions', status: 200, auth: A });
  await log.record(pool, { method: 'POST', path: '/api/admin/regions', status: 201, auth: C, body: {} });
  r = await call('GET /api/admin/log', A); eq(r.json.entries.length, 2, 'only successful owner writes are recorded');
  const reg = r.json.entries[0]; eq(reg.label, 'المناطق', 'regions label'); ok(!/secret123/.test(reg.details), 'secrets never stored'); eq(reg.canUndo, false, 'no undo for a region');
  eq((await call('POST /api/admin/log/:id/undo', A, {}, { id: reg.id })).status, 404, 'cannot undo what has no undo');

  console.log('D) undo');
  r = await call('POST /api/admin/log/:id/undo', A, {}, { id: e.id }); eq(r.status, 200, 'undo works');
  eq((await f()).coupons, true, 'coupons back on');
  eq((await call('POST /api/admin/log/:id/undo', A, {}, { id: e.id })).status, 409, 'cannot undo twice');
  eq((await call('GET /api/admin/log', A)).json.entries.find(x => x.id === e.id).undone, true, 'marked as undone');
  await log.record(pool, { method: 'PATCH', path: '/api/admin/settings', status: 200, auth: A, body: { announcement: 'جديد' }, undo: { type: 'settings', patch: { announcement: 'القديم' } } });
  const s = (await call('GET /api/admin/log', A)).json.entries[0]; ok(/إعلان/.test(s.summary), 'settings summary: ' + s.summary);
  await q("UPDATE app_settings SET announcement='جديد' WHERE id=1");
  eq((await call('POST /api/admin/log/:id/undo', A, {}, { id: s.id })).status, 200, 'settings undo');
  eq((await q('SELECT announcement FROM app_settings WHERE id=1')).rows[0].announcement, 'القديم', 'the old announcement is back');
  console.log('E) the log is capped');
  for (let i = 0; i < 3; i++) await log.record(pool, { method: 'PATCH', path: '/api/admin/ads/1', status: 200, auth: A, body: { i } });
  ok((await q('SELECT COUNT(*)::int n FROM admin_log')).rows[0].n < 500, 'log stays bounded');
  await q("UPDATE app_settings SET features='{}'::jsonb WHERE id=1");
  console.log(bad ? `FAILED ${bad}` : 'ALL OK', 'pass=' + pass);
  await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
