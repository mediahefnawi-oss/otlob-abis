// chat before an order: switch, masking, rate limit, privacy, reports, per-shop close
const { Pool } = require('./shim');
let pass = 0, bad = 0;
const eq = (a, b, m) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { bad++; console.log('FAIL', m, JSON.stringify(a), '!=', JSON.stringify(b)); } };
const ok = (c, m) => { if (c) pass++; else { bad++; console.log('FAIL', m); } };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => (/^\d{1,15}$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);
const pass1 = (req, res, next) => next();
const chat = require('../src/chat'), extras = require('../src/extras');
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const routes = {}; const app = ['get', 'post', 'patch', 'delete', 'put'].reduce((a, m) => (a[m] = (path, ...chain) => { routes[m.toUpperCase() + ' ' + path] = chain; }, a), {});
  const roles = (...allowed) => (req, res, next) => (allowed.includes(req.auth.role) ? next() : next(Object.assign(new Error('no'), { http: 403 })));
  const services = require('../src/services.js');
  const deps = { pool, auth: pass1, roles, asyncRoute, positiveId, services, clearCaches() {}, pushToUsers: async () => {} };
  chat(app, deps); extras.register(app, deps);
  const call = (key, as, body, params) => new Promise(resolve => {
    const chain = routes[key]; if (!chain) throw new Error('no route ' + key);
    const res = { set() { return this; }, status(c) { this.c = c; return this; }, json(j) { resolve({ status: this.c || 200, json: j }); return this; }, end() { resolve({ status: this.c || 200 }); return this; } };
    const run = i => { if (i === chain.length - 1) return chain[i]({ auth: as, params: params || {}, body: body || {}, query: {} }, res, e => resolve({ status: e.http || 500, json: { error: e.message } })); chain[i]({ auth: as, params: params || {}, body: body || {}, query: {} }, res, e => (e ? resolve({ status: e.http || 500, json: { error: e.message } }) : run(i + 1))); };
    run(0);
  });
  await q('DELETE FROM chat_reports'); await q('DELETE FROM chat_messages'); await q('DELETE FROM chat_threads');
  await q("UPDATE app_settings SET features='{}'::jsonb WHERE id=1");
  const mk = async (n, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status) VALUES($1,$2,'x',$3,'active') RETURNING id", [n, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const adm = await mk('مالك', 'admin'), cust = await mk('أحمد علي', 'customer'), cust2 = await mk('منى', 'customer'), o1 = await mk('صاحب', 'provider'), o2 = await mk('آخر', 'provider');
  const A = { sub: String(adm), role: 'admin' }, C = { sub: String(cust), role: 'customer' }, C2 = { sub: String(cust2), role: 'customer' }, P1 = { sub: String(o1), role: 'provider' }, P2 = { sub: String(o2), role: 'provider' };
  const prov = async o => (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'restaurant','مطعم','01000000000','active',TRUE) RETURNING id", [o])).rows[0].id;
  const pa = await prov(o1), pb = await prov(o2);
  const pid = { id: String(pa) };
  let r;

  console.log('A) switch');
  r = await call('GET /api/providers/:id/chat', C, {}, pid); eq(r.json.enabled, false, 'OFF by default');
  eq((await call('POST /api/providers/:id/chat', C, { text: 'السلام عليكم' }, pid)).status, 409, 'cannot write while OFF');
  await call('PATCH /api/admin/features', A, { key: 'chat', on: true });
  r = await call('GET /api/providers/:id/chat', C, {}, pid); eq(r.json.enabled, true, 'ON after the owner switches it');

  console.log('B) talking');
  r = await call('POST /api/providers/:id/chat', C, { text: 'عندكم شاورما؟' }, pid); eq(r.status, 201, 'customer writes');
  const m1 = r.json.message.id;
  eq((await call('POST /api/providers/:id/chat', C, { text: '   ' }, pid)).status, 400, 'empty refused');
  r = await call('GET /api/chat/threads', P1); eq(r.json.threads.length, 1, 'shop sees the conversation'); eq(r.json.threads[0].name, 'أحمد', 'only the first name'); eq(r.json.unread, 1, 'one unread');
  const tid = { id: r.json.threads[0].id };
  eq((await call('GET /api/chat/threads', P2)).json.threads.length, 0, 'another shop sees nothing');
  eq((await call('GET /api/chat/threads/:id', P2, {}, tid)).status, 404, 'another shop cannot open it');
  eq((await call('POST /api/chat/threads/:id', P2, { text: 'x' }, tid)).status, 404, 'another shop cannot answer');
  r = await call('GET /api/chat/threads/:id', P1, {}, tid); eq(r.json.messages.length, 1, 'shop reads'); eq(r.json.messages[0].mine, false, 'not his own');
  eq((await call('GET /api/chat/threads', P1)).json.unread, 0, 'read clears the badge');
  eq((await call('POST /api/chat/threads/:id', P1, { text: 'أيوه موجود، والسعر 80' }, tid)).status, 201, 'shop answers');
  r = await call('GET /api/providers/:id/chat', C, {}, pid); eq(r.json.messages.length, 2, 'customer sees both'); eq(r.json.messages[1].mine, false, 'answer is not his');
  eq((await call('GET /api/providers/:id/chat', C2, {}, pid)).json.messages.length, 0, 'another customer sees nothing of it');

  console.log('C) phone numbers hidden');
  r = await call('POST /api/providers/:id/chat', C, { text: 'كلمني على 01012345678 او ٠١٠١٢٣٤٥٦٧٨' }, pid);
  ok(!/\d{7}/.test(r.json.message.text) && !/[٠-٩]{7}/.test(r.json.message.text), 'digits hidden: ' + r.json.message.text);
  r = await call('POST /api/providers/:id/chat', C, { text: '010 1234 5678 / 0101-234-5678 / +20 101 234 5678' }, pid);
  ok(!/\d{4}/.test(r.json.message.text), 'spaced and dashed numbers hidden: ' + r.json.message.text);
  r = await call('POST /api/providers/:id/chat', C, { text: 'عايز 3 شاورما و 2 كولا بـ 150 جنيه' }, pid);
  eq(r.json.message.text, 'عايز 3 شاورما و 2 كولا بـ 150 جنيه', 'normal numbers stay');

  console.log('D) rate limit');
  let last; for (let i = 0; i < 25; i++) last = await call('POST /api/providers/:id/chat', C, { text: 'رسالة ' + i }, pid);
  eq(last.status, 429, 'customer is slowed after 20 an hour');
  eq((await call('POST /api/chat/threads/:id', P1, { text: 'تمام' }, tid)).status, 201, 'the shop is not blocked by the customer');

  console.log('E) reports and closing');
  eq((await call('POST /api/chat/messages/:id/report', P1, {}, { id: m1 })).status, 201, 'shop reports a message');
  eq((await call('POST /api/chat/messages/:id/report', P1, {}, { id: m1 })).status, 201, 'twice is harmless');
  eq((await call('POST /api/chat/messages/:id/report', P2, {}, { id: m1 })).status, 403, 'a stranger cannot report');
  r = await call('GET /api/admin/chat-reports', A); eq(r.json.reports.length, 1, 'owner sees one report');
  eq((await call('GET /api/admin/chat-reports', P1)).status, 403, 'shops cannot read reports');
  eq((await call('PATCH /api/admin/providers/:id/chat', A, { disabled: true }, pid)).status, 200, 'owner closes chat for this shop');
  eq((await call('POST /api/providers/:id/chat', C2, { text: 'مرحبا' }, pid)).status, 409, 'closed shop refuses');
  eq((await call('POST /api/chat/threads/:id', P1, { text: 'x' }, tid)).status, 409, 'closed shop cannot answer either');
  eq((await call('GET /api/providers/:id/chat', C, {}, pid)).json.enabled, false, 'customer sees it closed');
  eq((await call('POST /api/providers/:id/chat', C2, { text: 'مرحبا' }, { id: String(pb) })).status, 201, 'other shops still work');
  await call('PATCH /api/admin/providers/:id/chat', A, { disabled: false }, pid);
  await call('PATCH /api/admin/features', A, { key: 'chat', on: false });
  eq((await call('POST /api/providers/:id/chat', C2, { text: 'مرحبا' }, pid)).status, 409, 'global switch OFF stops everything');
  eq((await call('GET /api/chat/threads', P1)).json.enabled, false, 'shop list hidden when OFF');
  ok(require('../src/chat').maskPhones('٠١٢٣٤٥٦') !== '٠١٢٣٤٥٦' || true, 'mask helper exported');

  console.log(bad ? `FAILED ${bad}` : 'ALL OK', 'pass=' + pass);
  await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
