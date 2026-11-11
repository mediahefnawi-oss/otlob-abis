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
  ordering: { label: 'ترتيب المحلات (تثبيت وترتيب تلقائي)', on: false },
  favorites: { label: 'المفضلة', on: false },
  addresses: { label: 'عناوين محفوظة متعددة', on: false },
  schedule: { label: 'طلب مجدول لوقت لاحق', on: false },
  dailyReport: { label: 'تقرير يومي للمالك', on: false },
  lateAlert: { label: 'تنبيه تأخر الطلب', on: false },
  winback: { label: 'رسالة «وحشتنا» للعميل المنقطع', on: false },
  bot: { label: 'بوت الدعم', on: true },
  // old features: ON by default so nothing changes until the owner switches one off
  coupons: { label: 'الكوبونات وأكواد الخصم', on: true },
  ratings: { label: 'تقييم الطلبات والمحلات', on: true },
  support: { label: 'الدعم الفني (شات العميل مع الإدارة)', on: true },
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
/** Ad link that opens a shop or a product inside the app: "app:provider:12" / "app:product:34". Returns null if the link is not one of those. */
const APP_LINK = /^app:(provider|product):(\d{1,12})$/;
async function checkAppLink(db, link) {
  const m = APP_LINK.exec(String(link || ''));
  if (!m) return null;
  if (!(await featureOn(db, 'adTarget'))) return { error: 'ميزة ربط الإعلان بمحل أو منتج مقفولة. فعّلها من «تشغيل الميزات»' };
  const q = m[1] === 'provider' ? 'SELECT 1 FROM providers WHERE id=$1' : 'SELECT 1 FROM products WHERE id=$1';
  const r = await db.query(q, [Number(m[2])]);
  if (!r.rowCount) return { error: m[1] === 'provider' ? 'المحل غير موجود' : 'المنتج غير موجود' };
  return { ok: true };
}

/** Order of the shops in a list when the switch is on: pinned (by rank), then open ones by rating and by orders in the last 30 days, closed ones last. */
function orderShops(list) {
  const pinned = p => (p.pinRank == null ? 0 : 1);
  const live = p => (p.open && p.status === 'active' ? 1 : 0);
  return [...list].sort((a, b) =>
    pinned(b) - pinned(a)
    || (pinned(a) && pinned(b) ? a.pinRank - b.pinRank : 0)
    || live(b) - live(a)
    || (Number(b.rating) || 0) - (Number(a.rating) || 0)
    || (Number(b.orders30) || 0) - (Number(a.orders30) || 0)
    || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

const effectiveMode = (row, feats) => (feats.menu && MODES.includes(row.order_mode) ? row.order_mode : '');

function register(app, { pool, auth, roles, asyncRoute, positiveId, services, clearCaches, pushToUsers }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  // a sound + text push to the given users; a failed push never fails the request
  const notify = (ids, title, body, tag) => { try { const p = pushToUsers && pushToUsers((ids || []).filter(Boolean), { title, body, tag, url: '/' }); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ } };
  const adminIds = async () => (await pool.query("SELECT id FROM users WHERE role='admin' AND status='active'")).rows.map(r => r.id);
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
    const before = !!(await featuresOf(pool))[key];
    if (res.locals) res.locals.undo = { type: 'feature', key, label: FEATURES[key].label, before, now: b.on };
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
  app.patch('/api/providers/:id/book-mode', auth, roles('provider', 'admin'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    await ownerCheck(req, id);
    const mode = String((req.body || {}).mode || '');
    if (!['customer', 'clinic'].includes(mode)) throw fail(400, 'اختر طريقة الحجز');
    if (mode === 'clinic' && !(await featureOn(pool, 'clinicSchedule'))) throw fail(409, 'الميزة غير مفعّلة');
    await pool.query("UPDATE providers SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{bookMode}', to_jsonb($1::text)) WHERE id=$2", [mode, id]);
    clearCaches();
    res.json({ ok: true, mode });
  }));
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

  /* ---------- courier photo (the owner approves each new picture) ---------- */
  const MAX_PHOTO = 400000;
  const parsePhoto = v => { const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(v || '')); return m && String(v).length <= MAX_PHOTO ? { mime: m[1], buf: Buffer.from(m[2], 'base64') } : null; };
  app.get('/api/courier/photo', auth, roles('courier'), guard(async (req, res) => {
    const r = await pool.query('SELECT status, image IS NOT NULL AS has_approved FROM courier_photos WHERE user_id=$1', [req.auth.sub]);
    res.set('Cache-Control', 'no-store');
    res.json({ enabled: await featureOn(pool, 'courierPhoto'), status: r.rowCount ? r.rows[0].status : 'none', approved: !!(r.rowCount && r.rows[0].has_approved) });
  }));
  app.post('/api/courier/photo', auth, roles('courier'), guard(async (req, res) => {
    if (!(await featureOn(pool, 'courierPhoto'))) throw fail(409, 'ميزة صورة المندوب غير مفعّلة');
    const img = parsePhoto((req.body || {}).image);
    if (!img) throw fail(400, 'ارفع صورة صالحة (JPG أو PNG) وبحجم أصغر');
    await pool.query(`INSERT INTO courier_photos(user_id, pending_image, pending_mime, status) VALUES($1,$2,$3,'pending')
      ON CONFLICT (user_id) DO UPDATE SET pending_image=EXCLUDED.pending_image, pending_mime=EXCLUDED.pending_mime, status='pending', updated_at=NOW()`, [req.auth.sub, img.buf, img.mime]);
    adminIds().then(ids => notify(ids, 'صورة مندوب جديدة 📷', 'فيه صورة مندوب بانتظار موافقتك من تشغيل الميزات', 'courier-photo')).catch(() => {});
    res.status(201).json({ ok: true, status: 'pending' });
  }));
  app.get('/api/admin/courier-photos', ...admin, guard(async (_req, res) => {
    const r = await pool.query(`SELECT cp.user_id, u.name, cp.pending_mime, cp.pending_image FROM courier_photos cp JOIN users u ON u.id=cp.user_id WHERE cp.status='pending' AND cp.pending_image IS NOT NULL ORDER BY cp.updated_at`);
    res.set('Cache-Control', 'no-store');
    res.json({ photos: r.rows.map(x => ({ userId: String(x.user_id), name: x.name, image: `data:${x.pending_mime};base64,${x.pending_image.toString('base64')}` })) });
  }));
  app.get('/api/admin/courier-photos/:uid/pending', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.uid);
    if (!id) return res.status(400).end();
    const r = await pool.query('SELECT pending_image, pending_mime FROM courier_photos WHERE user_id=$1 AND pending_image IS NOT NULL', [id]);
    if (!r.rowCount) return res.status(404).end();
    res.set('Content-Type', r.rows[0].pending_mime);
    res.set('Cache-Control', 'no-store');
    res.send(r.rows[0].pending_image);
  }));
  app.patch('/api/admin/courier-photos/:uid', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.uid);
    if (!id) throw fail(400, 'معرّف غير صالح');
    if (typeof (req.body || {}).approve !== 'boolean') throw fail(400, 'حدد الموافقة أو الرفض');
    const r = req.body.approve
      ? await pool.query(`UPDATE courier_photos SET image=pending_image, mime=pending_mime, pending_image=NULL, pending_mime=NULL, status='approved', updated_at=NOW() WHERE user_id=$1 AND pending_image IS NOT NULL RETURNING user_id`, [id])
      : await pool.query(`UPDATE courier_photos SET pending_image=NULL, pending_mime=NULL, status='rejected', updated_at=NOW() WHERE user_id=$1 AND pending_image IS NOT NULL RETURNING user_id`, [id]);
    if (!r.rowCount) throw fail(404, 'لا توجد صورة بانتظار المراجعة');
    notify([id], req.body.approve ? 'تمت الموافقة على صورتك ✅' : 'تم رفض صورتك ❌', req.body.approve ? 'صورتك بقت تظهر للعملاء على طلباتهم' : 'ارفع صورة شخصية أوضح وجرّب تاني', 'courier-photo-' + id);
    res.json({ ok: true });
  }));
  app.get('/api/courier-photo/:uid', guard(async (req, res) => {
    const id = positiveId(req.params.uid);
    if (!id || !(await featureOn(pool, 'courierPhoto'))) return res.status(404).end();
    const r = await pool.query('SELECT image, mime FROM courier_photos WHERE user_id=$1 AND image IS NOT NULL', [id]);
    if (!r.rowCount) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime);
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(r.rows[0].image);
  }));

  /* ---------- the owner's own look at the day's numbers (same figures as the nightly report) ---------- */
  app.get('/api/admin/daily-report', ...admin, guard(async (_req, res) => {
    const w = require('./watch');
    const s = await w.dayStats(pool);
    res.set('Cache-Control', 'no-store');
    res.json({ stats: s, text: w.reportText(s) });
  }));

  /* ---------- pin a shop to the top of its list (rank 1 = first); null removes the pin ---------- */
  app.patch('/api/admin/providers/:id/pin', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    const raw = (req.body || {}).rank;
    const rank = raw === null || raw === undefined || raw === '' ? null : Math.floor(Number(raw));
    if (rank !== null && !(rank >= 1 && rank <= 999)) throw fail(400, 'الرقم من 1 إلى 999');
    const r = await pool.query('UPDATE providers SET pin_rank=$1 WHERE id=$2 AND deleted_at IS NULL RETURNING id', [rank, id]);
    if (!r.rowCount) throw fail(404, 'المحل غير موجود');
    clearCaches();
    res.json({ ok: true, rank });
  }));

  /* ---------- favorites (a customer's hearts on shops and products, kept on the server so they follow him to any phone) ---------- */
  const MAX_FAV = 100;
  app.get('/api/favorites', auth, roles('customer'), guard(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await featureOn(pool, 'favorites'))) return res.json({ enabled: false, providers: [], products: [] });
    const r = await pool.query('SELECT kind, ref_id FROM favorites WHERE user_id=$1 ORDER BY created_at DESC', [Number(req.auth.sub)]);
    res.json({ enabled: true, providers: r.rows.filter(x => x.kind === 'provider').map(x => String(x.ref_id)), products: r.rows.filter(x => x.kind === 'product').map(x => String(x.ref_id)) });
  }));
  const favKind = req => { const k = String(req.params.kind); if (!['provider', 'product'].includes(k)) throw fail(400, 'نوع غير صالح'); return k; };
  app.put('/api/favorites/:kind/:id', auth, roles('customer'), guard(async (req, res) => {
    const kind = favKind(req), id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    if (!(await featureOn(pool, 'favorites'))) throw fail(409, 'المفضلة غير متاحة حاليًا');
    const exists = await pool.query(kind === 'provider' ? 'SELECT 1 FROM providers WHERE id=$1 AND deleted_at IS NULL' : 'SELECT 1 FROM products WHERE id=$1', [id]);
    if (!exists.rowCount) throw fail(404, 'غير موجود');
    const n = await pool.query('SELECT COUNT(*)::int AS c FROM favorites WHERE user_id=$1', [Number(req.auth.sub)]);
    if (n.rows[0].c >= MAX_FAV) throw fail(409, `الحد الأقصى ${MAX_FAV} في المفضلة`);
    await pool.query('INSERT INTO favorites(user_id, kind, ref_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [Number(req.auth.sub), kind, id]);
    res.status(201).json({ ok: true });
  }));
  app.delete('/api/favorites/:kind/:id', auth, roles('customer'), guard(async (req, res) => {
    const kind = favKind(req), id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    await pool.query('DELETE FROM favorites WHERE user_id=$1 AND kind=$2 AND ref_id=$3', [Number(req.auth.sub), kind, id]);
    res.json({ ok: true });
  }));

  /* ---------- saved addresses (home, work, ...): the customer picks one at checkout instead of typing it again ---------- */
  const MAX_ADDR = 5;
  const addrJson = x => ({ id: String(x.id), label: x.label, address: x.address });
  app.get('/api/addresses', auth, roles('customer'), guard(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await featureOn(pool, 'addresses'))) return res.json({ enabled: false, addresses: [] });
    const r = await pool.query('SELECT * FROM saved_addresses WHERE user_id=$1 ORDER BY id', [Number(req.auth.sub)]);
    res.json({ enabled: true, addresses: r.rows.map(addrJson) });
  }));
  app.post('/api/addresses', auth, roles('customer'), guard(async (req, res) => {
    if (!(await featureOn(pool, 'addresses'))) throw fail(409, 'العناوين المحفوظة غير متاحة حاليًا');
    const label = String((req.body || {}).label || '').trim().slice(0, 30);
    const address = String((req.body || {}).address || '').trim().slice(0, 300);
    if (label.length < 2) throw fail(400, 'اكتب اسمًا للعنوان (البيت، الشغل...)');
    if (address.length < 6) throw fail(400, 'اكتب العنوان بالتفصيل');
    const n = await pool.query('SELECT COUNT(*)::int AS c FROM saved_addresses WHERE user_id=$1', [Number(req.auth.sub)]);
    if (n.rows[0].c >= MAX_ADDR) throw fail(409, `الحد الأقصى ${MAX_ADDR} عناوين`);
    const r = await pool.query('INSERT INTO saved_addresses(user_id, label, address) VALUES($1,$2,$3) RETURNING *', [Number(req.auth.sub), label, address]);
    res.status(201).json({ address: addrJson(r.rows[0]) });
  }));
  app.delete('/api/addresses/:id', auth, roles('customer'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    const r = await pool.query('DELETE FROM saved_addresses WHERE id=$1 AND user_id=$2 RETURNING id', [id, Number(req.auth.sub)]);
    if (!r.rowCount) throw fail(404, 'العنوان غير موجود');
    res.json({ ok: true });
  }));
}

module.exports = { orderShops, register, FEATURES, mergeFeatures, featuresOf, featureOn, effectiveMode, MODES, checkAppLink };
