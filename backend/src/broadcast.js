'use strict';
/**
 * Owner broadcasts: one message that reaches everyone (or one group) as a phone notification AND as a message inside the app
 * (so users without push still see it once). Audiences: all | customer | courier | provider | captain.
 */
const AUD = ['all', 'customer', 'courier', 'provider', 'captain'];
const AUD_AR = { all: 'الكل', customer: 'العملاء', courier: 'المناديب', provider: 'المحلات', captain: 'الكباتن' };
const WHERE = {
  all: "u.role NOT IN ('admin','manager')",
  customer: "u.role = 'customer'",
  courier: "u.role = 'courier'",
  provider: "u.role = 'provider'",
  captain: 'EXISTS (SELECT 1 FROM captain_profiles cp WHERE cp.user_id = u.id)',
};
/** a user sees a broadcast when it is for all, for his role, or for captains and he is one */
const MATCH = `(b.audience='all' OR b.audience=u.role OR (b.audience='captain' AND EXISTS (SELECT 1 FROM captain_profiles cp WHERE cp.user_id=u.id)))`;

function register(app, { pool, auth, roles, asyncRoute, positiveId, pushToUsers }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; }
  });
  const out = r => ({ id: Number(r.id), title: r.title, body: r.body, audience: r.audience, audienceAr: AUD_AR[r.audience] || r.audience, sentTo: r.sent_to, createdAt: new Date(r.created_at).getTime() });
  const recent = async () => (await pool.query('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 30')).rows.map(out);

  const count = async aud => Number((await pool.query(`SELECT COUNT(*) FROM users u WHERE u.status='active' AND ${WHERE[aud]}`)).rows[0].count);
  app.get('/api/admin/broadcasts', auth, roles('admin'), asyncRoute(async (_req, res) => {
    const counts = {};
    for (const a of AUD) counts[a] = await count(a);
    const dev = Number((await pool.query('SELECT COUNT(DISTINCT user_id) FROM push_subscriptions')).rows[0].count);
    res.json({ broadcasts: await recent(), counts, pushUsers: dev });
  }));
  app.post('/api/admin/broadcasts', auth, roles('admin'), guard(async (req, res) => {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 80), body = String(b.body || '').trim().slice(0, 400);
    const aud = AUD.includes(b.audience) ? b.audience : 'all';
    if (!title) throw fail(400, 'اكتب عنوان الإشعار');
    const ids = (await pool.query(`SELECT u.id FROM users u WHERE u.status='active' AND ${WHERE[aud]}`)).rows.map(r => Number(r.id));
    const ins = await pool.query('INSERT INTO broadcasts(title, body, audience, sent_to) VALUES($1,$2,$3,$4) RETURNING *', [title, body, aud, ids.length]);
    if (ids.length && typeof pushToUsers === 'function') {
      const p = pushToUsers(ids, { title, body, tag: `bc-${ins.rows[0].id}`, url: '/' });
      if (p && p.catch) p.catch(() => {});
    }
    res.status(201).json({ broadcast: out(ins.rows[0]), broadcasts: await recent() });
  }));
  app.delete('/api/admin/broadcasts/:id', auth, roles('admin'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'إشعار غير صحيح');
    await pool.query('DELETE FROM broadcasts WHERE id=$1', [id]);
    res.json({ broadcasts: await recent() });
  }));

  /** messages this user has not dismissed yet (last 3 days) */
  app.get('/api/broadcasts/unread', auth, asyncRoute(async (req, res) => {
    const r = await pool.query(
      `SELECT b.* FROM broadcasts b JOIN users u ON u.id=$1
        WHERE b.created_at > NOW() - INTERVAL '3 days' AND b.created_at >= u.created_at - INTERVAL '1 day' AND ${MATCH}
          AND NOT EXISTS (SELECT 1 FROM broadcast_seen s WHERE s.broadcast_id=b.id AND s.user_id=u.id)
        ORDER BY b.created_at DESC LIMIT 5`, [Number(req.auth.sub)]);
    res.json({ broadcasts: r.rows.map(out) });
  }));
  app.post('/api/broadcasts/:id/seen', auth, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'إشعار غير صحيح');
    await pool.query('INSERT INTO broadcast_seen(broadcast_id, user_id) SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM broadcasts WHERE id=$1) ON CONFLICT DO NOTHING', [id, Number(req.auth.sub)]);
    res.json({ ok: true });
  }));
}
module.exports = { register, AUD };
