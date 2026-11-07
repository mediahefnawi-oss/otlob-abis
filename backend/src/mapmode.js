'use strict';
/** The owner's switch for maps and live location (see schema.sql). Everything map-related asks this first. */
async function load(db) {
  try {
    const r = await db.query('SELECT map_enabled, map_required FROM app_settings WHERE id=1');
    const x = r.rows[0] || {};
    return { enabled: x.map_enabled !== false, required: x.map_required !== false };
  } catch { return { enabled: true, required: true }; } // not migrated yet
}
function registerMapModeRoutes(app, { pool, auth, roles, asyncRoute, settingsMemo }) {
  app.patch('/api/admin/map-mode', auth, roles('admin'), asyncRoute(async (req, res) => {
    const b = req.body || {};
    try { await pool.query('UPDATE app_settings SET map_enabled=$1, map_required=$2, updated_at=NOW() WHERE id=1', [b.enabled !== false, b.required !== false]); }
    catch (e) { if (e.code === '42703') return res.status(503).json({ error: 'قاعدة البيانات لم تُحدَّث بعد' }); throw e; }
    settingsMemo.clear();
    res.json({ ok: true });
  }));
}
module.exports = { load, registerMapModeRoutes };
