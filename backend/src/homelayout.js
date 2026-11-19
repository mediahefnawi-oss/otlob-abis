'use strict';
/**
 * The owner's design of the customer home: the order of the sections, which ones are hidden,
 * the shape of each service icon and how the services are laid out (grid or one row you swipe).
 * Stored as one JSON object in app_settings.home_layout; an empty object = the original home, exactly as before.
 */
const SECTIONS = ['ads', 'today', 'favorites', 'announce', 'services', 'marketOffers', 'makers', 'market', 'rides', 'trips', 'active', 'errand', 'nearby', 'top'];
const SHAPES = ['tile', 'rect', 'wide', 'round', 'text'];
const MODES = ['grid', 'row'];
const VIEWS = ['row', 'g3', 'g4', 'full'];   // how the service icons are laid out: swipe row / 3 per row / 4 per row / one per line
const BLOCK_ID = /^ban:[a-z0-9]{4,16}$/;
const SVC_KEY = /^[a-z0-9_]{1,40}$/;

/** Pure: validates what the owner sent. Returns the clean layout or null. */
function cleanLayout(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const okId = id => typeof id === 'string' && (SECTIONS.includes(id) || BLOCK_ID.test(id));
  const out = {};
  if (raw.order !== undefined) {
    if (!Array.isArray(raw.order) || raw.order.length > 60) return null;
    const seen = new Set();
    out.order = raw.order.filter(id => okId(id) && !seen.has(id) && seen.add(id));
  }
  if (raw.hidden !== undefined) {
    if (!Array.isArray(raw.hidden) || raw.hidden.length > 60) return null;
    out.hidden = [...new Set(raw.hidden.filter(okId))];
  }
  if (raw.mode !== undefined) { if (!MODES.includes(raw.mode)) return null; out.mode = raw.mode; }
  if (raw.view !== undefined) { if (!VIEWS.includes(raw.view)) return null; out.view = raw.view; }
  if (raw.svc !== undefined) {
    if (!raw.svc || typeof raw.svc !== 'object' || Array.isArray(raw.svc)) return null;
    const keys = Object.keys(raw.svc);
    if (keys.length > 40) return null;
    out.svc = {};
    for (const k of keys) {
      if (!SVC_KEY.test(k)) return null;
      const v = raw.svc[k];
      if (!v || typeof v !== 'object' || !SHAPES.includes(v.shape)) return null;
      out.svc[k] = { shape: v.shape };
    }
  }
  return out;
}

function register(app, { pool, auth, roles, asyncRoute, clearCaches }) {
  const admin = [auth, roles('admin')];
  app.get('/api/admin/home-layout', ...admin, asyncRoute(async (_req, res) => {
    let l = {};
    try { l = (await pool.query('SELECT home_layout FROM app_settings WHERE id=1')).rows[0].home_layout || {}; } catch { /* not migrated yet */ }
    res.json({ layout: l });
  }));
  app.put('/api/admin/home-layout', ...admin, asyncRoute(async (req, res) => {
    const c = cleanLayout((req.body || {}).layout);
    if (!c) return res.status(400).json({ error: 'تصميم الرئيسية غير صالح' });
    await pool.query('UPDATE app_settings SET home_layout=$1::jsonb, updated_at=NOW() WHERE id=1', [JSON.stringify(c)]);
    clearCaches();
    res.json({ layout: c });
  }));
}
module.exports = { cleanLayout, SECTIONS, SHAPES, MODES, VIEWS, register };
