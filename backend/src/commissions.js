'use strict';
/**
 * Commissions, counter resets, audit log and the login picture.
 *
 *  - Rules (percent or fixed) are stored in PostgreSQL and edited from the owner's panel only; nothing is hard-coded.
 *    Most specific wins: provider > type > all (couriers: courier > all). The newest rule whose start date has passed is used.
 *  - A commission is written ONCE when an order is delivered / a booking is completed (unique index = never twice).
 *    It keeps a snapshot of the rule used, so editing a rule later never changes history.
 *  - Cancellations and returns are separate negative adjustment rows (documented, never edits).
 *  - Counter resets (sales / orders / profit) only move a "since" line used by the displayed counters.
 *    Orders, invoices, commissions and dues are never touched, so reports and cumulative totals stay intact.
 */
const TZ = 'Africa/Cairo';
const services = require('./services');
const PROVIDER_TYPES = { includes: x => services.isKnown(x), get length() { return services.keys().length; } };
const COUNTERS = ['sales', 'orders', 'profit'];
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* ---------- Cairo time helpers (Egypt observes daylight saving time) ---------- */
function tzOffsetMs(utcMs) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs))) p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}
function cairoToUtc(y, m, d, hh, mm) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const t = guess - tzOffsetMs(guess);
  return guess - tzOffsetMs(t);
}
function cairoDate(utcMs) {
  const o = new Date(utcMs + tzOffsetMs(utcMs));
  return { y: o.getUTCFullYear(), m: o.getUTCMonth() + 1, d: o.getUTCDate() };
}
/** Next run (UTC ms) strictly after `afterMs`, or null. s = { frequency, run_time, day_of_week, day_of_month, run_date } */
function nextRun(s, afterMs) {
  const [hh, mm] = String(s.run_time || '00:00').split(':').map(Number);
  if (s.frequency === 'once') {
    const rd = s.run_date instanceof Date ? s.run_date.toISOString().slice(0, 10) : String(s.run_date || '').slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(rd);
    if (!m) return null;
    const t = cairoToUtc(Number(m[1]), Number(m[2]), Number(m[3]), hh, mm);
    return t > afterMs ? t : null;
  }
  const start = cairoDate(afterMs);
  for (let i = 0; i < 400; i++) {
    const dt = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate(), dow = dt.getUTCDay();
    let ok = s.frequency === 'daily';
    if (s.frequency === 'weekly') ok = dow === Number(s.day_of_week);
    if (s.frequency === 'monthly') ok = d === Math.min(Number(s.day_of_month), new Date(Date.UTC(y, m, 0)).getUTCDate());
    if (!ok) continue;
    const t = cairoToUtc(y, m, d, hh, mm);
    if (t > afterMs) return t;
  }
  return null;
}

/* ---------- rules ---------- */
const SPECIFICITY = { all: 1, type: 2, courier: 3, provider: 3 };
function pickRule(rules) {
  return [...rules].sort((a, b) =>
    (SPECIFICITY[b.scope] - SPECIFICITY[a.scope]) || (new Date(b.effective_from) - new Date(a.effective_from)) || (Number(b.id) - Number(a.id)))[0] || null;
}
function computeAmount(rule, base) {
  if (!rule) return 0;
  if (Number(base) < Number(rule.min_amount || 0)) return 0;
  return round2(rule.kind === 'percent' ? (Number(base) * Number(rule.value)) / 100 : Number(rule.value));
}
const RULES_SQL = `SELECT * FROM commission_rules WHERE target=$1 AND active=TRUE AND effective_from <= $2::timestamptz AND (
  scope='all' OR (scope='type' AND provider_type=$3::text) OR (scope='provider' AND provider_id=$4::bigint) OR (scope='courier' AND courier_user_id=$5::bigint))`;
async function ruleFor(db, target, when, type, providerId, courierId) {
  const r = await db.query(RULES_SQL, [target, when, type || null, providerId || null, courierId || null]);
  return pickRule(r.rows);
}
const snapshot = r => ({ id: String(r.id), scope: r.scope, kind: r.kind, value: Number(r.value), minAmount: Number(r.min_amount), effectiveFrom: new Date(r.effective_from).getTime() });

const INSERT_ORDER_ENTRY = `INSERT INTO commission_entries(entry_type, kind, order_id, provider_id, courier_user_id, base_amount, amount, rule_id, rule_snapshot)
  VALUES('accrual',$1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (order_id, kind) WHERE entry_type='accrual' AND order_id IS NOT NULL DO NOTHING`;
const INSERT_APPT_ENTRY = `INSERT INTO commission_entries(entry_type, kind, appointment_id, provider_id, base_amount, amount, rule_id, rule_snapshot)
  VALUES('accrual','provider',$1,$2,$3,$4,$5,$6) ON CONFLICT (appointment_id, kind) WHERE entry_type='accrual' AND appointment_id IS NOT NULL DO NOTHING`;

/** Runs inside the caller's transaction but can never break it: a failure rolls back to a savepoint and is logged. */
async function safely(db, label, fn) {
  await db.query('SAVEPOINT comm_hook');
  try { await fn(); await db.query('RELEASE SAVEPOINT comm_hook'); }
  catch (e) { await db.query('ROLLBACK TO SAVEPOINT comm_hook').catch(() => {}); console.error(`commission hook (${label}) failed:`, e.message); }
}
async function onOrderDelivered(db, o) {
  await safely(db, `order ${o.id}`, async () => {
    await db.query('UPDATE orders SET delivered_at=COALESCE(delivered_at, NOW()) WHERE id=$1', [o.id]);
    const d = o.data || {};
    const when = new Date();
    let type = null;
    if (!o.provider_id) type = 'custom'; // اطلب إيه نجيبهولك: عمولة مستقلة على رسوم التوصيل التي كتبها المندوب
    if (o.provider_id) {
      type = ((await db.query('SELECT type FROM providers WHERE id=$1', [o.provider_id])).rows[0] || {}).type || null;
      const base = Number(d.subtotal) || 0;
      const rule = await ruleFor(db, 'provider', when, type, o.provider_id, null);
      const amount = computeAmount(rule, base);
      if (rule && amount > 0) await db.query(INSERT_ORDER_ENTRY, ['provider', o.id, o.provider_id, null, base, amount, rule.id, JSON.stringify(snapshot(rule))]);
    }
    if (o.courier_user_id) {
      const base = Number(d.deliveryFee) || 0;
      const rule = await ruleFor(db, 'courier', when, type, o.provider_id, o.courier_user_id);
      const amount = computeAmount(rule, base);
      if (rule && amount > 0) await db.query(INSERT_ORDER_ENTRY, ['courier', o.id, o.provider_id || null, o.courier_user_id, base, amount, rule.id, JSON.stringify(snapshot(rule))]);
    }
  });
}
async function onApptCompleted(db, a) {
  await safely(db, `appointment ${a.id}`, async () => {
    await db.query('UPDATE appointments SET completed_at=COALESCE(completed_at, NOW()) WHERE id=$1', [a.id]);
    const type = ((await db.query('SELECT type FROM providers WHERE id=$1', [a.provider_id])).rows[0] || {}).type || 'clinic';
    const base = Number(a.fee) || 0;
    const rule = await ruleFor(db, 'provider', new Date(), type, a.provider_id, null);
    const amount = computeAmount(rule, base);
    if (rule && amount > 0) await db.query(INSERT_APPT_ENTRY, [a.id, a.provider_id, base, amount, rule.id, JSON.stringify(snapshot(rule))]);
  });
}

/* ---------- counters ---------- */
const BASE_SQL = c => `COALESCE((SELECT MAX(r.reset_at) FROM counter_resets r WHERE r.reset_at <= NOW() AND '${c}' = ANY(r.counters)
  AND (r.scope='all' OR (r.scope='type' AND r.provider_type=p.type) OR (r.scope='provider' AND r.provider_id=p.id))), 'epoch'::timestamptz)`;
const COUNTERS_SQL = `WITH base AS (
  SELECT p.id, p.type, p.name, ${BASE_SQL('sales')} AS b_sales, ${BASE_SQL('orders')} AS b_orders, ${BASE_SQL('profit')} AS b_profit
  FROM providers p WHERE p.deleted_at IS NULL AND ($1::bigint IS NULL OR p.owner_user_id = $1::bigint)
)
SELECT b.id, b.type, b.name, b.b_sales, b.b_orders, b.b_profit,
  COALESCE((SELECT SUM((o.data->>'subtotal')::numeric) FROM orders o WHERE o.provider_id=b.id AND o.status='delivered' AND o.delivered_at > b.b_sales), 0)
  + COALESCE((SELECT SUM(a.fee) FROM appointments a WHERE a.provider_id=b.id AND a.status='completed' AND a.completed_at > b.b_sales), 0) AS sales,
  (SELECT COUNT(*) FROM orders o WHERE o.provider_id=b.id AND o.created_at > b.b_orders)
  + (SELECT COUNT(*) FROM appointments a WHERE a.provider_id=b.id AND a.created_at > b.b_orders) AS orders,
  (SELECT COUNT(*) FROM orders o WHERE o.provider_id=b.id AND o.status='delivered' AND o.delivered_at > b.b_orders)
  + (SELECT COUNT(*) FROM appointments a WHERE a.provider_id=b.id AND a.status='completed' AND a.completed_at > b.b_orders) AS done,
  COALESCE((SELECT SUM(e.amount) FROM commission_entries e WHERE e.provider_id=b.id AND e.kind='provider' AND e.created_at > b.b_profit), 0) AS commission,
  COALESCE((SELECT SUM(e.amount) FROM commission_entries e WHERE e.provider_id=b.id AND e.kind='courier' AND e.created_at > b.b_profit), 0) AS courier_cut
FROM base b ORDER BY b.id`;
const CUSTOM_SQL = `SELECT
  (SELECT COUNT(*) FROM orders o WHERE o.provider_id IS NULL AND o.created_at > COALESCE((SELECT MAX(reset_at) FROM counter_resets WHERE reset_at <= NOW() AND scope='all' AND 'orders'=ANY(counters)), 'epoch'::timestamptz)) AS orders,
  COALESCE((SELECT SUM(e.amount) FROM commission_entries e WHERE e.provider_id IS NULL AND e.kind='courier' AND e.created_at > COALESCE((SELECT MAX(reset_at) FROM counter_resets WHERE reset_at <= NOW() AND scope='all' AND 'profit'=ANY(counters)), 'epoch'::timestamptz)), 0) AS courier_cut`;
const n = v => Number(v) || 0;
async function computeCounters(db, ownerId) {
  const rows = (await db.query(COUNTERS_SQL, [ownerId || null])).rows;
  const providers = {}; const types = {};
  const totals = { sales: 0, orders: 0, done: 0, commission: 0, courierCut: 0, profit: 0 };
  const add = (t, x) => { for (const k of Object.keys(t)) t[k] = round2(t[k] + x[k]); };
  for (const r of rows) {
    const x = { sales: n(r.sales), orders: n(r.orders), done: n(r.done), commission: n(r.commission), courierCut: n(r.courier_cut) };
    x.profit = round2(x.commission + x.courierCut);
    providers[r.id] = { ...x, net: round2(x.sales - x.commission), type: r.type, name: r.name, since: { sales: new Date(r.b_sales).getTime(), orders: new Date(r.b_orders).getTime(), profit: new Date(r.b_profit).getTime() } };
    types[r.type] = types[r.type] || { sales: 0, orders: 0, done: 0, commission: 0, courierCut: 0, profit: 0 };
    add(types[r.type], x); add(totals, x);
  }
  let custom = { orders: 0, courierCut: 0 };
  if (!ownerId) {
    const c = (await db.query(CUSTOM_SQL)).rows[0];
    custom = { orders: n(c.orders), courierCut: n(c.courier_cut) };
    totals.orders += custom.orders; totals.courierCut = round2(totals.courierCut + custom.courierCut); totals.profit = round2(totals.profit + custom.courierCut);
  }
  return { providers, types, totals, custom, now: Date.now() };
}

module.exports = function registerCommissionRoutes(app, { pool, auth, roles, asyncRoute, positiveId }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; }
  });
  async function withTx(fn) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; }
    catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  }
  const audit = (db, actorId, action, entity, entityId, before, after, note = '') => db.query(
    `INSERT INTO audit_log(actor_user_id, actor_name, action, entity, entity_id, before, after, note)
     VALUES($1::bigint, COALESCE((SELECT name FROM users WHERE id=$1::bigint), 'النظام'), $2, $3, $4, $5, $6, $7)`,
    [actorId || null, action, entity, String(entityId || ''), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, String(note || '').slice(0, 300)]);
  const admin = [auth, roles('admin')];
  const me = req => Number(req.auth.sub);

  /* ---------- rules ---------- */
  const ruleJson = r => ({
    id: String(r.id), target: r.target, scope: r.scope, providerType: r.provider_type || undefined, providerId: r.provider_id ? String(r.provider_id) : undefined,
    courierUserId: r.courier_user_id ? String(r.courier_user_id) : undefined, kind: r.kind, value: Number(r.value), minAmount: Number(r.min_amount),
    active: r.active, effectiveFrom: new Date(r.effective_from).getTime(), note: r.note, updatedAt: new Date(r.updated_at).getTime(),
  });
  const parseTime = (v, fallback) => {
    if (v === undefined || v === null || v === '') return fallback;
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v)); // a plain date = midnight in Cairo
    if (day) return new Date(cairoToUtc(Number(day[1]), Number(day[2]), Number(day[3]), 0, 0));
    const t = typeof v === 'number' ? v : Date.parse(v);
    if (!Number.isFinite(t)) throw fail(400, 'تاريخ السريان غير صالح');
    return new Date(t);
  };
  async function normalizeRule(db, b, old) {
    await services.ensure(db);
    const o = old || {};
    const target = old ? old.target : String(b.target || '');
    if (!['provider', 'courier'].includes(target)) throw fail(400, 'حدد هل القاعدة لمقدم الخدمة أم للمندوب');
    const scope = b.scope === undefined ? o.scope : String(b.scope);
    const allowed = target === 'provider' ? ['all', 'type', 'provider'] : ['all', 'courier', 'type'];
    if (!allowed.includes(scope)) throw fail(400, 'نطاق القاعدة غير صالح');
    const kind = b.kind === undefined ? o.kind : String(b.kind);
    if (!['percent', 'fixed'].includes(kind)) throw fail(400, 'نوع العمولة: نسبة أو مبلغ ثابت');
    const value = b.value === undefined ? Number(o.value) : Number(b.value);
    if (!Number.isFinite(value) || value < 0 || (kind === 'percent' && value > 100) || value > 100000) throw fail(400, kind === 'percent' ? 'النسبة بين 0 و100' : 'قيمة غير صالحة');
    const min = b.minAmount === undefined ? Number(o.min_amount || 0) : Number(b.minAmount);
    if (!Number.isFinite(min) || min < 0) throw fail(400, 'الحد الأدنى غير صالح');
    let ptype = null, pid = null, cid = null;
    if (scope === 'type') {
      ptype = b.providerType === undefined ? o.provider_type : String(b.providerType);
      if (target === 'courier' ? ptype !== 'custom' : !PROVIDER_TYPES.includes(ptype)) throw fail(400, 'اختر القسم');
    }
    if (scope === 'provider') {
      pid = b.providerId === undefined ? o.provider_id : positiveId(b.providerId);
      if (!pid || !(await db.query('SELECT 1 FROM providers WHERE id=$1', [pid])).rowCount) throw fail(400, 'اختر مقدم الخدمة');
    }
    if (scope === 'courier') {
      cid = b.courierUserId === undefined ? o.courier_user_id : positiveId(b.courierUserId);
      if (!cid || !(await db.query("SELECT 1 FROM users WHERE id=$1 AND role='courier'", [cid])).rowCount) throw fail(400, 'اختر المندوب');
    }
    return {
      target, scope, ptype, pid, cid, kind, value: round2(value), min: round2(min),
      active: b.active === undefined ? (old ? old.active : true) : Boolean(b.active),
      from: parseTime(b.effectiveFrom, old ? new Date(old.effective_from) : new Date()),
      note: b.note === undefined ? (o.note || '') : String(b.note).slice(0, 200),
    };
  }
  app.get('/api/admin/commissions/rules', ...admin, asyncRoute(async (_req, res) => {
    const r = await pool.query('SELECT * FROM commission_rules ORDER BY target, scope, id');
    res.json({ rules: r.rows.map(ruleJson) });
  }));
  app.post('/api/admin/commissions/rules', ...admin, guard(async (req, res) => {
    const out = await withTx(async db => {
      const v = await normalizeRule(db, req.body || {}, null);
      const r = await db.query(`INSERT INTO commission_rules(target, scope, provider_type, provider_id, courier_user_id, kind, value, min_amount, active, effective_from, note, created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [v.target, v.scope, v.ptype, v.pid, v.cid, v.kind, v.value, v.min, v.active, v.from, v.note, me(req)]);
      await audit(db, me(req), 'rule.create', 'commission_rule', r.rows[0].id, null, ruleJson(r.rows[0]));
      return r.rows[0];
    });
    res.status(201).json({ rule: ruleJson(out) });
  }));
  app.patch('/api/admin/commissions/rules/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف القاعدة غير صالح');
    const out = await withTx(async db => {
      const f = await db.query('SELECT * FROM commission_rules WHERE id=$1 FOR UPDATE', [id]);
      if (!f.rowCount) throw fail(404, 'القاعدة غير موجودة');
      const v = await normalizeRule(db, req.body || {}, f.rows[0]);
      const r = await db.query(`UPDATE commission_rules SET scope=$1, provider_type=$2, provider_id=$3, courier_user_id=$4, kind=$5, value=$6, min_amount=$7, active=$8,
        effective_from=$9, note=$10, updated_at=NOW() WHERE id=$11 RETURNING *`, [v.scope, v.ptype, v.pid, v.cid, v.kind, v.value, v.min, v.active, v.from, v.note, id]);
      await audit(db, me(req), 'rule.update', 'commission_rule', id, ruleJson(f.rows[0]), ruleJson(r.rows[0]));
      return r.rows[0];
    });
    res.json({ rule: ruleJson(out) });
  }));
  app.delete('/api/admin/commissions/rules/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف القاعدة غير صالح');
    await withTx(async db => {
      const r = await db.query('DELETE FROM commission_rules WHERE id=$1 RETURNING *', [id]);
      if (!r.rowCount) throw fail(404, 'القاعدة غير موجودة');
      await audit(db, me(req), 'rule.delete', 'commission_rule', id, ruleJson(r.rows[0]), null);
    });
    res.json({ ok: true });
  }));

  /* ---------- ledger, reports, balances ---------- */
  const entryJson = e => ({
    id: String(e.id), type: e.entry_type, kind: e.kind, orderId: e.order_id ? String(e.order_id) : undefined, appointmentId: e.appointment_id ? String(e.appointment_id) : undefined,
    providerId: e.provider_id ? String(e.provider_id) : undefined, courierId: e.courier_user_id ? String(e.courier_user_id) : undefined,
    base: Number(e.base_amount), amount: Number(e.amount), rule: e.rule_snapshot, parentId: e.parent_id ? String(e.parent_id) : undefined,
    note: e.note, status: e.status, createdAt: new Date(e.created_at).getTime(),
  });
  const dayStart = (s, plusDays = 0) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plusDays));
    return new Date(cairoToUtc(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), 0, 0));
  };
  app.get('/api/admin/commissions/report', ...admin, guard(async (req, res) => {
    const period = req.query.period === 'month' ? 'month' : 'day';
    const from = dayStart(req.query.from) || new Date(Date.now() - 30 * 86400000);
    const to = dayStart(req.query.to, 1) || new Date(Date.now() + 86400000);
    const r = await pool.query(`SELECT to_char(date_trunc('${period}', created_at AT TIME ZONE 'Africa/Cairo'), 'YYYY-MM-DD') AS period, kind,
        COUNT(*) FILTER (WHERE entry_type='accrual') AS cnt,
        COALESCE(SUM(base_amount) FILTER (WHERE entry_type='accrual'), 0) AS base,
        COALESCE(SUM(amount) FILTER (WHERE entry_type='accrual'), 0) AS gross,
        COALESCE(SUM(amount) FILTER (WHERE entry_type='adjustment'), 0) AS adjustments,
        COALESCE(SUM(amount), 0) AS net
      FROM commission_entries WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz GROUP BY 1, 2 ORDER BY 1 DESC, 2`, [from, to]);
    res.json({ period, rows: r.rows.map(x => ({ period: x.period, kind: x.kind, count: Number(x.cnt), base: Number(x.base), gross: Number(x.gross), adjustments: Number(x.adjustments), net: Number(x.net) })) });
  }));
  app.get('/api/admin/commissions/overview', ...admin, asyncRoute(async (_req, res) => {
    const t = await pool.query(`SELECT kind, COALESCE(SUM(amount) FILTER (WHERE entry_type='accrual'),0) AS gross, COALESCE(SUM(amount) FILTER (WHERE entry_type='adjustment'),0) AS adj,
        COALESCE(SUM(amount),0) AS net, COALESCE(SUM(amount) FILTER (WHERE status='due'),0) AS due, COALESCE(SUM(amount) FILTER (WHERE status='settled'),0) AS settled
      FROM commission_entries GROUP BY kind`);
    const b = await pool.query(`SELECT e.kind, e.provider_id, e.courier_user_id, COALESCE(p.name, u.name, '—') AS name,
        COALESCE(SUM(e.amount) FILTER (WHERE e.status='due'),0) AS due, COALESCE(SUM(e.amount) FILTER (WHERE e.status='settled'),0) AS settled, COUNT(*) FILTER (WHERE e.entry_type='accrual') AS cnt
      FROM commission_entries e LEFT JOIN providers p ON e.kind='provider' AND p.id=e.provider_id LEFT JOIN users u ON e.kind='courier' AND u.id=e.courier_user_id
      GROUP BY e.kind, e.provider_id, e.courier_user_id, p.name, u.name ORDER BY due DESC`);
    const m = await pool.query(`SELECT COALESCE(SUM(amount),0) AS net FROM commission_entries WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo'`);
    res.json({
      totals: t.rows.map(x => ({ kind: x.kind, gross: Number(x.gross), adjustments: Number(x.adj), net: Number(x.net), due: Number(x.due), settled: Number(x.settled) })),
      month: Number(m.rows[0].net),
      balances: b.rows.map(x => ({ kind: x.kind, id: String(x.kind === 'provider' ? x.provider_id : x.courier_user_id || ''), name: x.name, due: Number(x.due), settled: Number(x.settled), count: Number(x.cnt) })),
    });
  }));
  app.get('/api/admin/commissions/entries', ...admin, guard(async (req, res) => {
    const where = []; const v = [];
    const add = (sql, val) => { v.push(val); where.push(sql.replace('?', `$${v.length}`)); };
    if (req.query.orderId) add('e.order_id = ?::bigint', positiveId(req.query.orderId) || 0);
    if (req.query.appointmentId) add('e.appointment_id = ?::bigint', positiveId(req.query.appointmentId) || 0);
    if (req.query.providerId) add('e.provider_id = ?::bigint', positiveId(req.query.providerId) || 0);
    if (req.query.courierId) add('e.courier_user_id = ?::bigint', positiveId(req.query.courierId) || 0);
    if (['due', 'settled'].includes(req.query.status)) add('e.status = ?', req.query.status);
    v.push(Math.min(200, Math.max(1, Number(req.query.limit) || 60)));
    const r = await pool.query(`SELECT e.* FROM commission_entries e ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.id DESC LIMIT $${v.length}`, v);
    res.json({ entries: r.rows.map(entryJson) });
  }));

  /** Cancellation / return: documented negative adjustment(s) against the original accrual(s). Never edits or deletes. */
  app.post('/api/admin/commissions/reverse', ...admin, guard(async (req, res) => {
    const b = req.body || {};
    const orderId = b.orderId ? positiveId(b.orderId) : null;
    const apptId = b.appointmentId ? positiveId(b.appointmentId) : null;
    if (!orderId && !apptId) throw fail(400, 'حدد الطلب أو الحجز');
    const note = String(b.note || '').trim().slice(0, 200);
    if (note.length < 3) throw fail(400, 'اكتب سبب التسوية (إلغاء / مرتجع)');
    const refund = b.refundAmount === undefined || b.refundAmount === '' || b.refundAmount === null ? null : Number(b.refundAmount);
    if (refund !== null && (!Number.isFinite(refund) || refund <= 0)) throw fail(400, 'مبلغ المرتجع غير صالح');
    const withCourier = b.reverseCourier !== false;
    const out = await withTx(async db => {
      const acc = await db.query(`SELECT * FROM commission_entries WHERE entry_type='accrual' AND ${orderId ? 'order_id=$1' : 'appointment_id=$1'} ORDER BY id FOR UPDATE`, [orderId || apptId]);
      if (!acc.rowCount) throw fail(404, 'لا توجد عمولة محتسبة لهذا الطلب');
      const made = [];
      for (const e of acc.rows) {
        if (e.kind === 'courier' && !withCourier) continue;
        const prev = await db.query("SELECT COALESCE(SUM(amount),0) AS s FROM commission_entries WHERE parent_id=$1 AND entry_type='adjustment'", [e.id]);
        const remaining = round2(Number(e.amount) + Number(prev.rows[0].s)); // adjustments are negative
        if (remaining <= 0) continue;
        let cut = remaining;
        if (refund !== null && e.kind === 'provider') {
          const base = Number(e.base_amount);
          cut = e.rule_snapshot && e.rule_snapshot.kind === 'percent' ? round2((Number(e.amount) * Math.min(refund, base)) / (base || 1)) : (refund >= base ? remaining : 0);
          cut = Math.min(cut, remaining);
        }
        if (cut <= 0) continue;
        const r = await db.query(`INSERT INTO commission_entries(entry_type, kind, order_id, appointment_id, provider_id, courier_user_id, base_amount, amount, rule_id, rule_snapshot, parent_id, note, created_by)
          VALUES('adjustment',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [e.kind, e.order_id, e.appointment_id, e.provider_id, e.courier_user_id, refund !== null && e.kind === 'provider' ? -Math.min(refund, Number(e.base_amount)) : -Number(e.base_amount), -cut, e.rule_id, e.rule_snapshot, e.id, note, me(req)]);
        made.push(r.rows[0]);
      }
      if (!made.length) throw fail(409, 'لا يوجد رصيد عمولة قابل للعكس (تمت تسويته بالكامل أو لا ينطبق)');
      await audit(db, me(req), 'commission.reverse', orderId ? 'order' : 'appointment', orderId || apptId, null, { adjustments: made.map(entryJson) }, note);
      return made;
    });
    res.status(201).json({ adjustments: out.map(entryJson) });
  }));

  /** Marks everything due for one provider / courier as paid. Later adjustments are simply new "due" rows (credit). */
  app.post('/api/admin/commissions/settle', ...admin, guard(async (req, res) => {
    const b = req.body || {};
    const providerId = b.providerId ? positiveId(b.providerId) : null;
    const courierId = b.courierId ? positiveId(b.courierId) : null;
    if (!providerId === !courierId) throw fail(400, 'حدد مقدم الخدمة أو المندوب');
    const note = String(b.note || '').trim().slice(0, 200);
    const out = await withTx(async db => {
      const rows = await db.query(`SELECT id, amount FROM commission_entries WHERE status='due' AND kind=$1 AND ${providerId ? 'provider_id' : 'courier_user_id'}=$2 ORDER BY id FOR UPDATE`, [providerId ? 'provider' : 'courier', providerId || courierId]);
      if (!rows.rowCount) throw fail(409, 'لا توجد مستحقات غير مسددة');
      const total = round2(rows.rows.reduce((s, x) => s + Number(x.amount), 0));
      const s = await db.query('INSERT INTO commission_settlements(party, provider_id, courier_user_id, amount, entries_count, note, created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [providerId ? 'provider' : 'courier', providerId, courierId, total, rows.rowCount, note, me(req)]);
      await db.query("UPDATE commission_entries SET status='settled', settlement_id=$1 WHERE id = ANY($2::bigint[])", [s.rows[0].id, rows.rows.map(x => x.id)]);
      await audit(db, me(req), 'commission.settle', providerId ? 'provider' : 'courier', providerId || courierId, null, { amount: total, entries: rows.rowCount }, note);
      return { amount: total, entries: rows.rowCount };
    });
    res.json(out);
  }));

  /** What a provider / courier sees about their own commission. */
  app.get('/api/my/commissions', auth, roles('provider', 'courier'), asyncRoute(async (req, res) => {
    const uid = me(req);
    const isProvider = req.auth.role === 'provider';
    const sum = await pool.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE status='due'),0) AS due, COALESCE(SUM(amount) FILTER (WHERE status='settled'),0) AS settled,
        COALESCE(SUM(amount) FILTER (WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo'),0) AS month
      FROM commission_entries WHERE ${isProvider ? "kind='provider' AND provider_id IN (SELECT id FROM providers WHERE owner_user_id=$1)" : "kind='courier' AND courier_user_id=$1"}`, [uid]);
    const rules = [];
    if (isProvider) {
      for (const p of (await pool.query('SELECT id, type, name FROM providers WHERE owner_user_id=$1 AND deleted_at IS NULL', [uid])).rows) {
        const r = await ruleFor(pool, 'provider', new Date(), p.type, p.id, null);
        rules.push({ providerId: String(p.id), name: p.name, kind: r ? r.kind : 'fixed', value: r ? Number(r.value) : 0, minAmount: r ? Number(r.min_amount) : 0 });
      }
    } else {
      const r = await ruleFor(pool, 'courier', new Date(), null, null, uid);
      rules.push({ kind: r ? r.kind : 'fixed', value: r ? Number(r.value) : 0, minAmount: r ? Number(r.min_amount) : 0 });
    }
    const last = await pool.query(`SELECT * FROM commission_entries WHERE ${isProvider ? "kind='provider' AND provider_id IN (SELECT id FROM providers WHERE owner_user_id=$1)" : "kind='courier' AND courier_user_id=$1"} ORDER BY id DESC LIMIT 15`, [uid]);
    const s = sum.rows[0];
    res.json({ due: Number(s.due), settled: Number(s.settled), month: Number(s.month), rules, entries: last.rows.map(entryJson) });
  }));

  /* ---------- counters + resets + schedules ---------- */
  const counterList = v => {
    const list = Array.isArray(v) ? [...new Set(v.map(String))] : [];
    if (!list.length || list.some(c => !COUNTERS.includes(c))) throw fail(400, 'اختر العدادات المطلوب تصفيرها (المبيعات / الطلبات / الأرباح)');
    return list;
  };
  async function targetOf(db, b) {
    await services.ensure(db);
    const scope = String(b.scope || '');
    if (!['all', 'type', 'provider'].includes(scope)) throw fail(400, 'حدد نطاق التصفير: الجميع أو قسم أو مقدم خدمة');
    let ptype = null, pid = null;
    if (scope === 'type') { ptype = String(b.providerType || ''); if (!PROVIDER_TYPES.includes(ptype)) throw fail(400, 'اختر القسم'); }
    if (scope === 'provider') { pid = positiveId(b.providerId); if (!pid || !(await db.query('SELECT 1 FROM providers WHERE id=$1', [pid])).rowCount) throw fail(400, 'اختر مقدم الخدمة'); }
    return { scope, ptype, pid };
  }
  const resetJson = r => ({ id: String(r.id), scope: r.scope, providerType: r.provider_type || undefined, providerId: r.provider_id ? String(r.provider_id) : undefined, counters: r.counters, at: new Date(r.reset_at).getTime(), source: r.source, note: r.note });
  const schedJson = r => ({ id: String(r.id), scope: r.scope, providerType: r.provider_type || undefined, providerId: r.provider_id ? String(r.provider_id) : undefined, counters: r.counters, frequency: r.frequency, time: r.run_time,
    dayOfWeek: r.day_of_week === null ? undefined : Number(r.day_of_week), dayOfMonth: r.day_of_month === null ? undefined : Number(r.day_of_month),
    date: r.run_date ? (r.run_date instanceof Date ? r.run_date.toISOString().slice(0, 10) : String(r.run_date).slice(0, 10)) : undefined,
    enabled: r.enabled, nextRunAt: r.next_run_at ? new Date(r.next_run_at).getTime() : undefined, lastRunAt: r.last_run_at ? new Date(r.last_run_at).getTime() : undefined });

  /** Executes schedules whose time has come (lazily, under a lock; the reset is stamped with the scheduled moment, so timing is exact). */
  async function runDueSchedules() {
    const due = await pool.query('SELECT 1 FROM counter_schedules WHERE enabled=TRUE AND next_run_at IS NOT NULL AND next_run_at <= NOW() LIMIT 1');
    if (!due.rowCount) return 0;
    return withTx(async db => {
      await db.query('SELECT pg_advisory_xact_lock(74202)');
      const list = await db.query('SELECT * FROM counter_schedules WHERE enabled=TRUE AND next_run_at IS NOT NULL AND next_run_at <= NOW() ORDER BY id FOR UPDATE');
      let ran = 0;
      for (const s of list.rows) {
        let at = new Date(s.next_run_at).getTime();
        let next = nextRun(s, at);
        for (let i = 0; next !== null && next <= Date.now() && i < 2000; i++) { at = next; next = nextRun(s, at); }
        const r = await db.query(`INSERT INTO counter_resets(scope, provider_type, provider_id, counters, reset_at, source, schedule_id, note) VALUES($1,$2,$3,$4,$5,'schedule',$6,'تصفير مجدول') RETURNING *`,
          [s.scope, s.provider_type, s.provider_id, s.counters, new Date(at), s.id]);
        await db.query('UPDATE counter_schedules SET last_run_at=$1, next_run_at=$2, enabled=$3 WHERE id=$4', [new Date(at), next === null ? null : new Date(next), next !== null && s.frequency !== 'once', s.id]);
        await audit(db, null, 'counters.reset.schedule', 'counter_schedule', s.id, null, resetJson(r.rows[0]));
        ran++;
      }
      return ran;
    });
  }

  app.get('/api/counters', auth, roles('admin', 'provider'), asyncRoute(async (req, res) => {
    await runDueSchedules().catch(e => console.error('schedule run failed:', e.message));
    res.json(await computeCounters(pool, req.auth.role === 'admin' ? null : me(req)));
  }));
  app.get('/api/admin/counters/resets', ...admin, asyncRoute(async (_req, res) => {
    await runDueSchedules().catch(e => console.error('schedule run failed:', e.message));
    const [r, s] = await Promise.all([
      pool.query('SELECT * FROM counter_resets ORDER BY reset_at DESC, id DESC LIMIT 60'),
      pool.query('SELECT * FROM counter_schedules ORDER BY id DESC LIMIT 100'),
    ]);
    res.json({ resets: r.rows.map(resetJson), schedules: s.rows.map(schedJson) });
  }));
  app.post('/api/admin/counters/reset', ...admin, guard(async (req, res) => {
    const b = req.body || {};
    const out = await withTx(async db => {
      const t = await targetOf(db, b);
      const counters = counterList(b.counters);
      const r = await db.query("INSERT INTO counter_resets(scope, provider_type, provider_id, counters, source, note, created_by) VALUES($1,$2,$3,$4,'manual',$5,$6) RETURNING *",
        [t.scope, t.ptype, t.pid, counters, String(b.note || '').slice(0, 200), me(req)]);
      await audit(db, me(req), 'counters.reset.manual', 'counter_reset', r.rows[0].id, null, resetJson(r.rows[0]), b.note);
      return r.rows[0];
    });
    res.status(201).json({ reset: resetJson(out) });
  }));
  async function normalizeSchedule(db, b, old) {
    const t = old ? { scope: old.scope, ptype: old.provider_type, pid: old.provider_id } : await targetOf(db, b);
    const counters = b.counters === undefined && old ? old.counters : counterList(b.counters);
    const frequency = b.frequency === undefined && old ? old.frequency : String(b.frequency || '');
    if (!['once', 'daily', 'weekly', 'monthly'].includes(frequency)) throw fail(400, 'اختر التكرار: مرة واحدة أو يومي أو أسبوعي أو شهري');
    const time = b.time === undefined && old ? old.run_time : String(b.time || '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw fail(400, 'الساعة بصيغة HH:mm');
    const dow = frequency === 'weekly' ? Number(b.dayOfWeek === undefined && old ? old.day_of_week : b.dayOfWeek) : null;
    if (frequency === 'weekly' && !(Number.isInteger(dow) && dow >= 0 && dow <= 6)) throw fail(400, 'اختر يوم الأسبوع');
    const dom = frequency === 'monthly' ? Number(b.dayOfMonth === undefined && old ? old.day_of_month : b.dayOfMonth) : null;
    if (frequency === 'monthly' && !(Number.isInteger(dom) && dom >= 1 && dom <= 31)) throw fail(400, 'اختر يوم الشهر (1-31)');
    let date = null;
    if (frequency === 'once') {
      date = String(b.date === undefined && old ? (old.run_date instanceof Date ? old.run_date.toISOString().slice(0, 10) : old.run_date) : b.date || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(400, 'اختر تاريخ التصفير');
    }
    const enabled = b.enabled === undefined ? (old ? old.enabled : true) : Boolean(b.enabled);
    const spec = { frequency, run_time: time, day_of_week: dow, day_of_month: dom, run_date: date };
    const next = enabled ? nextRun(spec, Date.now()) : null;
    if (enabled && next === null) throw fail(400, 'هذا الموعد في الماضي');
    return { ...t, counters, frequency, time, dow, dom, date, enabled, next: next === null ? null : new Date(next) };
  }
  app.post('/api/admin/counters/schedules', ...admin, guard(async (req, res) => {
    const out = await withTx(async db => {
      const v = await normalizeSchedule(db, req.body || {}, null);
      const r = await db.query(`INSERT INTO counter_schedules(scope, provider_type, provider_id, counters, frequency, run_time, day_of_week, day_of_month, run_date, enabled, next_run_at, created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [v.scope, v.ptype, v.pid, v.counters, v.frequency, v.time, v.dow, v.dom, v.date, v.enabled, v.next, me(req)]);
      await audit(db, me(req), 'counters.schedule.create', 'counter_schedule', r.rows[0].id, null, schedJson(r.rows[0]));
      return r.rows[0];
    });
    res.status(201).json({ schedule: schedJson(out) });
  }));
  app.patch('/api/admin/counters/schedules/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف الجدولة غير صالح');
    const out = await withTx(async db => {
      const f = await db.query('SELECT * FROM counter_schedules WHERE id=$1 FOR UPDATE', [id]);
      if (!f.rowCount) throw fail(404, 'الجدولة غير موجودة');
      const v = await normalizeSchedule(db, req.body || {}, f.rows[0]);
      const r = await db.query(`UPDATE counter_schedules SET counters=$1, frequency=$2, run_time=$3, day_of_week=$4, day_of_month=$5, run_date=$6, enabled=$7, next_run_at=$8 WHERE id=$9 RETURNING *`,
        [v.counters, v.frequency, v.time, v.dow, v.dom, v.date, v.enabled, v.next, id]);
      await audit(db, me(req), 'counters.schedule.update', 'counter_schedule', id, schedJson(f.rows[0]), schedJson(r.rows[0]));
      return r.rows[0];
    });
    res.json({ schedule: schedJson(out) });
  }));
  app.delete('/api/admin/counters/schedules/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف الجدولة غير صالح');
    await withTx(async db => {
      const r = await db.query('DELETE FROM counter_schedules WHERE id=$1 RETURNING *', [id]);
      if (!r.rowCount) throw fail(404, 'الجدولة غير موجودة');
      await audit(db, me(req), 'counters.schedule.delete', 'counter_schedule', id, schedJson(r.rows[0]), null);
    });
    res.json({ ok: true });
  }));

  /* ---------- audit log ---------- */
  app.get('/api/admin/audit', ...admin, asyncRoute(async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 80));
    const prefix = String(req.query.prefix || '').slice(0, 40);
    const r = await pool.query('SELECT * FROM audit_log WHERE ($1 = \'\' OR action LIKE $1 || \'%\') ORDER BY id DESC LIMIT $2', [prefix, limit]);
    res.json({ log: r.rows.map(x => ({ id: String(x.id), actor: x.actor_name, action: x.action, entity: x.entity, entityId: x.entity_id, before: x.before, after: x.after, note: x.note, at: new Date(x.created_at).getTime() })) });
  }));

  /* ---------- login screen picture (owner controls it; everyone can see it) ---------- */
  const MAX_LOGIN_IMAGE = 1400000;
  app.get('/api/login-image', asyncRoute(async (_req, res) => {
    const r = await pool.query("SELECT image, mime FROM site_images WHERE key='login'");
    if (!r.rowCount) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable'); // the link changes (?v=) with the picture
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(r.rows[0].image);
  }));
  app.put('/api/admin/login-image', ...admin, guard(async (req, res) => {
    const s = String((req.body || {}).image || '');
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(s);
    if (!m || s.length > MAX_LOGIN_IMAGE) throw fail(400, 'ارفع صورة صالحة (JPG أو PNG) بحجم أصغر');
    const v = await withTx(async db => {
      const r = await db.query("INSERT INTO site_images(key, image, mime, updated_at) VALUES('login',$1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET image=EXCLUDED.image, mime=EXCLUDED.mime, updated_at=NOW() RETURNING (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v",
        [Buffer.from(m[2], 'base64'), m[1]]);
      await audit(db, me(req), 'login-image.set', 'site_image', 'login', null, { bytes: Buffer.byteLength(m[2], 'base64') });
      return Number(r.rows[0].v);
    });
    res.json({ loginImageV: v });
  }));
  /* ---------- the app's icon: stored here, used when the Android app is built (see build-apk.yml) ---------- */
  app.get('/api/app-icon', asyncRoute(async (_req, res) => {
    const r = await pool.query("SELECT image, mime FROM site_images WHERE key='app_icon'");
    if (!r.rowCount) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime);
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(r.rows[0].image);
  }));
  app.put('/api/admin/app-icon', ...admin, guard(async (req, res) => {
    const s = String((req.body || {}).image || '');
    const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(s);
    if (!m || s.length > MAX_LOGIN_IMAGE) throw fail(400, 'ارفع صورة مربعة صالحة (PNG أو JPG) بحجم أصغر');
    const v = await withTx(async db => {
      const r = await db.query("INSERT INTO site_images(key, image, mime, updated_at) VALUES('app_icon',$1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET image=EXCLUDED.image, mime=EXCLUDED.mime, updated_at=NOW() RETURNING (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v",
        [Buffer.from(m[2], 'base64'), m[1]]);
      await audit(db, me(req), 'app-icon.set', 'site_image', 'app_icon', null, { bytes: Buffer.byteLength(m[2], 'base64') });
      return Number(r.rows[0].v);
    });
    res.json({ appIconV: v });
  }));
  app.delete('/api/admin/app-icon', ...admin, guard(async (req, res) => {
    await withTx(async db => {
      await db.query("DELETE FROM site_images WHERE key='app_icon'");
      await audit(db, me(req), 'app-icon.remove', 'site_image', 'app_icon', null, null);
    });
    res.json({ appIconV: 0 });
  }));
  /* ---------- the picture of each service icon on the home screen (restaurants, pharmacies...) ---------- */
  const CAT_TYPES = { includes: x => !!services.find(String(x)) }; // every service, including the errand one
  app.get('/api/cat-icon/:type', asyncRoute(async (req, res) => {
    await services.ensure(pool);
    const t = String(req.params.type || '');
    if (!CAT_TYPES.includes(t)) return res.status(404).end();
    const r = await pool.query('SELECT image, mime FROM site_images WHERE key=$1', [`cat_${t}`]);
    if (!r.rowCount) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime);
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(r.rows[0].image);
  }));
  app.put('/api/admin/cat-icon/:type', ...admin, guard(async (req, res) => {
    await services.ensure(pool);
    const t = String(req.params.type || '');
    if (!CAT_TYPES.includes(t)) throw fail(400, 'نوع الخدمة غير معروف');
    const s = String((req.body || {}).image || '');
    const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(s);
    if (!m || s.length > MAX_LOGIN_IMAGE) throw fail(400, 'ارفع صورة صالحة (PNG أو JPG) بحجم أصغر');
    const v = await withTx(async db => {
      const r = await db.query("INSERT INTO site_images(key, image, mime, updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT (key) DO UPDATE SET image=EXCLUDED.image, mime=EXCLUDED.mime, updated_at=NOW() RETURNING (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v",
        [`cat_${t}`, Buffer.from(m[2], 'base64'), m[1]]);
      await audit(db, me(req), 'cat-icon.set', 'site_image', `cat_${t}`, null, { bytes: Buffer.byteLength(m[2], 'base64') });
      return Number(r.rows[0].v);
    });
    res.json({ type: t, v });
  }));
  app.delete('/api/admin/cat-icon/:type', ...admin, guard(async (req, res) => {
    await services.ensure(pool);
    const t = String(req.params.type || '');
    if (!CAT_TYPES.includes(t)) throw fail(400, 'نوع الخدمة غير معروف');
    await withTx(async db => {
      await db.query('DELETE FROM site_images WHERE key=$1', [`cat_${t}`]);
      await audit(db, me(req), 'cat-icon.remove', 'site_image', `cat_${t}`, null, null);
    });
    res.json({ type: t, v: 0 });
  }));
  /* ---------- the logo on the first screen (the owner can replace it; PNG keeps its transparent background) ---------- */
  app.get('/api/welcome-logo', asyncRoute(async (_req, res) => {
    const r = await pool.query("SELECT image, mime FROM site_images WHERE key='welcome_logo'");
    if (!r.rowCount) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable'); // the link changes (?v=) with the picture
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(r.rows[0].image);
  }));
  app.put('/api/admin/welcome-logo', ...admin, guard(async (req, res) => {
    const s = String((req.body || {}).image || '');
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(s);
    if (!m || s.length > MAX_LOGIN_IMAGE) throw fail(400, 'ارفع لوجو صالح (PNG أو JPG) بحجم أصغر');
    const v = await withTx(async db => {
      const r = await db.query("INSERT INTO site_images(key, image, mime, updated_at) VALUES('welcome_logo',$1,$2,NOW()) ON CONFLICT (key) DO UPDATE SET image=EXCLUDED.image, mime=EXCLUDED.mime, updated_at=NOW() RETURNING (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v",
        [Buffer.from(m[2], 'base64'), m[1]]);
      await audit(db, me(req), 'welcome-logo.set', 'site_image', 'welcome_logo', null, { bytes: Buffer.byteLength(m[2], 'base64') });
      return Number(r.rows[0].v);
    });
    res.json({ welcomeLogoV: v });
  }));
  app.delete('/api/admin/welcome-logo', ...admin, guard(async (req, res) => {
    await withTx(async db => {
      await db.query("DELETE FROM site_images WHERE key='welcome_logo'");
      await audit(db, me(req), 'welcome-logo.remove', 'site_image', 'welcome_logo', null, null);
    });
    res.json({ welcomeLogoV: 0 });
  }));
  app.delete('/api/admin/login-image', ...admin, guard(async (req, res) => {
    await withTx(async db => {
      await db.query("DELETE FROM site_images WHERE key='login'");
      await audit(db, me(req), 'login-image.remove', 'site_image', 'login', null, null);
    });
    res.json({ loginImageV: 0 });
  }));
};
Object.assign(module.exports, { onOrderDelivered, onApptCompleted, pickRule, computeAmount, nextRun, cairoToUtc, computeCounters, ruleFor, round2 });
