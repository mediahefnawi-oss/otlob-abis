'use strict';
/**
 * Discount codes. Only the owner makes them (or the "gift" he gives a customer when he cancels his order).
 * A code takes an amount or a percent off the PRODUCTS of the cart (never the delivery fee, never below zero), only inside its dates,
 * for all shops or chosen shops, for everyone or one customer, with a limit per customer and in total.
 * The server alone decides: the app only asks "check" and shows the answer; checkout re-checks everything inside the transaction.
 * One checkout (one invoice) counts as ONE use, however many shops it splits into. A cancelled order gives its use back.
 */
const round2 = n => Math.round(n * 100) / 100;
const fail = (status, error) => Object.assign(new Error(error), { http: status });
const dup = e => !!e && (e.code === '23505' || e.errno === '23505'); // Postgres "unique violation"
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const normCode = s => String(s || '').toUpperCase().replace(/[\s‎‏]/g, '').replace(/[^A-Z0-9-]/g, '');
const genCode = (prefix = 'ABIS') => prefix + '-' + Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');

/** Midnight (Cairo time) of 'YYYY-MM-DD' as a Date. */
function cairoMidnight(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || Number.isNaN(Date.parse(ymd))) return null;
  const probe = new Date(`${ymd}T12:00:00Z`);
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', timeZoneName: 'longOffset' }).formatToParts(probe).find(p => p.type === 'timeZoneName');
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(part ? part.value : '');
  const off = m ? `${m[1]}${m[2]}:${m[3]}` : '+02:00';
  return new Date(`${ymd}T00:00:00${off}`);
}

/** Split a discount over the shops it applies to, in proportion to their products, to the piastre. */
function allocate(total, groups) {
  const sum = groups.reduce((s, g) => s + g.subtotal, 0);
  const out = new Map(); let left = total;
  groups.forEach((g, i) => {
    const part = i === groups.length - 1 ? left : Math.min(g.subtotal, round2(total * g.subtotal / sum));
    const v = Math.max(0, Math.min(g.subtotal, round2(part)));
    out.set(String(g.providerId), v); left = round2(left - v);
  });
  return out;
}

/**
 * Is this code good for this customer and this cart? Returns { coupon, discount, perGroup } or throws a 400 with the reason.
 * groups: [{ providerId, subtotal }] with the prices the customer pays (offers already taken off).
 * forUpdate: lock the code row, so two customers cannot both take the last use.
 */
async function evaluate(db, { code, userId, groups, forUpdate = false }) {
  const c = normCode(code);
  if (c.length < 4) throw fail(400, 'اكتب كود الخصم');
  const r = await db.query(`SELECT * FROM coupons WHERE code=$1${forUpdate ? ' FOR UPDATE' : ''}`, [c]);
  const cp = r.rows[0];
  if (!cp) throw fail(400, 'كود الخصم غير صحيح');
  if (!cp.active) throw fail(400, 'هذا الكود متوقف');
  const now = Date.now();
  if (new Date(cp.starts_at).getTime() > now) throw fail(400, 'هذا الكود لم يبدأ بعد');
  if (new Date(cp.ends_at).getTime() <= now) throw fail(400, 'انتهت صلاحية هذا الكود');
  if (cp.user_id != null && Number(cp.user_id) !== Number(userId)) throw fail(400, 'هذا الكود غير مخصص لحسابك');
  if (cp.premium_only) { const pb = await require('./premium').benefits(db, userId); if (!pb.member || !pb.offers) throw fail(400, 'هذا الكود للمشتركين في أبيس بريميم بس'); }
  const ids = cp.provider_ids ? cp.provider_ids.map(String) : null;
  // a shop with a running offer keeps its offer: the offer and a code never stack (one discount only)
  const forShops = groups.filter(g => !ids || ids.includes(String(g.providerId)));
  const eligible = forShops.filter(g => !g.hasOffer);
  if (!forShops.length) throw fail(400, 'هذا الكود لا ينطبق على المتاجر في سلتك');
  if (!eligible.length) throw fail(400, 'المتجر عليه عرض حالي، ولا يجتمع العرض مع كود الخصم');
  if (cp.per_user != null) {
    const u = await db.query('SELECT COUNT(DISTINCT group_ref)::int AS n FROM coupon_uses WHERE coupon_id=$1 AND user_id=$2', [cp.id, userId]);
    if (u.rows[0].n >= cp.per_user) throw fail(400, cp.per_user === 1 ? 'استخدمت هذا الكود من قبل' : `استخدمت هذا الكود ${cp.per_user} مرات من قبل`);
  }
  if (cp.max_uses != null) {
    const t = await db.query('SELECT COUNT(DISTINCT group_ref)::int AS n FROM coupon_uses WHERE coupon_id=$1', [cp.id]);
    if (t.rows[0].n >= cp.max_uses) throw fail(400, 'انتهت مرات استخدام هذا الكود');
  }
  const base = round2(eligible.reduce((s, g) => s + g.subtotal, 0));
  let discount = cp.kind === 'amount' ? Number(cp.value) : round2(base * Number(cp.value) / 100);
  if (cp.kind === 'percent' && cp.max_discount != null) discount = Math.min(discount, Number(cp.max_discount));
  discount = round2(Math.min(discount, base));
  if (!(discount > 0)) throw fail(400, 'لا يوجد خصم على هذه السلة');
  return { coupon: cp, discount, perGroup: allocate(discount, eligible) };
}

/** Remember that this checkout used the code (inside the checkout transaction). */
async function record(db, { coupon, userId, groupRef, orders }) {
  for (const o of orders) {
    if (!(o.discount > 0)) continue;
    await db.query('INSERT INTO coupon_uses(coupon_id, user_id, order_id, group_ref, amount) VALUES($1,$2,$3,$4,$5)', [coupon.id, userId, o.id, groupRef, o.discount]);
  }
}
/** A cancelled order gives its use back. */
async function release(db, orderId) {
  try { await db.query('DELETE FROM coupon_uses WHERE order_id=$1', [orderId]); } catch { /* a database without the table has no uses */ }
}

/** A private one-use code for one customer (the owner's gift when he cancels an order). */
async function makeGift(db, { userId, kind, value, days }) {
  if (!['amount', 'percent'].includes(kind)) throw fail(400, 'نوع الهدية غير صحيح');
  const v = Number(value);
  if (!(v > 0) || (kind === 'percent' && v > 90) || v > 100000) throw fail(400, 'قيمة الهدية غير صحيحة');
  const d = Math.floor(Number(days));
  if (!(d >= 1 && d <= 365)) throw fail(400, 'مدة الهدية غير صحيحة');
  for (let i = 0; i < 8; i++) {
    const code = genCode('ABIS');
    try {
      const r = await db.query(
        `INSERT INTO coupons(code, kind, value, ends_at, user_id, per_user, max_uses, source) VALUES($1,$2,$3, NOW() + make_interval(days => $4), $5, 1, 1, 'gift') RETURNING *`,
        [code, kind, v, d, userId]);
      return r.rows[0];
    } catch (e) { if (!dup(e)) throw e; }
  }
  throw fail(500, 'تعذر توليد الكود، حاول مرة أخرى');
}

const couponJson = x => ({
  id: String(x.id), code: x.code, kind: x.kind, value: Number(x.value), maxDiscount: x.max_discount != null ? Number(x.max_discount) : null,
  startsAt: new Date(x.starts_at).getTime(), endsAt: new Date(x.ends_at).getTime(),
  providerIds: x.provider_ids ? x.provider_ids.map(String) : null, userId: x.user_id ? String(x.user_id) : null, userName: x.uname || null,
  perUser: x.per_user != null ? Number(x.per_user) : null, maxUses: x.max_uses != null ? Number(x.max_uses) : null, uses: Number(x.uses || 0), given: Number(x.given || 0),
  active: !!x.active, source: x.source, premiumOnly: !!x.premium_only,
});

function registerCouponRoutes(app, { pool, auth, roles, asyncRoute, positiveId }) {
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; }
  });
  const list = async () => (await pool.query(
    `SELECT c.*, u.name AS uname, (SELECT COUNT(DISTINCT group_ref) FROM coupon_uses WHERE coupon_id=c.id) AS uses, (SELECT COALESCE(SUM(amount),0) FROM coupon_uses WHERE coupon_id=c.id) AS given
       FROM coupons c LEFT JOIN users u ON u.id=c.user_id
      ORDER BY (c.active AND c.ends_at > NOW()) DESC, c.created_at DESC LIMIT 300`)).rows.map(couponJson);

  app.get('/api/admin/coupons', auth, roles('admin'), guard(async (_req, res) => res.json({ coupons: await list() })));

  app.post('/api/admin/coupons', auth, roles('admin'), guard(async (req, res) => {
    const b = req.body || {};
    const kind = b.kind === 'percent' ? 'percent' : b.kind === 'amount' ? 'amount' : null;
    if (!kind) throw fail(400, 'اختر نوع الخصم');
    const value = Number(b.value);
    if (!(value > 0) || value > 100000) throw fail(400, 'اكتب قيمة الخصم');
    if (kind === 'percent' && !(value >= 1 && value <= 90)) throw fail(400, 'نسبة الخصم من 1 إلى 90');
    let maxDiscount = null;
    if (kind === 'percent' && b.maxDiscount != null && b.maxDiscount !== '') {
      maxDiscount = Number(b.maxDiscount);
      if (!(maxDiscount > 0) || maxDiscount > 100000) throw fail(400, 'الحد الأقصى للخصم غير صحيح');
    }
    const days = Math.floor(Number(b.days));
    if (!(days >= 1 && days <= 365)) throw fail(400, 'مدة الصلاحية من 1 إلى 365 يوم');
    let starts = new Date();
    if (b.startDate) {
      starts = cairoMidnight(String(b.startDate));
      if (!starts) throw fail(400, 'تاريخ البداية غير صحيح');
    }
    const ends = new Date(starts.getTime() + days * 24 * 3600 * 1000);
    if (ends.getTime() <= Date.now()) throw fail(400, 'هذه الفترة انتهت بالفعل');
    let code = normCode(b.code);
    if (b.code && !/^[A-Z0-9-]{4,20}$/.test(code)) throw fail(400, 'الكود من 4 إلى 20 حرفاً إنجليزياً أو أرقاماً');
    let providerIds = null;
    if (Array.isArray(b.providerIds) && b.providerIds.length) {
      providerIds = [...new Set(b.providerIds.map(positiveId).filter(Boolean))];
      if (!providerIds.length) throw fail(400, 'اختر متاجر صحيحة');
      const ok = await pool.query('SELECT id FROM providers WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL', [providerIds]);
      if (ok.rowCount !== providerIds.length) throw fail(404, 'أحد المتاجر غير موجود');
    }
    let userId = null;
    if (b.userId) {
      userId = positiveId(b.userId);
      if (!userId || !(await pool.query("SELECT 1 FROM users WHERE id=$1 AND role='customer'", [userId])).rowCount) throw fail(404, 'العميل غير موجود');
    }
    let perUser = 1;
    if (b.perUser === null || b.perUser === 'none') perUser = null;
    else if (b.perUser !== undefined) { perUser = Math.floor(Number(b.perUser)); if (!(perUser >= 1 && perUser <= 100)) throw fail(400, 'عدد مرات الاستخدام لكل عميل غير صحيح'); }
    let maxUses = null;
    if (b.maxUses != null && b.maxUses !== '') { maxUses = Math.floor(Number(b.maxUses)); if (!(maxUses >= 1 && maxUses <= 1000000)) throw fail(400, 'إجمالي الاستخدامات غير صحيح'); }
    const premiumOnly = b.premiumOnly === true;
    const insert = c => pool.query(
      'INSERT INTO coupons(code, kind, value, max_discount, starts_at, ends_at, provider_ids, user_id, per_user, max_uses, premium_only) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [c, kind, value, maxDiscount, starts, ends, providerIds, userId, perUser, maxUses, premiumOnly]);
    try {
      if (code) await insert(code);
      else for (let i = 0; ; i++) { try { await insert(genCode('OFF')); break; } catch (e) { if (!dup(e) || i > 8) throw e; } }
    } catch (e) {
      if (dup(e)) throw fail(409, 'هذا الكود موجود بالفعل، اختر كوداً آخر');
      throw e;
    }
    res.status(201).json({ coupons: await list() });
  }));

  app.patch('/api/admin/coupons/:id', auth, roles('admin'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'كود غير صحيح');
    const r = await pool.query('UPDATE coupons SET active=$1 WHERE id=$2', [(req.body || {}).active === true, id]);
    if (!r.rowCount) throw fail(404, 'الكود غير موجود');
    res.json({ coupons: await list() });
  }));

  app.delete('/api/admin/coupons/:id', auth, roles('admin'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'كود غير صحيح');
    const used = await pool.query('SELECT 1 FROM coupon_uses WHERE coupon_id=$1 LIMIT 1', [id]);
    if (used.rowCount) throw fail(409, 'هذا الكود اتستخدم بالفعل. أوقفه بدل الحذف');
    await pool.query('DELETE FROM coupons WHERE id=$1', [id]);
    res.json({ coupons: await list() });
  }));
}

module.exports = { registerCouponRoutes, evaluate, record, release, makeGift, normCode, genCode, allocate, cairoMidnight, couponJson, round2 };
