'use strict';
/**
 * Offers / discounts. Only the owner creates them. An offer takes a percentage off every product of one shop (or of all shops) while it
 * is active and inside its dates. If several apply to a product, the biggest percentage wins (they never stack).
 * The server prices the order, so the customer always pays exactly the price he saw.
 */
const COLORS = ['red', 'green', 'orange', 'purple', 'blue', 'gold'];
const round2 = n => Math.round(n * 100) / 100;

/** Offers running right now. A database without the table (not migrated yet) simply has none. */
async function activeOffers(db) {
  try {
    const r = await db.query('SELECT id, title, percent, provider_id, color, ends_at FROM offers WHERE active=TRUE AND starts_at <= NOW() AND (ends_at IS NULL OR ends_at > NOW())');
    return r.rows;
  } catch { return []; }
}
/** The offer that applies to a product of this shop, or null. */
function bestOffer(offers, providerId) {
  let best = null;
  for (const o of offers) {
    if (o.provider_id != null && Number(o.provider_id) !== Number(providerId)) continue;
    if (!best || o.percent > best.percent) best = o;
  }
  return best;
}
const salePrice = (price, offer) => offer ? round2(Number(price) * (100 - offer.percent) / 100) : Number(price);
const offerJson = o => ({ id: String(o.id), title: o.title, percent: Number(o.percent), color: o.color, providerId: o.provider_id ? String(o.provider_id) : null, endsAt: o.ends_at ? new Date(o.ends_at).getTime() : null });

function registerOfferRoutes(app, { pool, auth, roles, asyncRoute, positiveId }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; }
  });
  const rowJson = x => ({ ...offerJson(x), active: !!x.active, startsAt: new Date(x.starts_at).getTime(), providerName: x.pname || null });
  const list = async () => (await pool.query(`SELECT o.*, p.name AS pname FROM offers o LEFT JOIN providers p ON p.id=o.provider_id ORDER BY o.active DESC, o.created_at DESC LIMIT 200`)).rows.map(rowJson);

  app.get('/api/admin/offers', auth, roles('admin'), asyncRoute(async (_req, res) => res.json({ offers: await list() })));
  app.post('/api/admin/offers', auth, roles('admin'), guard(async (req, res) => {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 60);
    const percent = Math.floor(Number(b.percent));
    const color = COLORS.includes(b.color) ? b.color : 'red';
    if (!title) throw fail(400, 'اكتب اسم العرض');
    if (!(percent >= 1 && percent <= 90)) throw fail(400, 'نسبة الخصم من 1 إلى 90');
    let pid = null;
    if (b.providerId) {
      pid = positiveId(b.providerId);
      if (!pid || !(await pool.query('SELECT 1 FROM providers WHERE id=$1 AND deleted_at IS NULL', [pid])).rowCount) throw fail(404, 'المتجر غير موجود');
    }
    let ends = null;
    if (b.hours != null && b.hours !== '') {
      const h = Number(b.hours);
      if (!(h > 0 && h <= 24 * 365)) throw fail(400, 'مدة العرض غير صحيحة');
      ends = new Date(Date.now() + h * 3600 * 1000);
    }
    await pool.query('INSERT INTO offers(title, percent, provider_id, color, ends_at) VALUES($1,$2,$3,$4,$5)', [title, percent, pid, color, ends]);
    res.status(201).json({ offers: await list() });
  }));
  app.patch('/api/admin/offers/:id', auth, roles('admin'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'عرض غير صحيح');
    const r = await pool.query('UPDATE offers SET active=$1 WHERE id=$2', [(req.body || {}).active === true, id]);
    if (!r.rowCount) throw fail(404, 'العرض غير موجود');
    res.json({ offers: await list() });
  }));
  app.delete('/api/admin/offers/:id', auth, roles('admin'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'عرض غير صحيح');
    await pool.query('DELETE FROM offers WHERE id=$1', [id]);
    res.json({ offers: await list() });
  }));
}
module.exports = { registerOfferRoutes, activeOffers, bestOffer, salePrice, offerJson, COLORS };
