'use strict';
/**
 * The owner's feature switches, moving a shop to another section, the order mode of a shop and its menu pictures.
 * Every new feature starts switched OFF; the owner opens it from the panel (and can close it again at any time).
 */
const FEATURES = {
  menu: { label: 'المنيو وطرق الطلب', on: false },
  chat: { label: 'شات العميل مع المحل', on: false },
  voice: { label: 'الطلب الصوتي', on: false },
  clinicSchedule: { label: 'العيادة تحدد الموعد', on: false },
  rx: { label: 'تحويل الروشتة للصيدلية', on: false },
  pool: { label: 'الطلب الجماعي', on: false },
  adTarget: { label: 'ربط الإعلان بمحل ومنتج', on: false },
  courierPhoto: { label: 'صورة المندوب', on: false },
  bot: { label: 'بوت الدعم', on: true },
};
const MODES = ['cart', 'request', 'menu'];
const MAX_MENU_IMAGE = 1500000; // characters of base64 text
const MAX_MENU_PAGES = 8;

/** the switches with their defaults filled in */
function mergeFeatures(stored) {
  const out = {};
  const s = stored && typeof stored === 'object' ? stored : {};
  for (const k of Object.keys(FEATURES)) out[k] = typeof s[k] === 'boolean' ? s[k] : FEATURES[k].on;
  return out;
}
async function featuresOf(db) {
  try { return mergeFeatures((await db.query('SELECT features FROM app_settings WHERE id=1')).rows[0].features); }
  catch { return mergeFeatures(null); } // not migrated yet: defaults
}
async function featureOn(db, key) { return !!(await featuresOf(db))[key]; }
/** menu / manual-request mode of a shop, only while the switch is on */
const effectiveMode = (row, feats) => (feats.menu && MODES.includes(row.order_mode) ? row.order_mode : '');

function register(app, { pool, auth, roles, asyncRoute, positiveId, services, clearCaches }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; }
  });
  const admin = [auth, roles('admin')];

  /* ---------- switches ---------- */
  app.get('/api/admin/features', ...admin, guard(async (_req, res) => {
    const f = await featuresOf(pool);
    res.json({ features: Object.keys(FEATURES).map(k => ({ key: k, label: FEATURES[k].label, on: f[k] })) });
  }));
  app.patch('/api/admin/features', ...admin, guard(async (req, res) => {
    const b = req.body || {};
    const key = String(b.key || '');
    if (!FEATURES[key]) throw fail(400, 'ميزة غير معروفة');
    if (typeof b.on !== 'boolean') throw fail(400, 'حدد تشغيل أو إيقاف');
    try { await pool.query('UPDATE app_settings SET features = COALESCE(features, \'{}\'::jsonb) || jsonb_build_object($1::text, $2::boolean), updated_at=NOW() WHERE id=1', [key, b.on]); }
    catch (e) { if (e.code === '42703') throw fail(503, 'قاعدة البيانات لم تُحدَّث بعد'); throw e; }
    clearCaches();
    const f = await featuresOf(pool);
    res.json({ features: Object.keys(FEATURES).map(k => ({ key: k, label: FEATURES[k].label, on: f[k] })) });
  }));

  /* ---------- move a shop to another section / set how it takes orders ---------- */
  app.patch('/api/admin/providers/:id/type', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف مقدم الخدمة غير صالح');
    await services.ensure(pool);
    const type = String((req.body || {}).type || '');
    if (!services.isKnown(type)) throw fail(400, 'القسم غير معروف');
    const r = await pool.query('UPDATE providers SET type=$1 WHERE id=$2 AND deleted_at IS NULL RETURNING id, type', [type, id]);
    if (!r.rowCount) throw fail(404, 'مقدم الخدمة غير موجود');
    clearCaches();
    res.json({ id: String(id), type });
  }));
  app.patch('/api/admin/providers/:id/order-mode', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف مقدم الخدمة غير صالح');
    const raw = (req.body || {}).mode;
    const mode = raw === '' || raw === null || raw === undefined ? null : String(raw);
    if (mode !== null && !MODES.includes(mode)) throw fail(400, 'طريقة الطلب غير معروفة');
    const r = await pool.query('UPDATE providers SET order_mode=$1 WHERE id=$2 AND deleted_at IS NULL RETURNING id', [mode, id]);
    if (!r.rowCount) throw fail(404, 'مقدم الخدمة غير موجود');
    clearCaches();
    res.json({ id: String(id), mode: mode || '' });
  }));

  /* ---------- menu pictures (the shop itself or the owner) ---------- */
  async function ownerCheck(req, providerId) {
    const p = await pool.query('SELECT owner_user_id FROM providers WHERE id=$1 AND deleted_at IS NULL', [providerId]);
    if (!p.rowCount) throw fail(404, 'مقدم الخدمة غير موجود');
    if (req.auth.role !== 'admin' && String(p.rows[0].owner_user_id) !== req.auth.sub) throw fail(403, 'غير مسموح');
  }
  app.get('/api/providers/:id/menu', guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    if (!(await featureOn(pool, 'menu'))) return res.json({ images: [] });
    const r = await pool.query('SELECT id FROM menu_images WHERE provider_id=$1 ORDER BY sort_order, id', [id]);
    res.set('Cache-Control', 'no-store');
    res.json({ images: r.rows.map(x => String(x.id)) });
  }));
  app.get('/api/menu/:imgId', guard(async (req, res) => {
    const id = positiveId(req.params.imgId);
    if (!id) return res.status(400).end();
    const r = await pool.query('SELECT image, mime FROM menu_images WHERE id=$1', [id]);
    if (!r.rowCount) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(r.rows[0].image);
  }));
  app.post('/api/providers/:id/menu', auth, roles('provider', 'admin'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف مقدم الخدمة غير صالح');
    await ownerCheck(req, id);
    if (!(await featureOn(pool, 'menu'))) throw fail(409, 'ميزة المنيو غير مفعّلة');
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body || {}).image || ''));
    if (!m || String(req.body.image).length > MAX_MENU_IMAGE) throw fail(400, 'ارفع صورة صالحة (JPG أو PNG) وبحجم أصغر');
    const n = await pool.query('SELECT COUNT(*)::int AS c FROM menu_images WHERE provider_id=$1', [id]);
    if (n.rows[0].c >= MAX_MENU_PAGES) throw fail(409, `الحد الأقصى ${MAX_MENU_PAGES} صور للمنيو`);
    const r = await pool.query('INSERT INTO menu_images(provider_id, image, mime, sort_order) VALUES($1,$2,$3,$4) RETURNING id', [id, Buffer.from(m[2], 'base64'), m[1], n.rows[0].c]);
    clearCaches();
    res.status(201).json({ id: String(r.rows[0].id) });
  }));
  app.delete('/api/menu/:imgId', auth, roles('provider', 'admin'), guard(async (req, res) => {
    const id = positiveId(req.params.imgId);
    if (!id) throw fail(400, 'معرّف غير صالح');
    const r = await pool.query('SELECT provider_id FROM menu_images WHERE id=$1', [id]);
    if (!r.rowCount) throw fail(404, 'الصورة غير موجودة');
    await ownerCheck(req, r.rows[0].provider_id);
    await pool.query('DELETE FROM menu_images WHERE id=$1', [id]);
    clearCaches();
    res.json({ ok: true });
  }));
}

module.exports = { register, FEATURES, mergeFeatures, featuresOf, featureOn, effectiveMode, MODES };
