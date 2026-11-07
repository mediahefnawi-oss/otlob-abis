process.env.NO_SWEEP = '1';
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
  const cust = await u('ع', 'customer'), po = await u('ص', 'provider');
  const rid = (await q("INSERT INTO regions(name) VALUES('a'||floor(random()*1e9)) RETURNING id")).rows[0].id;
  const far = await u('بعيد', 'courier'), near = await u('قريب', 'courier'), noloc = await u('بدون موقع', 'courier'), stale = await u('موقعه قديم', 'courier');
  for (const c of [far, near, noloc, stale]) await q('UPDATE users SET region_id=$1 WHERE id=$2', [rid, c]);
  // shop at (30.00, 31.00); near ~0.5 km, far ~5 km
  const p = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open,lat,lng) VALUES($1,'restaurant','س','01000000000','active',TRUE,30.0,31.0) RETURNING id", [po])).rows[0].id;
  const pn = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'restaurant','ن','01000000000','active',TRUE) RETURNING id", [po])).rows[0].id; // no position
  const loc = (id, lat, lng, ago = '0 seconds') => q(`INSERT INTO courier_locations(courier_id, lat, lng, updated_at) VALUES($1,$2,$3, NOW() - INTERVAL '${ago}') ON CONFLICT (courier_id) DO UPDATE SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, updated_at=EXCLUDED.updated_at`, [id, lat, lng]);
  await loc(near, 30.0045, 31.0); await loc(far, 30.045, 31.0); await loc(stale, 30.0001, 31.0, '10 minutes');
  const P = { sub: String(po), role: 'provider' };
  const mk = async prov => (await q("INSERT INTO orders(customer_user_id, provider_id, status, total, region_id, data) VALUES($1,$2,'pending',100,$3,$4) RETURNING id", [cust, prov, rid, JSON.stringify({ providerOwnerId: String(po), providerName: 'س', providerType: 'restaurant', subtotal: 80, deliveryFee: 20, history: [] })])).rows[0].id;
  const who = async id => (await q('SELECT courier_user_id c, data FROM orders WHERE id=$1', [id])).rows[0];
  const accept = id => call('POST /api/orders/:id/action', P, { id: String(id) }, { action: 'accept' });

  // switch OFF: nothing is assigned
  await q('UPDATE app_settings SET auto_assign=FALSE WHERE id=1');
  let o1 = await mk(p); let r = await accept(o1);
  ok(r.status === 200 && (await who(o1)).c === null, 'switch off: stays open for couriers');
  // switch ON: the nearest courier with a fresh position gets it
  await q('UPDATE app_settings SET auto_assign=TRUE WHERE id=1');
  let o2 = await mk(p); r = await accept(o2);
  let w = await who(o2);
  ok(Number(w.c) === Number(near), 'nearest courier gets it: ' + w.c + ' vs near ' + near);
  ok(w.data.courierName === 'قريب' && w.data.autoAssigned && !w.data.courierAck, 'marked as auto-assigned, not yet opened');
  ok(r.json.order && r.json.order.autoPending === true, 'order json tells the app to open it');
  ok(notes.some(n => n.ids.includes(Number(near))), 'the courier is notified');
  const msgs = (await q('SELECT body FROM messages WHERE order_id=$1', [o2])).rows.map(x => x.body);
  ok(msgs.some(m => m.includes('الأقرب للمتجر')), 'the customer is told: ' + JSON.stringify(msgs));
  // the courier opens it: it stays with him and the sweeper leaves it alone
  r = await call('POST /api/orders/:id/ack', { sub: String(near), role: 'courier' }, { id: String(o2) });
  ok(r.status === 200 && r.json.order.autoPending !== true, 'opening it confirms the order');
  await q("UPDATE orders SET data = jsonb_set(data, '{autoAssigned,at}', to_jsonb($1::bigint)) WHERE id=$2", [Date.now() - 10 * 60 * 1000, o2]);
  ok((await app.sweepUnacked()) === 0 && Number((await who(o2)).c) === Number(near), 'confirmed order is never taken back');
  r = await call('POST /api/orders/:id/ack', { sub: String(far), role: 'courier' }, { id: String(o2) });
  ok(r.status === 404, 'another courier cannot confirm it');

  // a courier who ignores it loses it, the next best gets it, in order: far (5 km) then stale/noloc (counted far), then nobody
  let o3 = await mk(p); await accept(o3);
  ok(Number((await who(o3)).c) === Number(near) || true, 'assigned');
  // near already carries o2 (busy 1) -> score 0.5+2=2.5 still beats far (5 + 0)
  ok(Number((await who(o3)).c) === Number(near), 'a busy but much nearer courier still wins (0.5 + 2 < 5)');
  const old = async id => q("UPDATE orders SET data = jsonb_set(data, '{autoAssigned,at}', to_jsonb($1::bigint)) WHERE id=$2", [Date.now() - 3 * 60 * 1000, id]);
  await old(o3);
  ok((await app.sweepUnacked()) >= 1, 'sweeper moves the unopened order on');
  w = await who(o3);
  ok(Number(w.c) === Number(far), 'next: the far one (5 km beats unknown position): ' + w.c);
  ok(w.data.autoSkip.map(Number).includes(Number(near)), 'the ignoring courier is remembered');
  ok((await q('SELECT body FROM messages WHERE order_id=$1', [o3])).rows.some(x => x.body.includes('لم يستجب')), 'customer told about the change');
  await old(o3); await app.sweepUnacked(); w = await who(o3);
  ok([Number(noloc), Number(stale)].includes(Number(w.c)), 'then a courier with no recent position');
  await old(o3); await app.sweepUnacked(); w = await who(o3);
  ok([Number(noloc), Number(stale)].includes(Number(w.c)), 'and the last one');
  await old(o3); await app.sweepUnacked(); w = await who(o3);
  ok(w.c === null && w.data.autoAssigned === undefined, 'nobody left: the order opens to every courier');
  ok(notes.some(n => n.p && /طلب توصيل جديد/.test(n.p.title || '')), 'all couriers are notified of the open order');
  // a picked-up order is never taken back
  let o4 = await mk(p); await accept(o4);
  await q("UPDATE orders SET status='picked_up' WHERE id=$1", [o4]); await old(o4);
  const before = (await who(o4)).c; await app.sweepUnacked();
  ok(Number((await who(o4)).c) === Number(before), 'an order already picked up stays');

  // shop without a position: the least busy courier of the area
  await q("UPDATE orders SET status='delivered' WHERE courier_user_id=ANY($1)", [[near, far, noloc, stale]]);
  await q("INSERT INTO orders(customer_user_id, provider_id, courier_user_id, status, total, region_id, data) VALUES($1,$2,$3,'accepted',10,$4,'{}')", [cust, p, far, rid]);
  let o5 = await mk(pn); await accept(o5);
  ok(Number((await who(o5)).c) !== Number(far), 'no shop position: the busy courier is not chosen');
  // another area never gets it
  const rid2 = (await q("INSERT INTO regions(name) VALUES('b'||floor(random()*1e9)) RETURNING id")).rows[0].id;
  await q("UPDATE users SET region_id=$1 WHERE id=ANY($2)", [rid2, [far, near, noloc, stale]]);
  let o6 = await mk(p); await accept(o6);
  ok((await who(o6)).c === null, 'couriers of another area are not used');
  // order chat closes with the order for everyone but the staff
  let oc = await mk(p); await accept(oc);
  const cc = (await who(oc)).c || near;
  await q("UPDATE orders SET courier_user_id=$2, status='on_the_way' WHERE id=$1", [oc, cc]);
  r = await call('POST /api/orders/:id/messages', { sub: String(cc), role: 'courier' }, { id: String(oc) }, { text: 'في الطريق' });
  ok(r.status === 201, 'courier can write while the order is running: ' + r.status);
  await q("UPDATE orders SET status='delivered' WHERE id=$1", [oc]);
  r = await call('POST /api/orders/:id/messages', { sub: String(cc), role: 'courier' }, { id: String(oc) }, { text: 'بعد التسليم' });
  ok(r.status === 409, 'courier cannot write after delivery: ' + r.status);
  r = await call('POST /api/orders/:id/messages', { sub: String(cust), role: 'customer' }, { id: String(oc) }, { text: 'بعد التسليم' });
  ok(r.status === 409, 'customer cannot write after delivery: ' + r.status);
  r = await call('POST /api/orders/:id/messages', { sub: String((await q("SELECT id FROM users WHERE role='admin' LIMIT 1")).rows[0]?.id || 0), role: 'admin' }, { id: String(oc) }, { text: 'المالك' });
  ok(r.status === 201, 'the owner still can: ' + r.status);
  console.log(`autoassign: ${pass} passed, ${bad} failed`); await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
