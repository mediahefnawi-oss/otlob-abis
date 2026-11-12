'use strict';
/**
 * Wiping the trial data from the owner's panel (switch "dataWipe", OFF by default). Only the owner can do it, only while the switch is on, and only with
 * his password plus the typed word "مسح". It deletes orders / bookings / prescriptions (and what hangs on them: chats, pictures, recordings, ratings,
 * invoices, commissions, coupon uses) in ONE transaction, optionally restarting the numbering from 1. It never touches customers, shops, products,
 * areas, settings or the activity log. There is no undo: a database backup (deploy/backup.sh) is the only way back, so the screen says so.
 */
const bcrypt = require('bcryptjs');
const extrasLib = require('./extras');
const WORD = 'مسح';
const SCOPES = ['orders', 'bookings', 'rx'];

const fail = (status, error) => Object.assign(new Error(error), { http: status });

async function counts(db) {
  const r = await db.query(`SELECT
    (SELECT COUNT(*) FROM orders) AS orders,
    (SELECT COUNT(*) FROM orders WHERE status NOT IN ('delivered','rejected','cancelled','unavailable')) AS open_orders,
    (SELECT COUNT(*) FROM appointments) AS bookings,
    (SELECT COUNT(*) FROM prescriptions) AS rx,
    (SELECT COUNT(*) FROM invoices) AS invoices,
    (SELECT COUNT(*) FROM messages) AS messages,
    (SELECT COUNT(*) FROM commission_entries) AS commissions`);
  const x = r.rows[0]; const o = {};
  for (const k of Object.keys(x)) o[k.replace(/_(\w)/g, (_m, c) => c.toUpperCase())] = Number(x[k]);
  return o;
}

/** the deletion itself (inside the caller's transaction); returns what was removed */
async function wipe(db, what, renumber) {
  const before = await counts(db);
  if (what.includes('orders')) {
    await db.query('DELETE FROM commission_entries WHERE order_id IS NOT NULL');
    await db.query('DELETE FROM coupon_uses WHERE order_id IS NOT NULL');
    await db.query('DELETE FROM invoices WHERE order_id IS NOT NULL');
    await db.query('DELETE FROM orders'); // chats, pictures, recordings, ratings and late alerts go with them (ON DELETE CASCADE)
  }
  if (what.includes('rx')) {
    await db.query('DELETE FROM commission_entries WHERE rx_id IS NOT NULL');
    await db.query('DELETE FROM prescriptions');
  }
  if (what.includes('bookings')) {
    await db.query('DELETE FROM commission_entries WHERE appointment_id IS NOT NULL');
    await db.query('DELETE FROM invoices WHERE appointment_id IS NOT NULL');
    await db.query('DELETE FROM appointments'); // lab files go with them
  }
  if (renumber) {
    // a numbering is restarted only when its table is really empty, so a number can never repeat
    const empty = async t => Number((await db.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n) === 0;
    if (await empty('orders')) { await db.query('ALTER SEQUENCE orders_order_number_seq RESTART WITH 1'); await db.query('ALTER SEQUENCE orders_id_seq RESTART WITH 1'); }
    if (await empty('appointments')) await db.query('ALTER SEQUENCE appointments_id_seq RESTART WITH 1');
    if (await empty('prescriptions')) await db.query('ALTER SEQUENCE prescriptions_id_seq RESTART WITH 1');
    if (await empty('invoices')) { await db.query('ALTER SEQUENCE invoices_id_seq RESTART WITH 1'); await db.query('ALTER SEQUENCE invoices_invoice_number_seq RESTART WITH 1'); }
  }
  const after = await counts(db);
  return { before, after };
}

function register(app, { pool, auth, roles, asyncRoute }) {
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; }
  });
  app.get('/api/admin/wipe/preview', auth, roles('admin'), guard(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ enabled: await extrasLib.featureOn(pool, 'dataWipe'), counts: await counts(pool), word: WORD });
  }));
  app.post('/api/admin/wipe', auth, roles('admin'), guard(async (req, res) => {
    if (!(await extrasLib.featureOn(pool, 'dataWipe'))) throw fail(409, 'فعّل «مسح بيانات الطلبات» من تشغيل الميزات أولاً');
    const b = req.body || {};
    const what = [...new Set(Array.isArray(b.what) ? b.what.map(String) : [])];
    if (!what.length || what.some(x => !SCOPES.includes(x))) throw fail(400, 'اختر اللي عايز تمسحه');
    if (String(b.confirm || '').trim() !== WORD) throw fail(400, `اكتب كلمة «${WORD}» للتأكيد`);
    const u = await pool.query("SELECT password_hash FROM users WHERE id=$1 AND role='admin'", [Number(req.auth.sub)]);
    if (!u.rowCount || !(await bcrypt.compare(String(b.password || ''), u.rows[0].password_hash))) throw fail(403, 'كلمة المرور غير صحيحة');
    const client = await pool.connect();
    let out;
    try {
      await client.query('BEGIN');
      out = await wipe(client, what, b.renumber === true);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    res.json({ ok: true, ...out });
  }));
}

module.exports = { register, wipe, counts, WORD, SCOPES };
