'use strict';
/**
 * Customer ratings. After an order is delivered the customer rates the shop (1-5 stars, optional comment) and the courier (stars only).
 *  - one rating per order; the customer may change it for 24 hours;
 *  - the shop's average and comments are public; a courier's rating is for the owner and the supervisors only;
 *  - the owner can hide an abusive comment (the stars still count);
 *  - the shop's real average replaces the hand-set number once it has MIN_REAL ratings.
 * A database without the table (not migrated yet) simply has no ratings.
 */
const EDIT_MS = 24 * 3600 * 1000;
const MIN_REAL = 5;
const round1 = n => Math.round(n * 10) / 10;

/** {providerId -> {avg, count}} over every rating of a shop (hidden comments still count as stars). */
async function providerStats(db) {
  try {
    const r = await db.query('SELECT provider_id, AVG(provider_stars)::float AS avg, COUNT(*)::int AS n FROM ratings WHERE provider_stars IS NOT NULL AND provider_id IS NOT NULL GROUP BY provider_id');
    return new Map(r.rows.map(x => [String(x.provider_id), { avg: round1(x.avg), count: x.n }]));
  } catch { return new Map(); }
}

/** Adds ratingAvg / ratingCount to a provider json and lets the real average replace the hand-set number. */
function withStats(p, stats) {
  const s = stats.get(String(p.id));
  if (!s) return p;
  return { ...p, ratingAvg: s.avg, ratingCount: s.count, ...(s.count >= MIN_REAL ? { rating: s.avg } : {}) };
}

function registerRatingRoutes(app, { pool, auth, roles, asyncRoute, positiveId }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; }
  });
  const stars = v => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null; };
  const mine = x => ({ id: String(x.id), orderId: String(x.order_id), providerStars: x.provider_stars, courierStars: x.courier_stars, comment: x.comment || '', createdAt: new Date(x.created_at).getTime(), canEdit: Date.now() - new Date(x.created_at).getTime() < EDIT_MS });

  // the customer rates a delivered order
  app.post('/api/orders/:id/rating', auth, roles('customer'), guard(async (req, res) => {
    if (!(await require('./extras').featureOn(pool, 'ratings'))) throw fail(409, 'التقييم متوقف حاليًا');
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'رقم الطلب غير صحيح');
    const b = req.body || {};
    const ps = stars(b.providerStars);
    if (!ps) throw fail(400, 'اختر عدد النجوم للمتجر');
    const o = (await pool.query('SELECT id, status, customer_user_id, provider_id, courier_user_id FROM orders WHERE id=$1', [id])).rows[0];
    if (!o || String(o.customer_user_id) !== String(req.auth.sub)) throw fail(404, 'الطلب غير موجود');
    if (o.status !== 'delivered') throw fail(409, 'يمكنك التقييم بعد تسليم الطلب');
    let cs = null;
    if (b.courierStars != null && b.courierStars !== '') {
      cs = stars(b.courierStars);
      if (!cs) throw fail(400, 'تقييم المندوب غير صحيح');
      if (!o.courier_user_id) cs = null;
    }
    const comment = String(b.comment || '').trim().slice(0, 500) || null;
    const old = (await pool.query('SELECT id, created_at FROM ratings WHERE order_id=$1', [id])).rows[0];
    if (old && Date.now() - new Date(old.created_at).getTime() >= EDIT_MS) throw fail(409, 'انتهت مدة تعديل التقييم');
    const r = old
      ? await pool.query('UPDATE ratings SET provider_stars=$1, courier_stars=$2, comment=$3, updated_at=NOW() WHERE order_id=$4 RETURNING *', [ps, cs, comment, id])
      : await pool.query('INSERT INTO ratings(order_id, customer_user_id, provider_id, courier_user_id, provider_stars, courier_stars, comment) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [id, o.customer_user_id, o.provider_id, o.courier_user_id, ps, cs, comment]);
    res.status(old ? 200 : 201).json({ rating: mine(r.rows[0]) });
  }));

  // the customer reads his own rating of the order (null when he has not rated yet)
  app.get('/api/orders/:id/rating', auth, roles('customer'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'رقم الطلب غير صحيح');
    const r = (await pool.query('SELECT * FROM ratings WHERE order_id=$1 AND customer_user_id=$2', [id, req.auth.sub])).rows[0];
    res.json({ rating: r ? mine(r) : null });
  }));

  // a shop's public rating: average, distribution and the latest visible comments
  app.get('/api/providers/:id/ratings', auth, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف المتجر غير صحيح');
    const s = (await pool.query('SELECT COUNT(*)::int AS n, COALESCE(AVG(provider_stars),0)::float AS avg, COUNT(*) FILTER (WHERE provider_stars=5)::int AS s5, COUNT(*) FILTER (WHERE provider_stars=4)::int AS s4, COUNT(*) FILTER (WHERE provider_stars=3)::int AS s3, COUNT(*) FILTER (WHERE provider_stars=2)::int AS s2, COUNT(*) FILTER (WHERE provider_stars=1)::int AS s1 FROM ratings WHERE provider_id=$1 AND provider_stars IS NOT NULL', [id])).rows[0];
    const c = (await pool.query("SELECT r.provider_stars, r.comment, r.created_at, split_part(COALESCE(u.name,''),' ',1) AS who FROM ratings r LEFT JOIN users u ON u.id=r.customer_user_id WHERE r.provider_id=$1 AND r.hidden=FALSE AND r.comment IS NOT NULL ORDER BY r.created_at DESC LIMIT 20", [id])).rows;
    res.json({ count: s.n, avg: s.n ? round1(s.avg) : 0, dist: { 5: s.s5, 4: s.s4, 3: s.s3, 2: s.s2, 1: s.s1 }, comments: c.map(x => ({ stars: x.provider_stars, comment: x.comment, who: x.who || 'عميل', at: new Date(x.created_at).getTime() })) });
  }));

  // staff: latest ratings with the order, shop, courier and customer (to hide an abusive comment); couriers' averages
  app.get('/api/staff/ratings', auth, roles('admin', 'supervisor'), guard(async (_req, res) => {
    const r = await pool.query("SELECT r.*, o.order_number, p.name AS pname, cu.name AS cname, c.name AS courier_name FROM ratings r JOIN orders o ON o.id=r.order_id LEFT JOIN providers p ON p.id=r.provider_id LEFT JOIN users cu ON cu.id=r.customer_user_id LEFT JOIN users c ON c.id=r.courier_user_id ORDER BY r.created_at DESC LIMIT 100");
    const cr = await pool.query('SELECT courier_user_id, AVG(courier_stars)::float AS avg, COUNT(*)::int AS n FROM ratings WHERE courier_stars IS NOT NULL AND courier_user_id IS NOT NULL GROUP BY courier_user_id');
    res.json({
      ratings: r.rows.map(x => ({ ...mine(x), orderNumber: x.order_number, providerName: x.pname || '', customerName: x.cname || '', courierName: x.courier_name || '', hidden: !!x.hidden })),
      couriers: Object.fromEntries(cr.rows.map(x => [String(x.courier_user_id), { avg: round1(x.avg), count: x.n }])),
    });
  }));
  app.patch('/api/admin/ratings/:id', auth, roles('admin'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف التقييم غير صحيح');
    if (typeof (req.body || {}).hidden !== 'boolean') throw fail(400, 'حدد إخفاء أو إظهار');
    const r = await pool.query('UPDATE ratings SET hidden=$1 WHERE id=$2 RETURNING id, hidden', [req.body.hidden, id]);
    if (!r.rowCount) throw fail(404, 'التقييم غير موجود');
    res.json({ id: String(r.rows[0].id), hidden: r.rows[0].hidden });
  }));
}

module.exports = { registerRatingRoutes, providerStats, withStats, MIN_REAL, EDIT_MS };
