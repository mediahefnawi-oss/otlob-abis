process.env.NO_SWEEP = '1';
const { Pool } = require('./shim');
const H = require('./h26');
const R2 = require('../src/rides2.js');
const { ok, eq, done } = H.counters();
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  await q('TRUNCATE ride_types, rides, captain_profiles, captain_photos, captain_ledger, captain_change_requests RESTART IDENTITY CASCADE');
  const pushes = []; const { app, asyncRoute, positiveId, auth, roles, call } = H;
  R2.register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib: { featureOn: async () => true }, pushToUsers: async (ids, p) => { pushes.push({ ids: ids.map(Number), p }); }, hashPassword: async p => 'h:' + p });
  const mk = async (n, role) => Number((await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',TRUE) RETURNING id", [n, H.phone(), role])).rows[0].id);
  const adm = await mk('owner', 'admin'), cap = await mk('كابتن', 'courier'), newc = await mk('جديد', 'courier'), cust = await mk('عميل', 'customer'), cust2 = await mk('عميل2', 'customer');
  const t1 = (await q("INSERT INTO ride_types(name, base_fee, per_km, min_fee, adj_pct) VALUES('ملاكي',5,3,10,30) RETURNING id")).rows[0].id;
  const t2 = (await q("INSERT INTO ride_types(name, base_fee, per_km, min_fee, adj_pct) VALUES('توكتوك',3,2,8,30) RETURNING id")).rows[0].id;
  await q("INSERT INTO captain_profiles(user_id,type_id,model,color,plate,status) VALUES($1,$2,'لانسر','أبيض','111','approved')", [cap, t1]);
  const A = { sub: String(adm), role: 'admin' }, K = { sub: String(cap), role: 'courier' }, N = { sub: String(newc), role: 'courier' }, C = { sub: String(cust), role: 'customer' }, C2 = { sub: String(cust2), role: 'customer' };
  const IMG = 'data:image/png;base64,iVBORw0KGgo=';
  const prof = () => q('SELECT * FROM captain_profiles WHERE user_id=$1', [cap]).then(r => r.rows[0]);
  const pend = () => q("SELECT * FROM captain_change_requests WHERE user_id=$1 AND status='pending' ORDER BY id", [cap]).then(r => r.rows);

  /* an accepted captain only sends a request: nothing changes, he keeps working */
  let r = await call('PUT /api/captain/profile', { as: K, body: { typeId: t2, model: 'كورولا', color: 'أسود', plate: '999', nationalId: '1' } });
  eq([r.status, r.json.pending], [200, true], 'profile edit becomes a request');
  let p = await prof(); eq([p.model, p.plate, p.type_id, p.status], ['لانسر', '111', t1, 'approved'], 'data unchanged and still approved');
  await call('PUT /api/captain/profile', { as: K, body: { typeId: t2, model: 'كورولا 2', color: 'أسود', plate: '999', nationalId: '1' } });
  eq((await pend()).length, 1, 'a second request replaces the first');
  r = await call('PUT /api/captain/photos/:kind', { as: K, params: { kind: 'car' }, body: { image: IMG } });
  eq([r.status, r.json.pending], [200, true], 'photo becomes a request');
  eq((await q('SELECT COUNT(*)::int n FROM captain_photos WHERE user_id=$1', [cap])).rows[0].n, 0, 'no photo stored yet');
  await call('PUT /api/captain/photos/:kind', { as: K, params: { kind: 'selfie' }, body: { image: IMG } });
  eq((await pend()).length, 3, 'profile + 2 photos pending');
  ok(pushes.some(x => x.ids.includes(adm)), 'the owner is alerted');
  eq((await call('GET /api/captain/me', { as: K })).json.profile.pending.sort(), ['car', 'profile', 'selfie'], 'captain sees what is pending');

  /* a captain still being registered edits directly (old behaviour) */
  await q("INSERT INTO captain_profiles(user_id,type_id,model,color,plate,status) VALUES($1,$2,'a','b','c','pending')", [newc, t1]);
  r = await call('PUT /api/captain/profile', { as: N, body: { typeId: t2, model: 'جديد', color: 'ل', plate: '5' } });
  eq([r.status, r.json.pending], [200, undefined], 'pending captain edits directly');
  eq((await q('SELECT model FROM captain_profiles WHERE user_id=$1', [newc])).rows[0].model, 'جديد', 'saved at once');
  await call('PUT /api/captain/photos/:kind', { as: N, params: { kind: 'car' }, body: { image: IMG } });
  eq((await q('SELECT COUNT(*)::int n FROM captain_photos WHERE user_id=$1', [newc])).rows[0].n, 1, 'photo saved at once for a new captain');

  /* the owner sees old vs new and decides */
  eq((await call('GET /api/admin/captain-requests', { as: C })).status, 403, 'customer cannot list');
  eq((await call('GET /api/admin/captain-requests', { as: K })).status, 403, 'captain cannot list');
  const L = (await call('GET /api/admin/captain-requests', { as: A })).json.requests;
  eq(L.length, 3, 'three requests listed');
  const rp = L.find(x => x.kind === 'profile'), rc = L.find(x => x.photoKind === 'car'), rs = L.find(x => x.photoKind === 'selfie');
  eq([rp.current.model, rp.next.model, rp.next.typeName], ['لانسر', 'كورولا 2', 'توكتوك'], 'old and new side by side');
  const ph = await call('GET /api/admin/captain-requests/:id/photo', { as: A, params: { id: rc.id } });
  ok(Buffer.isBuffer(ph.sent) && ph.sent.length > 0, 'owner sees the new photo');
  eq((await call('POST /api/admin/captain-requests/:id/approve', { as: K, params: { id: rp.id } })).status, 403, 'captain cannot approve his own');
  pushes.length = 0;
  eq((await call('POST /api/admin/captain-requests/:id/approve', { as: A, params: { id: rp.id } })).json.ok, true, 'approve profile');
  p = await prof(); eq([p.model, p.plate, p.type_id, p.status], ['كورولا 2', '999', t2, 'approved'], 'data applied, still approved');
  ok(pushes.some(x => x.ids.includes(cap)), 'captain told');
  eq((await call('POST /api/admin/captain-requests/:id/approve', { as: A, params: { id: rp.id } })).status, 404, 'cannot approve twice');
  await call('POST /api/admin/captain-requests/:id/approve', { as: A, params: { id: rc.id } });
  eq((await q("SELECT COUNT(*)::int n FROM captain_photos WHERE user_id=$1 AND kind='car'", [cap])).rows[0].n, 1, 'photo applied');
  eq((await call('POST /api/admin/captain-requests/:id/reject', { as: A, params: { id: rs.id }, body: { note: 'الصورة مش واضحة' } })).json.ok, true, 'reject');
  eq((await q("SELECT COUNT(*)::int n FROM captain_photos WHERE user_id=$1 AND kind='selfie'", [cap])).rows[0].n, 0, 'rejected photo not stored');
  ok(pushes.some(x => x.ids.includes(cap) && /رفض/.test(x.p.title)), 'captain told about the refusal');
  eq((await pend()).length, 0, 'nothing pending');
  eq((await call('GET /api/captain/me', { as: K })).json.profile.pending, [], 'captain sees nothing pending');

  /* a suspended captain cannot sneak a change through either */
  await q("UPDATE captain_profiles SET status='suspended' WHERE user_id=$1", [cap]);
  r = await call('PUT /api/captain/profile', { as: K, body: { typeId: t1, model: 'س', color: 'ص', plate: '1' } });
  eq(r.json.pending, true, 'suspended captain also needs approval');
  await q("UPDATE captain_profiles SET status='approved' WHERE user_id=$1", [cap]);

  /* the owner's own direct edit still works at once */
  eq((await call('PATCH /api/admin/captains/:id', { as: A, params: { id: cap }, body: { model: 'من المالك' } })).json.ok, true, 'owner edits directly');
  eq((await prof()).model, 'من المالك', 'applied');

  /* customer sees the captain's photo and car only on his own ride, never the licenses */
  await q("INSERT INTO captain_photos(user_id,kind,image,mime) VALUES($1,'license',$2,'image/png'),($1,'driver',$2,'image/png'),($1,'selfie',$2,'image/png')", [cap, Buffer.from('x')]);
  const ride = async (cid, status) => Number((await q("INSERT INTO rides(customer_id,type_id,driver_id,from_lat,from_lng,from_text,to_lat,to_lng,to_text,km,minutes,suggested,offered,expires_at,status) VALUES($1,$2,$3,30,31,'أ',30.1,31.1,'ب',5,10,20,20,NOW()+INTERVAL '10 minutes',$4) RETURNING id", [cid, t1, cap, status])).rows[0].id);
  const rid = await ride(cust, 'assigned');
  const G = (as, id, kind) => call('GET /api/rides/:id/driver-photo/:kind', { as, params: { id, kind } });
  eq((await G(C, rid, 'selfie')).status, 200, 'customer sees the captain photo');
  eq((await G(C, rid, 'car')).status, 200, 'customer sees the car photo');
  eq((await G(C, rid, 'license')).status, 404, 'never the vehicle license');
  eq((await G(C, rid, 'driver')).status, 404, 'never the driving license');
  eq((await G(C2, rid, 'selfie')).status, 404, 'another customer cannot');
  eq((await G(K, rid, 'selfie')).status, 403, 'not for captains/others');
  const rid2 = await ride(cust, 'completed'); eq((await G(C, rid2, 'selfie')).status, 404, 'only while the ride is live');
  await q('DELETE FROM rides WHERE id=$1', [rid2]);
  const cur = (await call('GET /api/rides/current', { as: C })).json;
  eq(cur.driver && cur.driver.photos.sort(), ['car', 'selfie'], 'ride json lists the available photos');
  process.exit(done('captain requests') ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
