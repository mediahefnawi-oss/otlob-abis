const { Pool } = require('./shim');
const comm = require('../src/support.js');
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
  await q(`TRUNCATE support_messages, support_threads, commission_entries, commission_settlements, counter_resets, audit_log, appointments, orders, products, providers, users RESTART IDENTITY CASCADE`);
  const user = async (name, role) => (await q("INSERT INTO users(name, phone, password_hash, role) VALUES($1,$2,'x',$3) RETURNING id", [name, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const admin = await user('المالك', 'admin'), c1 = await user('عميل 1', 'customer'), c2 = await user('عميل 2', 'customer'), shop = await user('محل', 'provider'), sup = await user('مشرف', 'supervisor'), sup2 = await user('مشرف 2', 'supervisor');
  const pushes = [];
  const sup_mod = comm; // the support module (the first lines of this file load it as "comm")
  sup_mod(app, { pool, auth, roles, asyncRoute, positiveId, pushToUsers: (ids, p) => { pushes.push({ ids: ids.map(Number), p }); return Promise.resolve(); } });
  const A = { sub: String(admin), role: 'admin' }, C1 = { sub: String(c1), role: 'customer' }, C2 = { sub: String(c2), role: 'customer' }, SH = { sub: String(shop), role: 'provider' }, S1 = { sub: String(sup), role: 'supervisor' }, S2 = { sub: String(sup2), role: 'supervisor' };

  console.log('1) a user writes to support');
  eq((await call('GET /api/support/mine', { as: C1 })).json.thread, null, 'no thread yet');
  eq((await call('POST /api/support/mine/messages', { as: C1, body: { text: '   ' } })).status, 400, 'empty refused');
  const m1 = await call('POST /api/support/mine/messages', { as: C1, body: { text: 'الطلب اتأخر' } });
  eq(m1.status, 201, 'sent'); eq(m1.json.message.senderName, 'عميل 1', 'sender name'); eq(m1.json.message.senderRole, 'customer', 'sender role');
  await call('POST /api/support/mine/messages', { as: C1, body: { text: 'ممكن حد يرد؟' } });
  await call('POST /api/support/mine/messages', { as: C2, body: { text: 'عايز أغيّر عنواني' } });
  eq((await q('SELECT count(*) c FROM support_threads')).rows[0].c, '2', 'one thread per user'); 
  eq((await call('POST /api/support/mine/messages', { as: A, body: { text: 'x' } })).status, 403, 'admin has no personal thread');
  eq((await call('POST /api/support/mine/messages', { as: S1, body: { text: 'x' } })).status, 403, 'supervisor has no personal thread');
  ok(pushes.some(x => x.ids.includes(Number(admin))), 'owner is notified'); ok(!pushes.some(x => x.ids.includes(Number(sup))), 'supervisor without permission is NOT notified');

  console.log('2) supervisor is locked out by default');
  eq((await call('GET /api/support/threads', { as: S1 })).status, 403, 'supervisor list refused');
  eq((await call('GET /api/support/threads/:id', { as: S1, params: { id: '1' } })).status, 403, 'supervisor open refused');
  eq((await call('POST /api/support/threads/:id/messages', { as: S1, params: { id: '1' }, body: { text: 'hi' } })).status, 403, 'supervisor reply refused');
  eq((await call('GET /api/support/unread', { as: S1 })).json.unread, 0, 'supervisor unread = 0');
  eq((await call('GET /api/support/threads', { as: C1 })).status, 403, 'customer cannot list the inbox');

  console.log('3) the owner works the inbox');
  const l = await call('GET /api/support/threads', { as: A });
  eq(l.json.threads.length, 2, 'two open threads'); eq(l.json.threads[0].unread > 0, true, 'unread first');
  eq((await call('GET /api/support/unread', { as: A })).json.unread, 2, 'owner badge = 2 threads');
  const t1 = l.json.threads.find(t => t.userId === String(c1));
  eq(t1.unread, 2, 'c1 has 2 unread'); eq(t1.userName, 'عميل 1', 'user name shown');
  const open = await call('GET /api/support/threads/:id', { as: A, params: { id: t1.id } });
  eq(open.json.messages.length, 2, 'both messages'); eq((await call('GET /api/support/unread', { as: A })).json.unread, 1, 'opening clears that thread');
  const rep = await call('POST /api/support/threads/:id/messages', { as: A, params: { id: t1.id }, body: { text: 'تم، بنتابع' } });
  eq(rep.status, 201, 'owner reply'); eq(rep.json.message.senderRole, 'admin', 'staff role shown');
  ok(pushes.some(x => x.ids.includes(Number(c1)) && x.p.title === 'رد من الدعم الفني'), 'user is notified of the reply');
  const mine = await call('GET /api/support/mine', { as: C1 });
  eq(mine.json.messages.length, 3, 'user sees the thread'); eq((await call('GET /api/support/unread', { as: C1 })).json.unread, 0, 'unread cleared after reading');
  const later = await call('GET /api/support/mine', { as: C1, query: { after: String(m1.json.message.id) } });
  eq(later.json.messages.length, 2, 'only messages after id');
  eq((await call('GET /api/support/mine', { as: C2 })).json.messages.length, 1, 'c2 sees only his own conversation');

  console.log('4) close and reopen');
  eq((await call('POST /api/support/threads/:id/status', { as: A, params: { id: t1.id }, body: { status: 'closed' } })).status, 200, 'closed');
  eq((await call('GET /api/support/threads', { as: A })).json.threads.length, 1, 'closed one leaves the open list');
  eq((await call('GET /api/support/threads', { as: A, query: { status: 'closed' } })).json.threads.length, 1, 'shows in closed');
  await call('POST /api/support/mine/messages', { as: C1, body: { text: 'رجعت تاني' } });
  eq((await call('GET /api/support/threads', { as: A })).json.threads.length, 2, 'user writing reopens it');
  eq((await call('POST /api/support/threads/:id/status', { as: A, params: { id: t1.id }, body: { status: 'weird' } })).status, 400, 'bad status refused');

  console.log('5) owner lets a supervisor in, then takes it back');
  eq((await call('PATCH /api/admin/supervisors/:id/support', { as: S1, params: { id: String(sup) }, body: { enabled: true } })).status, 403, 'a supervisor cannot grant himself access');
  eq((await call('PATCH /api/admin/supervisors/:id/support', { as: A, params: { id: String(shop) }, body: { enabled: true } })).status, 404, 'only supervisors can be granted');
  eq((await call('PATCH /api/admin/supervisors/:id/support', { as: A, params: { id: String(sup) }, body: { enabled: true } })).json.enabled, true, 'granted');
  const sl = await call('GET /api/support/threads', { as: S1 });
  eq(sl.status, 200, 'supervisor now sees the inbox'); eq(sl.json.threads.length, 2, 'both threads');
  const sr = await call('POST /api/support/threads/:id/messages', { as: S1, params: { id: t1.id }, body: { text: 'أنا المشرف وهحل المشكلة' } });
  eq(sr.status, 201, 'supervisor replies'); eq(sr.json.message.senderRole, 'supervisor', 'reply carries his role/name'); eq(sr.json.message.senderName, 'مشرف', 'his name');
  eq((await call('GET /api/support/threads', { as: S2 })).status, 403, 'the other supervisor is still locked out');
  await call('POST /api/support/mine/messages', { as: C2, body: { text: 'ردّوا عليّ' } });
  ok(pushes.slice(-1)[0].ids.includes(Number(sup)), 'allowed supervisor is notified of new messages');
  eq((await call('PATCH /api/admin/supervisors/:id/support', { as: A, params: { id: String(sup) }, body: { enabled: false } })).json.enabled, false, 'revoked');
  eq((await call('GET /api/support/threads', { as: S1 })).status, 403, 'list refused at once');
  eq((await call('GET /api/support/threads/:id', { as: S1, params: { id: t1.id } })).status, 403, 'open refused at once');
  eq((await call('POST /api/support/threads/:id/messages', { as: S1, params: { id: t1.id }, body: { text: 'still here?' } })).status, 403, 'reply refused at once');
  eq((await call('GET /api/support/unread', { as: S1 })).json.unread, 0, 'badge gone');
  const all = await call('GET /api/support/threads/:id', { as: A, params: { id: t1.id } });
  ok(all.json.messages.some(m => m.senderName === 'مشرف'), 'his old reply stays in the history');
  eq(Number((await q('SELECT count(*) c FROM support_messages')).rows[0].c) >= 6, true, 'nothing deleted');
  eq((await call('GET /api/support/threads/:id', { as: A, params: { id: '9999' } })).status, 404, 'unknown thread');
  eq((await call('GET /api/support/mine', { as: SH })).status, 200, 'shops can use support too');

  console.log(failN ? `FAILED ${failN}` : 'ALL OK', 'pass=' + pass);
  await pool.end();
  process.exit(failN ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
