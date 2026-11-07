'use strict';
/**
 * Delivery price by distance. The owner switches it on (fee_mode = 'km') and sets the price of a kilometre, a minimum, a maximum and a
 * road factor (a straight line is shorter than the road). Needs the shop's spot and the customer's spot; without both, the area price is used.
 */
const { km } = require('./tracking');

/** Pure: the fee for two points, or null when either spot is missing. */
function feeFor(cfg, a, b) {
  if (!cfg || cfg.mode !== 'km') return null;
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const dist = km(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng)) * Number(cfg.factor || 1);
  const raw = Math.round(dist * Number(cfg.perKm));
  const fee = Math.min(Number(cfg.max), Math.max(Number(cfg.min), raw));
  return { fee, km: Math.round(dist * 10) / 10 };
}
const cfgFromRow = x => ({ mode: x.fee_mode === 'km' ? 'km' : 'region', perKm: Number(x.fee_per_km), min: Number(x.fee_min), max: Number(x.fee_max), factor: Number(x.fee_factor) });

async function loadCfg(db) {
  try { const r = await db.query('SELECT fee_mode, fee_per_km, fee_min, fee_max, fee_factor FROM app_settings WHERE id=1'); return r.rowCount ? cfgFromRow(r.rows[0]) : { mode: 'region' }; }
  catch { return { mode: 'region' }; } // not migrated yet
}
/** The fee for a shop and a customer from the database, or null (switch off / a spot missing). */
async function forOrder(db, providerId, customerId) {
  const cfg = await loadCfg(db);
  if (cfg.mode !== 'km') return null;
  try {
    const p = await db.query('SELECT lat, lng FROM providers WHERE id=$1', [providerId]);
    const u = await db.query('SELECT home_lat AS lat, home_lng AS lng FROM users WHERE id=$1', [customerId]);
    return feeFor(cfg, p.rows[0], u.rows[0]);
  } catch { return null; }
}

function registerKmFeeRoutes(app, { pool, auth, roles, asyncRoute, settingsMemo }) {
  app.patch('/api/admin/delivery-mode', auth, roles('admin'), asyncRoute(async (req, res) => {
    const b = req.body || {};
    const mode = b.mode === 'km' ? 'km' : 'region';
    const n = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) && x >= lo && x <= hi ? x : null; };
    const perKm = n(b.perKm, 0.5, 500), min = n(b.min, 0, 1000), max = n(b.max, 0, 2000), factor = n(b.factor, 1, 3);
    if (perKm === null || min === null || max === null || factor === null) return res.status(400).json({ error: 'الأرقام غير صحيحة' });
    if (max < min) return res.status(400).json({ error: 'الحد الأقصى أقل من الأدنى' });
    try { await pool.query('UPDATE app_settings SET fee_mode=$1, fee_per_km=$2, fee_min=$3, fee_max=$4, fee_factor=$5, updated_at=NOW() WHERE id=1', [mode, perKm, min, max, factor]); }
    catch (e) { if (e.code === '42703') return res.status(503).json({ error: 'قاعدة البيانات لم تُحدَّث بعد' }); throw e; }
    settingsMemo.clear();
    res.json({ ok: true });
  }));
}
module.exports = { feeFor, forOrder, cfgFromRow, registerKmFeeRoutes };
