'use strict';
/**
 * Rides phase 2: captains, ride requests, offers, dispatch and commission.
 * A captain is a normal courier account plus a captain_profiles row (vehicle + photos) the owner reviews.
 * Everything customer/captain-facing is behind the "rides" switch; the owner's panel always works.
 */
const { km: lineKm, validPoint } = require('./tracking');
const { priceFor, bounds, roadDistance } = require('./rides');

const KINDS = ['car', 'license', 'driver', 'selfie'];
const STATUSES = ['pending', 'approved', 'rejected', 'suspended', 'needs_photo'];
const ACTIVE = ['searching', 'assigned', 'arrived', 'started'];
const RIDE_TTL_MIN = 10;

const money = v => Math.round(Number(v) * 100) / 100;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/** Pure: the commission of a finished ride. The captain's own %, else the type's %, else the default; never below the minimum. */
function commissionFor(price, { captainPct, typePct, defaultPct, minFee }) {
  const pct = [captainPct, typePct, defaultPct].find(x => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)));
  const p = Math.max(0, Math.min(100, Number(pct ?? 0)));
  if (p === 0) return 0; // an explicit 0% means exempt: the minimum does not apply
  const c = Math.max(Number(minFee) || 0, money(Number(price) * p / 100));
  return Math.min(money(Number(price)), money(c));
}
/** Pure: may a captain receive rides with this balance and threshold (threshold is negative: how far below zero is allowed)? */
const canReceive = (balance, minBalance) => Number(balance) >= Number(minBalance);

function register(app, { pool, auth, roles, asyncRoute, positiveId, extrasLib, pushToUsers }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => { try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; } });
  const admin = [auth, roles('admin')];
  const me = req => Number(req.auth.sub);
  const on = async () => { try { return await extrasLib.featureOn(pool, 'rides'); } catch { return false; } };
  const needOn = async () => { if (!(await on())) throw fail(404, 'الخدمة غير متاحة الآن'); };
  const push = (ids, title, body, tag) => { try { Promise.resolve(pushToUsers && pushToUsers(ids, { title, body, tag, url: '/' })).catch(() => {}); } catch { /* ignore */ } };
  const settings = async () => (await pool.query('SELECT ride_commission_pct, ride_commission_min, ride_min_balance, ride_auto_dispatch, ride_offer_secs, ride_radius_km FROM app_settings WHERE id=1')).rows[0]
    || { ride_commission_pct: 15, ride_commission_min: 5, ride_min_balance: -50, ride_auto_dispatch: false, ride_offer_secs: 25, ride_radius_km: 5 };

  /* ================= captain: profile + photos ================= */
  app.put('/api/captain/profile', auth, roles('courier'), guard(async (req, res) => {
    await needOn();
    const b = req.body || {};
    const typeId = positiveId(b.typeId); if (!typeId) throw fail(400, 'اختر نوع المركبة');
    const t = await pool.query('SELECT id FROM ride_types WHERE id=$1 AND active', [typeId]);
    if (!t.rowCount) throw fail(404, 'النوع غير متاح');
    const model = str(b.model, 60), color = str(b.color, 30), plate = str(b.plate, 20), nid = str(b.nationalId, 20);
    if (!model || !color || !plate) throw fail(400, 'اكتب الموديل واللون ورقم اللوحة');
    // editing an approved profile sends it back for review so the owner sees the change
    const r = await pool.query(
      `INSERT INTO captain_profiles(user_id, type_id, model, color, plate, national_id) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id) DO UPDATE SET type_id=$2, model=$3, color=$4, plate=$5, national_id=$6,
         status = CASE WHEN captain_profiles.status IN ('suspended','rejected') THEN captain_profiles.status ELSE 'pending' END, updated_at=NOW()
       RETURNING status`, [me(req), typeId, model, color, plate, nid]);
    res.json({ ok: true, status: r.rows[0].status });
  }));
  app.put('/api/captain/photos/:kind', auth, roles('courier'), guard(async (req, res) => {
    await needOn();
    const kind = String(req.params.kind); if (!KINDS.includes(kind)) throw fail(400, 'نوع الصورة غير صحيح');
    const s = String((req.body || {}).image || '');
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(s);
    if (!m || s.length > 1500000) throw fail(400, 'ارفع صورة صالحة (JPG أو PNG أو WebP) بحجم أصغر');
    const p = await pool.query('SELECT status FROM captain_profiles WHERE user_id=$1', [me(req)]);
    if (!p.rowCount) throw fail(409, 'سجّل بيانات المركبة أولاً');
    await pool.query(`INSERT INTO captain_photos(user_id, kind, image, mime) VALUES($1,$2,$3,$4)
      ON CONFLICT (user_id, kind) DO UPDATE SET image=$3, mime=$4, updated_at=NOW()`, [me(req), kind, Buffer.from(m[2], 'base64'), m[1]]);
    if (p.rows[0].status === 'needs_photo') await pool.query("UPDATE captain_profiles SET status='pending', updated_at=NOW() WHERE user_id=$1", [me(req)]);
    res.json({ ok: true });
  }));
  app.get('/api/captain/me', auth, roles('courier'), guard(async (req, res) => {
    const r = await pool.query(`SELECT p.*, t.name AS type_name, ARRAY(SELECT kind FROM captain_photos WHERE user_id=p.user_id) AS photos
      FROM captain_profiles p LEFT JOIN ride_types t ON t.id=p.type_id WHERE p.user_id=$1`, [me(req)]);
    if (!r.rowCount) return res.json({ profile: null });
    const p = r.rows[0], s = await settings();
    res.json({ profile: { status: p.status, note: p.note, typeId: p.type_id, typeName: p.type_name, model: p.model, color: p.color, plate: p.plate, balance: Number(p.balance), photos: p.photos, autoReceive: p.auto_receive, canReceive: p.status === 'approved' && canReceive(p.balance, s.ride_min_balance) } });
  }));

  /* ================= admin: review + control the captains ================= */
  app.get('/api/admin/captains', ...admin, guard(async (req, res) => {
    const st = STATUSES.includes(req.query.status) ? req.query.status : null;
    const r = await pool.query(`SELECT p.user_id, u.name, u.phone, p.status, p.note, p.model, p.color, p.plate, p.balance, p.commission_pct, p.auto_receive, t.name AS type_name,
        ARRAY(SELECT kind FROM captain_photos WHERE user_id=p.user_id) AS photos
      FROM captain_profiles p JOIN users u ON u.id=p.user_id LEFT JOIN ride_types t ON t.id=p.type_id
      WHERE ($1::text IS NULL OR p.status=$1) ORDER BY (p.status='pending') DESC, p.updated_at DESC LIMIT 300`, [st]);
    res.json({ captains: r.rows.map(x => ({ id: Number(x.user_id), name: x.name, phone: x.phone, status: x.status, note: x.note, typeName: x.type_name, model: x.model, color: x.color, plate: x.plate, balance: Number(x.balance), commissionPct: x.commission_pct === null ? null : Number(x.commission_pct), autoReceive: x.auto_receive, photos: x.photos })) });
  }));
  app.get('/api/admin/captains/:id/photo/:kind', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id || !KINDS.includes(req.params.kind)) return res.status(404).end();
    const r = await pool.query('SELECT image, mime FROM captain_photos WHERE user_id=$1 AND kind=$2', [id, req.params.kind]);
    if (!r.rowCount) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime); res.set('Cache-Control', 'private, no-store'); res.send(r.rows[0].image);
  }));
  app.patch('/api/admin/captains/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const b = req.body || {}, sets = [], vals = [id];
    const add = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (b.status !== undefined) { if (!STATUSES.includes(b.status)) throw fail(400, 'حالة غير صحيحة'); add('status', b.status); }
    if (b.note !== undefined) add('note', str(b.note, 300));
    if (b.commissionPct !== undefined) {
      if (b.commissionPct === null || b.commissionPct === '') add('commission_pct', null);
      else { const v = Number(b.commissionPct); if (!Number.isFinite(v) || v < 0 || v > 100) throw fail(400, 'نسبة العمولة 0–100'); add('commission_pct', v); }
    }
    if (b.autoReceive !== undefined) add('auto_receive', !!b.autoReceive);
    if (b.typeId !== undefined) { const t = positiveId(b.typeId); if (!t) throw fail(400, 'نوع غير صالح'); add('type_id', t); }
    for (const [k, col, n] of [['model', 'model', 60], ['color', 'color', 30], ['plate', 'plate', 20]]) if (b[k] !== undefined) add(col, str(b[k], n));
    if (!sets.length) throw fail(400, 'لا يوجد تعديل');
    const r = await pool.query(`UPDATE captain_profiles SET ${sets.join(', ')}, updated_at=NOW() WHERE user_id=$1 RETURNING status, note`, vals);
    if (!r.rowCount) throw fail(404, 'الكابتن غير موجود');
    if (b.status !== undefined) {
      const msg = { approved: 'تم قبول حسابك كابتن. تقدر تستقبل الرحلات الآن', rejected: 'تم رفض طلبك كابتن', needs_photo: 'نحتاج صورة أوضح: ' + r.rows[0].note, suspended: 'تم إيقاف حسابك مؤقتاً' }[b.status];
      if (msg) push([id], 'أطلب أبيس — كابتن', msg, 'captain-status');
    }
    res.json({ ok: true, status: r.rows[0].status });
  }));
  app.post('/api/admin/captains/:id/balance', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const amt = Number((req.body || {}).amount);
    if (!Number.isFinite(amt) || amt === 0 || Math.abs(amt) > 100000) throw fail(400, 'اكتب مبلغاً صحيحاً (موجب للشحن وسالب للخصم)');
    const kind = (req.body || {}).kind === 'adjust' ? 'adjust' : 'topup';
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const u = await c.query('UPDATE captain_profiles SET balance = balance + $2 WHERE user_id=$1 RETURNING balance', [id, money(amt)]);
      if (!u.rowCount) { await c.query('ROLLBACK'); throw fail(404, 'الكابتن غير موجود'); }
      await c.query('INSERT INTO captain_ledger(user_id, kind, amount, note) VALUES($1,$2,$3,$4)', [id, kind, money(amt), str((req.body || {}).note, 200)]);
      await c.query('COMMIT');
      res.json({ ok: true, balance: Number(u.rows[0].balance) });
    } catch (e) { try { await c.query('ROLLBACK'); } catch { /* already */ } throw e; } finally { c.release(); }
  }));
  app.get('/api/admin/captains/:id/ledger', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const r = await pool.query('SELECT id, kind, amount, ride_id, note, created_at FROM captain_ledger WHERE user_id=$1 ORDER BY id DESC LIMIT 100', [id]);
    res.json({ ledger: r.rows.map(x => ({ id: Number(x.id), kind: x.kind, amount: Number(x.amount), rideId: x.ride_id && Number(x.ride_id), note: x.note, at: x.created_at })) });
  }));

  /* ----- the owner's commission + dispatch settings ----- */
  app.get('/api/admin/rides/settings', ...admin, guard(async (_req, res) => {
    const s = await settings();
    res.json({ commissionPct: Number(s.ride_commission_pct), commissionMin: Number(s.ride_commission_min), minBalance: Number(s.ride_min_balance), autoDispatch: !!s.ride_auto_dispatch, offerSecs: s.ride_offer_secs, radiusKm: Number(s.ride_radius_km) });
  }));
  app.patch('/api/admin/rides/settings', ...admin, guard(async (req, res) => {
    const b = req.body || {}, sets = [], vals = [];
    const num = (k, col, lo, hi, int) => { if (b[k] === undefined) return; const v = Number(b[k]); if (!Number.isFinite(v) || v < lo || v > hi) throw fail(400, `قيمة غير صحيحة: ${k}`); vals.push(int ? Math.round(v) : v); sets.push(`${col}=$${vals.length}`); };
    num('commissionPct', 'ride_commission_pct', 0, 100); num('commissionMin', 'ride_commission_min', 0, 1000);
    num('minBalance', 'ride_min_balance', -100000, 0); num('offerSecs', 'ride_offer_secs', 10, 120, true); num('radiusKm', 'ride_radius_km', 0.5, 100);
    if (b.autoDispatch !== undefined) { vals.push(!!b.autoDispatch); sets.push(`ride_auto_dispatch=$${vals.length}`); }
    if (!sets.length) throw fail(400, 'لا يوجد تعديل');
    await pool.query(`UPDATE app_settings SET ${sets.join(', ')} WHERE id=1`, vals);
    res.json({ ok: true });
  }));
  app.patch('/api/admin/ride-types/:id/commission', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const raw = (req.body || {}).commissionPct;
    let v = null; if (raw !== null && raw !== '' && raw !== undefined) { v = Number(raw); if (!Number.isFinite(v) || v < 0 || v > 100) throw fail(400, 'نسبة العمولة 0–100'); }
    const r = await pool.query('UPDATE ride_types SET commission_pct=$2, updated_at=NOW() WHERE id=$1 RETURNING id', [id, v]);
    if (!r.rowCount) throw fail(404, 'النوع غير موجود');
    res.json({ ok: true });
  }));

  /* ================= rides ================= */
  const RIDE_COLS = `r.id, r.status, r.type_id, r.from_lat, r.from_lng, r.from_text, r.to_lat, r.to_lng, r.to_text, r.km, r.minutes, r.suggested, r.offered, r.final_price, r.driver_id, r.expires_at, r.created_at`;
  const rideOut = r => ({ id: Number(r.id), status: r.status, typeId: r.type_id, from: { lat: r.from_lat, lng: r.from_lng, text: r.from_text }, to: { lat: r.to_lat, lng: r.to_lng, text: r.to_text }, km: Number(r.km), minutes: r.minutes, suggested: Number(r.suggested), offered: Number(r.offered), finalPrice: r.final_price === null ? null : Number(r.final_price), driverId: r.driver_id && Number(r.driver_id), expiresAt: r.expires_at });

  /** Captains who may get this ride: approved, right type, online, with enough balance, inside the radius (nearest first). */
  async function eligibleCaptains(ride, s) {
    const r = await pool.query(`SELECT p.user_id, p.auto_receive, l.lat, l.lng FROM captain_profiles p
      JOIN users u ON u.id=p.user_id AND u.available
      JOIN courier_locations l ON l.courier_id=p.user_id AND l.updated_at > NOW() - INTERVAL '5 minutes'
      WHERE p.status='approved' AND p.type_id=$1 AND p.balance >= $2
        AND NOT EXISTS (SELECT 1 FROM rides x WHERE x.driver_id=p.user_id AND x.status IN ('assigned','arrived','started'))`, [ride.type_id, s.ride_min_balance]);
    return r.rows.map(x => ({ id: Number(x.user_id), auto: x.auto_receive, d: lineKm(ride.from_lat, ride.from_lng, x.lat, x.lng) }))
      .filter(x => x.d <= Number(s.ride_radius_km)).sort((a, b) => a.d - b.d);
  }
  async function assign(rideId, driverId, price) {
    const r = await pool.query(`UPDATE rides SET status='assigned', driver_id=$2, final_price=$3, updated_at=NOW()
      WHERE id=$1 AND status='searching' AND expires_at > NOW() RETURNING customer_id`, [rideId, driverId, money(price)]);
    return r.rowCount ? Number(r.rows[0].customer_id) : null;
  }

  app.post('/api/rides', auth, roles('customer'), guard(async (req, res) => {
    await needOn();
    const b = req.body || {};
    if (!validPoint(Number((b.from || {}).lat), Number((b.from || {}).lng)) || !validPoint(Number((b.to || {}).lat), Number((b.to || {}).lng))) throw fail(400, 'حدد نقطة التحميل والوجهة');
    const typeId = positiveId(b.typeId); if (!typeId) throw fail(400, 'اختر نوع المركبة');
    const t = await pool.query('SELECT * FROM ride_types WHERE id=$1 AND active', [typeId]);
    if (!t.rowCount) throw fail(404, 'النوع غير متاح');
    const open = await pool.query("SELECT 1 FROM rides WHERE customer_id=$1 AND status = ANY($2) AND expires_at > NOW() - INTERVAL '1 day'", [me(req), ACTIVE]);
    if (open.rowCount) throw fail(409, 'عندك رحلة شغالة بالفعل');
    const d = await roadDistance(b.from, b.to);
    const suggested = priceFor(t.rows[0], d.km), bd = bounds(suggested, t.rows[0].adj_pct);
    const offered = Number(b.price); if (!Number.isFinite(offered) || offered < bd.lo || offered > bd.hi) throw fail(400, `السعر لازم يكون بين ${bd.lo} و${bd.hi}`);
    const ins = await pool.query(`INSERT INTO rides(customer_id, type_id, from_lat, from_lng, from_text, to_lat, to_lng, to_text, km, minutes, suggested, offered, expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW() + ($13 || ' minutes')::interval) RETURNING *`,
      [me(req), typeId, Number(b.from.lat), Number(b.from.lng), str(b.from.text, 200), Number(b.to.lat), Number(b.to.lng), str(b.to.text, 200), d.km, d.min, suggested, offered, String(RIDE_TTL_MIN)]);
    const ride = ins.rows[0], s = await settings();
    const cands = await eligibleCaptains(ride, s);
    let assignedTo = null;
    if (s.ride_auto_dispatch) {
      const pick = cands.find(c => c.auto);
      if (pick && (await assign(ride.id, pick.id, offered))) { assignedTo = pick.id; push([pick.id], 'رحلة جديدة لك', `${d.km} كم — ${offered} ج`, `ride-${ride.id}`); }
    }
    if (!assignedTo) push(cands.map(c => c.id), 'طلب رحلة جديد', `${d.km} كم — ${offered} ج`, `ride-${ride.id}`);
    const fresh = await pool.query(`SELECT ${RIDE_COLS} FROM rides r WHERE id=$1`, [ride.id]);
    res.json({ ride: rideOut(fresh.rows[0]), notified: cands.length });
  }));
  app.get('/api/rides/current', auth, roles('customer'), guard(async (req, res) => {
    const r = await pool.query(`SELECT ${RIDE_COLS} FROM rides r WHERE customer_id=$1 AND (status = ANY($2) OR updated_at > NOW() - INTERVAL '2 minutes') ORDER BY id DESC LIMIT 1`, [me(req), ACTIVE]);
    if (!r.rowCount) return res.json({ ride: null, offers: [] });
    const o = await pool.query(`SELECT o.id, o.price, o.status, o.driver_id, u.name, p.model, p.color, p.plate FROM ride_offers o JOIN users u ON u.id=o.driver_id JOIN captain_profiles p ON p.user_id=o.driver_id
      WHERE o.ride_id=$1 AND o.status IN ('open','accepted') ORDER BY o.price`, [r.rows[0].id]);
    res.json({ ride: rideOut(r.rows[0]), offers: o.rows.map(x => ({ id: Number(x.id), price: Number(x.price), status: x.status, driver: { id: Number(x.driver_id), name: x.name, model: x.model, color: x.color, plate: x.plate } })) });
  }));
  app.post('/api/rides/:id/accept-offer', auth, roles('customer'), guard(async (req, res) => {
    const id = positiveId(req.params.id), oid = positiveId((req.body || {}).offerId); if (!id || !oid) throw fail(400, 'بيانات غير صالحة');
    const o = await pool.query(`SELECT o.driver_id, o.price FROM ride_offers o JOIN rides r ON r.id=o.ride_id WHERE o.id=$1 AND o.ride_id=$2 AND r.customer_id=$3 AND o.status='open'`, [oid, id, me(req)]);
    if (!o.rowCount) throw fail(404, 'العرض غير موجود');
    const cust = await assign(id, Number(o.rows[0].driver_id), o.rows[0].price);
    if (!cust) throw fail(409, 'الرحلة لم تعد متاحة');
    await pool.query("UPDATE ride_offers SET status = CASE WHEN id=$1 THEN 'accepted' ELSE 'rejected' END WHERE ride_id=$2 AND status='open'", [oid, id]);
    push([Number(o.rows[0].driver_id)], 'تم قبول عرضك', `رحلة ${money(o.rows[0].price)} ج`, `ride-${id}`);
    res.json({ ok: true });
  }));
  app.post('/api/rides/:id/cancel', auth, roles('customer'), guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const r = await pool.query("UPDATE rides SET status='cancelled', updated_at=NOW() WHERE id=$1 AND customer_id=$2 AND status IN ('searching','assigned','arrived') RETURNING driver_id", [id, me(req)]);
    if (!r.rowCount) throw fail(409, 'لا يمكن إلغاء هذه الرحلة');
    if (r.rows[0].driver_id) push([Number(r.rows[0].driver_id)], 'تم إلغاء الرحلة', 'العميل ألغى الرحلة', `ride-${id}`);
    res.json({ ok: true });
  }));

  /* ----- the captain ----- */
  const needCaptain = async (req) => {
    await needOn();
    const p = await pool.query('SELECT status, balance, type_id, commission_pct FROM captain_profiles WHERE user_id=$1', [me(req)]);
    if (!p.rowCount || p.rows[0].status !== 'approved') throw fail(403, 'حسابك كابتن غير مفعّل بعد');
    return p.rows[0];
  };
  /** the captain's trip in progress (accepted by the customer): both points, the written details and the customer to call */
  app.get('/api/captain/current', auth, roles('courier'), guard(async (req, res) => {
    await needCaptain(req);
    const r = await pool.query(`SELECT ${RIDE_COLS}, u.name AS customer_name, u.phone AS customer_phone FROM rides r JOIN users u ON u.id=r.customer_id
      WHERE r.driver_id=$1 AND r.status IN ('assigned','arrived','started') ORDER BY r.id DESC LIMIT 1`, [me(req)]);
    if (!r.rowCount) return res.json({ ride: null });
    const x = r.rows[0];
    res.json({ ride: { ...rideOut(x), customer: { name: String(x.customer_name || '').split(' ')[0], phone: x.customer_phone } } });
  }));
  app.get('/api/captain/requests', auth, roles('courier'), guard(async (req, res) => {
    const p = await needCaptain(req), s = await settings();
    if (!canReceive(p.balance, s.ride_min_balance)) throw fail(403, 'رصيدك غير كافٍ. اشحن رصيدك لاستقبال الرحلات');
    const loc = await pool.query('SELECT lat, lng FROM courier_locations WHERE courier_id=$1', [me(req)]);
    const r = await pool.query(`SELECT ${RIDE_COLS}, (SELECT price FROM ride_offers WHERE ride_id=r.id AND driver_id=$2) AS my_offer FROM rides r
      WHERE r.status='searching' AND r.expires_at > NOW() AND r.type_id=$1 ORDER BY r.id DESC LIMIT 30`, [p.type_id, me(req)]);
    const L = loc.rows[0];
    res.json({ requests: r.rows.map(x => ({ ...rideOut(x), myOffer: x.my_offer === null ? null : Number(x.my_offer), pickupKm: L ? Math.round(lineKm(x.from_lat, x.from_lng, L.lat, L.lng) * 10) / 10 : null })).filter(x => x.pickupKm === null || x.pickupKm <= Number(s.ride_radius_km)), offerSecs: s.ride_offer_secs });
  }));
  /** accept at the customer's price (price omitted) or counter-offer another price inside the allowed range */
  app.post('/api/captain/requests/:id/offer', auth, roles('courier'), guard(async (req, res) => {
    const p = await needCaptain(req), s = await settings();
    if (!canReceive(p.balance, s.ride_min_balance)) throw fail(403, 'رصيدك غير كافٍ');
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const r = await pool.query(`SELECT r.*, t.adj_pct FROM rides r JOIN ride_types t ON t.id=r.type_id WHERE r.id=$1 AND r.status='searching' AND r.expires_at > NOW() AND r.type_id=$2`, [id, p.type_id]);
    if (!r.rowCount) throw fail(404, 'الطلب لم يعد متاحاً');
    const ride = r.rows[0], raw = (req.body || {}).price;
    if (raw === undefined || raw === null || Number(raw) === Number(ride.offered)) {
      const cust = await assign(id, me(req), ride.offered);
      if (!cust) throw fail(409, 'سبقك كابتن آخر');
      await pool.query("UPDATE ride_offers SET status='rejected' WHERE ride_id=$1 AND status='open'", [id]);
      push([cust], 'كابتنك في الطريق', `تم قبول طلبك بسعر ${money(ride.offered)} ج`, `ride-${id}`);
      return res.json({ ok: true, accepted: true });
    }
    const price = Number(raw), bd = bounds(Number(ride.suggested), ride.adj_pct);
    if (!Number.isFinite(price) || price < bd.lo || price > bd.hi) throw fail(400, `العرض لازم يكون بين ${bd.lo} و${bd.hi}`);
    const cap = await pool.query('SELECT can_counter FROM captain_profiles WHERE user_id=$1', [me(req)]);
    if (!cap.rows[0].can_counter) throw fail(403, 'غير مسموح لك بعرض سعر مختلف');
    await pool.query(`INSERT INTO ride_offers(ride_id, driver_id, price) VALUES($1,$2,$3)
      ON CONFLICT (ride_id, driver_id) DO UPDATE SET price=$3, status='open', created_at=NOW()`, [id, me(req), money(price)]);
    push([Number(ride.customer_id)], 'عرض سعر جديد', `كابتن عرض ${money(price)} ج`, `ride-${id}`);
    res.json({ ok: true, accepted: false });
  }));
  /** arrived / started / completed — completing takes the commission from the captain's balance */
  app.post('/api/captain/rides/:id/status', auth, roles('courier'), guard(async (req, res) => {
    await needOn();
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const to = String((req.body || {}).status), from = { arrived: 'assigned', started: 'arrived', completed: 'started' }[to];
    if (!from) throw fail(400, 'حالة غير صحيحة');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query('SELECT r.customer_id, r.final_price, r.type_id FROM rides r WHERE r.id=$1 AND r.driver_id=$2 AND r.status=$3 FOR UPDATE', [id, me(req), from]);
      if (!r.rowCount) { await c.query('ROLLBACK'); throw fail(409, 'لا يمكن تغيير حالة هذه الرحلة'); }
      let commission = null;
      if (to === 'completed') {
        const s = await settings();
        const cp = await c.query('SELECT commission_pct FROM captain_profiles WHERE user_id=$1', [me(req)]);
        const tp = await c.query('SELECT commission_pct FROM ride_types WHERE id=$1', [r.rows[0].type_id]);
        commission = commissionFor(r.rows[0].final_price, { captainPct: cp.rows[0].commission_pct, typePct: tp.rows[0] && tp.rows[0].commission_pct, defaultPct: s.ride_commission_pct, minFee: s.ride_commission_min });
        const nb = await c.query('UPDATE captain_profiles SET balance = balance - $2 WHERE user_id=$1 RETURNING balance', [me(req), commission]);
        await c.query("INSERT INTO captain_ledger(user_id, kind, amount, ride_id, note) VALUES($1,'commission',$2,$3,'عمولة رحلة')", [me(req), -commission, id]);
        if (!canReceive(nb.rows[0].balance, s.ride_min_balance)) await c.query("UPDATE captain_profiles SET status='suspended', note='تم الإيقاف تلقائياً: الرصيد أقل من الحد المسموح' WHERE user_id=$1 AND status='approved'", [me(req)]);
      }
      await c.query('UPDATE rides SET status=$2, commission=COALESCE($3, commission), updated_at=NOW() WHERE id=$1', [id, to, commission]);
      await c.query('COMMIT');
      push([Number(r.rows[0].customer_id)], 'رحلتك', { arrived: 'الكابتن وصل', started: 'بدأت الرحلة', completed: 'وصلت بالسلامة' }[to], `ride-${id}`);
      res.json({ ok: true, commission });
    } catch (e) { try { await c.query('ROLLBACK'); } catch { /* already */ } throw e; } finally { c.release(); }
  }));

  /* ================= admin: watch + assign by hand ================= */
  app.get('/api/admin/rides', ...admin, guard(async (req, res) => {
    const st = String(req.query.status || '');
    const r = await pool.query(`SELECT ${RIDE_COLS}, c.name AS customer, d.name AS driver FROM rides r JOIN users c ON c.id=r.customer_id LEFT JOIN users d ON d.id=r.driver_id
      WHERE ($1='' OR r.status=$1) ORDER BY r.id DESC LIMIT 100`, [st]);
    res.json({ rides: r.rows.map(x => ({ ...rideOut(x), customer: x.customer, driver: x.driver })) });
  }));
  app.post('/api/admin/rides/:id/assign', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id), did = positiveId((req.body || {}).driverId); if (!id || !did) throw fail(400, 'بيانات غير صالحة');
    const p = await pool.query("SELECT 1 FROM captain_profiles WHERE user_id=$1 AND status='approved'", [did]);
    if (!p.rowCount) throw fail(409, 'الكابتن غير مفعّل');
    const r = await pool.query('SELECT offered, status FROM rides WHERE id=$1', [id]);
    if (!r.rowCount) throw fail(404, 'الرحلة غير موجودة');
    // the owner may reassign a ride that is still searching or already assigned (before the captain arrives)
    const u = await pool.query("UPDATE rides SET status='assigned', driver_id=$2, final_price=COALESCE(final_price, offered), expires_at=GREATEST(expires_at, NOW() + INTERVAL '10 minutes'), updated_at=NOW() WHERE id=$1 AND status IN ('searching','assigned') RETURNING customer_id", [id, did]);
    if (!u.rowCount) throw fail(409, 'لا يمكن تحويل هذه الرحلة');
    push([did], 'رحلة جديدة لك', `سعر ${money(r.rows[0].offered)} ج`, `ride-${id}`);
    push([Number(u.rows[0].customer_id)], 'كابتنك في الطريق', 'تم تعيين كابتن لرحلتك', `ride-${id}`);
    res.json({ ok: true });
  }));
}
module.exports = { commissionFor, canReceive, register };
