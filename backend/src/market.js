'use strict';
/** "طلبات ماركت": a product list the owner manages; the order goes straight to the couriers (see /api/orders/market). Switch "market" (OFF). */
const NAME_MAX = 60;
/** sizes of one product: up to 12, a name each (unique) and a price or none (the courier prices it). Returns null when something is wrong. */
function cleanSizes(raw) {
  if (!Array.isArray(raw) || raw.length > 12) return null;
  const out = [], seen = new Set();
  for (const z of raw) {
    const label = String((z && z.label) || '').trim();
    if (!label || label.length > 20 || seen.has(label)) return null;
    seen.add(label);
    let price = null;
    if (z.price !== null && z.price !== undefined && z.price !== '') { const v = Number(z.price); if (!Number.isFinite(v) || v < 0 || v > 100000) return null; price = Math.round(v * 100) / 100; }
    out.push({ label, price });
  }
  return out;
}
function cleanProduct(b, partial = false) {
  b = b || {}; const out = {};
  if (!partial || b.name !== undefined) { const n = String(b.name || '').trim(); if (!n || n.length > NAME_MAX) return null; out.name = n; }
  if (!partial || b.price !== undefined) {
    if (b.price === null || b.price === undefined || b.price === '') out.price = null;   // no price: the courier prices it
    else { const v = Number(b.price); if (!Number.isFinite(v) || v < 0 || v > 100000) return null; out.price = Math.round(v * 100) / 100; }
  }
  if (b.sizes !== undefined) {
    const z = cleanSizes(b.sizes); if (!z) return null;
    out.sizes = JSON.stringify(z);
    // the price column keeps the cheapest priced size (shown as "من X ج"); no priced size = the courier prices it
    if (z.length) { const ps = z.filter(x => x.price != null).map(x => x.price); out.price = ps.length ? Math.min(...ps) : null; }
  }
  if (b.description !== undefined) out.description = String(b.description || '').trim().slice(0, 500);
  if (b.category !== undefined) out.category = String(b.category).trim().slice(0, 30);
  if (b.emoji !== undefined) out.emoji = String(b.emoji).trim().slice(0, 8) || '🛒';
  if (b.discountPct !== undefined) {
    if (b.discountPct === null || b.discountPct === '' || Number(b.discountPct) === 0) out.discount_pct = null;
    else { const v = Number(b.discountPct); if (!Number.isFinite(v) || v < 1 || v > 90) return null; out.discount_pct = Math.round(v * 100) / 100; }
  }
  if (b.offerText !== undefined) out.offer_text = String(b.offerText || '').trim().slice(0, 30);
  if (b.offerUntil !== undefined) {
    if (!b.offerUntil) out.offer_until = null;
    else { const t = new Date(b.offerUntil); if (isNaN(t.getTime())) return null; out.offer_until = t.toISOString(); }
  }
  if (b.available !== undefined) out.available = !!b.available;
  if (b.sort_order !== undefined) { const v = Number(b.sort_order); if (!Number.isFinite(v) || v < 0 || v > 9999) return null; out.sort_order = Math.round(v); }
  return out;
}
/** Pure: the price a customer pays now. A discount applies only to a priced product and only until offer_until (if set). */
function discountOf(row, now = Date.now()) {
  const pct = row.discount_pct == null ? 0 : Number(row.discount_pct);
  return pct > 0 && (!row.offer_until || new Date(row.offer_until).getTime() > now) ? pct : 0;
}
function salePrice(row, now = Date.now()) {
  if (row.price == null) return { price: null, active: false };
  const base = Number(row.price), pct = discountOf(row, now);
  return { price: pct ? Math.round(base * (100 - pct)) / 100 : base, active: pct > 0 };
}
const sizesOf = row => (Array.isArray(row.sizes) ? row.sizes : []);
/** Pure: the price of one size (the discount of the product applies to every priced size). */
function sizePrice(row, size, now = Date.now()) {
  if (size.price == null) return { price: null, was: null, active: false };
  const pct = discountOf(row, now), base = Number(size.price);
  return { price: pct ? Math.round(base * (100 - pct)) / 100 : base, was: pct ? base : null, active: pct > 0 };
}
function register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => { try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; } });
  const admin = [auth, roles('admin')];
  const COLS = 'id, name, category, description, price, sizes, discount_pct, offer_text, offer_until, emoji, available, sort_order, (image IS NOT NULL) AS has_image, (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v';
  const out = r => { const sp = salePrice(r); return ({ id: r.id, name: r.name, category: r.category, description: r.description || '', price: r.price == null ? null : Number(r.price), discountPct: r.discount_pct == null ? null : Number(r.discount_pct), offerText: r.offer_text || '', offerUntil: r.offer_until ? new Date(r.offer_until).toISOString() : null, salePrice: sp.price, onOffer: sp.active, sizes: sizesOf(r).map(z => { const q = sizePrice(r, z); return { label: z.label, price: z.price == null ? null : Number(z.price), salePrice: q.price }; }), emoji: r.emoji, available: r.available, sort: r.sort_order, image: r.has_image ? `/api/market-image/${r.id}?v=${r.v}` : null }); };

  app.get('/api/admin/market-products', ...admin, guard(async (_req, res) => {
    res.json({ products: (await pool.query(`SELECT ${COLS} FROM market_products ORDER BY sort_order, id`)).rows.map(out) });
  }));
  app.post('/api/admin/market-products', ...admin, guard(async (req, res) => {
    const c = cleanProduct(req.body); if (!c) throw fail(400, 'البيانات غير صحيحة (الاسم والسعر)');
    const n = await pool.query('SELECT COUNT(*)::int AS c FROM market_products'); if (n.rows[0].c >= 2000) throw fail(409, 'الحد الأقصى 2000 منتج');
    const r = await pool.query(`INSERT INTO market_products(name, price, category, emoji, available, sort_order, discount_pct, offer_text, offer_until, sizes, description) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING ${COLS}`, [c.name, c.price, c.category || '', c.emoji || '🛒', c.available !== false, c.sort_order || 0, c.discount_pct ?? null, c.offer_text || '', c.offer_until ?? null, c.sizes || '[]', c.description || '']);
    res.status(201).json({ product: out(r.rows[0]) });
  }));
  /** one tap: adds the ready-made list of products (no prices). Products with the same name are skipped, so it is safe to press twice. */
  app.post('/api/admin/market-products/import-defaults', ...admin, guard(async (_req, res) => {
    const list = require('./market_defaults');
    const have = new Set((await pool.query('SELECT name FROM market_products')).rows.map(r => r.name));
    const todo = list.filter(p => !have.has(p.name));
    if (todo.length) await pool.query(
      'INSERT INTO market_products(name, price, category, emoji, available, sort_order) SELECT n, NULL, c, e, TRUE, o FROM unnest($1::text[], $2::text[], $3::text[], $4::int[]) AS t(n, c, e, o)',
      [todo.map(p => p.name), todo.map(p => p.category), todo.map(p => p.emoji), todo.map(p => p.sort)]);
    res.json({ ok: true, added: todo.length, total: list.length });
  }));
  app.patch('/api/admin/market-products/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const c = cleanProduct(req.body, true); if (!c || !Object.keys(c).length) throw fail(400, 'البيانات غير صحيحة');
    const keys = Object.keys(c);
    const r = await pool.query(`UPDATE market_products SET ${keys.map((k, i) => `${k}=$${i + 2}${k === 'sizes' ? '::jsonb' : ''}`).join(', ')}, updated_at=NOW() WHERE id=$1 RETURNING ${COLS}`, [id, ...keys.map(k => c[k])]);
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
    const r = await pool.query('SELECT market_fee, market_offer_text FROM app_settings WHERE id=1'); res.json({ fee: Number((r.rows[0] || {}).market_fee ?? 15), offerText: (r.rows[0] || {}).market_offer_text || 'وفّر واطلب' });
  }));
  app.patch('/api/admin/market-settings', ...admin, guard(async (req, res) => {
    const b = req.body || {};
    if (b.offerText !== undefined) {
      const t = String(b.offerText || '').trim().slice(0, 30); if (!t) throw fail(400, 'اكتب جملة الزر');
      await pool.query('UPDATE app_settings SET market_offer_text=$1 WHERE id=1', [t]);
      if (b.fee === undefined) return res.json({ ok: true });
    }
    const v = Number(b.fee); if (!Number.isFinite(v) || v < 0 || v > 1000) throw fail(400, 'رسوم التوصيل غير صحيحة');
    await pool.query('UPDATE app_settings SET market_fee=$1 WHERE id=1', [v]); res.json({ ok: true });
  }));
  /** the customer's catalogue (only while the switch is ON) */
  app.get('/api/market-products', auth, guard(async (_req, res) => {
    if (!(await extrasLib.featureOn(pool, 'market'))) throw fail(404, 'الخدمة غير متاحة الآن');
    const r = await pool.query(`SELECT ${COLS} FROM market_products WHERE available ORDER BY sort_order, id`);
    const f = await pool.query('SELECT market_fee, market_offer_text FROM app_settings WHERE id=1');
    res.json({ products: r.rows.map(out), fee: Number((f.rows[0] || {}).market_fee ?? 15), offerText: (f.rows[0] || {}).market_offer_text || 'وفّر واطلب' });
  }));

  /* ----- the look of the new services on the home: icon picture, cover picture, one description line ----- */
  const SVC = ['market', 'rides', 'errand'], KIND = ['icon', 'cover', 'cover2', 'cover3'];
  const okSvc = (k, kind) => SVC.includes(k) && (kind === undefined || KIND.includes(kind));
  app.get('/api/svc-meta', asyncRoute(async (_req, res) => {
    const m = await pool.query('SELECT key, sub, title, sort FROM service_meta');
    const im = await pool.query("SELECT key, (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v FROM site_images WHERE key LIKE 'svc\\_%'");
    const out = {}; for (const k of SVC) out[k] = { sub: '', title: '', sort: 0, icon: 0, cover: 0, cover2: 0, cover3: 0 };
    for (const r of m.rows) if (out[r.key]) { out[r.key].sub = r.sub; out[r.key].title = r.title || ''; out[r.key].sort = Number(r.sort) || 0; }
    for (const r of im.rows) { const x = /^svc_(market|rides|errand)_(icon|cover|cover2|cover3)$/.exec(r.key); if (x) out[x[1]][x[2]] = Number(r.v); }
    res.set('Cache-Control', 'no-store'); res.json(out);
  }));
  app.get('/api/svc-image/:key/:kind', guard(async (req, res) => {
    if (!okSvc(req.params.key, req.params.kind)) return res.status(404).end();
    const r = await pool.query('SELECT image, mime FROM site_images WHERE key=$1', [`svc_${req.params.key}_${req.params.kind}`]);
    if (!r.rowCount) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime); res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300'); res.set('Cross-Origin-Resource-Policy', 'cross-origin'); res.send(r.rows[0].image);
  }));
  app.put('/api/admin/svc-image/:key/:kind', ...admin, guard(async (req, res) => {
    if (!okSvc(req.params.key, req.params.kind)) throw fail(404, 'خدمة غير معروفة');
    const s = String((req.body || {}).image || '');
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(s);
    if (!m || s.length > 2200000) throw fail(400, 'ارفع صورة صالحة (JPG أو PNG أو WebP) بحجم أصغر');
    await pool.query("INSERT INTO site_images(key, image, mime, updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT (key) DO UPDATE SET image=$2, mime=$3, updated_at=NOW()", [`svc_${req.params.key}_${req.params.kind}`, Buffer.from(m[2], 'base64'), m[1]]);
    res.json({ ok: true });
  }));
  app.delete('/api/admin/svc-image/:key/:kind', ...admin, guard(async (req, res) => {
    if (!okSvc(req.params.key, req.params.kind)) throw fail(404, 'خدمة غير معروفة');
    await pool.query('DELETE FROM site_images WHERE key=$1', [`svc_${req.params.key}_${req.params.kind}`]);
    res.json({ ok: true });
  }));
  app.patch('/api/admin/svc-meta/:key', ...admin, guard(async (req, res) => {
    if (!okSvc(req.params.key)) throw fail(404, 'خدمة غير معروفة');
    const b = req.body || {};
    await pool.query("INSERT INTO service_meta(key, sub, updated_at) VALUES($1,'',NOW()) ON CONFLICT (key) DO NOTHING", [req.params.key]);
    if (b.sub !== undefined) await pool.query('UPDATE service_meta SET sub=$2, updated_at=NOW() WHERE key=$1', [req.params.key, String(b.sub || '').trim().slice(0, 120)]);
    if (b.title !== undefined) await pool.query('UPDATE service_meta SET title=$2, updated_at=NOW() WHERE key=$1', [req.params.key, String(b.title || '').trim().slice(0, 40)]);
    if (b.sort !== undefined) { const v = Number(b.sort); if (!Number.isFinite(v) || v < 0 || v > 999) throw fail(400, 'ترتيب غير صحيح'); await pool.query('UPDATE service_meta SET sort=$2, updated_at=NOW() WHERE key=$1', [req.params.key, Math.round(v)]); }
    res.json({ ok: true });
  }));
}
module.exports = { cleanProduct, cleanSizes, salePrice, sizePrice, sizesOf, register };
