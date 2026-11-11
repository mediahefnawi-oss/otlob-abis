'use strict';
/**
 * Voice orders (switch "voice"). A customer records up to 45 seconds and sends it with a written request ("اطلب أي حاجة" or a
 * shop's written request). The recording lives apart from the order (like the request photo) and is deleted after 30 days.
 * Only the customer, the shop, the courier of the order, a supervisor of its area and the owner may listen.
 */
const extrasLib = require('./extras');
const MAX_CHARS = 360000; // base64 text (about 260 KB of audio)
const MAX_SECONDS = 45;
const KEEP_DAYS = 30;
const MIME = /^data:audio\/(webm|ogg|mp4|m4a|x-m4a|aac|mpeg|mp3|wav|3gpp)(;codecs=[^;,]+)?;base64,[A-Za-z0-9+/=]+$/;

const fail = (status, error) => Object.assign(new Error(error), { http: status });

/** Validates the voice part of a request body. Returns null when there is none; throws a 400/409 when it is not acceptable. */
async function check(db, v) {
  if (v === undefined || v === null || v === '') return null;
  if (!(await extrasLib.featureOn(db, 'voice'))) throw fail(409, 'الطلب بالصوت غير متاح حاليًا');
  const audio = v && typeof v === 'object' ? v.audio : null;
  const seconds = Math.round(Number(v && v.seconds));
  if (typeof audio !== 'string' || audio.length > MAX_CHARS || !MIME.test(audio)) throw fail(400, 'التسجيل غير صالح أو كبير');
  if (!Number.isFinite(seconds) || seconds < 1) throw fail(400, 'التسجيل قصير جدًا');
  if (seconds > MAX_SECONDS + 3) throw fail(400, `التسجيل أطول من ${MAX_SECONDS} ثانية`);
  return { audio, seconds: Math.min(seconds, MAX_SECONDS) };
}
async function save(db, orderId, v) {
  await db.query('INSERT INTO order_voice(order_id, audio, seconds) VALUES($1,$2,$3) ON CONFLICT (order_id) DO UPDATE SET audio=EXCLUDED.audio, seconds=EXCLUDED.seconds', [orderId, v.audio, v.seconds]);
}
/** Deletes recordings older than KEEP_DAYS. Returns how many. */
async function purge(db) {
  const r = await db.query(`DELETE FROM order_voice WHERE created_at < NOW() - ($1 || ' days')::interval`, [String(KEEP_DAYS)]);
  return r.rowCount || 0;
}

function register(app, { pool, auth, asyncRoute, positiveId }) {
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; }
  });
  app.get('/api/orders/:id/voice', auth, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف الطلب غير صالح');
    const f = await pool.query(
      `SELECT o.customer_user_id, o.courier_user_id, o.region_id, p.owner_user_id AS powner, v.audio, v.seconds
         FROM orders o LEFT JOIN providers p ON p.id=o.provider_id LEFT JOIN order_voice v ON v.order_id=o.id WHERE o.id=$1`, [id]);
    if (!f.rowCount) throw fail(404, 'الطلب غير موجود');
    const r = f.rows[0]; const me = Number(req.auth.sub);
    let ok = req.auth.role === 'admin' || [r.customer_user_id, r.courier_user_id, r.powner].some(x => x && Number(x) === me);
    if (!ok && req.auth.role === 'supervisor' && r.region_id) {
      const s = await pool.query('SELECT sup_regions FROM users WHERE id=$1', [me]);
      ok = String((s.rows[0] || {}).sup_regions || '').split(',').filter(Boolean).map(Number).includes(Number(r.region_id));
    }
    if (!ok) throw fail(403, 'غير مسموح');
    if (!r.audio) throw fail(404, 'التسجيل غير موجود أو اتحذف بعد 30 يوم');
    res.set('Cache-Control', 'private, max-age=3600');
    res.json({ audio: r.audio, seconds: r.seconds });
  }));
}
module.exports = { check, save, purge, register, MAX_SECONDS, KEEP_DAYS };
