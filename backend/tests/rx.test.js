// prescription forwarding: switch, privacy, pharmacy approval, 7-day expiry
const { Pool } = require('./shim');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m}: got ${a}, want ${b}`);
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const PIC = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const pushes = [];
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const roles = (...allowed) => (req, res, next) => (allowed.includes(req.auth.role) ? next() : next(Object.assign(new Error('no'), { http: 403 })));
  const pass1 = (req, res, next) => next();
  const services = require('../src/services.js');
  const deps = { pool, auth: pass1, roles, asyncRoute, positiveId, services, clearCaches() {}, pushToUsers: async (ids, p) => { pushes.push({ ids: ids.map(String), p }); } };
  require('../src/rx.js')(app, deps); require('../src/extras.js').register(app, deps);
  const call = (key, as, body, params) => new Promise(resolve => {
    const chain = routes[key]; if (!chain) throw new Error('no route ' + key);
    const res = { set() { return this; }, status(c) { this.c = c; return this; }, json(j) { resolve({ status: this.c || 200, json: j }); return this; }, send(x) { resolve({ status: this.c || 200, body: x }); }, end() { resolve({ status: this.c || 200 }); } };
    const req = { auth: as, params: params || {}, body: body || {}, query: {} };
    const run = i => { const f = chain[i]; if (i === chain.length - 1) return f(req, res, e => resolve({ status: e.http || 500, json: { error: e.message } })); f(req, res, e => (e ? resolve({ status: e.http || 500, json: { error: e.message } }) : run(i + 1))); };
    run(0);
  });
  await q("UPDATE app_settings SET features='{}'::jsonb WHERE id=1");
  const rg = (await q("INSERT INTO regions(name, delivery_fee) VALUES('منطقة روشتة'||random(), 0) RETURNING id")).rows[0].id;
  const rg2 = (await q("INSERT INTO regions(name, delivery_fee) VALUES('منطقة بعيدة'||random(), 0) RETURNING id")).rows[0].id;
  const mk = async (n, role, region) => (await q("INSERT INTO users(name, phone, password_hash, role, status, region_id) VALUES($1,$2,'x',$3,'active',$4) RETURNING id", [n, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role, region || null])).rows[0].id;
  const adm = await mk('مالك', 'admin'), pat = await mk('مريض', 'customer', rg), oth = await mk('غريب', 'customer'), oc = await mk('عيادة', 'provider'), oc2 = await mk('عيادة2', 'provider'), op1 = await mk('صيدلي قريب', 'provider', rg), op2 = await mk('صيدلي بعيد', 'provider', rg2), op3 = await mk('صيدلي ثالث', 'provider');
  const A = { sub: String(adm), role: 'admin' }, PAT = { sub: String(pat), role: 'customer' }, OTH = { sub: String(oth), role: 'customer' }, CL = { sub: String(oc), role: 'provider' }, CL2 = { sub: String(oc2), role: 'provider' }, PH1 = { sub: String(op1), role: 'provider' }, PH2 = { sub: String(op2), role: 'provider' }, PH3 = { sub: String(op3), role: 'provider' };
  const prov = async (o, type) => (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,$2,$3,'01000000000','active',TRUE) RETURNING id", [o, type, type + o])).rows[0].id;
  const clinic = await prov(oc, 'clinic'), clinic2 = await prov(oc2, 'clinic'), ph1 = await prov(op1, 'pharmacy'), ph2 = await prov(op2, 'pharmacy'), ph3 = await prov(op3, 'pharmacy');
  const appt = async (status) => (await q("INSERT INTO appointments(customer_user_id, provider_id, appointment_date, appointment_time, status, data) VALUES($1,$2,CURRENT_DATE,'بانتظار-'||substr(md5(random()::text),1,8),$3,'{}') RETURNING id", [pat, clinic, status])).rows[0].id;
  const a1 = await appt('confirmed'), a0 = await appt('pending');
  let r;

  console.log('A) switch');
  eq((await call('POST /api/rx', CL, { appointmentId: String(a1), meds: 'أموكسيسيلين' })).status, 409, 'OFF: cannot write');
  eq((await call('GET /api/rx', PAT)).json.enabled, false, 'OFF: list empty');
  await call('PATCH /api/admin/features', A, { key: 'rx', on: true });

  console.log('B) the clinic writes it');
  r = await call('GET /api/rx/pharmacies/:appointmentId', CL, {}, { appointmentId: String(a1) });
  eq(r.json.pharmacies[0].id, String(ph1), 'nearest (patient area) pharmacy comes first'); eq(r.json.pharmacies[0].suggested, true, 'marked as suggested');
  eq((await call('GET /api/rx/pharmacies/:appointmentId', CL2, {}, { appointmentId: String(a1) })).status, 404, 'another clinic cannot see the patient');
  eq((await call('POST /api/rx', CL, { appointmentId: String(a0), meds: 'x' })).status, 409, 'only after the booking is confirmed');
  eq((await call('POST /api/rx', CL, { appointmentId: String(a1) })).status, 400, 'empty refused');
  eq((await call('POST /api/rx', CL2, { appointmentId: String(a1), meds: 'x' })).status, 404, 'another clinic cannot write for this patient');
  eq((await call('POST /api/rx', CL, { appointmentId: String(a1), meds: 'x', pharmacyId: String(clinic2) })).status, 400, 'a clinic is not a pharmacy');
  eq((await call('POST /api/rx', CL, { appointmentId: String(a1), meds: 'x', image: 'data:text/html;base64,AAAA' })).status, 400, 'not a picture refused');
  r = await call('POST /api/rx', CL, { appointmentId: String(a1), meds: 'أموكسيسيلين 500 مرتين يوميًا', image: PIC, pharmacyId: String(ph1) });
  eq(r.status, 201, 'written'); ok(/^RX-\d{4,}$/.test(r.json.rx.number), 'RX number ' + r.json.rx.number); eq(r.json.rx.status, 'issued', 'issued');
  const id = { id: r.json.rx.id };

  console.log('C) privacy before approval');
  eq((await call('GET /api/rx', PH1)).json.list.length, 0, 'the suggested pharmacy sees nothing yet');
  eq((await call('POST /api/rx/:id/ready', PH1, {}, id)).status, 404, 'and cannot act');
  eq((await call('GET /api/rx', OTH)).json.list.length, 0, 'a stranger sees nothing');
  eq((await call('GET /api/rx/:id/photo', OTH, {}, id)).status, 404, 'a stranger cannot open the picture');
  eq((await call('GET /api/rx', PAT)).json.list.length, 1, 'the patient sees it');
  eq((await call('GET /api/rx', CL)).json.list.length, 1, 'the clinic sees it');
  eq((await call('GET /api/rx', CL2)).json.list.length, 0, 'another clinic does not');
  r = await call('GET /api/rx/:id/photo', PAT, {}, id); ok(/^data:image\/jpeg;base64,/.test(r.json.image), 'the patient gets the picture');

  console.log('D) the patient approves');
  eq((await call('POST /api/rx/:id/choose', OTH, {}, id)).status, 404, 'a stranger cannot approve');
  eq((await call('POST /api/rx/:id/choose', PAT, { pharmacyId: String(clinic) }, id)).status, 400, 'a clinic is not a pharmacy');
  eq((await call('GET /api/rx', PAT)).json.list[0].needsAction, true, 'patient: needs action while choosing the pharmacy');
  pushes.length = 0;
  r = await call('POST /api/rx/:id/choose', PAT, { pharmacyId: String(ph3) }, id); eq(r.status, 200, 'patient changes the pharmacy'); eq(r.json.rx.status, 'sent', 'sent'); eq(r.json.rx.pharmacyId, String(ph3), 'to the chosen one');
  ok(pushes.some(x => /روشتة جديدة للتجهيز/.test(x.p.title)), 'pharmacy gets a push to prepare it');
  ok(pushes.some(x => /أكّد الصيدلية/.test(x.p.title)), 'the clinic is told the patient confirmed');
  eq((await call('GET /api/rx', PH3)).json.list[0].needsAction, true, 'pharmacy: needs action');
  eq((await call('GET /api/rx', PH1)).json.list.length, 0, 'the first suggestion still sees nothing');
  eq((await call('GET /api/rx', PH3)).json.list.length, 1, 'the chosen pharmacy sees it now');
  eq((await call('GET /api/rx/:id/photo', PH3, {}, id)).status, 200, 'and its picture');
  eq((await call('POST /api/rx/:id/ready', PH2, {}, id)).status, 404, 'another pharmacy cannot act');
  pushes.length = 0;
  eq((await call('POST /api/rx/:id/ready', PH3, {}, id)).json.rx.status, 'ready', 'pharmacy marks it ready');
  ok(pushes.some(x => /روشتتك جاهزة في/.test(x.p.title) && /نوصّلهالك/.test(x.p.body)), 'patient is asked: collect or deliver');
  eq((await call('GET /api/rx', PAT)).json.list[0].needsAction, true, 'patient: needs action when ready');
  r = await call('POST /api/rx/:id/delivery', PAT, {}, id); eq(r.status, 200, 'patient asks for delivery'); ok(/RX-\d+/.test(r.json.orderText), 'text for the written order carries the number'); eq(r.json.pharmacyId, String(ph3), 'for that pharmacy');
  eq((await call('POST /api/rx/:id/pickup', PH3, {}, id)).json.rx.status, 'picked_up', 'pharmacy closes it');
  eq((await call('POST /api/rx/:id/pickup', PAT, {}, id)).status, 409, 'cannot close twice');
  eq((await call('POST /api/rx/:id/cancel', PAT, {}, id)).status, 409, 'cannot cancel a finished one');

  console.log('E) cancel and expiry');
  r = await call('POST /api/rx', CL, { appointmentId: String(a1), meds: 'باراسيتامول' }); const id2 = { id: r.json.rx.id };
  eq((await call('POST /api/rx/:id/choose', PAT, {}, id2)).status, 400, 'no pharmacy chosen yet');
  eq((await call('POST /api/rx/:id/cancel', CL, {}, id2)).json.rx.status, 'cancelled', 'the clinic can cancel');
  eq((await call('POST /api/rx/:id/choose', PAT, { pharmacyId: String(ph1) }, id2)).status, 409, 'a cancelled one cannot be sent');
  r = await call('POST /api/rx', CL, { appointmentId: String(a1), meds: 'فيتامين', pharmacyId: String(ph1) }); const id3 = { id: r.json.rx.id };
  await q("UPDATE prescriptions SET expires_at = NOW() - INTERVAL '1 hour' WHERE id=$1", [id3.id]);
  eq((await call('POST /api/rx/:id/choose', PAT, {}, id3)).status, 409, 'expired after 7 days: cannot be sent');
  eq((await call('GET /api/rx', PAT)).json.list.find(x => x.id === id3.id).status, 'expired', 'shown as expired');
  r = await call('POST /api/rx', CL, { appointmentId: String(a1), meds: 'قطرة', pharmacyId: String(ph1) }); const id4 = { id: r.json.rx.id };
  await call('POST /api/rx/:id/choose', PAT, {}, id4);
  await q("UPDATE prescriptions SET expires_at = NOW() - INTERVAL '1 hour' WHERE id=$1", [id4.id]);
  eq((await call('POST /api/rx/:id/ready', PH1, {}, id4)).status, 409, 'expired: the pharmacy cannot prepare it');
  eq((await call('GET /api/rx', A)).json.list.length >= 4, true, 'the owner sees all');
  console.log('F) price of the medicines + commission');
  const toReady = async (price) => {
    const x = await call('POST /api/rx', CL, { appointmentId: String(a1), meds: 'دواء', pharmacyId: String(ph1) }); const k = { id: x.json.rx.id };
    await call('POST /api/rx/:id/choose', PAT, {}, k);
    return { k, r: await call('POST /api/rx/:id/ready', PH1, price === undefined ? {} : { price }, k) };
  };
  eq((await toReady(0)).r.status, 400, 'a zero price is refused');
  eq((await toReady('abc')).r.status, 400, 'a non-number price is refused');
  eq((await toReady(-5)).r.status, 400, 'a negative price is refused');
  pushes.length = 0;
  let f = await toReady(185); eq(f.r.json.rx.price, 185, 'the price is saved'); ok(pushes.some(x => /185/.test(x.p.body)), 'the patient is told the price in the push');
  eq((await call('GET /api/rx', PAT)).json.list.find(x => x.id === f.k.id).price, 185, 'the patient sees the price');
  eq((await call('POST /api/rx/:id/price', PAT, { price: 1 }, f.k)).status, 403, 'the patient cannot change the price');
  pushes.length = 0;
  eq((await call('POST /api/rx/:id/price', PH1, { price: 200 }, f.k)).json.rx.price, 200, 'the pharmacy can change it while ready');
  ok(pushes.some(x => /سعر أدوية/.test(x.p.title) && /200/.test(x.p.body)), 'the patient is told it changed');
  eq((await call('POST /api/rx/:id/price', PH1, { price: 0 }, f.k)).status, 400, 'a zero price refused on change');
  eq((await call('POST /api/rx/:id/price', PH1, { price: 185 }, f.k)).json.rx.price, 185, 'back to 185');
  eq((await toReady()).r.json.rx.price, null, 'a prescription without price still works (old behaviour)');
  // commission: switch OFF -> nothing
  await q("DELETE FROM commission_entries WHERE rx_id IS NOT NULL");
  await call('POST /api/rx/:id/pickup', PH1, {}, f.k);
  eq((await q('SELECT COUNT(*)::int n FROM commission_entries WHERE rx_id=$1', [f.k.id])).rows[0].n, 0, 'switch OFF: no commission');
  // switch ON at 10%
  await call('PATCH /api/admin/features', A, { key: 'rxCommission', on: true });
  eq((await call('GET /api/admin/rx-commission', A)).json.enabled, true, 'admin sees it enabled');
  eq((await call('PATCH /api/admin/rx-commission', A, { percent: 150 })).status, 400, 'percent above 100 refused');
  eq((await call('PATCH /api/admin/rx-commission', A, { percent: 'x' })).status, 400, 'percent must be a number');
  eq((await call('PATCH /api/admin/rx-commission', A, { percent: 10 })).json.percent, 10, 'percent saved');
  f = await toReady(185); await call('POST /api/rx/:id/pickup', PAT, {}, f.k);
  let e = (await q("SELECT * FROM commission_entries WHERE rx_id=$1", [f.k.id])).rows;
  eq(e.length, 1, 'collected: one commission entry'); eq(Number(e[0].amount), 18.5, '10% of 185'); eq(String(e[0].provider_id), String(ph1), 'on the pharmacy'); eq(e[0].status, 'due', 'due');
  // delivered one: an ordinary order takes the commission, so none here
  f = await toReady(100); await call('POST /api/rx/:id/delivery', PAT, {}, f.k); await call('POST /api/rx/:id/pickup', PH1, {}, f.k);
  eq((await q('SELECT COUNT(*)::int n FROM commission_entries WHERE rx_id=$1', [f.k.id])).rows[0].n, 0, 'delivery path: no second commission');
  // delivery text carries the price
  f = await toReady(120); r = await call('POST /api/rx/:id/delivery', PAT, {}, f.k); ok(/120/.test(r.json.orderText), 'the written order text carries the price');
  // no price -> no commission; 0% -> none
  f = await toReady(); await call('POST /api/rx/:id/pickup', PAT, {}, f.k);
  eq((await q('SELECT COUNT(*)::int n FROM commission_entries WHERE rx_id=$1', [f.k.id])).rows[0].n, 0, 'no price: no commission');
  await call('PATCH /api/admin/rx-commission', A, { percent: 0 });
  f = await toReady(50); await call('POST /api/rx/:id/pickup', PAT, {}, f.k);
  eq((await q('SELECT COUNT(*)::int n FROM commission_entries WHERE rx_id=$1', [f.k.id])).rows[0].n, 0, '0%: no commission');
  eq((await call('GET /api/admin/rx-commission', PAT)).status, 403, 'only the owner reads the setting');
  await q("DELETE FROM commission_entries WHERE rx_id IS NOT NULL");

  console.log(bad ? `FAILED ${bad}` : 'ALL OK', 'pass=' + pass);
  await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
