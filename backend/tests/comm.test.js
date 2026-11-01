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
  // ---------- fixtures ----------
  await q(`TRUNCATE commission_entries, commission_settlements, counter_resets, counter_schedules, audit_log, site_images, appointments, orders, products, providers, users RESTART IDENTITY CASCADE`);
  await q("DELETE FROM commission_rules WHERE note <> 'افتراضي'");
  const user = async (name, role) => (await q("INSERT INTO users(name, phone, password_hash, role) VALUES($1,$2,'x',$3) RETURNING id", [name, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const adminId = await user('المالك', 'admin');
  const cust = await user('عميل', 'customer');
  const courier1 = await user('مندوب 1', 'courier');
  const courier2 = await user('مندوب 2', 'courier');
  const prov = async (type, name) => { const o = await user('مالك ' + name, 'provider'); return { id: (await q("INSERT INTO providers(owner_user_id, type, name, phone, status, is_open) VALUES($1,$2,$3,'01000000000','active',TRUE) RETURNING id", [o, type, name])).rows[0].id, owner: o, type }; };
  const sm = await prov('supermarket', 'سوبر'), ph = await prov('pharmacy', 'صيدلية'), rs = await prov('restaurant', 'مطعم'), cl = await prov('clinic', 'عيادة'), mk = await prov('maker', 'صانع'), st = await prov('store', 'متجر');
  const order = async (p, subtotal, fee, courier) => (await q("INSERT INTO orders(customer_user_id, provider_id, courier_user_id, status, total, data) VALUES($1,$2,$3,'on_the_way',$4,$5) RETURNING *", [cust, p ? p.id : null, courier || null, subtotal + fee, JSON.stringify({ subtotal, deliveryFee: fee })])).rows[0];
  const deliver = async o => { const c = await pool.connect(); try { await c.query('BEGIN'); const r = (await c.query("UPDATE orders SET status='delivered' WHERE id=$1 RETURNING *", [o.id])).rows[0]; await comm.onOrderDelivered(c, r); await c.query('COMMIT'); } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } };
  const appt = async (p, fee) => (await q("INSERT INTO appointments(customer_user_id, provider_id, appointment_date, appointment_time, status, fee) VALUES($1,$2,CURRENT_DATE,'10:00','confirmed',$3) RETURNING *", [cust, p.id, fee])).rows[0];
  const complete = async a => { const c = await pool.connect(); try { await c.query('BEGIN'); await c.query("UPDATE appointments SET status='completed' WHERE id=$1", [a.id]); await comm.onApptCompleted(c, a); await c.query('COMMIT'); } finally { c.release(); } };
  const entries = async (where = 'TRUE', p = []) => (await q(`SELECT * FROM commission_entries WHERE ${where} ORDER BY id`, p)).rows;
  const sumEntries = async kind => Number((await q('SELECT COALESCE(SUM(amount),0) s FROM commission_entries WHERE kind=$1', [kind])).rows[0].s);

  // register routes (the real module)
  require('../src/commissions.js')(app, { pool, auth, roles, asyncRoute, positiveId });
  const A = { sub: String(adminId), role: 'admin' };

  console.log('1) Cairo time / schedule maths');
  const t0 = Date.parse('2026-07-10T10:00:00Z'); // summer: Cairo = UTC+3
  eq(new Date(comm.nextRun({ frequency: 'daily', run_time: '00:00' }, t0)).toISOString(), '2026-07-10T21:00:00.000Z', 'daily midnight Cairo (summer, UTC+3)');
  const t1 = Date.parse('2026-12-10T10:00:00Z'); // winter: UTC+2
  eq(new Date(comm.nextRun({ frequency: 'daily', run_time: '00:00' }, t1)).toISOString(), '2026-12-10T22:00:00.000Z', 'daily midnight Cairo (winter, UTC+2)');
  eq(new Date(comm.nextRun({ frequency: 'weekly', run_time: '09:30', day_of_week: 5 }, t1)).toISOString(), '2026-12-11T07:30:00.000Z', 'weekly Friday 09:30');
  eq(new Date(comm.nextRun({ frequency: 'monthly', run_time: '00:00', day_of_month: 31 }, Date.parse('2027-02-10T10:00:00Z'))).toISOString(), '2027-02-27T22:00:00.000Z', 'monthly day 31 clamps to Feb 28');
  eq(comm.nextRun({ frequency: 'once', run_time: '10:00', run_date: '2020-01-01' }, t1), null, 'once in the past = null');
  ok(comm.nextRun({ frequency: 'once', run_time: '10:00', run_date: '2030-01-01' }, t1) > t1, 'once in the future');

  console.log('2) default commissions');
  const o1 = await order(sm, 200, 20, courier1); await deliver(o1);
  const o2 = await order(ph, 55.55, 20, courier1); await deliver(o2);
  const o3 = await order(rs, 120, 20, courier2); await deliver(o3);
  const o4 = await order(mk, 90, 25, courier2); await deliver(o4);
  const o5 = await order(st, 40, 15, courier1); await deliver(o5);
  const a1 = await appt(cl, 300); await complete(a1);
  const pe = async id => (await entries("kind='provider' AND order_id=$1", [id]))[0];
  near((await pe(o1.id)).amount, 20, 'supermarket 10% of 200');
  near((await pe(o2.id)).amount, 5.56, 'pharmacy 10% of 55.55 (rounded)');
  near((await pe(o3.id)).amount, 15, 'restaurant 15 fixed');
  near((await pe(o4.id)).amount, 15, 'maker 15 fixed');
  near((await pe(o5.id)).amount, 15, 'store 15 fixed');
  near((await entries('appointment_id=$1', [a1.id]))[0].amount, 15, 'clinic booking 15 fixed');
  eq((await entries("kind='courier'")).length, 5, 'courier deduction on every delivered order');
  ok((await entries("kind='courier'")).every(e => Number(e.amount) === 5), 'courier deduction is 5');
  near((await pe(o1.id)).base_amount, 200, 'base = products only (no delivery fee)');
  ok((await pe(o1.id)).rule_snapshot.kind === 'percent', 'rule snapshot stored');
  const noCourier = await order(rs, 50, 10, null); await deliver(noCourier);
  eq((await entries("kind='courier' AND order_id=$1", [noCourier.id])).length, 0, 'no courier = no deduction');
  const custom = await order(null, 30, 20, courier1); await deliver(custom);
  eq((await entries('order_id=$1', [custom.id])).map(e => e.kind), ['courier'], 'custom order: courier only');

  console.log('3) never counted twice');
  await deliver(o1); await deliver(o1);
  await Promise.all([deliver(o3), deliver(o3), deliver(o3)]);
  await complete(a1);
  eq((await entries('order_id=$1', [o1.id])).length, 2, 'order 1 still 2 entries (provider + courier)');
  eq((await entries('order_id=$1', [o3.id])).length, 2, 'order 3 still 2 entries after parallel calls');
  eq((await entries('appointment_id=$1', [a1.id])).length, 1, 'booking still 1 entry');

  console.log('4) rule priority, dates, switches');
  const mkRule = async body => { const r = await call('POST /api/admin/commissions/rules', { as: A, body }); return r; };
  let r = await mkRule({ target: 'provider', scope: 'provider', providerId: sm.id, kind: 'percent', value: 5 });
  eq(r.status, 201, 'create provider rule');
  const oSm = await order(sm, 100, 10, courier1); await deliver(oSm);
  near((await pe(oSm.id)).amount, 5, 'provider rule (5%) beats type rule (10%)');
  const futureId = (await mkRule({ target: 'provider', scope: 'provider', providerId: sm.id, kind: 'percent', value: 50, effectiveFrom: Date.now() + 86400000 })).json.rule.id;
  const oSm2 = await order(sm, 100, 10, courier1); await deliver(oSm2);
  near((await pe(oSm2.id)).amount, 5, 'future-dated rule is not applied yet');
  await call('PATCH /api/admin/commissions/rules/:id', { as: A, params: { id: r.json.rule.id }, body: { active: false } });
  const oSm3 = await order(sm, 100, 10, courier1); await deliver(oSm3);
  near((await pe(oSm3.id)).amount, 10, 'switched off provider rule -> falls back to type rule');
  await call('PATCH /api/admin/commissions/rules/:id', { as: A, params: { id: r.json.rule.id }, body: { active: true, kind: 'fixed', value: 7 } });
  const oSm4 = await order(sm, 100, 10, courier1); await deliver(oSm4);
  near((await pe(oSm4.id)).amount, 7, 'edited rule to fixed 7');
  near((await pe(oSm.id)).amount, 5, 'old accrual unchanged after editing the rule (snapshot)');
  await call('DELETE /api/admin/commissions/rules/:id', { as: A, params: { id: futureId } });
  // minimum amount
  const minRule = (await mkRule({ target: 'provider', scope: 'provider', providerId: rs.id, kind: 'percent', value: 10, minAmount: 100 })).json.rule;
  const oR1 = await order(rs, 80, 10, null); await deliver(oR1);
  const oR2 = await order(rs, 150, 10, null); await deliver(oR2);
  eq((await entries("kind='provider' AND order_id=$1", [oR1.id])).length, 0, 'below minimum -> not eligible');
  near((await pe(oR2.id)).amount, 15, 'above minimum -> 10% of 150');
  await call('DELETE /api/admin/commissions/rules/:id', { as: A, params: { id: minRule.id } });
  // courier-specific rule
  const cr = (await mkRule({ target: 'courier', scope: 'courier', courierUserId: courier2, kind: 'fixed', value: 8 })).json.rule;
  const oC = await order(rs, 60, 10, courier2); await deliver(oC);
  near((await entries("kind='courier' AND order_id=$1", [oC.id]))[0].amount, 8, 'courier-specific deduction 8');
  await call('DELETE /api/admin/commissions/rules/:id', { as: A, params: { id: cr.id } });
  // validation
  eq((await mkRule({ target: 'provider', scope: 'all', kind: 'percent', value: 150 })).status, 400, 'percent > 100 rejected');
  eq((await mkRule({ target: 'provider', scope: 'type', providerType: 'bogus', kind: 'fixed', value: 1 })).status, 400, 'bad type rejected');
  eq((await mkRule({ target: 'courier', scope: 'type', providerType: 'maker', kind: 'fixed', value: 1 })).status, 400, 'courier rule cannot be per-type');
  eq((await mkRule({ target: 'provider', scope: 'all', kind: 'fixed', value: -3 })).status, 400, 'negative rejected');

  console.log('5) cancellations / returns');
  const before = await sumEntries('provider');
  r = await call('POST /api/admin/commissions/reverse', { as: A, body: { orderId: String(o1.id), note: 'مرتجع كامل' } });
  eq(r.status, 201, 'reverse ok');
  eq(r.json.adjustments.length, 2, 'provider + courier adjustments');
  near(await sumEntries('provider'), before - 20, 'provider ledger reduced by 20');
  near((await entries("entry_type='accrual' AND order_id=$1 AND kind='provider'", [o1.id]))[0].amount, 20, 'original accrual untouched');
  r = await call('POST /api/admin/commissions/reverse', { as: A, body: { orderId: String(o1.id), note: 'تكرار' } });
  eq(r.status, 409, 'second reversal refused (no double reversal)');
  eq((await call('POST /api/admin/commissions/reverse', { as: A, body: { orderId: String(o2.id) } })).status, 400, 'reversal needs a reason');
  r = await call('POST /api/admin/commissions/reverse', { as: A, body: { orderId: String(oSm3.id), refundAmount: 40, reverseCourier: false, note: 'مرتجع جزئي' } });
  near(r.json.adjustments[0].amount, -4, 'partial return 40 of 100 at 10% -> -4');
  eq(r.json.adjustments.length, 1, 'courier kept when reverseCourier=false');
  r = await call('POST /api/admin/commissions/reverse', { as: A, body: { orderId: String(oSm3.id), refundAmount: 100, reverseCourier: false, note: 'باقي المرتجع' } });
  near(r.json.adjustments[0].amount, -6, 'cumulative reversal capped at the remaining 6');
  r = await call('POST /api/admin/commissions/reverse', { as: A, body: { appointmentId: String(a1.id), note: 'إلغاء الكشف' } });
  near(r.json.adjustments[0].amount, -15, 'booking reversal');
  eq((await call('POST /api/admin/commissions/reverse', { as: A, body: { orderId: '99999', note: 'xx yy' } })).status, 404, 'unknown order');

  console.log('6) settlement');
  let ov = (await call('GET /api/admin/commissions/overview', { as: A })).json;
  const smBal = ov.balances.find(b => b.kind === 'provider' && b.id === String(sm.id));
  const smDueSql = Number((await q("SELECT SUM(amount) s FROM commission_entries WHERE kind='provider' AND provider_id=$1 AND status='due'", [sm.id])).rows[0].s);
  near(smBal.due, smDueSql, 'overview balance = ledger');
  r = await call('POST /api/admin/commissions/settle', { as: A, body: { providerId: String(sm.id), note: 'دفعة نقدية' } });
  near(r.json.amount, smDueSql, 'settled amount = dues');
  eq((await call('POST /api/admin/commissions/settle', { as: A, body: { providerId: String(sm.id) } })).status, 409, 'nothing left to settle');
  eq((await call('POST /api/admin/commissions/settle', { as: A, body: {} })).status, 400, 'settle needs a party');
  const lateAdj = (await call('POST /api/admin/commissions/reverse', { as: A, body: { orderId: String(oSm4.id), reverseCourier: false, note: 'مرتجع بعد السداد' } })).json.adjustments[0];
  eq(lateAdj.status, 'due', 'adjustment after settlement stays as a due credit');
  near(Number((await q("SELECT SUM(amount) s FROM commission_entries WHERE status='settled' AND provider_id=$1", [sm.id])).rows[0].s), smDueSql, 'settled history untouched');

  console.log('7) counters + resets (data is never deleted)');
  const snap = async () => ({
    orders: Number((await q('SELECT COUNT(*) c FROM orders')).rows[0].c), appts: Number((await q('SELECT COUNT(*) c FROM appointments')).rows[0].c),
    entries: Number((await q('SELECT COUNT(*) c FROM commission_entries')).rows[0].c), ledger: Number((await q('SELECT SUM(amount) s FROM commission_entries')).rows[0].s),
  });
  const counters = async as => (await call('GET /api/counters', { as: as || A })).json;
  let c0 = await counters();
  near(c0.providers[rs.id].sales, 120 + 50 + 80 + 150 + 60, 'restaurant sales = delivered subtotals');
  ok(c0.providers[rs.id].orders >= 5, 'restaurant orders counted');
  near(c0.providers[cl.id].sales, 300, 'clinic sales = completed booking fee');
  near(c0.totals.profit, c0.totals.commission + c0.totals.courierCut, 'profit = commissions + courier cuts');
  const dataBefore = await snap();
  await new Promise(r => setTimeout(r, 30));
  // wait so "after reset" rows are strictly later
  r = await call('POST /api/admin/counters/reset', { as: A, body: { scope: 'provider', providerId: String(rs.id), counters: ['sales'] } });
  eq(r.status, 201, 'reset one provider / one counter');
  let c1 = await counters();
  near(c1.providers[rs.id].sales, 0, 'restaurant sales reset to 0');
  near(c1.providers[rs.id].orders, c0.providers[rs.id].orders, 'restaurant orders NOT reset');
  near(c1.providers[rs.id].commission, c0.providers[rs.id].commission, 'restaurant profit NOT reset');
  near(c1.providers[sm.id].sales, c0.providers[sm.id].sales, 'other providers unaffected');
  eq(await snap(), dataBefore, 'orders / bookings / commissions untouched by reset');
  const oNew = await order(rs, 70, 10, courier1); await new Promise(r => setTimeout(r, 30)); await deliver(oNew);
  near((await counters()).providers[rs.id].sales, 70, 'counter counts again after the reset');
  const dataMid = await snap();
  await call('POST /api/admin/counters/reset', { as: A, body: { scope: 'type', providerType: 'supermarket', counters: ['sales', 'orders', 'profit'] } });
  let c2 = await counters();
  near(c2.providers[sm.id].sales + c2.providers[sm.id].orders + c2.providers[sm.id].profit, 0, 'type reset zeroes the supermarket');
  ok(c2.providers[ph.id].sales > 0, 'pharmacy unaffected by supermarket type reset');
  eq((await call('POST /api/admin/counters/reset', { as: A, body: { scope: 'all', counters: [] } })).status, 400, 'must choose counters');
  eq((await call('POST /api/admin/counters/reset', { as: A, body: { scope: 'all', counters: ['balance'] } })).status, 400, 'unknown counter refused');
  await new Promise(r => setTimeout(r, 30));
  await call('POST /api/admin/counters/reset', { as: A, body: { scope: 'all', counters: ['sales', 'orders', 'profit'] } });
  let c3 = await counters();
  near(c3.totals.sales + c3.totals.orders + c3.totals.profit, 0, 'reset-all zeroes the displayed totals');
  const dataAfter = await snap();
  eq(dataAfter, dataMid, 'still nothing deleted or changed after all resets');
  const ovAfter = (await call('GET /api/admin/commissions/overview', { as: A })).json;
  ok(ovAfter.totals.length === 2, 'cumulative commission totals still available');
  const rep = (await call('GET /api/admin/commissions/report', { as: A, query: { period: 'day' } })).json;
  ok(rep.rows.length >= 2 && rep.rows.some(x => x.kind === 'provider' && x.count > 0), 'reports unaffected by resets');
  const repM = (await call('GET /api/admin/commissions/report', { as: A, query: { period: 'month' } })).json;
  ok(repM.rows.length >= 2, 'monthly report');
  // owner of a provider only sees own counters
  const P = { sub: String(sm.owner), role: 'provider' };
  const cp = await counters(P);
  eq(Object.keys(cp.providers), [String(sm.id)], 'provider sees only own provider');
  eq((await call('GET /api/counters', { as: { sub: String(cust), role: 'customer' } })).status, 403, 'customers cannot read counters');

  console.log('8) scheduled resets');
  await new Promise(r => setTimeout(r, 30));
  const oS = await order(ph, 100, 10, courier1); await deliver(oS);
  ok((await counters()).providers[ph.id].sales >= 100, 'pharmacy has sales before the schedule');
  await q("UPDATE orders SET delivered_at = NOW() - INTERVAL '2 hours' WHERE id=$1", [oS.id]);
  const dataSched = await snap();
  // a schedule created through the API (future)
  r = await call('POST /api/admin/counters/schedules', { as: A, body: { scope: 'type', providerType: 'pharmacy', counters: ['sales'], frequency: 'daily', time: '00:00' } });
  eq(r.status, 201, 'create daily schedule');
  ok(r.json.schedule.nextRunAt > Date.now(), 'next run is in the future');
  eq((await call('POST /api/admin/counters/schedules', { as: A, body: { scope: 'all', counters: ['sales'], frequency: 'once', date: '2020-01-01', time: '10:00' } })).status, 400, 'past one-time date refused');
  eq((await call('POST /api/admin/counters/schedules', { as: A, body: { scope: 'all', counters: ['sales'], frequency: 'weekly', time: '10:00' } })).status, 400, 'weekly needs a day');
  // force it due: scheduled moment is one hour ago
  const dueAt = new Date(Date.now() - 3600000);
  await q('UPDATE counter_schedules SET next_run_at=$1 WHERE id=$2', [dueAt, r.json.schedule.id]);
  const cDue = await Promise.all([counters(), counters(), counters()]); // parallel => must run once
  const resets = (await q("SELECT * FROM counter_resets WHERE source='schedule'")).rows;
  eq(resets.length, 1, 'scheduled reset executed exactly once despite parallel requests');
  ok(Math.abs(new Date(resets[0].reset_at).getTime() - dueAt.getTime()) < 5, 'reset stamped with the scheduled moment');
  near(cDue[0].providers[ph.id].sales, 0, 'scheduled reset zeroed the pharmacy sales');
  const sch = (await q('SELECT * FROM counter_schedules WHERE id=$1', [r.json.schedule.id])).rows[0];
  ok(new Date(sch.next_run_at) > new Date() && sch.enabled, 'daily schedule re-armed');
  // disabled schedule does not run
  await call('PATCH /api/admin/counters/schedules/:id', { as: A, params: { id: r.json.schedule.id }, body: { enabled: false } });
  await q('UPDATE counter_schedules SET next_run_at=$1 WHERE id=$2', [new Date(Date.now() - 1000), r.json.schedule.id]);
  await counters();
  eq((await q("SELECT * FROM counter_resets WHERE source='schedule'")).rowCount, 1, 'switched-off schedule does not run');
  // one-time schedule disables itself
  const one = (await q(`INSERT INTO counter_schedules(scope, counters, frequency, run_time, run_date, enabled, next_run_at) VALUES('all','{orders}','once','10:00',CURRENT_DATE,TRUE,$1) RETURNING id`, [new Date(Date.now() - 5000)])).rows[0];
  await counters();
  const oneAfter = (await q('SELECT * FROM counter_schedules WHERE id=$1', [one.id])).rows[0];
  ok(!oneAfter.enabled && oneAfter.next_run_at === null && oneAfter.last_run_at, 'one-time schedule runs once then switches off');
  const list = (await call('GET /api/admin/counters/resets', { as: A })).json;
  ok(list.resets.length >= 5 && list.schedules.length >= 2, 'reset history + schedules listed');
  eq(await snap(), dataSched, 'schedules never touch the data');

  console.log('9) permissions (server side)');
  const nonAdmin = [{ sub: String(sm.owner), role: 'provider' }, { sub: String(cust), role: 'customer' }, { sub: String(courier1), role: 'courier' }, undefined];
  const adminOnly = ['GET /api/admin/commissions/rules', 'POST /api/admin/commissions/rules', 'PATCH /api/admin/commissions/rules/:id', 'DELETE /api/admin/commissions/rules/:id', 'GET /api/admin/commissions/report', 'GET /api/admin/commissions/overview',
    'GET /api/admin/commissions/entries', 'POST /api/admin/commissions/reverse', 'POST /api/admin/commissions/settle', 'GET /api/admin/counters/resets', 'POST /api/admin/counters/reset', 'POST /api/admin/counters/schedules',
    'PATCH /api/admin/counters/schedules/:id', 'DELETE /api/admin/counters/schedules/:id', 'GET /api/admin/audit', 'PUT /api/admin/login-image', 'DELETE /api/admin/login-image'];
  let blocked = 0, total = 0;
  for (const k of adminOnly) for (const who of nonAdmin) { total++; const o = await call(k, { as: who, params: { id: '1' }, body: { image: 'x' } }); if (o.status === 401 || o.status === 403) blocked++; }
  eq(blocked, total, `all ${adminOnly.length} owner-only routes reject non-owners (${total} attempts)`);
  eq((await call('GET /api/my/commissions', { as: { sub: String(cust), role: 'customer' } })).status, 403, 'customers have no commission view');

  console.log('10) provider / courier views');
  const mine = (await call('GET /api/my/commissions', { as: P })).json;
  eq(mine.rules[0].providerId, String(sm.id), 'provider sees own rule');
  near(mine.due, Number((await q("SELECT COALESCE(SUM(amount),0) s FROM commission_entries WHERE kind='provider' AND provider_id=$1 AND status='due'", [sm.id])).rows[0].s), 'provider due balance');
  const mineC = (await call('GET /api/my/commissions', { as: { sub: String(courier1), role: 'courier' } })).json;
  near(mineC.rules[0].value, 5, 'courier sees the 5 EGP deduction');
  ok(mineC.entries.every(e => e.kind === 'courier'), 'courier sees only courier rows');

  console.log('11) audit trail');
  const log = (await call('GET /api/admin/audit', { as: A, query: { limit: '200' } })).json.log;
  const acts = new Set(log.map(x => x.action));
  for (const a of ['rule.create', 'rule.update', 'rule.delete', 'commission.reverse', 'commission.settle', 'counters.reset.manual', 'counters.reset.schedule', 'counters.schedule.create', 'counters.schedule.update']) ok(acts.has(a), `audit has ${a}`);
  ok(log.find(x => x.action === 'rule.update').before && log.find(x => x.action === 'rule.update').after, 'rule edits keep before/after');
  ok(log.find(x => x.action === 'counters.reset.manual').actor === 'المالك', 'actor name recorded');

  console.log('12) login picture');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  r = await call('PUT /api/admin/login-image', { as: A, body: { image: png } });
  ok(r.status === 200 && r.json.loginImageV > 0, 'owner uploads login picture');
  r = await call('GET /api/login-image', {});
  ok(r.status === 200 && Buffer.isBuffer(r.sent) && r.headers['Content-Type'] === 'image/png', 'picture served publicly');
  eq((await call('PUT /api/admin/login-image', { as: A, body: { image: 'data:text/html;base64,AAAA' } })).status, 400, 'non-image refused');
  eq((await call('PUT /api/admin/login-image', { as: A, body: { image: 'data:image/png;base64,' + 'A'.repeat(1500000) } })).status, 400, 'oversize refused');
  await call('DELETE /api/admin/login-image', { as: A });
  eq((await q("SELECT 1 FROM site_images WHERE key='login'")).rowCount, 0, 'picture removed');

  console.log('13) a commission failure can never break delivery');
  {
    const c = await pool.connect();
    await c.query('BEGIN');
    const o = await order(rs, 100, 10, courier1);
    const r0 = (await c.query("UPDATE orders SET status='delivered' WHERE id=$1 RETURNING *", [o.id])).rows[0];
    const flaky = { query: (t, p) => (/INSERT INTO commission_entries/.test(t) ? Promise.reject(new Error('boom')) : c.query(t, p)) };
    const origErr = console.error; console.error = () => {};
    await comm.onOrderDelivered(flaky, r0);
    console.error = origErr;
    const still = await c.query("SELECT status FROM orders WHERE id=$1", [o.id]);
    await c.query('COMMIT'); c.release();
    eq(still.rows[0].status, 'delivered', 'order stays delivered when the commission step fails');
  }

  console.log(`\n${pass} passed, ${failN} failed`);
  await pool.end();
  process.exit(failN ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
