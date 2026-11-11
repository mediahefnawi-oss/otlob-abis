'use strict';
/**
 * Two small background jobs, each behind its own owner switch:
 *  - "lateAlert": an order that sits too long in a stage sends ONE notification (to the owner and to the shop) per stage.
 *  - "dailyReport": every night (22:00 Cairo time) the owner gets one notification with the day's numbers.
 */
const extrasLib = require('./extras');

// minutes an order may stay in a stage before the alert, and who to tell
const STAGES = {
  pending: { mins: 15, text: 'لسه ما اتقبلش', shop: true },
  accepted: { mins: 45, text: 'بيتحضّر من فترة طويلة', shop: true },
  ready: { mins: 20, text: 'جاهز وما استلمهوش مندوب', shop: true },
  on_the_way: { mins: 60, text: 'مع المندوب من أكتر من ساعة', shop: false },
};

const adminIds = async pool => (await pool.query("SELECT id FROM users WHERE role='admin' AND status='active'")).rows.map(x => x.id);

/** One pass. Returns how many alerts were sent. */
async function lateSweep(pool, notify) {
  if (!(await extrasLib.featureOn(pool, 'lateAlert'))) return 0;
  let sent = 0;
  const admins = await adminIds(pool);
  for (const [stage, cfg] of Object.entries(STAGES)) {
    const r = await pool.query(`SELECT o.id, o.order_number, p.name AS pname, p.owner_user_id FROM orders o LEFT JOIN providers p ON p.id=o.provider_id
      WHERE o.status=$1 AND o.updated_at < NOW() - ($2 || ' minutes')::interval AND o.created_at > NOW() - INTERVAL '6 hours'
        AND (o.data->>'scheduledFor' IS NULL OR (o.data->>'scheduledFor')::bigint < (EXTRACT(EPOCH FROM NOW())*1000)::bigint - ($2::int * 60000))
        AND NOT EXISTS (SELECT 1 FROM late_alerts l WHERE l.order_id=o.id AND l.stage=$1) LIMIT 50`, [stage, String(cfg.mins)]);
    for (const o of r.rows) {
      const mark = await pool.query('INSERT INTO late_alerts(order_id, stage) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING order_id', [o.id, stage]);
      if (!mark.rowCount) continue;
      const who = [...admins, ...(cfg.shop && o.owner_user_id ? [o.owner_user_id] : [])];
      await notify(who, { title: `طلب متأخر ⏰ #${o.order_number}`, body: `${o.pname || 'طلب'}: ${cfg.text} (من ${cfg.mins} دقيقة)`, tag: 'late-' + o.id, url: '/', requireInteraction: true });
      sent++;
    }
  }
  return sent;
}

/** The numbers for one Cairo calendar day (default today). */
async function dayStats(pool, day) {
  const d = day || (await pool.query("SELECT (NOW() AT TIME ZONE 'Africa/Cairo')::date AS d")).rows[0].d;
  const t = await pool.query(`SELECT COUNT(*) FILTER (WHERE status='delivered')::int AS delivered, COUNT(*) FILTER (WHERE status IN ('cancelled','rejected'))::int AS lost,
      COUNT(*)::int AS total, COALESCE(SUM(total) FILTER (WHERE status='delivered'),0)::float AS revenue
    FROM orders WHERE (created_at AT TIME ZONE 'Africa/Cairo')::date = $1::date`, [d]);
  const top = await pool.query(`SELECT p.name, COUNT(*)::int AS n FROM orders o JOIN providers p ON p.id=o.provider_id
    WHERE o.status='delivered' AND (o.created_at AT TIME ZONE 'Africa/Cairo')::date = $1::date GROUP BY p.name ORDER BY n DESC, p.name LIMIT 1`, [d]);
  const nu = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='customer' AND (created_at AT TIME ZONE 'Africa/Cairo')::date = $1::date", [d]);
  return { day: typeof d === 'string' ? d : new Date(d).toISOString().slice(0, 10), ...t.rows[0], topShop: top.rows[0] ? top.rows[0].name : '', topShopOrders: top.rows[0] ? top.rows[0].n : 0, newCustomers: nu.rows[0].n };
}
const reportText = s => `${s.delivered} طلب اتسلّم، إيراد ${Math.round(s.revenue)} ج.م${s.lost ? `، ${s.lost} ملغي/مرفوض` : ''}${s.topShop ? `. الأكثر طلبًا: ${s.topShop} (${s.topShopOrders})` : ''}${s.newCustomers ? `. عملاء جدد: ${s.newCustomers}` : ''}`;

/** Sends today's report once, from 22:00 Cairo time on. Returns true when it was sent. */
async function dailyReport(pool, notify, { force = false } = {}) {
  if (!(await extrasLib.featureOn(pool, 'dailyReport'))) return false;
  const now = (await pool.query("SELECT (NOW() AT TIME ZONE 'Africa/Cairo')::date AS d, EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Africa/Cairo')::int AS h")).rows[0];
  if (!force && now.h < 22) return false;
  const mark = await pool.query('INSERT INTO report_log(day) VALUES($1::date) ON CONFLICT DO NOTHING RETURNING day', [now.d]);
  if (!mark.rowCount) return false;
  const s = await dayStats(pool, now.d);
  await notify(await adminIds(pool), { title: 'تقرير النهارده 📊', body: reportText(s), tag: 'daily-report', url: '/' });
  return true;
}

let lastPurge = 0;
function start({ pool, pushToUsers, everyMs = 60 * 1000 }) {
  const notify = async (ids, payload) => { try { await pushToUsers(ids, payload); } catch { /* a failed push is not an error here */ } };
  const run = async () => {
    try { await lateSweep(pool, notify); await dailyReport(pool, notify); if (Date.now() - lastPurge > 6 * 3600 * 1000) { lastPurge = Date.now(); await require('./voice').purge(pool); } }
    catch (e) { if (e && e.code !== '42P01') console.warn('watch:', e.message); }
  };
  setTimeout(run, 30 * 1000).unref();
  const t = setInterval(run, everyMs); t.unref();
  return t;
}
module.exports = { start, lateSweep, dailyReport, dayStats, reportText };
