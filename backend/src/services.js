/**
 * Services ("الخدمات": restaurants, pharmacies, clinics...): the owner renames / stops / orders them and adds new ones from the panel.
 * Every service works through one of four proven templates, so a new service never needs a new order path:
 *   cart    products + basket (restaurants, stores)
 *   request the customer writes what he wants, no products (supermarkets, pharmacies)
 *   booking appointments (clinics)
 *   maker   products + written requests, the provider prices and sets a ready date (makers)
 *   lab     the customer writes the reason / sends a prescription, the lab sets the visit day and price, the customer confirms, the lab uploads the report
 * If the table is missing (not migrated yet) the six original services are used, so nothing breaks while deploying.
 */
const BUILTIN = [
  { key: 'restaurant', label: 'المطاعم', single: 'مطعم', emoji: '🍔', template: 'cart', sort_order: 10, size: 'small', active: true, show_home: true, can_products: true, builtin: true },
  { key: 'supermarket', label: 'السوبر ماركت', single: 'سوبر ماركت', emoji: '🛒', template: 'request', sort_order: 20, size: 'small', active: true, show_home: true, can_products: false, builtin: true },
  { key: 'pharmacy', label: 'الصيدليات', single: 'صيدلية', emoji: '💊', template: 'request', sort_order: 30, size: 'small', active: true, show_home: true, can_products: false, builtin: true },
  { key: 'clinic', label: 'حجز العيادات', single: 'عيادة', emoji: '🩺', template: 'booking', sort_order: 40, size: 'small', active: true, show_home: true, can_products: true, builtin: true },
  { key: 'lab', label: 'المعامل والتحاليل', single: 'معمل', emoji: '🧪', template: 'lab', sort_order: 45, size: 'large', active: false, show_home: true, can_products: false, builtin: true },
  { key: 'store', label: 'متاجر', single: 'متجر', emoji: '🏬', template: 'cart', sort_order: 50, size: 'small', active: true, show_home: true, can_products: true, builtin: true },
  { key: 'maker', label: 'صُنّاع أبيس', single: 'صانع', emoji: '🧵', template: 'maker', sort_order: 60, size: 'small', active: true, show_home: true, can_products: true, builtin: true },
  // "اطلب إيه؟ نجيبهولك": not a provider type, it has no providers; the courier prices the errand. It is listed here so it is renamed / stopped / ordered like the others.
  { key: 'errand', label: 'اطلب إيه؟ نجيبهولك', single: 'طلب خاص', emoji: '🎁', template: 'errand', sort_order: 70, size: 'large', active: true, show_home: true, can_products: false, builtin: true },
];
const TEMPLATES = ['cart', 'request', 'booking', 'maker', 'lab'];
const SIZES = ['small', 'medium', 'large'];

let cache = { at: 0, list: BUILTIN };
const TTL = 8000;

const json = r => ({
  key: r.key, label: r.label, single: r.single, emoji: r.emoji, template: r.template, order: Number(r.sort_order), size: r.size,
  active: !!r.active, showHome: !!r.show_home, canProducts: !!r.can_products, builtin: !!r.builtin,
});

async function load(db) {
  try {
    const r = await db.query('SELECT * FROM service_types ORDER BY sort_order ASC, created_at ASC');
    cache = { at: Date.now(), list: r.rowCount ? r.rows : BUILTIN };
  } catch { cache = { at: Date.now(), list: BUILTIN }; } // table not migrated yet
  return cache.list;
}
/** call at the start of a request handler; later the sync helpers below can be used */
async function ensure(db) { if (Date.now() - cache.at > TTL) await load(db); return cache.list; }
function invalidate() { cache.at = 0; }
const find = type => cache.list.find(s => s.key === type) || BUILTIN.find(s => s.key === type) || null;
/** provider types only (the errand service has no providers) */
const keys = () => cache.list.filter(s => s.template !== 'errand').map(s => s.key);
const isKnown = type => { const s = find(String(type || '')); return !!s && s.template !== 'errand'; };
/** is the errand service switched on (the owner can stop it) */
const isActive = type => { const s = find(type); return !s || s.active !== false; };
const errandActive = () => { const s = find('errand'); return !s || s.active !== false; };
/** the order path of a service; unknown types behave like a basket service */
const tplOf = type => (find(type) || {}).template || 'cart';
/** the provider can add / edit products */
const canProducts = type => { const s = find(type); if (!s) return true; return s.template !== 'request' && s.template !== 'errand' && s.template !== 'lab' && s.can_products !== false; };
/** the customer may send a written request to this type */
const acceptsRequests = type => ['request', 'maker'].includes(tplOf(type));
const listJson = () => cache.list.map(json);
/** types that cannot have products (used in SQL) */
const noProductTypes = () => cache.list.filter(s => s.template !== 'errand' && !canProducts(s.key)).map(s => s.key);

function register(app, { pool, auth, roles, asyncRoute }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; }
  });
  const admin = [auth, roles('admin')];
  const text = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);

  app.get('/api/services', asyncRoute(async (_req, res) => {
    await load(pool);
    res.set('Cache-Control', 'no-store');
    res.json({ services: listJson() });
  }));

  app.post('/api/admin/services', ...admin, guard(async (req, res) => {
    const b = req.body || {};
    const label = text(b.label, 40);
    if (label.length < 2) throw fail(400, 'اكتب اسم الخدمة');
    const single = text(b.single, 30) || label;
    const emoji = text(b.emoji, 8) || '🛍️';
    const template = String(b.template || '');
    if (!TEMPLATES.includes(template)) throw fail(400, 'اختر طريقة الشغل');
    const size = SIZES.includes(b.size) ? b.size : 'small';
    const canP = template !== 'request' && template !== 'lab' ? b.canProducts !== false : false;
    await seedBuiltin(pool); await load(pool);
    const key = `svc_${Date.now().toString(36)}`;
    const next = Math.max(0, ...cache.list.map(s => Number(s.sort_order))) + 10;
    try {
      await pool.query(`INSERT INTO service_types(key, label, single, emoji, template, sort_order, size, active, show_home, can_products, builtin)
        VALUES($1,$2,$3,$4,$5,$6,$7,TRUE,$8,$9,FALSE)`, [key, label, single, emoji, template, next, size, b.showHome !== false, canP]);
    } catch (e) { if (e.code === '42P01') throw fail(503, 'قاعدة البيانات لم تُحدَّث بعد'); throw e; }
    invalidate(); await load(pool);
    res.status(201).json({ services: listJson(), key });
  }));

  app.patch('/api/admin/services/:key', ...admin, guard(async (req, res) => {
    const key = String(req.params.key || '');
    await seedBuiltin(pool); await load(pool);
    const s = cache.list.find(x => x.key === key);
    if (!s) throw fail(404, 'الخدمة غير موجودة');
    const b = req.body || {};
    const sets = [], vals = [];
    const put = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (b.label !== undefined) { const v = text(b.label, 40); if (v.length < 2) throw fail(400, 'اكتب اسم الخدمة'); put('label', v); }
    if (b.single !== undefined) { const v = text(b.single, 30); if (v.length < 2) throw fail(400, 'اكتب الاسم المفرد'); put('single', v); }
    if (b.emoji !== undefined) put('emoji', text(b.emoji, 8) || s.emoji);
    if (b.size !== undefined) { if (!SIZES.includes(b.size)) throw fail(400, 'حجم غير صالح'); put('size', b.size); }
    if (b.active !== undefined) put('active', !!b.active);
    if (b.showHome !== undefined) put('show_home', !!b.showHome);
    if (b.canProducts !== undefined) { if (s.template !== 'request' && s.template !== 'errand' && s.template !== 'lab') put('can_products', !!b.canProducts); }
    if (!sets.length) return res.json({ services: listJson() });
    vals.push(key);
    await pool.query(`UPDATE service_types SET ${sets.join(', ')} WHERE key=$${vals.length}`, vals);
    invalidate(); await load(pool);
    res.json({ services: listJson() });
  }));

  // body: { keys: [..all keys in the wanted order..] }
  app.put('/api/admin/services-order', ...admin, guard(async (req, res) => {
    const list = Array.isArray((req.body || {}).keys) ? req.body.keys.map(String) : [];
    await seedBuiltin(pool); await load(pool);
    const known = new Set(cache.list.map(s => s.key));
    if (!list.length || list.some(k => !known.has(k)) || new Set(list).size !== list.length) throw fail(400, 'ترتيب غير صالح');
    const rest = cache.list.map(s => s.key).filter(k => !list.includes(k));
    const all = [...list, ...rest];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < all.length; i++) await client.query('UPDATE service_types SET sort_order=$1 WHERE key=$2', [(i + 1) * 10, all[i]]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    invalidate(); await load(pool);
    res.json({ services: listJson() });
  }));

  app.delete('/api/admin/services/:key', ...admin, guard(async (req, res) => {
    const key = String(req.params.key || '');
    await load(pool);
    const s = cache.list.find(x => x.key === key);
    if (!s) throw fail(404, 'الخدمة غير موجودة');
    if (s.builtin) throw fail(400, 'الخدمات الأساسية لا تُحذف، يمكنك إيقافها فقط');
    const used = await pool.query('SELECT 1 FROM providers WHERE type=$1 AND deleted_at IS NULL LIMIT 1', [key]);
    if (used.rowCount) throw fail(409, 'يوجد مقدمو خدمة داخل هذه الخدمة، أوقفها بدل الحذف');
    await pool.query('DELETE FROM service_types WHERE key=$1', [key]);
    await pool.query("DELETE FROM site_images WHERE key=$1", [`cat_${key}`]).catch(() => {});
    invalidate(); await load(pool);
    res.json({ services: listJson() });
  }));
}

/** copy the six original services into the table the first time the owner changes anything (idempotent) */
async function seedBuiltin(db) {
  try {
    const n = Number((await db.query('SELECT COUNT(*)::int AS n FROM service_types WHERE builtin AND key = ANY($1::text[])', [BUILTIN.map(x => x.key)])).rows[0].n);
    if (n >= BUILTIN.length) return;
    for (const s of BUILTIN) {
      await db.query(`INSERT INTO service_types(key, label, single, emoji, template, sort_order, size, active, show_home, can_products, builtin)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9,TRUE) ON CONFLICT (key) DO NOTHING`, [s.key, s.label, s.single, s.emoji, s.template, s.sort_order, s.size, s.active, s.can_products]);
    }
  } catch (e) { if (e.code !== '42P01') throw e; }
}

module.exports = { isActive, errandActive, register, ensure, invalidate, load, find, keys, isKnown, tplOf, canProducts, acceptsRequests, listJson, noProductTypes, BUILTIN, TEMPLATES };
