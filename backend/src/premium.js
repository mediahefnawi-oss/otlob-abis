'use strict';
/**
 * "أبيس بريميم": a paid subscription the owner activates by hand (the customer pays by transfer and sends the proof).
 * The owner's master switch "premium" turns the whole thing on; each benefit has its own switch:
 *   premiumFreeDelivery  free delivery on a shop's order from a minimum amount
 *   premiumDiscount      a percent off the products (never together with an offer or a discount code: one discount only)
 *   premiumOffers        discount codes marked "للمشتركين بس"
 *   premiumPriority      the order shows first to couriers, with a PRO mark for the shop and the courier
 * The server alone decides every price: the app only shows the same numbers.
 */
const round2 = n => Math.round(n * 100) / 100;
const fail = (status, error) => Object.assign(new Error(error), { http: status });

const DEFAULTS = { price: 99, days: 30, discountPct: 5, freeAbove: 150, transfer: '', promo: 'توصيل مجاني وخصومات حصرية مع أبيس بريميم', lines: [] };

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
/** The stored settings with the defaults filled in. */
function cfgOf(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    price: num(r.price, DEFAULTS.price), days: Math.floor(num(r.days, DEFAULTS.days)), discountPct: num(r.discountPct, DEFAULTS.discountPct), freeAbove: num(r.freeAbove, DEFAULTS.freeAbove),
    transfer: String(r.transfer || '').slice(0, 40), promo: r.promo != null ? String(r.promo).slice(0, 120) : DEFAULTS.promo,
    lines: Array.isArray(r.lines) ? r.lines.map(x => String(x || '').trim().slice(0, 80)).filter(Boolean).slice(0, 8) : [],
  };
}
/** The owner's edit, checked. Throws a 400 with the reason. */
function cleanCfg(b) {
  b = b || {};
  const price = Number(b.price), days = Math.floor(Number(b.days)), pct = Number(b.discountPct), free = Number(b.freeAbove);
  if (!(price >= 0 && price <= 100000)) throw fail(400, 'سعر الاشتراك غير صحيح');
  if (!(days >= 1 && days <= 365)) throw fail(400, 'مدة الاشتراك من 1 إلى 365 يوم');
  if (!(pct >= 0 && pct <= 50)) throw fail(400, 'نسبة الخصم من 0 إلى 50');
  if (!(free >= 0 && free <= 100000)) throw fail(400, 'حد التوصيل المجاني غير صحيح');
  const transfer = String(b.transfer || '').trim();
  if (transfer.length > 40) throw fail(400, 'رقم التحويل طويل');
  const lines = (Array.isArray(b.lines) ? b.lines : []).map(x => String(x || '').trim()).filter(Boolean);
  if (lines.length > 8 || lines.some(x => x.length > 80)) throw fail(400, 'أقصى عدد 8 سطور، كل سطر 80 حرف');
  return { price, days, discountPct: pct, freeAbove: free, transfer, promo: String(b.promo || '').trim().slice(0, 120), lines };
}

const isActive = until => !!until && new Date(until).getTime() > Date.now();
const NONE = Object.freeze({ member: false, discountPct: 0, freeAbove: null, priority: false, offers: false });

const extras = () => require('./extras');
async function loadCfg(db) {
  try { const r = await db.query('SELECT premium FROM app_settings WHERE id=1'); return cfgOf(r.rowCount ? r.rows[0].premium : null); }
  catch (e) { if (e.code === '42703') return cfgOf(null); throw e; } // column not migrated yet
}
/** What this customer gets right now (nothing unless the master switch is on and his subscription has not ended). */
async function benefits(db, userId) {
  if (!userId) return NONE;
  let f;
  try { f = await extras().featuresOf(db); } catch { return NONE; }
  if (!f.premium) return NONE;
  let r;
  try { r = await db.query('SELECT premium_until FROM users WHERE id=$1', [userId]); }
  catch (e) { if (e.code === '42703') return NONE; throw e; }
  if (!r.rowCount || !isActive(r.rows[0].premium_until)) return NONE;
  const cfg = await loadCfg(db);
  return { member: true, discountPct: f.premiumDiscount ? cfg.discountPct : 0, freeAbove: f.premiumFreeDelivery ? cfg.freeAbove : null, priority: !!f.premiumPriority, offers: !!f.premiumOffers };
}
/**
 * The member's price for one shop's part of an order.
 * discount: a percent off the products, only when the shop has no running offer and no discount code was used (one discount only);
 * fee: 0 when the products reach the free-delivery amount (never for a shared "شير اللقمة" delivery, which has its own price split).
 */
function priceGroup({ subtotal, couponDisc = 0, hasOffer = false, fee, pooled = false }, ben) {
  let discount = 0, free = false, outFee = fee;
  if (ben && ben.member) {
    if (ben.discountPct > 0 && !hasOffer && !(couponDisc > 0)) discount = Math.min(round2(subtotal), round2(subtotal * ben.discountPct / 100));
    if (ben.freeAbove != null && fee > 0 && !pooled && subtotal >= ben.freeAbove) { outFee = 0; free = true; }
  }
  return { discount, fee: outFee, free };
}

/** The public part of the settings: what the customer needs to see (price, benefits that are on, how to pay). */
function publicView(rawCfg, feats) {
  const c = cfgOf(rawCfg);
  return {
    on: !!feats.premium, price: c.price, days: c.days, transfer: c.transfer, promo: c.promo, lines: c.lines,
    discountPct: feats.premiumDiscount ? c.discountPct : 0, freeAbove: feats.premiumFreeDelivery ? c.freeAbove : null, offers: !!feats.premiumOffers, priority: !!feats.premiumPriority,
  };
}

function register(app, { pool, auth, roles, asyncRoute, clearCaches, pushToUsers }) {
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; }
  });
  const admin = [auth, roles('admin')];
  const normPhone = v => String(v || '').replace(/\s+/g, '');
  const subJson = x => ({ id: String(x.id), name: x.name, phone: x.phone, until: new Date(x.premium_until).getTime(), active: isActive(x.premium_until), daysLeft: Math.max(0, Math.ceil((new Date(x.premium_until).getTime() - Date.now()) / 86400000)) });
  const subscribers = async () => (await pool.query("SELECT id, name, phone, premium_until FROM users WHERE premium_until IS NOT NULL AND role='customer' ORDER BY premium_until DESC LIMIT 300")).rows.map(subJson);
  // what the subscribers' benefits cost in the last 30 days (delivered orders): the free deliveries the courier still earned, and the percent taken off
  const costs = async () => {
    const r = await pool.query(`SELECT COALESCE(SUM(CASE WHEN (data->>'premiumFree')='true' THEN (data->>'normalFee')::numeric ELSE 0 END),0) AS free_cost,
        COALESCE(SUM(CASE WHEN data->>'couponCode'='PREMIUM' THEN (data->>'discount')::numeric ELSE 0 END),0) AS disc_cost, COUNT(*) FILTER (WHERE (data->>'premiumFree')='true' OR data->>'couponCode'='PREMIUM') AS n
      FROM orders WHERE status='delivered' AND delivered_at > NOW() - INTERVAL '30 days'`);
    const x = r.rows[0];
    return { freeDelivery: round2(Number(x.free_cost)), discount: round2(Number(x.disc_cost)), orders: Number(x.n) };
  };
  const view = async () => { const subs = await subscribers(); return { cfg: await loadCfg(pool), subscribers: subs, activeCount: subs.filter(s => s.active).length, cost30: await costs() }; };
  const log = (db, userId, adminId, action, days, until) => db.query('INSERT INTO premium_log(user_id, admin_id, action, days, until) VALUES($1,$2,$3,$4,$5)', [userId, adminId, action, days, until]).catch(() => {});

  app.get('/api/admin/premium', ...admin, guard(async (_req, res) => { res.json(await view()); }));
  app.put('/api/admin/premium', ...admin, guard(async (req, res) => {
    const cfg = cleanCfg(req.body);
    await pool.query('UPDATE app_settings SET premium=$1::jsonb, updated_at=NOW() WHERE id=1', [JSON.stringify(cfg)]);
    clearCaches();
    res.json(await view());
  }));
  app.post('/api/admin/premium/activate', ...admin, guard(async (req, res) => {
    const b = req.body || {};
    const phone = normPhone(b.phone);
    const days = Math.floor(Number(b.days));
    if (!/^01[0-9]{9}$/.test(phone)) throw fail(400, 'اكتب رقم هاتف العميل (11 رقم)');
    if (!(days >= 1 && days <= 3650)) throw fail(400, 'عدد الأيام من 1 إلى 3650');
    const u = await pool.query("SELECT id, name, premium_until FROM users WHERE phone=$1 AND role='customer'", [phone]);
    if (!u.rowCount) throw fail(404, 'مفيش عميل بالرقم ده');
    // an active subscription is extended from its end, an ended one starts now
    const r = await pool.query("UPDATE users SET premium_until = GREATEST(COALESCE(premium_until, NOW()), NOW()) + make_interval(days => $1) WHERE id=$2 RETURNING premium_until", [days, u.rows[0].id]);
    await log(pool, u.rows[0].id, Number(req.auth.sub), 'activate', days, r.rows[0].premium_until);
    clearCaches();
    try { const p = pushToUsers && pushToUsers([u.rows[0].id], { title: 'أبيس بريميم ✨', body: 'تم تفعيل اشتراكك. استمتع بالتوصيل المجاني والخصومات!', tag: 'premium', url: '/' }); if (p && p.catch) p.catch(() => {}); } catch { /* a failed push never fails the request */ }
    res.json({ ...(await view()), activated: { name: u.rows[0].name, until: new Date(r.rows[0].premium_until).getTime() } });
  }));
  app.post('/api/admin/premium/cancel', ...admin, guard(async (req, res) => {
    const phone = normPhone((req.body || {}).phone);
    const u = await pool.query("SELECT id FROM users WHERE phone=$1 AND role='customer'", [phone]);
    if (!u.rowCount) throw fail(404, 'مفيش عميل بالرقم ده');
    await pool.query('UPDATE users SET premium_until=NULL WHERE id=$1', [u.rows[0].id]);
    await log(pool, u.rows[0].id, Number(req.auth.sub), 'cancel', null, null);
    clearCaches();
    res.json(await view());
  }));
}

module.exports = { DEFAULTS, cfgOf, cleanCfg, isActive, benefits, priceGroup, publicView, loadCfg, register, NONE };
