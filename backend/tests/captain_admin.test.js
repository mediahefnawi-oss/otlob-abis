process.env.NO_SWEEP = '1';
const { Pool } = require('./shim');
const H = require('./h26');
const R2 = require('../src/rides2.js');
const { ok, eq, done } = H.counters();
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  await q('TRUNCATE ride_types, rides, captain_profiles, captain_photos, captain_ledger RESTART IDENTITY CASCADE');
  const pushes = []; const { app, asyncRoute, positiveId, auth, roles, call } = H;
  R2.register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib: { featureOn: async () => true }, pushToUsers: async (ids, p) => { pushes.push({ ids: ids.map(Number), p }); }, hashPassword: async p => 'h:' + p });
  const mk = async (n, role, ph) => Number((await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',TRUE) RETURNING id", [n, ph || H.phone(), role])).rows[0].id);
  const adm = await mk('owner', 'admin'), cap = await mk('كابتن', 'courier', '01011111111'), other = await mk('تاني', 'courier', '01022222222'), cust = await mk('عميل', 'customer');
  const t1 = (await q("INSERT INTO ride_types(name, base_fee, per_km, min_fee, adj_pct) VALUES('ملاكي',5,3,10,30) RETURNING id")).rows[0].id;
  const t2 = (await q("INSERT INTO ride_types(name, base_fee, per_km, min_fee, adj_pct) VALUES('توكتوك',3,2,8,30) RETURNING id")).rows[0].id;
  await q("INSERT INTO captain_profiles(user_id,type_id,model,color,plate,status) VALUES($1,$2,'لانسر','أبيض','1','approved')", [cap, t1]);
  const A = { sub: String(adm), role: 'admin' }, C = { sub: String(cust), role: 'customer' };
  const P = (body, id = cap) => call('PATCH /api/admin/captains/:id', { as: A, params: { id }, body });
  const get = async () => (await call('GET /api/admin/captains', { as: A })).json.captains.find(c => c.id === cap);
  eq((await call('PATCH /api/admin/captains/:id', { as: C, params: { id: cap }, body: { name: 'x' } })).status, 403, 'customer cannot edit');
  eq((await call('PUT /api/admin/captains/:id/photos/:kind', { as: C, params: { id: cap, kind: 'car' }, body: { image: 'x' } })).status, 403, 'customer cannot upload');
  let g = await get(); eq([g.mode, g.ordersOff, g.typeId], ['both', false, t1], 'default: both');
  /* vehicle + type + account */
  eq((await P({ model: 'كورولا', color: 'أسود', plate: '9 ب', typeId: t2 })).json.ok, true, 'vehicle data saved');
  g = await get(); eq([g.model, g.color, g.plate, g.typeId], ['كورولا', 'أسود', '9 ب', t2], 'vehicle updated');
  eq((await P({ name: 'سامي محمود', phone: '01033333333' })).json.ok, true, 'account saved');
  eq((await q('SELECT name, phone FROM users WHERE id=$1', [cap])).rows[0].phone, '01033333333', 'phone changed on the user');
  eq((await P({ phone: '01022222222' })).status, 409, 'phone used by another account');
  eq((await P({ phone: '123' })).status, 400, 'bad phone'); eq((await P({ name: 'ab' })).status, 400, 'short name');
  eq((await P({})).status, 400, 'empty edit');
  eq((await P({ model: 'x' }, 999999)).status, 404, 'unknown captain');
  /* mode */
  pushes.length = 0;
  await P({ mode: 'captain' }); g = await get(); eq([g.mode, g.ordersOff, g.status], ['captain', true, 'approved'], 'captain only');
  await P({ mode: 'courier' }); g = await get(); eq([g.mode, g.ordersOff, g.status], ['courier', false, 'suspended'], 'courier only (rides off)');
  await P({ mode: 'both' }); g = await get(); eq([g.mode, g.ordersOff, g.status], ['both', false, 'approved'], 'both');
  eq(pushes.length, 0, 'a mode change does not push the captain');
  eq((await P({ mode: 'weird' })).status, 400, 'bad mode');
  await q("UPDATE captain_profiles SET status='pending' WHERE user_id=$1", [cap]);
  eq((await P({ mode: 'captain' })).status, 409, 'mode needs an accepted account');
  await q("UPDATE captain_profiles SET status='approved' WHERE user_id=$1", [cap]);
  /* orders are kept away from a captain-only account */
  await P({ mode: 'captain' });
  const O = require('../src/orders.js');
  ok((await q("SELECT 1 FROM users WHERE id=$1 AND orders_off", [cap])).rowCount === 1, 'orders_off stored');
  /* photos */
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  eq((await call('PUT /api/admin/captains/:id/photos/:kind', { as: A, params: { id: cap, kind: 'car' }, body: { image: png } })).json.ok, true, 'car photo saved');
  eq((await call('PUT /api/admin/captains/:id/photos/:kind', { as: A, params: { id: cap, kind: 'selfie' }, body: { image: png } })).json.ok, true, 'captain photo saved');
  eq((await call('PUT /api/admin/captains/:id/photos/:kind', { as: A, params: { id: cap, kind: 'nope' }, body: { image: png } })).status, 400, 'bad kind');
  eq((await call('PUT /api/admin/captains/:id/photos/:kind', { as: A, params: { id: cap, kind: 'car' }, body: { image: 'data:text/html;base64,AAAA' } })).status, 400, 'not an image refused');
  eq((await call('PUT /api/admin/captains/:id/photos/:kind', { as: A, params: { id: 999999, kind: 'car' }, body: { image: png } })).status, 404, 'unknown captain photo');
  g = await get(); eq(g.photos.sort(), ['car', 'selfie'], 'listed photos');
  eq((await call('DELETE /api/admin/captains/:id/photos/:kind', { as: A, params: { id: cap, kind: 'car' } })).json.ok, true, 'photo deleted');
  eq((await call('DELETE /api/admin/captains/:id/photos/:kind', { as: A, params: { id: cap, kind: 'car' } })).status, 404, 'already gone');
  /* password */
  eq((await call('POST /api/admin/captains/:id/password', { as: A, params: { id: cap }, body: { password: 'short' } })).status, 400, 'short password');
  eq((await call('POST /api/admin/captains/:id/password', { as: A, params: { id: cap }, body: { password: 'Newpass123' } })).json.ok, true, 'password set');
  eq((await q('SELECT password_hash FROM users WHERE id=$1', [cap])).rows[0].password_hash, 'h:Newpass123', 'stored hashed by the app hasher');
  ok(!JSON.stringify((await q("SELECT before, after FROM audit_log WHERE entity='captain'")).rows).includes('Newpass123'), 'the password never reaches the audit log');
  ok((await q("SELECT 1 FROM audit_log WHERE action='captain.edit'")).rowCount >= 3, 'edits audited');
  /* status path still pushes */
  pushes.length = 0; await P({ status: 'suspended' }); ok(pushes.length === 1, 'a status change still tells the captain');
  const bad = await done('captain admin'); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
