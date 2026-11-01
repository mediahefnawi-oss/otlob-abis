const { Pool } = require('./shim');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const pass1 = (req, res, next) => next();
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  require('../src/orders.js')(app, { pool, auth: pass1, authAny: pass1, roles: () => pass1, asyncRoute, positiveId,
    maintenanceState: async () => ({ enabled: true }), loadSettings: async () => ({}), cleanUser: x => x, pushToUsers: async () => {} });
  const call = async (key, as, query) => {
    const chain = routes[key]; const out = { json: null };
    const req = { auth: as, params: {}, body: {}, query: query || {} };
    const res = { set() { return this; }, status() { return this; }, json(j) { out.json = j; return this; } };
    let err = null; chain[chain.length - 1](req, res, e => { err = e; });
    const t0 = Date.now(); while (!err && out.json === null && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 2));
    if (err) throw err; return out.json;
  };
  const u = async (n, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status, available) VALUES($1,$2,'x',$3,'active',TRUE) RETURNING id", [n, '011' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const cust = await u('ع', 'customer'), po = await u('ص', 'provider'), cour = await u('م', 'courier'), adm = await u('أ', 'admin');
  const p = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'supermarket','س','01000000000','active',TRUE) RETURNING id", [po])).rows[0].id;
  const A = id => ({ sub: String(id), role: id === cust ? 'customer' : id === po ? 'provider' : id === cour ? 'courier' : 'admin', status: 'active' });
  for (const id of [cust, po, cour, adm]) {
    const a = await call('GET /api/sync', A(id));
    ok(a.tag && !a.warnings.length, `full answer carries a tag (${id}) ${JSON.stringify(a.warnings)}`);
    const b = await call('GET /api/sync', A(id), { tag: a.tag });
    ok(b.unchanged === true && b.tag === a.tag, `same tag -> unchanged (${id})`);
    const c = await call('GET /api/sync', A(id), { tag: 'bogus' });
    ok(!c.unchanged && c.tag === a.tag, `wrong tag -> full answer (${id})`);
  }
  const t0 = (await call('GET /api/sync', A(cust))).tag, tp = (await call('GET /api/sync', A(po))).tag, tc = (await call('GET /api/sync', A(cour))).tag;
  const o = (await q("INSERT INTO orders(customer_user_id, provider_id, status, total, data) VALUES($1,$2,'pending',50,$3) RETURNING id", [cust, p, JSON.stringify({ history: [] })])).rows[0].id;
  ok(!(await call('GET /api/sync', A(cust), { tag: t0 })).unchanged, 'new order changes customer tag');
  ok(!(await call('GET /api/sync', A(po), { tag: tp })).unchanged, 'new order changes provider tag');
  ok((await call('GET /api/sync', A(cour), { tag: tc })).unchanged, 'pending order is invisible to courier -> tag same');
  const t1 = (await call('GET /api/sync', A(cust))).tag;
  await q("UPDATE orders SET status='accepted', updated_at=NOW()+interval '1 second' WHERE id=$1", [o]);
  ok(!(await call('GET /api/sync', A(cust), { tag: t1 })).unchanged, 'status change changes tag');
  ok(!(await call('GET /api/sync', A(cour), { tag: tc })).unchanged, 'accepted order shows up for courier');
  const t2 = (await call('GET /api/sync', A(cust))).tag;
  await q("INSERT INTO messages(order_id,sender_user_id,body) VALUES($1,$2,'مرحبا')", [o, po]);
  ok(!(await call('GET /api/sync', A(cust), { tag: t2 })).unchanged, 'new chat message changes tag');
  const t3 = (await call('GET /api/sync', A(cust))).tag;
  await q("UPDATE users SET name='اسم جديد' WHERE id=$1", [cust]);
  ok(!(await call('GET /api/sync', A(cust), { tag: t3 })).unchanged, 'profile change changes tag');
  const t4 = (await call('GET /api/sync', A(po))).tag;
  await q("UPDATE app_settings SET announcement='x', updated_at=NOW()+interval '2 second' WHERE id=1");
  ok(!(await call('GET /api/sync', A(po), { tag: t4 })).unchanged, 'settings change changes tag');
  const t5 = (await call('GET /api/sync', A(adm))).tag; await q("UPDATE users SET available=FALSE WHERE id=$1", [cour]);
  ok(!(await call('GET /api/sync', A(adm), { tag: t5 })).unchanged, 'courier going offline changes tag');
  // speed: 200 fingerprint checks
  const tt = Date.now(); for (let i = 0; i < 200; i++) await call('GET /api/sync', A(cust), { tag: t3 }); console.log('200 checks ms:', Date.now() - tt);
  console.log(`sync tests: ${pass} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
