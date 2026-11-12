'use strict';
/**
 * The owner's activity log. Every successful change made from the owner panel (anything that writes under /api/admin) is recorded with who,
 * when and what, in plain Arabic. Feature switches and the basic app settings carry an "undo": the route that changed them leaves the old
 * value in res.locals.undo and the owner can bring it back from the log screen. Nothing here can make a request fail.
 */
const extrasLib = require('./extras');
const KEEP = 500; // entries kept
const LABELS = [
  [/^\/api\/admin\/features/, 'مفاتيح الميزات'], [/^\/api\/admin\/settings/, 'إعدادات التطبيق'], [/^\/api\/admin\/services/, 'الأقسام'],
  [/^\/api\/admin\/regions/, 'المناطق'], [/^\/api\/admin\/route-prices/, 'أسعار المسارات'], [/^\/api\/admin\/ads/, 'الإعلانات'],
  [/^\/api\/admin\/coupons/, 'الكوبونات'], [/^\/api\/admin\/offers/, 'العروض'], [/^\/api\/admin\/providers/, 'المحلات والخدمات'],
  [/^\/api\/admin\/(couriers|supervisors)/, 'المناديب والمشرفين'], [/^\/api\/admin\/(users|customers)/, 'العملاء والحسابات'],
  [/^\/api\/admin\/update-notice/, 'إشعار التحديث'], [/^\/api\/admin\/courier-photos/, 'صور المناديب'], [/^\/api\/admin\/log/, 'سجل التغييرات'],
  [/^\/api\/admin\/ratings/, 'التقييمات'], [/^\/api\/admin\/wipe/, 'مسح البيانات'],
];
const VERB = { POST: 'إضافة / تنفيذ', PATCH: 'تعديل', PUT: 'تعديل', DELETE: 'حذف' };
const SECRET = /pass|token|secret|image|photo|icon|logo|audio|pin|key$/i;

const labelOf = path => (LABELS.find(([re]) => re.test(path)) || [null, 'إدارة التطبيق'])[1];
function cleanBody(b) {
  if (!b || typeof b !== 'object') return '';
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (SECRET.test(k) && k !== 'key') continue;
    if (v && typeof v === 'object') out[k] = Array.isArray(v) ? `[${v.length}]` : '{…}';
    else out[k] = typeof v === 'string' ? v.slice(0, 80) : v;
  }
  return JSON.stringify(out).slice(0, 600);
}
function summaryOf(method, path, body, undo, label) {
  if (undo && undo.type === 'feature') return `${undo.label || undo.key}: ${undo.now ? 'تشغيل' : 'إيقاف'}`;
  if (undo && undo.type === 'settings') return `تعديل: ${Object.keys(undo.patch).map(k => SETTING_NAMES[k] || k).join('، ')}`;
  return `${VERB[method] || 'تغيير'} — ${label}`;
}
const SETTING_NAMES = { appEnabled: 'تشغيل التطبيق', maintenanceMessage: 'رسالة الصيانة', announcement: 'إعلان الصفحة الرئيسية', autoAssign: 'التعيين التلقائي' };

async function record(pool, { method, path, status, auth, body, undo }) {
  try {
    if (!auth || auth.role !== 'admin' || status < 200 || status >= 300 || !['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) return;
    const u = await pool.query('SELECT name FROM users WHERE id=$1', [Number(auth.sub)]);
    const label = labelOf(path);
    await pool.query('INSERT INTO admin_log(admin_id, admin_name, method, path, label, summary, body, undo) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [Number(auth.sub), (u.rows[0] || {}).name || '', method, path.slice(0, 200), label, summaryOf(method, path, body, undo, label), cleanBody(body), undo ? JSON.stringify(undo) : null]);
    await pool.query('DELETE FROM admin_log WHERE id < (SELECT COALESCE(MIN(id), 0) FROM (SELECT id FROM admin_log ORDER BY id DESC LIMIT $1) x)', [KEEP]);
  } catch (e) { if (e && e.code !== '42P01') console.error('admin log:', e.message); }
}
/** mount before the routes: records every successful write under /api/admin once the response is sent */
function middleware(pool) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.path.startsWith('/api/admin')) {
      res.on('finish', () => { record(pool, { method: req.method, path: req.path, status: res.statusCode, auth: req.auth, body: req.body, undo: res.locals && res.locals.undo }); });
    }
    next();
  };
}

function register(app, { pool, auth, roles, asyncRoute, positiveId, clearCaches, settingsClear }) {
  const admin = [auth, roles('admin')];
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => { try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; } });
  app.get('/api/admin/log', ...admin, guard(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 60, 1), 200);
    let r;
    try { r = await pool.query('SELECT id, at, admin_name, label, summary, body, undo IS NOT NULL AS can_undo, undone_at FROM admin_log ORDER BY id DESC LIMIT $1', [limit]); }
    catch (e) { if (e.code === '42P01') return res.json({ entries: [] }); throw e; }
    res.set('Cache-Control', 'no-store');
    res.json({ entries: r.rows.map(x => ({ id: String(x.id), at: new Date(x.at).getTime(), admin: x.admin_name, label: x.label, summary: x.summary, details: x.body, canUndo: x.can_undo && !x.undone_at, undone: !!x.undone_at })) });
  }));
  app.post('/api/admin/log/:id/undo', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    const f = await pool.query('SELECT undo, undone_at FROM admin_log WHERE id=$1', [id]);
    if (!f.rowCount || !f.rows[0].undo) throw fail(404, 'التغيير ده مفيهوش تراجع');
    if (f.rows[0].undone_at) throw fail(409, 'التغيير ده اتراجع عنه قبل كده');
    const u = f.rows[0].undo;
    if (u.type === 'feature') {
      await pool.query("UPDATE app_settings SET features = COALESCE(features, '{}'::jsonb) || jsonb_build_object($1::text, $2::boolean), updated_at=NOW() WHERE id=1", [u.key, !!u.before]);
    } else if (u.type === 'settings') {
      const col = { appEnabled: 'app_enabled', maintenanceMessage: 'maintenance_message', announcement: 'announcement', autoAssign: 'auto_assign' };
      const keys = Object.keys(u.patch).filter(k => col[k]);
      if (!keys.length) throw fail(409, 'لا يمكن التراجع');
      await pool.query(`UPDATE app_settings SET ${keys.map((k, i) => `${col[k]}=$${i + 1}`).join(',')}, updated_at=NOW() WHERE id=1`, keys.map(k => u.patch[k]));
    } else throw fail(409, 'لا يمكن التراجع');
    await pool.query('UPDATE admin_log SET undone_at=NOW() WHERE id=$1', [id]);
    if (clearCaches) clearCaches();
    if (settingsClear) settingsClear();
    res.json({ ok: true });
  }));
}
module.exports = { middleware, record, register, labelOf, cleanBody };
