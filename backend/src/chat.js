'use strict';
/**
 * Customer <-> shop chat before an order. Off unless the owner switches "chat" on; the owner can also close it for one shop.
 * Phone numbers are hidden so the talk stays inside the app, each side may send 20 messages an hour in one conversation,
 * and either side can report a message. The shop sees only the customer's first name.
 */
const extrasLib = require('./extras');
const MAX_BODY = 500;
const PER_HOUR = 20;

const AR = '٠١٢٣٤٥٦٧٨٩', FA = '۰۱۲۳۴۵۶۷۸۹';
/** Hide anything that looks like a phone number (7+ digits, even with spaces, dots or dashes between them, Arabic digits too). */
function maskPhones(text) {
  const latin = String(text).replace(/[٠-٩]/g, c => AR.indexOf(c)).replace(/[۰-۹]/g, c => FA.indexOf(c));
  return latin.replace(/\+?\d(?:[\s.\-_()]?\d){6,}/g, '••••••••');
}

module.exports = function registerChat(app, { pool, auth, roles, asyncRoute, positiveId, pushToUsers }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; }
  });
  const me = req => Number(req.auth.sub);
  const notify = (ids, payload) => { try { const p = pushToUsers && pushToUsers(ids, payload); if (p && p.catch) p.catch(() => {}); } catch { /* never fails the chat */ } };
  const msgJson = m => ({ id: String(m.id), mine: undefined, fromCustomer: m.from_customer, text: m.body, at: new Date(m.created_at).getTime() });
  const firstName = n => String(n || '').trim().split(/\s+/)[0] || 'عميل';
  const bodyOf = req => {
    const t = maskPhones(String((req.body || {}).text || '').trim().slice(0, MAX_BODY)).trim();
    if (!t) throw fail(400, 'اكتب رسالتك');
    return t;
  };
  const chatOpen = async providerId => {
    if (!(await extrasLib.featureOn(pool, 'chat'))) throw fail(409, 'المحادثة غير متاحة حاليًا');
    const p = await pool.query('SELECT id, owner_user_id, name, chat_disabled FROM providers WHERE id=$1', [providerId]);
    if (!p.rowCount) throw fail(404, 'المحل غير موجود');
    if (p.rows[0].chat_disabled) throw fail(409, 'المحادثة مقفولة لهذا المحل');
    return p.rows[0];
  };
  const sentRecently = async (threadId, fromCustomer) => {
    const n = await pool.query(`SELECT COUNT(*)::int AS c FROM chat_messages WHERE thread_id=$1 AND from_customer=$2 AND created_at > NOW() - INTERVAL '1 hour'`, [threadId, fromCustomer]);
    if (n.rows[0].c >= PER_HOUR) throw fail(429, 'رسائل كتير في وقت قصير، جرّب بعد شوية');
  };
  const add = async (thread, fromCustomer, text) => {
    await sentRecently(thread.id, fromCustomer);
    const m = await pool.query('INSERT INTO chat_messages(thread_id, from_customer, body) VALUES($1,$2,$3) RETURNING *', [thread.id, fromCustomer, text]);
    await pool.query(`UPDATE chat_threads SET last_message=$2, last_message_at=NOW(), ${fromCustomer ? 'unread_provider=unread_provider+1' : 'unread_customer=unread_customer+1'} WHERE id=$1`, [thread.id, text.slice(0, 80)]);
    return m.rows[0];
  };

  /* ---- customer side ---- */
  app.get('/api/providers/:id/chat', auth, roles('customer'), guard(async (req, res) => {
    const pid = positiveId(req.params.id);
    if (!pid) throw fail(400, 'معرّف غير صالح');
    res.set('Cache-Control', 'no-store');
    if (!(await extrasLib.featureOn(pool, 'chat'))) return res.json({ enabled: false, messages: [] });
    const p = await pool.query('SELECT chat_disabled FROM providers WHERE id=$1', [pid]);
    if (!p.rowCount || p.rows[0].chat_disabled) return res.json({ enabled: false, messages: [] });
    const t = await pool.query('SELECT id FROM chat_threads WHERE customer_id=$1 AND provider_id=$2', [me(req), pid]);
    if (!t.rowCount) return res.json({ enabled: true, messages: [] });
    await pool.query('UPDATE chat_threads SET unread_customer=0 WHERE id=$1', [t.rows[0].id]);
    const m = await pool.query('SELECT * FROM chat_messages WHERE thread_id=$1 ORDER BY id DESC LIMIT 100', [t.rows[0].id]);
    res.json({ enabled: true, messages: m.rows.reverse().map(x => ({ ...msgJson(x), mine: x.from_customer })) });
  }));
  app.post('/api/providers/:id/chat', auth, roles('customer'), guard(async (req, res) => {
    const pid = positiveId(req.params.id);
    if (!pid) throw fail(400, 'معرّف غير صالح');
    const text = bodyOf(req);
    const p = await chatOpen(pid);
    const t = (await pool.query(`INSERT INTO chat_threads(customer_id, provider_id) VALUES($1,$2) ON CONFLICT (customer_id, provider_id) DO UPDATE SET provider_id=EXCLUDED.provider_id RETURNING id`, [me(req), pid])).rows[0];
    const m = await add(t, true, text);
    const u = await pool.query('SELECT name FROM users WHERE id=$1', [me(req)]);
    notify([p.owner_user_id], { title: `رسالة من ${firstName(u.rows[0] && u.rows[0].name)}`, body: text.slice(0, 80), tag: 'chat-' + t.id, url: '/' });
    res.status(201).json({ message: { ...msgJson(m), mine: true } });
  }));

  /* ---- shop side ---- */
  const myProviders = async req => (await pool.query('SELECT id FROM providers WHERE owner_user_id=$1', [me(req)])).rows.map(x => x.id);
  app.get('/api/chat/threads', auth, roles('provider'), guard(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await extrasLib.featureOn(pool, 'chat'))) return res.json({ enabled: false, threads: [] });
    const ids = await myProviders(req);
    if (!ids.length) return res.json({ enabled: true, threads: [] });
    const r = await pool.query(`SELECT t.id, t.last_message, t.last_message_at, t.unread_provider, u.name FROM chat_threads t JOIN users u ON u.id=t.customer_id WHERE t.provider_id = ANY($1) ORDER BY t.last_message_at DESC LIMIT 100`, [ids]);
    res.json({ enabled: true, unread: r.rows.reduce((s, x) => s + x.unread_provider, 0), threads: r.rows.map(x => ({ id: String(x.id), name: firstName(x.name), last: x.last_message, at: new Date(x.last_message_at).getTime(), unread: x.unread_provider })) });
  }));
  const myThread = async (req, id) => {
    const t = await pool.query('SELECT t.*, p.owner_user_id, p.name AS pname, p.chat_disabled FROM chat_threads t JOIN providers p ON p.id=t.provider_id WHERE t.id=$1', [id]);
    if (!t.rowCount || String(t.rows[0].owner_user_id) !== String(me(req))) throw fail(404, 'المحادثة غير موجودة');
    return t.rows[0];
  };
  app.get('/api/chat/threads/:id', auth, roles('provider'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    const t = await myThread(req, id);
    await pool.query('UPDATE chat_threads SET unread_provider=0 WHERE id=$1', [id]);
    const m = await pool.query('SELECT * FROM chat_messages WHERE thread_id=$1 ORDER BY id DESC LIMIT 100', [id]);
    res.set('Cache-Control', 'no-store');
    res.json({ name: firstName((await pool.query('SELECT name FROM users WHERE id=$1', [t.customer_id])).rows[0].name), messages: m.rows.reverse().map(x => ({ ...msgJson(x), mine: !x.from_customer })) });
  }));
  app.post('/api/chat/threads/:id', auth, roles('provider'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    const text = bodyOf(req);
    const t = await myThread(req, id);
    await chatOpen(t.provider_id);
    const m = await add(t, false, text);
    notify([t.customer_id], { title: `رد من ${t.pname}`, body: text.slice(0, 80), tag: 'chat-' + id, url: '/' });
    res.status(201).json({ message: { ...msgJson(m), mine: true } });
  }));

  /* ---- reports and owner controls ---- */
  app.post('/api/chat/messages/:id/report', auth, roles('customer', 'provider'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    const r = await pool.query('SELECT m.id, t.customer_id, p.owner_user_id FROM chat_messages m JOIN chat_threads t ON t.id=m.thread_id JOIN providers p ON p.id=t.provider_id WHERE m.id=$1', [id]);
    if (!r.rowCount) throw fail(404, 'الرسالة غير موجودة');
    const x = r.rows[0];
    if (String(x.customer_id) !== String(me(req)) && String(x.owner_user_id) !== String(me(req))) throw fail(403, 'غير مسموح');
    await pool.query('INSERT INTO chat_reports(message_id, reporter_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, me(req)]);
    res.status(201).json({ ok: true });
  }));
  app.get('/api/admin/chat-reports', auth, roles('admin'), guard(async (_req, res) => {
    const r = await pool.query(`SELECT r.id, r.created_at, m.body, m.from_customer, p.id AS provider_id, p.name AS provider_name, u.name AS customer_name, ru.name AS reporter
      FROM chat_reports r JOIN chat_messages m ON m.id=r.message_id JOIN chat_threads t ON t.id=m.thread_id JOIN providers p ON p.id=t.provider_id JOIN users u ON u.id=t.customer_id JOIN users ru ON ru.id=r.reporter_id
      ORDER BY r.id DESC LIMIT 50`);
    res.set('Cache-Control', 'no-store');
    res.json({ reports: r.rows.map(x => ({ id: String(x.id), at: new Date(x.created_at).getTime(), text: x.body, from: x.from_customer ? `العميل ${x.customer_name}` : `المحل ${x.provider_name}`, reporter: x.reporter, providerId: String(x.provider_id), providerName: x.provider_name })) });
  }));
  app.patch('/api/admin/providers/:id/chat', auth, roles('admin'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    if (typeof (req.body || {}).disabled !== 'boolean') throw fail(400, 'القيمة غير صالحة');
    const r = await pool.query('UPDATE providers SET chat_disabled=$1 WHERE id=$2 RETURNING id', [req.body.disabled, id]);
    if (!r.rowCount) throw fail(404, 'المحل غير موجود');
    res.json({ ok: true });
  }));
};
module.exports.maskPhones = maskPhones;
