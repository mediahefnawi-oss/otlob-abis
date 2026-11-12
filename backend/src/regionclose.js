'use strict';
/**
 * Temporary closing of a delivery area (switch "regionClose"). While an area is closed its customers cannot send a delivery order and read the owner's
 * message instead; nothing else changes (accounts, prices, old orders). A closing with an end time reopens by itself, and the customers of the area get
 * a push when it reopens. With the switch OFF everything behaves exactly as before.
 */
const extrasLib = require('./extras');
const MAX_MSG = 200;
const MAX_NOTIFY = 500;

const fmtTime = t => { try { return new Date(t).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', weekday: 'long', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
const text = x => String(x.closed_message || '').trim() || `التوصيل متوقف مؤقتًا في منطقة ${x.name}${x.closed_until ? ` — يرجع إن شاء الله ${fmtTime(x.closed_until)}` : ''}`;
const isClosed = x => !!x && !!x.closed && !(x.closed_until && new Date(x.closed_until) <= new Date());

/** the closure that applies to a customer (null = open, or the switch is off) */
async function closure(db, userId) {
  try {
    if (!(await extrasLib.featureOn(db, 'regionClose'))) return null;
    const r = await db.query('SELECT g.id, g.name, g.closed, g.closed_message, g.closed_until FROM users u JOIN regions g ON g.id=u.region_id WHERE u.id=$1', [userId]);
    const x = r.rows[0];
    return isClosed(x) ? { regionId: String(x.id), name: x.name, message: text(x), until: x.closed_until ? new Date(x.closed_until).getTime() : null } : null;
  } catch { return null; } // not migrated yet: never block an order
}
/** throws the 409 the apps show to the customer */
async function assertOpen(db, userId, fail) {
  const c = await closure(db, userId);
  if (c) throw fail(409, c.message);
}
/** how a region is shown in the lists: the owner sees the stored fields, everyone else only the effective state */
function view(x, admin, switchOn) {
  const closed = switchOn && isClosed(x);
  return {
    closed,
    ...(closed ? { closedMessage: text(x), closedUntil: x.closed_until ? new Date(x.closed_until).getTime() : null } : {}),
    ...(admin ? { closedRaw: !!x.closed, closedText: x.closed_message || '', closedUntilRaw: x.closed_until ? new Date(x.closed_until).getTime() : null } : {}),
  };
}
/** a push to the customers of an area that works again */
async function notifyReopened(pool, pushToUsers, regionId, name) {
  try {
    const r = await pool.query("SELECT id FROM users WHERE role='customer' AND status='active' AND region_id=$1 ORDER BY id DESC LIMIT $2", [regionId, MAX_NOTIFY]);
    if (r.rowCount) await pushToUsers(r.rows.map(x => x.id), { title: 'رجع التوصيل في منطقتك 🛵', body: `التوصيل شغّال تاني في ${name}، اطلب دلوقتي`, tag: 'region-open-' + regionId, url: '/' });
  } catch { /* a failed push is not an error here */ }
}
/** closings whose end time has passed are switched off and announced (run by the watcher every minute) */
async function sweep(pool, pushToUsers) {
  try {
    if (!(await extrasLib.featureOn(pool, 'regionClose'))) return 0;
    const r = await pool.query('UPDATE regions SET closed=FALSE, closed_until=NULL, closed_message=\'\' WHERE closed AND closed_until IS NOT NULL AND closed_until <= NOW() RETURNING id, name');
    for (const x of r.rows) await notifyReopened(pool, pushToUsers, x.id, x.name);
    return r.rowCount;
  } catch { return 0; }
}
/** the owner's PATCH body -> the new stored values (throws {http,error} style via fail) */
function parsePatch(b, old, fail) {
  const out = { closed: old.closed, msg: old.closed_message, until: old.closed_until };
  if (b.closed !== undefined) out.closed = b.closed === true;
  if (b.closedMessage !== undefined) out.msg = String(b.closedMessage || '').trim().slice(0, MAX_MSG);
  if (b.closedUntil !== undefined) {
    if (b.closedUntil === null || b.closedUntil === '') out.until = null;
    else { const t = Number(b.closedUntil); if (!Number.isFinite(t) || t <= Date.now()) throw fail(400, 'وقت الرجوع لازم يكون في المستقبل'); out.until = new Date(t); }
  }
  if (!out.closed) { out.until = null; out.msg = ''; } // reopened: nothing is kept
  return out;
}

module.exports = { closure, assertOpen, view, isClosed, notifyReopened, sweep, parsePatch };
