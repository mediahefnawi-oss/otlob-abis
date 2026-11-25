process.env.NO_SWEEP = '1';
const { Pool } = require('./shim');
const H = require('./h26');
const B = require('../src/bells.js');
const { ok, eq, done } = H.counters();
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const pushes = []; const { app, asyncRoute, positiveId, auth, roles, call } = H;
  B.register(app, { pool, auth, roles, asyncRoute, positiveId, pushToUsers: async (ids, p) => { pushes.push({ ids: ids.map(Number), p }); } });
  const mk = async (n, role, av = true) => Number((await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',$4) RETURNING id", [n, H.phone(), role, av])).rows[0].id);
  const adm = await mk('owner', 'admin'), c1 = await mk('مندوب1', 'courier'), c2 = await mk('مندوب2', 'courier', false), c3 = await mk('كابتن فقط', 'courier'), own = await mk('صاحب محل', 'provider'), cust = await mk('عميل', 'customer');
  await q('UPDATE users SET orders_off=TRUE WHERE id=$1', [c3]);
  const prov = Number((await q("INSERT INTO providers(owner_user_id, name, type, status, is_open, phone) VALUES($1,'مطعم الأمل','restaurant','active',TRUE,'01000000001') RETURNING id", [own])).rows[0].id);
  const prov2 = Number((await q("INSERT INTO providers(owner_user_id, name, type, status, is_open, phone) VALUES($1,'محل مقفول','restaurant','active',FALSE,'01000000002') RETURNING id", [own])).rows[0].id);
  const ord = async (status, pid = prov, courier = null) => Number((await q("INSERT INTO orders(customer_user_id, provider_id, status, courier_user_id, order_number, data) VALUES($1,$2,$3,$4,$5,$6) RETURNING id", [cust, pid, status, courier, Math.floor(Math.random() * 1e6) + 1, JSON.stringify({ providerName: 'مطعم الأمل', address: 'شارع المدرسة', customerName: 'معاذ' })])).rows[0].id);
  const A = { sub: String(adm), role: 'admin' }, C1 = { sub: String(c1), role: 'courier' }, P = { sub: String(own), role: 'provider' }, CU = { sub: String(cust), role: 'customer' };
  const ring = (as, id, body) => call('POST /api/admin/orders/:id/bell', { as, params: { id }, body });
  const live = id => q("SELECT * FROM bells WHERE order_id=$1 AND status='ringing'", [id]).then(r => r.rows);

  /* courier: unavailable people cannot be rung */
  let o1 = await ord('accepted');
  eq((await ring(A, o1, { role: 'courier', targetId: c2 })).status, 409, 'unavailable courier: refused');
  eq((await ring(A, o1, { role: 'courier', targetId: c3 })).status, 409, 'captain-only account is not a courier for orders');
  eq((await ring(CU, o1, { role: 'courier', targetId: c1 })).status, 403, 'only the owner rings');
  eq((await ring(C1, o1, { role: 'courier', targetId: c1 })).status, 403, 'a courier cannot ring');
  eq((await live(o1)).length, 0, 'nothing rings after refusals');
  /* ring + repeat + stop */
  pushes.length = 0;
  let r = await ring(A, o1, { role: 'courier', targetId: c1 }); eq(r.status, 201, 'ring started');
  ok(pushes.length === 1 && pushes[0].p.ring === true && pushes[0].ids[0] === c1, 'first loud push goes at once');
  eq((await ring(A, o1, { role: 'courier', targetId: c1 })).json.already, true, 'pressing twice does not double the bell');
  await q("UPDATE bells SET last_sent_at = NOW() - INTERVAL '20 seconds' WHERE order_id=$1", [o1]);
  pushes.length = 0; await app.sweepBells(); eq(pushes.filter(x => x.p.ring).length, 1, 'rings again after the interval');
  pushes.length = 0; await app.sweepBells(); eq(pushes.length, 0, 'but not before the interval');
  eq((await call('GET /api/me/bells', { as: C1 })).json.bells.length, 1, 'the courier sees the ringing order');
  eq((await call('GET /api/me/bells', { as: P })).json.bells.length, 0, 'others do not');
  eq((await call('GET /api/admin/orders/:id/bells', { as: A, params: { id: o1 } })).json.bells[0].status, 'ringing', 'owner sees it ringing');
  r = await call('DELETE /api/admin/orders/:id/bell', { as: A, params: { id: o1 } }); eq(r.json.stopped, 1, 'owner stops it');
  eq((await live(o1)).length, 0, 'stopped for good'); pushes.length = 0; await app.sweepBells(); eq(pushes.length, 0, 'no more rings after stop');

  /* courier ACCEPTS (open order) -> bell ends at once and the owner is told */
  await ring(A, o1, { role: 'courier', targetId: c1 }); pushes.length = 0;
  await q('UPDATE orders SET courier_user_id=$1 WHERE id=$2', [c1, o1]);
  await app.bellsAfterAction(o1, c1, 'courier_accept');
  eq((await live(o1)).length, 0, 'accept ends the bell'); ok(pushes.some(x => x.ids.includes(adm) && /قبل/.test(x.p.title)), 'owner told: accepted');
  /* courier REFUSES an order assigned to him: unassigned, bell ends, owner told */
  let o2 = await ord('accepted', prov, c1);
  await ring(A, o2, { role: 'courier', targetId: c1 }); pushes.length = 0;
  r = await call('POST /api/orders/:id/bell/respond', { as: C1, params: { id: o2 }, body: { decision: 'reject' } }); eq(r.status, 200, 'courier refuses');
  eq((await q('SELECT courier_user_id FROM orders WHERE id=$1', [o2])).rows[0].courier_user_id, null, 'order is back without a courier');
  eq((await live(o2)).length, 0, 'refusal ends the bell'); ok(pushes.some(x => x.ids.includes(adm) && /رفض/.test(x.p.title)), 'owner told: refused');
  /* too late to refuse once picked up */
  let o3 = await ord('picked_up', prov, c1);
  eq((await call('POST /api/orders/:id/bell/respond', { as: C1, params: { id: o3 }, body: { decision: 'reject' } })).status, 409, 'cannot refuse after pickup');
  eq((await ring(A, o3, { role: 'courier', targetId: c1 })).status, 409, 'cannot ring on a picked-up order');
  /* assigned to another courier: cannot ring a different one */
  let o4 = await ord('accepted', prov, c1);
  const c4 = await mk('مندوب4', 'courier'); eq((await ring(A, o4, { role: 'courier', targetId: c4 })).status, 409, 'order belongs to another courier');

  /* shop */
  let s1 = await ord('pending');
  eq((await ring(A, await ord('pending', prov2), { role: 'shop' })).status, 409, 'closed shop: unavailable');
  eq((await ring(A, await ord('accepted'), { role: 'shop' })).status, 409, 'shop already answered');
  pushes.length = 0; r = await ring(A, s1, { role: 'shop' }); eq(r.status, 201, 'shop rung'); ok(pushes[0].ids[0] === own && pushes[0].p.ring, 'loud push to the shop owner');
  eq((await call('GET /api/me/bells', { as: P })).json.bells[0].order.shop, 'مطعم الأمل', 'shop sees the order');
  pushes.length = 0; await app.bellsAfterAction(s1, own, 'accept');
  eq((await live(s1)).length, 0, 'shop accept ends the bell'); ok(pushes.some(x => x.ids.includes(adm) && /قبل/.test(x.p.title)), 'owner told: shop accepted');
  let s2 = await ord('pending'); await ring(A, s2, { role: 'shop' }); pushes.length = 0; await app.bellsAfterAction(s2, own, 'reject');
  ok(pushes.some(x => /رفض/.test(x.p.title)), 'owner told: shop refused');
  /* someone else's decision does not end it */
  let s3 = await ord('pending'); await ring(A, s3, { role: 'shop' }); await app.bellsAfterAction(s3, c1, 'accept'); eq((await live(s3)).length, 1, 'only the rung person ends his own bell');
  /* order moves on (cancelled / decided by the owner) -> ends on next sweep */
  await q("UPDATE orders SET status='cancelled' WHERE id=$1", [s3]); pushes.length = 0; await app.sweepBells(); eq((await live(s3)).length, 0, 'a cancelled order ends the bell');
  /* 30 minute limit */
  let s4 = await ord('pending'); await ring(A, s4, { role: 'shop' });
  await q("UPDATE bells SET started_at = NOW() - INTERVAL '31 minutes' WHERE order_id=$1", [s4]); pushes.length = 0; await app.sweepBells();
  eq((await live(s4)).length, 0, 'ends after 30 minutes'); ok(pushes.some(x => x.ids.includes(adm) && /ما ردّش/.test(x.p.title)), 'owner told: no answer');
  eq((await q("SELECT status FROM bells WHERE order_id=$1", [s4])).rows[0].status, 'expired', 'marked expired');
  process.exit(done('bells') ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
