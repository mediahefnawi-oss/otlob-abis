process.env.NO_SWEEP = '1';
const { Pool } = require('./shim');
const H = require('./h26');
const CV = require('../src/courierVehicles.js');
const { ok, eq, done } = H.counters();
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  await q('DELETE FROM courier_vehicles'); await q("DELETE FROM service_meta WHERE key='courier_vehicles_seeded'");
  const { app, asyncRoute, positiveId, auth, roles, call } = H;
  CV.register(app, { pool, auth, roles, asyncRoute, positiveId });
  const mk = async (n, role, veh) => Number((await q("INSERT INTO users(name, phone, password_hash, role, status, vehicle) VALUES($1,'01'||floor(random()*1e9)::bigint::text,'x',$2,'active',$3) RETURNING id", [n, role, veh || ''])).rows[0].id);
  const adm = await mk('owner', 'admin'), cu = await mk('عميل', 'customer');
  await mk('مندوب1', 'courier', 'موتوسيكل'); await mk('مندوب2', 'courier', 'موتوسيكل'); await mk('مندوب3', 'courier', 'سيارة');
  const A = { sub: String(adm), role: 'admin' }, C = { sub: String(cu), role: 'customer' };

  ok(CV.cleanVehicle({ name: 'a' }, false) === null, 'a one letter name is refused');
  eq(CV.cleanVehicle({ name: '  توكتوك   سريع ' }, false).name, 'توكتوك سريع', 'spaces are tidied');
  ok(CV.cleanVehicle({ active: true }, true).active === true, 'partial update keeps only what was sent');

  // public, no account: the three that always existed, in order
  const pub = await call('GET /api/public/courier-vehicles');
  eq(pub.status, 200, 'public list works without an account');
  eq(pub.json.vehicles.map(v => v.name).join(','), 'موتوسيكل,دراجة,سيارة', 'starts with the three existing means');
  ok(!!pub.json.vehicles[0].image && pub.json.vehicles[1].image === null, 'moto has its picture, the bicycle has none yet');
  eq((await call('GET /api/admin/courier-vehicles', { as: C })).status, 403, 'a customer cannot manage them');
  const adm1 = (await call('GET /api/admin/courier-vehicles', { as: A })).json.vehicles;
  eq(adm1.find(v => v.name === 'موتوسيكل').couriers, 2, 'the owner sees how many couriers use each');

  const add = await call('POST /api/admin/courier-vehicles', { as: A, body: { name: 'توكتوك' } });
  eq(add.status, 201, 'owner adds a means'); const tid = add.json.vehicle.id;
  eq((await call('POST /api/admin/courier-vehicles', { as: A, body: { name: 'توكتوك' } })).status, 409, 'a duplicate name is refused');
  eq((await call('GET /api/public/courier-vehicles')).json.vehicles.length, 4, 'the new one shows at sign-up');
  eq((await call('PATCH /api/admin/courier-vehicles/:id', { as: A, params: { id: String(tid) }, body: { active: false } })).json.vehicle.active, false, 'hide');
  eq((await call('GET /api/public/courier-vehicles')).json.vehicles.length, 3, 'a hidden one is not offered at sign-up');
  eq((await call('PATCH /api/admin/courier-vehicles/:id', { as: A, params: { id: String(tid) }, body: { name: 'تروسيكل', active: true } })).json.vehicle.name, 'تروسيكل', 'rename');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  eq((await call('PUT /api/admin/courier-vehicles/:id/image', { as: A, params: { id: String(tid) }, body: { image: png } })).status, 200, 'picture saved');
  eq((await call('PUT /api/admin/courier-vehicles/:id/image', { as: A, params: { id: String(tid) }, body: { image: 'x' } })).status, 400, 'a bad picture is refused');

  // delete the moto: couriers keep their own text
  const moto = adm1.find(v => v.name === 'موتوسيكل');
  eq((await call('DELETE /api/admin/courier-vehicles/:id', { as: A, params: { id: String(moto.id) } })).status, 200, 'delete a means');
  eq((await q("SELECT COUNT(*)::int AS n FROM users WHERE role='courier' AND vehicle='موتوسيكل'")).rows[0].n, 2, 'couriers that used it are not touched');
  eq((await call('GET /api/public/courier-vehicles')).json.vehicles.some(v => v.name === 'موتوسيكل'), false, 'it is gone from sign-up');
  // never re-added after the owner deleted it
  eq((await q('SELECT COUNT(*)::int AS n FROM courier_vehicles WHERE name=$1', ['موتوسيكل'])).rows[0].n, 0, 'defaults are not re-created');
  done();
})().catch(e => { console.error(e); process.exit(1); });
