'use strict';
/**
 * Open / close of NEW orders, by the owner (or a manager with the orders permission).
 *   key '*'   = the whole app (browsing still works, nothing new can be ordered)
 *   key <svc> = one service: restaurant, supermarket, pharmacy, clinic, lab, store, maker, errand ... plus 'market', 'ride' and 'trips'
 * A closing may carry a message and an end time (it opens by itself). Orders already running are never touched.
 */
const SPECIAL = { '*': 'كل التطبيق', market: 'طلبات ماركت', ride: 'التوصيلة', trips: 'رحلات المحافظات' };
const MSG_MAX = 200;
const KEY_RE = /^[a-z0-9_*-]{1,40}$/;

let cache = { at: 0, rows: new Map() };
const TTL = 3000;
const invalidate = () => { cache.at = 0; };

/** Pure: is this row closed right now? */
const isClosed = (x, now = Date.now()) => !!x && !!x.closed && !(x.until && new Date(x.until).getTime() <= now);
const fmt = t => { try { return new Date(t).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', weekday: 'long', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
/** Pure: the text shown to the customer */
const messageOf = (x, label) => String((x && x.message) || '').trim() || `${label || 'الخدمة'} متوقفة مؤقتًا${x && x.until ? ` — ترجع إن شاء الله ${fmt(x.until)}` : ''}`;
const labelOf = (key, services) => SPECIAL[key] || ((services || []).find(s => s.key === key) || {}).label || key;

async function load(db) {
  if (Date.now() - cache.at < TTL) return cache.rows;
  try {
    const r = await db.query('SELECT key, closed, message, until FROM order_gates WHERE closed');
    cache = { at: Date.now(), rows: new Map(r.rows.map(x => [x.key, x])) };
  } catch { cache = { at: Date.now(), rows: new Map() }; } // not migrated yet: never block an order
  return cache.rows;
}
/** The first closing that applies to these service keys (the whole app first), or null. */
async function check(db, keys, services) {
  const rows = await load(db);
  for (const k of ['*', ...(keys || [])]) {
    const x = rows.get(k);
    if (isClosed(x)) return { key: k, message: messageOf(x, labelOf(k, services)), until: x.until ? new Date(x.until).getTime() : null };
  }
  return null;
}
/** throws the 409 the apps show */
async function assertOpen(db, keys, fail, services) {
  const c = await check(db, keys, services);
  if (c) throw fail(409, c.message);
}

function register(app, { pool, auth, roles, asyncRoute, services }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => { try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; } });
  const admin = [auth, roles('admin')];
  const list = async () => { try { await services.ensure(pool); return services.listJson(); } catch { return []; } };

  /** what the apps need: which services are closed right now and the message */
  app.get('/api/gates', auth, guard(async (_req, res) => {
    invalidate();
    const rows = await load(pool), svc = await list(), out = {};
    for (const [k, x] of rows) if (isClosed(x)) out[k] = { message: messageOf(x, labelOf(k, svc)), until: x.until ? new Date(x.until).getTime() : null };
    res.set('Cache-Control', 'no-store');
    res.json({ closed: out });
  }));
  app.get('/api/admin/gates', ...admin, guard(async (_req, res) => {
    const svc = await list();
    const r = await pool.query('SELECT key, closed, message, until FROM order_gates');
    const by = new Map(r.rows.map(x => [x.key, x]));
    const keys = ['*', ...svc.filter(s => s.active !== false).map(s => s.key), 'market', 'ride', 'trips'];
    const seen = new Set();
    res.json({ gates: keys.filter(k => !seen.has(k) && seen.add(k)).map(k => { const x = by.get(k); return { key: k, label: labelOf(k, svc), closed: isClosed(x), rawClosed: !!(x && x.closed), message: x ? x.message : '', until: x && x.until ? new Date(x.until).getTime() : null }; }) });
  }));
  app.put('/api/admin/gates/:key', ...admin, guard(async (req, res) => {
    const key = String(req.params.key || '');
    if (!KEY_RE.test(key)) throw fail(400, 'خدمة غير معروفة');
    const svc = await list();
    if (!SPECIAL[key] && !svc.some(s => s.key === key)) throw fail(404, 'خدمة غير معروفة');
    const b = req.body || {};
    if (typeof b.closed !== 'boolean') throw fail(400, 'حدد فتح أو قفل');
    const message = String(b.message || '').trim().slice(0, MSG_MAX);
    let until = null;
    if (b.closed && b.until) { const t = new Date(b.until); if (isNaN(t.getTime()) || t.getTime() <= Date.now()) throw fail(400, 'وقت الفتح لازم يكون في المستقبل'); until = t.toISOString(); }
    await pool.query(`INSERT INTO order_gates(key, closed, message, until, updated_at) VALUES($1,$2,$3,$4,NOW())
      ON CONFLICT (key) DO UPDATE SET closed=$2, message=$3, until=$4, updated_at=NOW()`, [key, b.closed, b.closed ? message : '', until]);
    invalidate();
    res.json({ ok: true });
  }));
}
module.exports = { check, assertOpen, isClosed, messageOf, labelOf, invalidate, register, SPECIAL };
