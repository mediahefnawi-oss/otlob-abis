'use strict';
/**
 * Intercity trips with seats. An approved captain announces "a car goes to <governorate> on <day>, N seats at P each";
 * every customer gets a notification and books seats; the captain sees who booked and calls them.
 * Needs the "rides" switch (captains live there) and respects the owner's open/close of 'trips'.
 */
const gatesLib = require('./gates');

const MAX_OPEN_PER_CAPTAIN = 5;
const MAX_SEATS_PER_CUSTOMER = 4;
const MAX_DAYS_AHEAD = 60;
const MAX_NOTIFY = 20000;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const money = v => Math.round(Number(v) * 100) / 100;

/** Pure: validates what the captain sent. Returns { error } or { value }. */
function cleanTrip(b, now = Date.now()) {
  b = b || {};
  const dest = str(b.dest, 40), fromText = str(b.fromText, 80), note = str(b.note, 200);
  if (dest.length < 2) return { error: 'اكتب المحافظة اللي رايحها' };
  const when = new Date(b.departAt);
  if (isNaN(when.getTime())) return { error: 'حدد يوم وساعة الطلوع' };
  if (when.getTime() <= now + 30 * 60 * 1000) return { error: 'ميعاد الطلوع لازم يكون بعد نص ساعة على الأقل' };
  if (when.getTime() > now + MAX_DAYS_AHEAD * 86400000) return { error: `أقصى مدة ${MAX_DAYS_AHEAD} يوم قدام` };
  const seats = Number(b.seats);
  if (!Number.isInteger(seats) || seats < 1 || seats > 50) return { error: 'عدد الكراسي من 1 إلى 50' };
  const price = Number(b.price);
  if (!Number.isFinite(price) || price < 0 || price > 10000) return { error: 'سعر الكرسي غير صحيح' };
  return { value: { dest, fromText, note, departAt: when.toISOString(), seats, price: money(price) } };
}
/** Pure: the seats a customer asked for, validated against the trip size. Returns an array or null. */
function cleanSeats(raw, total) {
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [...new Set(list.map(Number))];
  if (!out.length || out.length > MAX_SEATS_PER_CUSTOMER || out.some(n => !Number.isInteger(n) || n < 1 || n > total)) return null;
  return out.sort((a, b) => a - b);
}
const fmtWhen = t => { try { return new Date(t).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

function register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib, pushToUsers }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => { try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; } });
  const admin = [auth, roles('admin')];
  const me = req => Number(req.auth.sub);
  const push = (ids, title, body, tag) => { try { const p = pushToUsers && pushToUsers((ids || []).filter(Boolean), { title, body, tag, url: '/' }); if (p && p.catch) p.catch(() => {}); } catch { /* a failed push never fails the request */ } };
  const needOn = async () => { let on = false; try { on = await extrasLib.featureOn(pool, 'rides'); } catch { /* off */ } if (!on) throw fail(404, 'الخدمة غير متاحة الآن'); };
  /** the owner chooses which vehicle types run intercity trips; while none is chosen every captain may (as before) */
  const tripsAllowed = async uid => {
    const r = await pool.query(`SELECT (SELECT COUNT(*) FROM ride_types WHERE trips_enabled AND active)::int AS n,
      COALESCE((SELECT t.trips_enabled FROM captain_profiles p JOIN ride_types t ON t.id=p.type_id WHERE p.user_id=$1), FALSE) AS mine`, [uid]);
    return r.rows[0].n === 0 || r.rows[0].mine === true;
  };
  const needCaptain = async req => {
    await needOn();
    const p = await pool.query('SELECT status FROM captain_profiles WHERE user_id=$1', [me(req)]);
    if (!p.rowCount || p.rows[0].status !== 'approved') throw fail(403, 'حسابك كابتن غير مفعّل بعد');
  };

  /** a trip with its seats: who booked each (the captain and the owner see names, the customer only his own) */
  async function seatsOf(ids) {
    if (!ids.length) return new Map();
    const r = await pool.query('SELECT s.trip_id, s.seat_no, s.customer_id, u.name, u.phone FROM trip_seats s JOIN users u ON u.id=s.customer_id WHERE s.trip_id = ANY($1::bigint[]) ORDER BY s.seat_no', [ids]);
    const m = new Map(); for (const x of r.rows) { const k = Number(x.trip_id); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
    return m;
  }
  const baseOut = (t, seatRows) => ({
    id: Number(t.id), dest: t.dest, fromText: t.from_text, departAt: new Date(t.depart_at).getTime(), seats: t.seats, price: Number(t.price), note: t.note, status: t.status,
    booked: seatRows.map(s => s.seat_no), free: t.seats - seatRows.length,
    vehicle: t.vtype_id ? { id: Number(t.vtype_id), name: t.vtype_name } : null,
  });
  const TRIP_SQL = `SELECT t.*, u.name AS driver_name, p.model, p.color, p.plate, rt.id AS vtype_id, rt.name AS vtype_name FROM trips t JOIN users u ON u.id=t.driver_id LEFT JOIN captain_profiles p ON p.user_id=t.driver_id LEFT JOIN ride_types rt ON rt.id=p.type_id`;

  /* ================= captain ================= */
  app.post('/api/captain/trips', auth, roles('courier'), guard(async (req, res) => {
    await needCaptain(req);
    await gatesLib.assertOpen(pool, ['trips'], fail);
    if (!(await tripsAllowed(me(req)))) throw fail(403, 'نوع مركبتك مش مسموح له برحلات المحافظات');
    const c = cleanTrip(req.body);
    if (c.error) throw fail(400, c.error);
    const open = await pool.query("SELECT COUNT(*)::int AS n FROM trips WHERE driver_id=$1 AND status='open' AND depart_at > NOW()", [me(req)]);
    if (open.rows[0].n >= MAX_OPEN_PER_CAPTAIN) throw fail(409, `عندك ${MAX_OPEN_PER_CAPTAIN} رحلات مفتوحة، خلّص أو الغي واحدة الأول`);
    const v = c.value;
    const r = await pool.query('INSERT INTO trips(driver_id, dest, from_text, depart_at, seats, price, note) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [me(req), v.dest, v.fromText, v.departAt, v.seats, v.price, v.note]);
    // everybody is told: a car goes to <dest> on <day>
    const ids = (await pool.query("SELECT id FROM users WHERE role='customer' AND status='active' AND deleted_at IS NULL ORDER BY id DESC LIMIT $1", [MAX_NOTIFY])).rows.map(x => x.id);
    push(ids, `عربية رايحة ${v.dest} 🚗`, `${fmtWhen(v.departAt)} — فاضل ${v.seats} كراسي. احجز كرسيك دلوقتي!`, `trip-${r.rows[0].id}`);
    const vt = (await pool.query('SELECT rt.id AS vtype_id, rt.name AS vtype_name FROM captain_profiles p JOIN ride_types rt ON rt.id=p.type_id WHERE p.user_id=$1', [me(req)])).rows[0] || {};
    res.status(201).json({ trip: baseOut({ ...r.rows[0], ...vt }, []), notified: ids.length });
  }));
  app.get('/api/captain/trips', auth, roles('courier'), guard(async (req, res) => {
    await needCaptain(req);
    const allowed = await tripsAllowed(me(req));
    const r = await pool.query(`${TRIP_SQL} WHERE t.driver_id=$1 AND t.depart_at > NOW() - INTERVAL '7 days' ORDER BY t.depart_at DESC LIMIT 50`, [me(req)]);
    const sm = await seatsOf(r.rows.map(x => Number(x.id)));
    res.json({ allowed, trips: r.rows.map(t => { const rows = sm.get(Number(t.id)) || []; return { ...baseOut(t, rows), passengers: rows.map(s => ({ seat: s.seat_no, name: s.name, phone: s.phone })) }; }) });
  }));
  app.post('/api/captain/trips/:id/status', auth, roles('courier'), guard(async (req, res) => {
    await needCaptain(req);
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const to = String((req.body || {}).status), from = { started: 'open', done: 'started' }[to];
    if (!from) throw fail(400, 'حالة غير صحيحة');
    const r = await pool.query('UPDATE trips SET status=$3, updated_at=NOW() WHERE id=$1 AND driver_id=$2 AND status=$4 RETURNING dest', [id, me(req), to, from]);
    if (!r.rowCount) throw fail(409, 'لا يمكن تغيير حالة هذه الرحلة');
    if (to === 'started') { const ids = (await pool.query('SELECT DISTINCT customer_id FROM trip_seats WHERE trip_id=$1', [id])).rows.map(x => x.customer_id); push(ids, 'الرحلة بدأت', `العربية اتحركت ناحية ${r.rows[0].dest}`, `trip-${id}`); }
    res.json({ ok: true });
  }));
  /** a cancelled trip tells everybody who booked */
  async function cancelTrip(id, where, params, who) {
    const r = await pool.query(`UPDATE trips SET status='cancelled', updated_at=NOW() WHERE id=$1 AND ${where} AND status IN ('open','started') RETURNING dest, depart_at`, [id, ...params]);
    if (!r.rowCount) throw fail(409, 'لا يمكن إلغاء هذه الرحلة');
    const ids = (await pool.query('SELECT DISTINCT customer_id FROM trip_seats WHERE trip_id=$1', [id])).rows.map(x => x.customer_id);
    push(ids, 'تم إلغاء الرحلة', `رحلة ${r.rows[0].dest} ${fmtWhen(r.rows[0].depart_at)} اتلغت ${who}. اتواصل معانا لو محتاج مساعدة`, `trip-${id}`);
  }
  app.post('/api/captain/trips/:id/cancel', auth, roles('courier'), guard(async (req, res) => {
    await needCaptain(req);
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    await cancelTrip(id, 'driver_id=$2', [me(req)], 'من الكابتن');
    res.json({ ok: true });
  }));

  /* ================= customer ================= */
  app.get('/api/trips', auth, roles('customer'), guard(async (req, res) => {
    await needOn();
    const r = await pool.query(`${TRIP_SQL} WHERE t.status='open' AND t.depart_at > NOW() ORDER BY t.depart_at LIMIT 60`);
    const sm = await seatsOf(r.rows.map(x => Number(x.id)));
    res.json({ trips: r.rows.map(t => {
      const rows = sm.get(Number(t.id)) || [];
      return { ...baseOut(t, rows), mine: rows.filter(s => Number(s.customer_id) === me(req)).map(s => s.seat_no),
        driver: { name: String(t.driver_name || '').split(' ').slice(0, 2).join(' '), model: t.model || '', color: t.color || '', plate: t.plate || '' } };
    }) });
  }));
  app.get('/api/trips/mine', auth, roles('customer'), guard(async (req, res) => {
    await needOn();
    const r = await pool.query(`SELECT t.*, u.name AS driver_name, u.phone AS driver_phone, p.model, p.color, p.plate,
        ARRAY(SELECT seat_no FROM trip_seats WHERE trip_id=t.id AND customer_id=$1 ORDER BY seat_no) AS my_seats
      FROM trips t JOIN users u ON u.id=t.driver_id LEFT JOIN captain_profiles p ON p.user_id=t.driver_id
      WHERE EXISTS (SELECT 1 FROM trip_seats s WHERE s.trip_id=t.id AND s.customer_id=$1) AND t.depart_at > NOW() - INTERVAL '2 days' ORDER BY t.depart_at DESC LIMIT 30`, [me(req)]);
    res.json({ trips: r.rows.map(t => ({ id: Number(t.id), dest: t.dest, fromText: t.from_text, departAt: new Date(t.depart_at).getTime(), price: Number(t.price), status: t.status, mySeats: t.my_seats,
      driver: { name: String(t.driver_name || '').split(' ').slice(0, 2).join(' '), phone: t.driver_phone, model: t.model || '', color: t.color || '', plate: t.plate || '' } })) });
  }));
  app.post('/api/trips/:id/book', auth, roles('customer'), guard(async (req, res) => {
    await needOn();
    await gatesLib.assertOpen(pool, ['trips'], fail);
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const c = await pool.connect();
    let driverId, dest, seats;
    try {
      await c.query('BEGIN');
      const t = await c.query("SELECT * FROM trips WHERE id=$1 AND status='open' AND depart_at > NOW() FOR UPDATE", [id]);
      if (!t.rowCount) { await c.query('ROLLBACK'); throw fail(404, 'الرحلة لم تعد متاحة'); }
      seats = cleanSeats((req.body || {}).seats ?? (req.body || {}).seat, t.rows[0].seats);
      if (!seats) { await c.query('ROLLBACK'); throw fail(400, `اختار من 1 إلى ${MAX_SEATS_PER_CUSTOMER} كراسي صحيحة`); }
      const mine = await c.query('SELECT COUNT(*)::int AS n FROM trip_seats WHERE trip_id=$1 AND customer_id=$2', [id, me(req)]);
      if (mine.rows[0].n + seats.length > MAX_SEATS_PER_CUSTOMER) { await c.query('ROLLBACK'); throw fail(409, `أقصى حجز ${MAX_SEATS_PER_CUSTOMER} كراسي للشخص`); }
      const taken = await c.query('SELECT seat_no FROM trip_seats WHERE trip_id=$1 AND seat_no = ANY($2::int[])', [id, seats]);
      if (taken.rowCount) { await c.query('ROLLBACK'); throw fail(409, `الكرسي ${taken.rows[0].seat_no} اتحجز، اختار كرسي تاني`); }
      for (const n of seats) await c.query('INSERT INTO trip_seats(trip_id, seat_no, customer_id) VALUES($1,$2,$3)', [id, n, me(req)]);
      await c.query('COMMIT');
      driverId = Number(t.rows[0].driver_id); dest = t.rows[0].dest;
    } catch (e) { try { await c.query('ROLLBACK'); } catch { /* already */ } throw e; } finally { c.release(); }
    const nm = (await pool.query('SELECT name FROM users WHERE id=$1', [me(req)])).rows[0];
    push([driverId], 'حجز جديد 🎟️', `${nm ? nm.name : 'عميل'} حجز ${seats.length} كرسي في رحلة ${dest}`, `trip-${id}`);
    res.json({ ok: true, seats });
  }));
  app.post('/api/trips/:id/cancel-booking', auth, roles('customer'), guard(async (req, res) => {
    await needOn();
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const t = await pool.query("SELECT driver_id, dest FROM trips WHERE id=$1 AND status='open'", [id]);
    if (!t.rowCount) throw fail(409, 'لا يمكن إلغاء الحجز الآن');
    const r = await pool.query('DELETE FROM trip_seats WHERE trip_id=$1 AND customer_id=$2 RETURNING seat_no', [id, me(req)]);
    if (!r.rowCount) throw fail(404, 'مفيش حجز ليك في الرحلة دي');
    push([Number(t.rows[0].driver_id)], 'تم إلغاء حجز', `عميل ألغى ${r.rowCount} كرسي في رحلة ${t.rows[0].dest}`, `trip-${id}`);
    res.json({ ok: true });
  }));

  /* ================= owner ================= */
  app.get('/api/admin/trips', ...admin, guard(async (_req, res) => {
    const r = await pool.query(`${TRIP_SQL} WHERE t.depart_at > NOW() - INTERVAL '14 days' ORDER BY t.depart_at DESC LIMIT 100`);
    const sm = await seatsOf(r.rows.map(x => Number(x.id)));
    res.json({ trips: r.rows.map(t => ({ ...baseOut(t, sm.get(Number(t.id)) || []), driver: t.driver_name, plate: t.plate || '' })) });
  }));
  app.post('/api/admin/trips/:id/cancel', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    await cancelTrip(id, 'TRUE', [], 'من الإدارة');
    res.json({ ok: true });
  }));
}
module.exports = { cleanTrip, cleanSeats, register, MAX_SEATS_PER_CUSTOMER };
