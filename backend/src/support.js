'use strict';
/**
 * In-app support chat.
 *
 *  - Every customer / shop / courier has ONE support conversation with the platform (support_threads) made of messages (support_messages).
 *  - The owner (admin) always sees every conversation. A supervisor sees them only while the owner has switched
 *    "support chat" on for that supervisor (users.support_chat, default OFF). The permission is checked in the
 *    database on every request, so switching it off takes effect at once: the supervisor can no longer list, open or answer anything.
 *  - Nothing is deleted. A conversation can be closed and reopens by itself when the user writes again.
 */
const MAX_BODY = 2000;

module.exports = function registerSupportRoutes(app, { pool, auth, roles, asyncRoute, positiveId, pushToUsers }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; }
  });
  const me = req => Number(req.auth.sub);
  const bodyOf = req => {
    const t = String((req.body || {}).text || '').trim().slice(0, MAX_BODY);
    if (!t) throw fail(400, 'اكتب رسالتك');
    return t;
  };
  const notify = (ids, payload) => { try { const p = pushToUsers && pushToUsers(ids, payload); if (p && p.catch) p.catch(() => {}); } catch { /* a failed push never fails the chat */ } };
  const msgJson = m => ({ id: String(m.id), threadId: String(m.thread_id), senderId: String(m.sender_user_id), senderName: m.sender_name, senderRole: m.sender_role, text: m.body, at: new Date(m.created_at).getTime() });
  const threadJson = t => ({ id: String(t.id), userId: String(t.user_id), status: t.status, lastMessage: t.last_message || '', lastAt: new Date(t.last_message_at).getTime(), unread: Number(t.unread_staff) });

  // who may work the support inbox: the owner always, a supervisor only while the owner allows it
  async function staffOnly(req) {
    if (req.auth.role === 'admin') return;
    if (req.auth.role === 'supervisor') {
      const r = await pool.query("SELECT support_chat FROM users WHERE id=$1 AND role='supervisor' AND deleted_at IS NULL AND status='active'", [me(req)]);
      if (r.rowCount && r.rows[0].support_chat) return;
    }
    throw fail(403, 'غير مسموح بالدخول إلى شات الدعم');
  }
  const userRoles = roles('customer', 'provider', 'courier');
  const staffRoles = roles('admin', 'supervisor');

  /* ---------- the user's own conversation ---------- */
  app.get('/api/support/mine', auth, userRoles, guard(async (req, res) => {
    const after = Number(req.query.after) > 0 ? Number(req.query.after) : 0;
    const t = (await pool.query('SELECT * FROM support_threads WHERE user_id=$1', [me(req)])).rows[0];
    if (!t) return res.json({ thread: null, messages: [] });
    const msgs = await pool.query('SELECT * FROM (SELECT * FROM support_messages WHERE thread_id=$1 AND id>$2 ORDER BY id DESC LIMIT 100) x ORDER BY id', [t.id, after]);
    if (Number(t.unread_user) > 0) await pool.query('UPDATE support_threads SET unread_user=0 WHERE id=$1', [t.id]);
    res.json({ thread: { id: String(t.id), status: t.status }, messages: msgs.rows.map(msgJson) });
  }));
  app.post('/api/support/mine/messages', auth, userRoles, guard(async (req, res) => {
    const text = bodyOf(req);
    const u = (await pool.query('SELECT name, role FROM users WHERE id=$1', [me(req)])).rows[0];
    if (!u) throw fail(404, 'الحساب غير موجود');
    const out = await withTx(async db => {
      const t = (await db.query(
        `INSERT INTO support_threads(user_id, status, last_message, last_message_at, unread_staff) VALUES($1,'open',$2,NOW(),1)
         ON CONFLICT (user_id) DO UPDATE SET status='open', last_message=EXCLUDED.last_message, last_message_at=NOW(), unread_staff=support_threads.unread_staff+1 RETURNING *`,
        [me(req), text.slice(0, 200)])).rows[0];
      const m = (await db.query('INSERT INTO support_messages(thread_id, sender_user_id, sender_name, sender_role, body) VALUES($1,$2,$3,$4,$5) RETURNING *', [t.id, me(req), u.name, u.role, text])).rows[0];
      return { t, m };
    });
    // tell the owner and every supervisor who may answer
    const staff = (await pool.query("SELECT id FROM users WHERE deleted_at IS NULL AND status='active' AND (role='admin' OR (role='supervisor' AND support_chat=TRUE))")).rows.map(r => r.id);
    notify(staff, { title: 'رسالة دعم جديدة', body: `${u.name}: ${text.slice(0, 80)}`, tag: 'support-' + out.t.id, url: '/', requireInteraction: true });
    res.status(201).json({ message: msgJson(out.m), thread: { id: String(out.t.id), status: out.t.status } });
  }));
  // a small counter for the badge: unread replies for a user, unread conversations for the staff who may work them
  app.get('/api/support/unread', auth, guard(async (req, res) => {
    if (req.auth.role === 'admin' || req.auth.role === 'supervisor') {
      try { await staffOnly(req); } catch { return res.json({ unread: 0 }); }
      const r = await pool.query("SELECT COUNT(*) AS n FROM support_threads WHERE status='open' AND unread_staff > 0");
      return res.json({ unread: Number(r.rows[0].n) });
    }
    const r = await pool.query('SELECT unread_user AS n FROM support_threads WHERE user_id=$1', [me(req)]);
    res.json({ unread: r.rowCount ? Number(r.rows[0].n) : 0 });
  }));

  /* ---------- the staff inbox ---------- */
  app.get('/api/support/threads', auth, staffRoles, guard(async (req, res) => {
    await staffOnly(req);
    const status = req.query.status === 'closed' ? 'closed' : 'open';
    const r = await pool.query(
      `SELECT t.*, u.name AS user_name, u.phone AS user_phone, u.role AS user_role FROM support_threads t JOIN users u ON u.id=t.user_id
       WHERE t.status=$1 ORDER BY (t.unread_staff > 0) DESC, t.last_message_at DESC LIMIT 100`, [status]);
    res.json({ threads: r.rows.map(t => ({ ...threadJson(t), userName: t.user_name, userPhone: t.user_phone, userRole: t.user_role })) });
  }));
  app.get('/api/support/threads/:id', auth, staffRoles, guard(async (req, res) => {
    await staffOnly(req);
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'محادثة غير صالحة');
    const after = Number(req.query.after) > 0 ? Number(req.query.after) : 0;
    const t = (await pool.query('SELECT t.*, u.name AS user_name, u.phone AS user_phone, u.role AS user_role FROM support_threads t JOIN users u ON u.id=t.user_id WHERE t.id=$1', [id])).rows[0];
    if (!t) throw fail(404, 'المحادثة غير موجودة');
    const msgs = await pool.query('SELECT * FROM (SELECT * FROM support_messages WHERE thread_id=$1 AND id>$2 ORDER BY id DESC LIMIT 200) x ORDER BY id', [id, after]);
    if (Number(t.unread_staff) > 0) await pool.query('UPDATE support_threads SET unread_staff=0 WHERE id=$1', [id]);
    res.json({ thread: { ...threadJson(t), userName: t.user_name, userPhone: t.user_phone, userRole: t.user_role }, messages: msgs.rows.map(msgJson) });
  }));
  app.post('/api/support/threads/:id/messages', auth, staffRoles, guard(async (req, res) => {
    await staffOnly(req);
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'محادثة غير صالحة');
    const text = bodyOf(req);
    const u = (await pool.query('SELECT name, role FROM users WHERE id=$1', [me(req)])).rows[0];
    const out = await withTx(async db => {
      const t = (await db.query('SELECT * FROM support_threads WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!t) throw fail(404, 'المحادثة غير موجودة');
      const m = (await db.query('INSERT INTO support_messages(thread_id, sender_user_id, sender_name, sender_role, body) VALUES($1,$2,$3,$4,$5) RETURNING *', [id, me(req), u.name, u.role, text])).rows[0];
      await db.query("UPDATE support_threads SET status='open', last_message=$2, last_message_at=NOW(), unread_user=unread_user+1, unread_staff=0 WHERE id=$1", [id, text.slice(0, 200)]);
      return { t, m };
    });
    notify([out.t.user_id], { title: 'رد من الدعم الفني', body: text.slice(0, 100), tag: 'support-reply', url: '/', requireInteraction: true });
    res.status(201).json({ message: msgJson(out.m) });
  }));
  app.post('/api/support/threads/:id/status', auth, staffRoles, guard(async (req, res) => {
    await staffOnly(req);
    const id = positiveId(req.params.id);
    const status = (req.body || {}).status;
    if (!id || !['open', 'closed'].includes(status)) throw fail(400, 'بيانات غير صالحة');
    const r = await pool.query('UPDATE support_threads SET status=$2 WHERE id=$1 RETURNING id', [id, status]);
    if (!r.rowCount) throw fail(404, 'المحادثة غير موجودة');
    res.json({ ok: true, status });
  }));

  /* ---------- the owner decides which supervisors work the support inbox ---------- */
  app.patch('/api/admin/supervisors/:id/support', auth, roles('admin'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    const enabled = (req.body || {}).enabled === true;
    const r = await pool.query("UPDATE users SET support_chat=$2 WHERE id=$1 AND role='supervisor' AND deleted_at IS NULL RETURNING id, support_chat", [id, enabled]);
    if (!r.rowCount) throw fail(404, 'المشرف غير موجود');
    res.json({ id: String(id), enabled: !!r.rows[0].support_chat });
  }));

  async function withTx(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; }
    catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  }
};
