'use strict';
/**
 * Group order: one shared cart per shop. The owner opens it and sends the link; each friend adds from his own account.
 * The owner alone confirms and pays: he sends the merged lines through the normal checkout (so every rule there still applies),
 * then marks the cart done. Behind the switch "groupOrder" (OFF).
 */
const crypto = require('crypto');
const offersLib = require('./offers');

const TTL_HOURS = 2, MAX_MEMBERS = 20, MAX_ITEMS = 80;
const newCode = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);

function register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => { try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; } });
  const cust = [auth, roles('customer')];
  const me = req => Number(req.auth.sub);
  const need = async () => { if (!(await extrasLib.featureOn(pool, 'groupOrder'))) throw fail(404, 'الطلب الجماعي غير متاح الآن'); };

  async function load(code) {
    const c = await pool.query(`SELECT g.*, p.name AS pname, p.type AS ptype, p.status AS pstatus, p.is_open FROM group_carts g JOIN providers p ON p.id=g.provider_id WHERE g.code=$1`, [String(code || '').slice(0, 20)]);
    if (!c.rowCount) throw fail(404, 'السلة غير موجودة');
    const g = c.rows[0];
    if (g.status === 'open' && new Date(g.expires_at) < new Date()) { await pool.query("UPDATE group_carts SET status='cancelled' WHERE id=$1", [g.id]); g.status = 'cancelled'; }
    return g;
  }
  const open = g => { if (g.status !== 'open') throw fail(410, g.status === 'ordered' ? 'السلة اتأكدت بالفعل' : 'السلة انتهت أو اتلغت'); };

  async function view(g, uid) {
    const offers = await offersLib.activeOffers(pool), best = offersLib.bestOffer(offers, g.provider_id);
    const r = await pool.query(`SELECT i.id, i.user_id, i.qty, i.product_id, pr.name, pr.price, pr.available, pr.data, u.name AS uname
      FROM group_items i JOIN products pr ON pr.id=i.product_id JOIN users u ON u.id=i.user_id WHERE i.cart_id=$1 ORDER BY i.id`, [g.id]);
    const members = new Map();
    let total = 0;
    for (const x of r.rows) {
      const price = Number(offersLib.salePrice(x.price, best)), line = Math.round(price * x.qty * 100) / 100;
      if (!members.has(String(x.user_id))) members.set(String(x.user_id), { userId: Number(x.user_id), name: x.uname, isOwner: Number(x.user_id) === Number(g.owner_id), items: [], subtotal: 0 });
      const m = members.get(String(x.user_id));
      m.items.push({ id: Number(x.id), productId: Number(x.product_id), name: x.name, emoji: (x.data && x.data.emoji) || '📦', price, qty: x.qty, line, available: x.available, canRemove: Number(g.owner_id) === uid || Number(x.user_id) === uid });
      m.subtotal = Math.round((m.subtotal + line) * 100) / 100;
      total += line;
    }
    const mine = Number(g.owner_id) === uid;
    return {
      code: g.code, status: g.status, providerId: Number(g.provider_id), providerName: g.pname, isOwner: mine, expiresAt: g.expires_at,
      members: [...members.values()], total: Math.round(total * 100) / 100,
      lines: mine ? r.rows.map(x => ({ productId: String(x.product_id), qty: x.qty })) : undefined, // what the owner sends to the normal checkout
    };
  }

  app.post('/api/group-carts', ...cust, guard(async (req, res) => {
    await need();
    const pid = positiveId((req.body || {}).providerId); if (!pid) throw fail(400, 'اختر المحل');
    const p = await pool.query("SELECT id, type, status, is_open FROM providers WHERE id=$1 AND deleted_at IS NULL", [pid]);
    if (!p.rowCount || p.rows[0].status !== 'active') throw fail(404, 'المحل غير متاح');
    if (!p.rows[0].is_open) throw fail(409, 'المحل مغلق حالياً');
    const ex = await pool.query("SELECT code FROM group_carts WHERE owner_id=$1 AND provider_id=$2 AND status='open' AND expires_at > NOW()", [me(req), pid]);
    if (ex.rowCount) return res.json({ code: ex.rows[0].code, reused: true });
    const code = newCode();
    await pool.query(`INSERT INTO group_carts(code, owner_id, provider_id, expires_at) VALUES($1,$2,$3, NOW() + ($4 || ' hours')::interval)`, [code, me(req), pid, String(TTL_HOURS)]);
    res.status(201).json({ code, reused: false });
  }));
  app.get('/api/group-carts/:code', ...cust, guard(async (req, res) => {
    await need();
    res.json({ cart: await view(await load(req.params.code), me(req)) });
  }));
  /** add / change my own item (qty 0 removes it) */
  app.put('/api/group-carts/:code/items', ...cust, guard(async (req, res) => {
    await need();
    const g = await load(req.params.code); open(g);
    const pid = positiveId((req.body || {}).productId), qty = Math.floor(Number((req.body || {}).qty));
    if (!pid || !Number.isFinite(qty) || qty < 0 || qty > 50) throw fail(400, 'بيانات غير صحيحة');
    if (qty === 0) { await pool.query('DELETE FROM group_items WHERE cart_id=$1 AND user_id=$2 AND product_id=$3', [g.id, me(req), pid]); return res.json({ cart: await view(g, me(req)) }); }
    const pr = await pool.query('SELECT available FROM products WHERE id=$1 AND provider_id=$2', [pid, g.provider_id]);
    if (!pr.rowCount) throw fail(404, 'المنتج مش من نفس المحل');
    if (!pr.rows[0].available) throw fail(409, 'المنتج غير متاح حالياً');
    const st = await pool.query('SELECT COUNT(DISTINCT user_id)::int AS m, COUNT(*)::int AS n, BOOL_OR(user_id=$2) AS joined FROM group_items WHERE cart_id=$1', [g.id, me(req)]);
    if (!st.rows[0].joined && st.rows[0].m >= MAX_MEMBERS) throw fail(409, 'السلة وصلت للحد الأقصى من الأشخاص');
    if (st.rows[0].n >= MAX_ITEMS) throw fail(409, 'السلة وصلت للحد الأقصى من الأصناف');
    await pool.query(`INSERT INTO group_items(cart_id, user_id, product_id, qty) VALUES($1,$2,$3,$4) ON CONFLICT (cart_id, user_id, product_id) DO UPDATE SET qty=$4`, [g.id, me(req), pid, qty]);
    res.json({ cart: await view(g, me(req)) });
  }));
  /** the owner removes anybody's item; a friend removes only his own */
  app.delete('/api/group-carts/:code/items/:itemId', ...cust, guard(async (req, res) => {
    await need();
    const g = await load(req.params.code); open(g);
    const id = positiveId(req.params.itemId); if (!id) throw fail(400, 'معرّف غير صالح');
    const r = await pool.query('DELETE FROM group_items WHERE id=$1 AND cart_id=$2 AND ($3 OR user_id=$4) RETURNING id', [id, g.id, Number(g.owner_id) === me(req), me(req)]);
    if (!r.rowCount) throw fail(403, 'لا يمكنك حذف هذا الصنف');
    res.json({ cart: await view(g, me(req)) });
  }));
  /** after the owner's normal checkout succeeded */
  app.post('/api/group-carts/:code/done', ...cust, guard(async (req, res) => {
    await need();
    const g = await load(req.params.code);
    if (Number(g.owner_id) !== me(req)) throw fail(403, 'صاحب الطلب بس يقدر يأكد');
    open(g);
    await pool.query("UPDATE group_carts SET status='ordered' WHERE id=$1", [g.id]);
    res.json({ ok: true });
  }));
  app.post('/api/group-carts/:code/cancel', ...cust, guard(async (req, res) => {
    await need();
    const g = await load(req.params.code);
    if (Number(g.owner_id) !== me(req)) throw fail(403, 'صاحب الطلب بس يقدر يلغي');
    open(g);
    await pool.query("UPDATE group_carts SET status='cancelled' WHERE id=$1", [g.id]);
    res.json({ ok: true });
  }));
}
module.exports = { register, newCode, TTL_HOURS };
