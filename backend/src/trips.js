'use strict';
/**
 * Intercity trips with seats. An approved captain announces "a car goes to <governorate> on <day>, N seats at P each";
 * every customer gets a notification and books seats; the captain sees who booked and calls them.
 * Needs the "rides" switch (captains live there) and respects the owner's open/close of 'trips'.
 */
const gatesLib = require('./gates');

const MAX_OPEN_PER_CAPTAIN = 5;
const MAX_SEATS_PER_CUSTOMER = 7;   // hard ceiling; the owner picks the live limit 4..7 (service_meta 'trips_max_persons')
const DEFAULT_MAX_PERSONS = 7;
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
  /** the owner hears about every booking and cancellation (never fails the request) */
  const alertOwner = (title, body, tag) => { pool.query("SELECT id FROM users WHERE role='admin' AND status='active' AND deleted_at IS NULL").then(r => push(r.rows.map(x => Number(x.id)), title, body, tag)).catch(() => {}); };
  const needOn = async () => { let on = false; try { on = await extrasLib.featureOn(pool, 'rides'); } catch { /* off */ } if (!on) throw fail(404, 'الخدمة غير متاحة الآن'); };
  /** the owner chooses which vehicle types run intercity trips; while none is chosen every captain may (as before) */
  const tripsAllowed = async uid => {
    const r = await pool.query(`SELECT (SELECT COUNT(*) FROM ride_types WHERE trips_enabled AND active)::int AS n,
      COALESCE((SELECT t.trips_enabled FROM captain_profiles p JOIN ride_types t ON t.id=p.type_id WHERE p.user_id=$1), FALSE) AS mine,
      COALESCE((SELECT trips_mode FROM captain_profiles WHERE user_id=$1), 'type') AS mode`, [uid]);
    const x = r.rows[0];
    if (x.mode === 'always') return true;
    if (x.mode === 'never') return false;
    return x.n === 0 || x.mine === true;
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
  const TRIP_SQL = `SELECT t.*, u.name AS driver_name, p.model, p.color, p.plate, p.trips_max, rt.id AS vtype_id, rt.name AS vtype_name FROM trips t JOIN users u ON u.id=t.driver_id LEFT JOIN captain_profiles p ON p.user_id=t.driver_id LEFT JOIN ride_types rt ON rt.id=p.type_id`;

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
  async function maxPersons() {
    try { const r = await pool.query("SELECT sub FROM service_meta WHERE key='trips_max_persons'"); const n = Number(r.rows[0] && r.rows[0].sub); return Number.isInteger(n) && n >= 1 && n <= MAX_SEATS_PER_CUSTOMER ? n : DEFAULT_MAX_PERSONS; }
    catch { return DEFAULT_MAX_PERSONS; }
  }
  /** the most persons per booking on this captain's trips: his own limit, else the owner's general one */
  async function limitFor(driverId) {
    const g = await maxPersons();
    try { const r = await pool.query('SELECT trips_max FROM captain_profiles WHERE user_id=$1', [driverId]); const v = Number(r.rows[0] && r.rows[0].trips_max); return Number.isInteger(v) && v >= 1 && v <= MAX_SEATS_PER_CUSTOMER ? v : g; }
    catch { return g; }
  }
  app.get('/api/trips', auth, roles('customer'), guard(async (req, res) => {
    await needOn();
    const r = await pool.query(`${TRIP_SQL} WHERE t.status='open' AND t.depart_at > NOW() ORDER BY t.depart_at LIMIT 60`);
    const sm = await seatsOf(r.rows.map(x => Number(x.id)));
    const maxP = await maxPersons();
    res.json({ maxPersons: maxP, trips: r.rows.map(t => {
      const rows = sm.get(Number(t.id)) || [];
      return { ...baseOut(t, rows), maxPersons: t.trips_max ? Math.min(Number(t.trips_max), 7) : maxP, mine: rows.filter(s => Number(s.customer_id) === me(req)).map(s => s.seat_no),
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
      const lim = await limitFor(t.rows[0].driver_id);
      const bb = req.body || {};
      const total = t.rows[0].seats;
      const mine = await c.query('SELECT COUNT(*)::int AS n FROM trip_seats WHERE trip_id=$1 AND customer_id=$2', [id, me(req)]);
      const taken = await c.query('SELECT seat_no FROM trip_seats WHERE trip_id=$1', [id]);
      const used = new Set(taken.rows.map(r => Number(r.seat_no)));
      if (bb.count !== undefined) {
        const n = Number(bb.count);
        if (!Number.isInteger(n) || n < 1) { await c.query('ROLLBACK'); throw fail(400, 'اكتب عدد الأفراد'); }
        if (n > lim) { await c.query('ROLLBACK'); throw fail(400, `أقصى عدد ${lim} أفراد في الحجز، للعدد الأكبر كلّمنا على واتساب`); }
        if (mine.rows[0].n + n > lim) { await c.query('ROLLBACK'); throw fail(409, `أقصى حجز ${lim} أفراد للعميل في الرحلة`); }
        seats = [];
        for (let k = 1; k <= total && seats.length < n; k++) if (!used.has(k)) seats.push(k);
        if (seats.length < n) { await c.query('ROLLBACK'); throw fail(409, `المتاح ${seats.length} أفراد بس في الرحلة دي`); }
      } else {
        seats = cleanSeats(bb.seats ?? bb.seat, total);
        if (!seats) { await c.query('ROLLBACK'); throw fail(400, 'اختار عدد الأفراد'); }
        if (mine.rows[0].n + seats.length > lim) { await c.query('ROLLBACK'); throw fail(409, `أقصى حجز ${lim} أفراد للعميل في الرحلة`); }
        const clash = seats.find(n => used.has(n));
        if (clash) { await c.query('ROLLBACK'); throw fail(409, 'المقاعد دي اتحجزت، جرّب تاني'); }
      }
      for (const n of seats) await c.query('INSERT INTO trip_seats(trip_id, seat_no, customer_id) VALUES($1,$2,$3)', [id, n, me(req)]);
      await c.query('COMMIT');
      driverId = Number(t.rows[0].driver_id); dest = t.rows[0].dest;
    } catch (e) { try { await c.query('ROLLBACK'); } catch { /* already */ } throw e; } finally { c.release(); }
    const nm = (await pool.query('SELECT name FROM users WHERE id=$1', [me(req)])).rows[0];
    push([driverId], 'حجز جديد 🎟️', `${nm ? nm.name : 'عميل'} حجز ${seats.length} أفراد في رحلة ${dest}`, `trip-${id}`);
    alertOwner('حجز جديد في رحلة محافظات', `${nm ? nm.name : 'عميل'} حجز ${seats.length} أفراد: ${dest}`, `owner-trip-${id}`);
    res.json({ ok: true, seats });
  }));
  app.post('/api/trips/:id/cancel-booking', auth, roles('customer'), guard(async (req, res) => {
    await needOn();
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const t = await pool.query("SELECT driver_id, dest FROM trips WHERE id=$1 AND status='open'", [id]);
    if (!t.rowCount) throw fail(409, 'لا يمكن إلغاء الحجز الآن');
    const r = await pool.query('DELETE FROM trip_seats WHERE trip_id=$1 AND customer_id=$2 RETURNING seat_no', [id, me(req)]);
    if (!r.rowCount) throw fail(404, 'مفيش حجز ليك في الرحلة دي');
    push([Number(t.rows[0].driver_id)], 'تم إلغاء حجز', `عميل ألغى ${r.rowCount} أفراد في رحلة ${t.rows[0].dest}`, `trip-${id}`);
    alertOwner('إلغاء حجز في رحلة', `عميل ألغى ${r.rowCount} أفراد: ${t.rows[0].dest}`, `owner-trip-${id}`);
    res.json({ ok: true });
  }));

  /* ================= owner ================= */
  app.get('/api/admin/trips', ...admin, guard(async (_req, res) => {
    const r = await pool.query(`${TRIP_SQL} WHERE t.depart_at > NOW() - INTERVAL '14 days' ORDER BY t.depart_at DESC LIMIT 100`);
    const sm = await seatsOf(r.rows.map(x => Number(x.id)));
    res.json({ trips: r.rows.map(t => { const rows = sm.get(Number(t.id)) || []; return { ...baseOut(t, rows), driver: t.driver_name, driverId: Number(t.driver_id), plate: t.plate || '', passengers: rows.map(s => ({ seat: s.seat_no, customerId: Number(s.customer_id), name: s.name, phone: s.phone })) }; }) });
  }));
  app.get('/api/admin/trips-settings', ...admin, guard(async (_req, res) => { res.json({ maxPersons: await maxPersons() }); }));
  app.post('/api/admin/trips-settings', ...admin, guard(async (req, res) => {
    const n = Number((req.body || {}).maxPersons);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SEATS_PER_CUSTOMER) throw fail(400, `الحد من 1 إلى ${MAX_SEATS_PER_CUSTOMER}`);
    await pool.query("INSERT INTO service_meta(key, sub, updated_at) VALUES('trips_max_persons',$1,NOW()) ON CONFLICT (key) DO UPDATE SET sub=EXCLUDED.sub, updated_at=NOW()", [String(n)]);
    res.json({ ok: true, maxPersons: n });
  }));
  app.post('/api/admin/trips/:id/cancel', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    await cancelTrip(id, 'TRUE', [], 'من الإدارة');
    res.json({ ok: true });
  }));

  /* ----- the owner's full control (additive): edit an open trip, change its captain, book / remove a passenger ----- */
  const audit = (req, action, id, before, after) => pool.query(
    `INSERT INTO audit_log(actor_user_id, actor_name, action, entity, entity_id, before, after, note)
     VALUES($1::bigint, COALESCE((SELECT name FROM users WHERE id=$1::bigint), 'النظام'), $2, 'trip', $3, $4, $5, '')`,
    [me(req), action, String(id), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]).catch(() => {});
  const bookedIds = async id => (await pool.query('SELECT DISTINCT customer_id FROM trip_seats WHERE trip_id=$1', [id])).rows.map(x => x.customer_id);
  app.patch('/api/admin/trips/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const b = req.body || {};
    const t = await pool.query("SELECT * FROM trips WHERE id=$1 AND status='open'", [id]);
    if (!t.rowCount) throw fail(409, 'لا يمكن تعديل هذه الرحلة (لازم تكون مفتوحة)');
    const old = t.rows[0], set = {}, told = [];
    if (b.price !== undefined) { const p = Number(b.price); if (!Number.isFinite(p) || p < 0 || p > 10000) throw fail(400, 'سعر الكرسي غير صحيح'); set.price = money(p); told.push(`السعر ${set.price} ج`); }
    if (b.seats !== undefined) {
      const n = Number(b.seats), top = (await pool.query('SELECT COALESCE(MAX(seat_no),0)::int AS m FROM trip_seats WHERE trip_id=$1', [id])).rows[0].m;
      if (!Number.isInteger(n) || n < 1 || n > 50) throw fail(400, 'عدد الكراسي من 1 إلى 50');
      if (n < top) throw fail(409, `فيه حجز على كرسي ${top}، مينفعش تقلل الكراسي عن كده`);
      set.seats = n;
    }
    if (b.departAt !== undefined) {
      const w = new Date(b.departAt);
      if (isNaN(w.getTime()) || w.getTime() <= Date.now() || w.getTime() > Date.now() + MAX_DAYS_AHEAD * 86400000) throw fail(400, 'ميعاد الطلوع غير صحيح');
      set.depart_at = w.toISOString(); told.push(`الميعاد ${fmtWhen(set.depart_at)}`);
    }
    if (b.dest !== undefined) { const d = str(b.dest, 40); if (d.length < 2) throw fail(400, 'اكتب المحافظة'); set.dest = d; }
    let newDriver = null;
    if (b.driverId !== undefined) {
      const did = positiveId(b.driverId); if (!did) throw fail(400, 'كابتن غير صالح');
      const p = await pool.query("SELECT 1 FROM captain_profiles WHERE user_id=$1 AND status='approved'", [did]);
      if (!p.rowCount) throw fail(409, 'الكابتن غير مفعّل');
      if (did !== Number(old.driver_id)) { set.driver_id = did; newDriver = did; told.push('الكابتن اتغيّر'); }
    }
    const keys = Object.keys(set); if (!keys.length) throw fail(400, 'مفيش تعديل');
    const sql = keys.map((k, i) => `${k}=$${i + 2}`).join(', ');
    const u = await pool.query(`UPDATE trips SET ${sql}, updated_at=NOW() WHERE id=$1 AND status='open' RETURNING dest`, [id, ...keys.map(k => set[k])]);
    if (!u.rowCount) throw fail(409, 'لا يمكن تعديل هذه الرحلة');
    if (told.length) push(await bookedIds(id), 'تعديل في رحلتك', `رحلة ${u.rows[0].dest}: ${told.join('، ')}`, `trip-${id}`);
    if (newDriver) { push([newDriver], 'رحلة جديدة لك', `رحلة ${u.rows[0].dest} اتحوّلت ليك`, `trip-${id}`); push([Number(old.driver_id)], 'رحلة اتحوّلت', `رحلة ${u.rows[0].dest} اتحوّلت لكابتن تاني`, `trip-${id}`); }
    await audit(req, 'trip.edit', id, { price: Number(old.price), seats: old.seats, departAt: old.depart_at, dest: old.dest, driverId: Number(old.driver_id) }, set);
    res.json({ ok: true });
  }));
  app.post('/api/admin/trips/:id/book', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id), cid = positiveId((req.body || {}).customerId), n = Number((req.body || {}).count || 1);
    if (!id || !cid || !Number.isInteger(n) || n < 1 || n > MAX_SEATS_PER_CUSTOMER) throw fail(400, 'بيانات غير صالحة');
    const u = await pool.query("SELECT name FROM users WHERE id=$1 AND role='customer' AND deleted_at IS NULL", [cid]);
    if (!u.rowCount) throw fail(404, 'العميل غير موجود (استخدم رقم العميل)');
    const c = await pool.connect(); let driverId, dest, seats = [];
    try {
      await c.query('BEGIN');
      const t = await c.query("SELECT * FROM trips WHERE id=$1 AND status='open' AND depart_at > NOW() FOR UPDATE", [id]);
      if (!t.rowCount) { await c.query('ROLLBACK'); throw fail(409, 'الرحلة لم تعد متاحة'); }
      const used = new Set((await c.query('SELECT seat_no FROM trip_seats WHERE trip_id=$1', [id])).rows.map(r => Number(r.seat_no)));
      for (let k = 1; k <= t.rows[0].seats && seats.length < n; k++) if (!used.has(k)) seats.push(k);
      if (seats.length < n) { await c.query('ROLLBACK'); throw fail(409, `المتاح ${seats.length} كراسي بس`); }
      for (const s of seats) await c.query('INSERT INTO trip_seats(trip_id, seat_no, customer_id) VALUES($1,$2,$3)', [id, s, cid]);
      await c.query('COMMIT'); driverId = Number(t.rows[0].driver_id); dest = t.rows[0].dest;
    } catch (e) { try { await c.query('ROLLBACK'); } catch { /* already */ } throw e; } finally { c.release(); }
    push([driverId], 'حجز جديد', `${u.rows[0].name} اتحجز له ${seats.length} في رحلة ${dest} (من الإدارة)`, `trip-${id}`);
    push([cid], 'تم حجزك', `الإدارة حجزتلك ${seats.length} في رحلة ${dest}`, `trip-${id}`);
    await audit(req, 'trip.book', id, null, { customerId: cid, seats });
    res.json({ ok: true, seats });
  }));
  app.post('/api/admin/trips/:id/unbook', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id), cid = positiveId((req.body || {}).customerId); if (!id || !cid) throw fail(400, 'بيانات غير صالحة');
    const t = await pool.query("SELECT driver_id, dest FROM trips WHERE id=$1 AND status='open'", [id]);
    if (!t.rowCount) throw fail(409, 'لا يمكن تعديل الحجز الآن');
    const r = await pool.query('DELETE FROM trip_seats WHERE trip_id=$1 AND customer_id=$2 RETURNING seat_no', [id, cid]);
    if (!r.rowCount) throw fail(404, 'العميل ده مش حاجز في الرحلة');
    push([Number(t.rows[0].driver_id)], 'تم إلغاء حجز', `الإدارة ألغت حجز ${r.rowCount} في رحلة ${t.rows[0].dest}`, `trip-${id}`);
    push([cid], 'تم إلغاء حجزك', `الإدارة ألغت حجزك في رحلة ${t.rows[0].dest}`, `trip-${id}`);
    await audit(req, 'trip.unbook', id, { customerId: cid, seats: r.rows.map(x => x.seat_no) }, null);
    res.json({ ok: true });
  }));
}
module.exports = { cleanTrip, cleanSeats, register, MAX_SEATS_PER_CUSTOMER };
