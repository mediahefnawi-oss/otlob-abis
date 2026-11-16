'use strict';
/** "طلبات ماركت": a product list the owner manages; the order goes straight to the couriers (see /api/orders/market). Switch "market" (OFF). */
const NAME_MAX = 60;
function cleanProduct(b, partial = false) {
  b = b || {}; const out = {};
  if (!partial || b.name !== undefined) { const n = String(b.name || '').trim(); if (!n || n.length > NAME_MAX) return null; out.name = n; }
  if (!partial || b.price !== undefined) { const v = Number(b.price); if (!Number.isFinite(v) || v < 0 || v > 100000) return null; out.price = Math.round(v * 100) / 100; }
  if (b.category !== undefined) out.category = String(b.category).trim().slice(0, 30);
  if (b.emoji !== undefined) out.emoji = String(b.emoji).trim().slice(0, 8) || '🛒';
  if (b.available !== undefined) out.available = !!b.available;
  if (b.sort_order !== undefined) { const v = Number(b.sort_order); if (!Number.isFinite(v) || v < 0 || v > 9999) return null; out.sort_order = Math.round(v); }
  return out;
}
function register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => { try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; } });
  const admin = [auth, roles('admin')];
  const COLS = 'id, name, category, price, emoji, available, sort_order, (image IS NOT NULL) AS has_image, (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v';
  const out = r => ({ id: r.id, name: r.name, category: r.category, price: Number(r.price), emoji: r.emoji, available: r.available, sort: r.sort_order, image: r.has_image ? `/api/market-image/${r.id}?v=${r.v}` : null });

  app.get('/api/admin/market-products', ...admin, guard(async (_req, res) => {
    res.json({ products: (await pool.query(`SELECT ${COLS} FROM market_products ORDER BY sort_order, id`)).rows.map(out) });
  }));
  app.post('/api/admin/market-products', ...admin, guard(async (req, res) => {
    const c = cleanProduct(req.body); if (!c) throw fail(400, 'البيانات غير صحيحة (الاسم والسعر)');
    const n = await pool.query('SELECT COUNT(*)::int AS c FROM market_products'); if (n.rows[0].c >= 2000) throw fail(409, 'الحد الأقصى 2000 منتج');
    const r = await pool.query(`INSERT INTO market_products(name, price, category, emoji, available, sort_order) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${COLS}`, [c.name, c.price, c.category || '', c.emoji || '🛒', c.available !== false, c.sort_order || 0]);
    res.status(201).json({ product: out(r.rows[0]) });
  }));
  app.patch('/api/admin/market-products/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const c = cleanProduct(req.body, true); if (!c || !Object.keys(c).length) throw fail(400, 'البيانات غير صحيحة');
    const keys = Object.keys(c);
    const r = await pool.query(`UPDATE market_products SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=NOW() WHERE id=$1 RETURNING ${COLS}`, [id, ...keys.map(k => c[k])]);
    if (!r.rowCount) throw fail(404, 'المنتج غير موجود');
    res.json({ product: out(r.rows[0]) });
  }));
  app.delete('/api/admin/market-products/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    if (!(await pool.query('DELETE FROM market_products WHERE id=$1 RETURNING id', [id])).rowCount) throw fail(404, 'المنتج غير موجود');
    res.json({ ok: true });
  }));
  app.put('/api/admin/market-products/:id/image', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const s = String((req.body || {}).image || '');
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(s);
    if (!m || s.length > 1500000) throw fail(400, 'ارفع صورة صالحة (JPG أو PNG أو WebP) بحجم أصغر');
    const r = await pool.query(`UPDATE market_products SET image=$2, mime=$3, updated_at=NOW() WHERE id=$1 RETURNING ${COLS}`, [id, Buffer.from(m[2], 'base64'), m[1]]);
    if (!r.rowCount) throw fail(404, 'المنتج غير موجود');
    res.json({ product: out(r.rows[0]) });
  }));
  app.get('/api/market-image/:id', guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) return res.status(404).end();
    const r = await pool.query('SELECT image, mime FROM market_products WHERE id=$1 AND image IS NOT NULL', [id]);
    if (!r.rowCount) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime); res.set('Cache-Control', 'public, max-age=31536000, immutable'); res.set('Cross-Origin-Resource-Policy', 'cross-origin'); res.send(r.rows[0].image);
  }));
  app.get('/api/admin/market-settings', ...admin, guard(async (_req, res) => {
    const r = await pool.query('SELECT market_fee FROM app_settings WHERE id=1'); res.json({ fee: Number((r.rows[0] || {}).market_fee ?? 15) });
  }));
  app.patch('/api/admin/market-settings', ...admin, guard(async (req, res) => {
    const v = Number((req.body || {}).fee); if (!Number.isFinite(v) || v < 0 || v > 1000) throw fail(400, 'رسوم التوصيل غير صحيحة');
    await pool.query('UPDATE app_settings SET market_fee=$1 WHERE id=1', [v]); res.json({ ok: true });
  }));
  /** the customer's catalogue (only while the switch is ON) */
  app.get('/api/market-products', auth, guard(async (_req, res) => {
    if (!(await extrasLib.featureOn(pool, 'market'))) throw fail(404, 'الخدمة غير متاحة الآن');
    const r = await pool.query(`SELECT ${COLS} FROM market_products WHERE available ORDER BY sort_order, id`);
    const f = await pool.query('SELECT market_fee FROM app_settings WHERE id=1');
    res.json({ products: r.rows.map(out), fee: Number((f.rows[0] || {}).market_fee ?? 15) });
  }));
}
module.exports = { cleanProduct, register };
