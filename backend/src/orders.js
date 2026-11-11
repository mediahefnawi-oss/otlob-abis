'use strict';
/**
 * Central orders, invoices, bookings and chat.
 * The app mirrors /api/sync into its screens; every state change goes through one of the POST/PATCH routes below,
 * so the server alone decides who may do what (and who wins when two couriers tap "accept" together).
 */
const crypto = require('crypto');
const commissions = require('./commissions');
const services = require('./services');
const offersLib = require('./offers');
const kmFee = require('./kmfee');
const tracking = require('./tracking');
const mapMode = require('./mapmode');
const couponsLib = require('./coupons');
const extrasLib = require('./extras');
const poolLib = require('./pool');
const voiceLib = require('./voice');
module.exports = function registerOrderRoutes(app, { pool, auth, authAny, roles, asyncRoute, positiveId, maintenanceState, loadSettings, cleanUser, pushToUsers }) {
  const num = v => Number(v) || 0;
  const ms = d => new Date(d).getTime();
  const PHONE = /^01[0-9]{9}$/;
  const normPhone = v => String(v || '').replace(/\s+/g, '');
  const BUSY = ['accepted', 'quoted', 'ready', 'picked_up', 'on_the_way', 'arrived'];
  const CUSTOM_NAME = 'طلب خاص — اطلب إيه؟';

  /* ---------- row -> app shape ---------- */
  const orderJson = r => {
    const d = r.data || {};
    return {
      id: String(r.id), number: Number(r.order_number), groupId: String(d.groupId || ''), invoiceId: String(d.invoiceId || ''), ...(d.scheduledFor ? { scheduledFor: Number(d.scheduledFor) } : {}), ...(d.hasVoice ? { hasVoice: true, voiceSecs: Number(d.voiceSecs) || 0 } : {}), ...(d.pool && d.pool.groupId && d.pool.size > 1 ? { pool: { size: d.pool.size, fullFee: num(d.pool.fullFee), share: num(d.pool.share) } } : d.pool && d.pool.want ? { pool: { size: 1, fullFee: num(d.pool.fullFee), share: num(d.pool.fullFee) } } : {}),
      customerId: String(r.customer_user_id), customerName: d.customerName || '', phone: d.phone || '', phone2: d.phone2 || '', address: d.address || '', notes: d.notes || '',
      providerId: r.provider_id ? String(r.provider_id) : 'custom', providerName: d.providerName || '', providerType: d.providerType || 'custom',
      providerOwnerId: d.providerOwnerId ? String(d.providerOwnerId) : '', items: d.items || [], customText: d.customText || undefined,
      request: d.request ? { text: d.request.text || '', hasImage: !!d.request.hasImage } : undefined, subtotal: num(d.subtotal), discount: d.discount > 0 ? num(d.discount) : undefined, couponCode: d.discount > 0 ? d.couponCode : undefined, giftCode: d.giftCode || undefined, deliveryFee: num(d.deliveryFee), total: num(r.total), status: r.status,
      courierId: r.courier_user_id ? String(r.courier_user_id) : undefined, courierName: d.courierName || undefined, courierPhone: d.courierPhone || undefined, courierVehicle: d.courierVehicle || undefined, rejectReason: d.rejectReason || undefined, readyDate: d.readyDate || undefined, readyTime: d.readyTime || undefined,
      regionId: r.region_id ? String(r.region_id) : undefined, regionName: d.regionName || undefined, providerRegionName: d.providerRegionName || undefined,
      createdAt: ms(r.created_at), updatedAt: ms(r.updated_at), history: d.history || [], autoPending: r.courier_user_id && d.autoAssigned && !d.courierAck && ['accepted', 'ready'].includes(r.status) ? true : undefined, staffHandled: d.staffHandled ? true : undefined, staffDismissed: d.staffDismissed ? true : undefined, cancelledBy: d.cancelledBy || undefined, errandQuote: d.errandQuote || undefined,
    };
  };
  const invoiceJson = r => ({
    ...(r.data || {}), id: String(r.id), kind: r.kind, customerId: String(r.customer_user_id), total: num(r.total), createdAt: ms(r.created_at),
    number: (r.data && r.data.number) || `INV-${r.invoice_number}`, parts: (r.data && r.data.parts) || [],
  });
  const apptJson = r => {
    const d = r.data || {};
    return {
      id: String(r.id), number: 500 + Number(r.id), customerId: String(r.customer_user_id), patientName: d.patientName || '', phone: d.phone || '',
      providerId: String(r.provider_id), clinicName: d.clinicName || '', clinicOwnerId: String(d.clinicOwnerId || ''), clinicAddress: d.clinicAddress || '',
      doctorId: r.doctor_product_id ? String(r.doctor_product_id) : '', doctorName: d.doctorName || '', specialty: d.specialty || '',
      date: r.date_str, time: r.appointment_time, fee: num(r.fee), notes: d.notes || '', status: r.status,
      invoiceId: d.invoiceId ? String(d.invoiceId) : undefined, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at),
      ...(d.kind === 'clinic_set' ? { clinicSet: { stage: d.stage || 'awaiting' } } : {}),
      ...(d.kind === 'lab' && d.lab ? { lab: { stage: d.lab.stage || 'new', reason: d.lab.reason || '', hasRx: !!d.lab.hasRx, hasReport: !!d.lab.hasReport, reportName: d.lab.reportName || '', note: d.lab.note || '' } } : {}),
    };
  };
  const messageJson = r => ({
    id: String(r.id), orderId: String(r.order_id), senderId: r.sender_user_id ? String(r.sender_user_id) : 'system',
    senderName: r.sender_name || '', senderRole: r.sender_role || 'system', text: r.body, createdAt: ms(r.created_at),
  });
  const APPT_SQL = "SELECT a.*, to_char(a.appointment_date,'YYYY-MM-DD') AS date_str FROM appointments a";

  /* ---------- helpers ---------- */
  async function sysMsg(db, orderId, text) {
    await db.query("INSERT INTO messages(order_id, sender_user_id, sender_name, sender_role, body) VALUES($1,NULL,'النظام','system',$2)", [orderId, text]);
  }
  async function regionOf(db, userId) {
    const r = await db.query('SELECT u.region_id, g.name, g.delivery_fee FROM users u LEFT JOIN regions g ON g.id=u.region_id AND g.active=TRUE WHERE u.id=$1', [userId]);
    const row = r.rows[0] || {};
    return row.name ? { id: row.region_id, name: row.name, fee: Number(row.delivery_fee) } : null;
  }
  /** The owner's price for delivering from this shop's area to the customer's area (null = none set: the customer's area price is used). */
  async function routeFee(db, providerId, customerRegionId) {
    if (!customerRegionId) return null;
    try {
      const r = await db.query('SELECT rp.price FROM providers p JOIN users u ON u.id=p.owner_user_id JOIN route_prices rp ON rp.from_region_id=u.region_id AND rp.to_region_id=$2 WHERE p.id=$1', [providerId, customerRegionId]);
      return r.rowCount ? Number(r.rows[0].price) : null;
    } catch { return null; } // table not migrated yet: never block an order
  }
  /** What a customer pays for delivery from a shop: only the owner's route price counts. A route without a price is closed. */
  async function deliveryFeeFor(db, prov, region, fallback, customerId, dest) {
    if (['booking', 'lab'].includes(services.tplOf(prov.type))) return 0;
    // owner's "by kilometre" switch: priced from the shop's spot to the customer's spot; without both spots the area price below applies
    if (customerId) { const k = await kmFee.forOrder(db, prov.id, customerId, dest); if (k) return k.fee; }
    if (!region) return Number(fallback) || 0; // an old customer account with no area: the shop's own price
    const r = await routeFee(db, prov.id, region.id);
    if (r === null) throw fail(409, `التوصيل من منطقة ${prov.name} إلى منطقتك غير متاح حالياً`);
    return r;
  }
  /**
   * Where this order goes on the map. The customer chooses: his saved spot (default), or "another address" - with a pin picked for this order, or none.
   * Returns undefined = saved spot, null = no pin, {lat,lng} = that pin.
   */
  const destOf = b => {
    if (!b || !b.destMode) return undefined; // an older app version: the saved spot, as before
    if (b.destMode === 'none') return null;
    const lat = Number(b.destLat), lng = Number(b.destLng);
    return tracking.validPoint(lat, lng) ? { lat, lng } : null;
  };
  /** One place for the rules: maps off = no pin at all; maps on and "required" = a new app must send a pin. Returns the destination to store. */
  const destRule = async (b) => {
    const mode = await mapMode.load(pool);
    if (!mode.enabled) return null;
    const dest = destOf(b);
    if (mode.required && b && b.destMode && dest === null) throw fail(400, 'حدد موقع التوصيل على الخريطة أولاً');
    return dest;
  };
  /** The first pin a customer ever sends becomes his saved spot (the owner sees it in his page); later pins belong to their orders only. */
  const rememberSpot = async (userId, dest) => {
    if (!dest) return;
    try { await pool.query('UPDATE users SET home_lat=COALESCE(home_lat,$1), home_lng=COALESCE(home_lng,$2) WHERE id=$3', [dest.lat, dest.lng, userId]); } catch { /* never blocks an order */ }
  };
  const destPoint = (user, dest) => {
    if (dest === null) return {};
    if (dest) return { destLat: dest.lat, destLng: dest.lng, destOther: true };
    return user.home_lat != null && user.home_lng != null ? { destLat: Number(user.home_lat), destLng: Number(user.home_lng) } : {};
  };
  /** The owner's label on the customer (trusted / watch / fraud), copied onto the order so shops and couriers see it. */
  async function flagData(db, userId, dest) {
    try {
      const r = await db.query('SELECT account_flag, flag_note, phone2, home_lat, home_lng FROM users WHERE id=$1', [userId]);
      const x = r.rows[0] || {};
      // the customer's optional second number travels with the order so the shop and courier can ring it if the first does not answer
      return { ...(x.account_flag ? { customerFlag: x.account_flag, customerFlagNote: x.flag_note || '' } : {}), ...(x.phone2 ? { phone2: x.phone2 } : {}), ...(destPoint(x, dest)) };
    } catch { return {}; } // column not migrated yet: never block an order because of a label
  }
  // shops, couriers and the owner see the label; the customer never does
  // After delivery, shops and couriers no longer see the customer's name / phone / address / notes (the owner can switch it off or change the delay).
  const privacyMask = (r, role, pv) => !!(pv && pv.on && (role === 'provider' || role === 'courier') && r.status === 'delivered'
    && Date.now() - new Date(r.delivered_at || r.updated_at).getTime() > Math.max(0, Number(pv.minutes) || 1) * 60000);
  const orderJsonFor = (r, role, pv) => {
    let o = orderJson(r);
    const d = r.data || {};
    if (o.giftCode && role !== 'customer' && role !== 'admin' && role !== 'supervisor') o = { ...o, giftCode: undefined }; // the owner's gift is for the customer only
    if (privacyMask(r, role, pv)) o = { ...o, customerName: 'عميل', phone: '', phone2: '', address: '', notes: '', privacyMasked: true };
    return role === 'customer' || !d.customerFlag ? o : { ...o, customerFlag: d.customerFlag, customerFlagNote: d.customerFlagNote || undefined };
  };
  const apptJsonFor = (r, role) => {
    const a = apptJson(r);
    const d = r.data || {};
    return role === 'customer' || !d.customerFlag ? a : { ...a, customerFlag: d.customerFlag, customerFlagNote: d.customerFlagNote || undefined };
  };
  /** The area the provider registered in (the owner's area): shown to the courier as "from area X to area Y". */
  async function providerRegionName(db, providerId) {
    const r = await db.query('SELECT g.name FROM providers p JOIN users u ON u.id=p.owner_user_id LEFT JOIN regions g ON g.id=u.region_id WHERE p.id=$1', [providerId]);
    return (r.rows[0] && r.rows[0].name) || undefined;
  }
  /** Writes a status change (history + timestamps) on a row that is already locked by the caller. */
  const isErrand = row => !!(row.data && row.data.providerType === 'custom');
  async function resetErrandInvoice(db, row) {
    const iv = await db.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [Number(row.data.invoiceId)]);
    if (!iv.rowCount) return;
    const idata = iv.rows[0].data || {};
    const parts = (idata.parts || []).map(pt => String(pt.orderId) === String(row.id) ? { ...pt, subtotal: 0, deliveryFee: 0 } : pt);
    await db.query('UPDATE invoices SET total=0, data=$1 WHERE id=$2', [JSON.stringify({ ...idata, parts }), iv.rows[0].id]);
  }
  async function moveOrder(db, row, status, dataPatch = {}, courier) {
    // "شير اللقمة": a member whose shop accepts late gets the courier already working on its group
    if (courier === undefined && !row.courier_user_id && status === 'accepted' && ((row.data || {}).pool || {}).groupId) {
      try { const gc = await poolLib.groupCourier(db, row); if (gc) courier = gc; } catch (e) { console.error('pool groupCourier:', e.message); }
    }
    const d = { ...(row.data || {}), ...dataPatch };
    if (status !== row.status) d.history = [...(d.history || []), { status, at: Date.now() }];
    const cid = courier === undefined ? row.courier_user_id : courier ? courier.id : null;
    if (courier !== undefined) {
      d.courierName = courier ? courier.name : undefined;
      d.courierPhone = courier ? courier.phone : undefined;
      d.courierVehicle = courier ? courier.vehicle : undefined;
    }
    const r = await db.query('UPDATE orders SET status=$1, data=$2, courier_user_id=$3, updated_at=NOW() WHERE id=$4 RETURNING *', [status, JSON.stringify(d), cid, row.id]);
    if (status === 'cancelled' && status !== row.status && d.couponCode) await couponsLib.release(db, row.id); // a cancelled order gives its discount code back
    // "شير اللقمة": the same courier on the whole group; a member leaving re-prices the rest (only while no courier is on the group)
    if (d.pool && d.pool.groupId) {
      try {
        if (courier) await poolLib.syncCourier(db, r.rows[0], { id: cid, name: d.courierName, phone: d.courierPhone, vehicle: d.courierVehicle });
        if (['cancelled', 'rejected', 'unavailable'].includes(status) && status !== row.status) await poolLib.recalc(db, d.pool.groupId);
      } catch (e) { console.error('pool sync:', e.message); }
    }
    return r.rows[0];
  }
  /**
   * Auto-assign (when the owner switched it on): an available courier of the order's area, the NEAREST to the shop first.
   * score = km from the shop to the courier's live position (seen in the last 3 minutes) + 2 km for every order he already carries;
   * a courier with no recent position counts as far away. Without a shop position the least busy courier wins.
   * Couriers who already ignored this order (autoSkip) are left out. No courier = the order waits for a courier to take it.
   * The courier must open the order within ACK_MS, otherwise it moves on to the next one (see sweepUnacked).
   */
  const ACK_MS = 2 * 60 * 1000;
  const NEAR_FRESH = "INTERVAL '3 minutes'";
  /* ---------- scheduled orders (switch "schedule"): the customer asks for a later delivery time (30 minutes to 2 days ahead) ---------- */
  const SCHED_MIN = 30 * 60 * 1000, SCHED_MAX = 48 * 3600 * 1000, SCHED_HOLD = 60 * 60 * 1000;
  async function scheduleOf(b) {
    if (b.scheduledFor === undefined || b.scheduledFor === null || b.scheduledFor === '') return 0;
    if (!(await extrasLib.featureOn(pool, 'schedule'))) throw fail(409, 'الطلب المجدول غير متاح حاليًا');
    const t = Number(b.scheduledFor);
    if (!Number.isFinite(t)) throw fail(400, 'وقت التوصيل غير صالح');
    if (t < Date.now() + SCHED_MIN) throw fail(400, 'اختر وقتًا بعد نصف ساعة على الأقل');
    if (t > Date.now() + SCHED_MAX) throw fail(400, 'الطلب المجدول لحد يومين قدام بس');
    return Math.round(t);
  }
  const schedText = t => new Date(Number(t)).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo', weekday: 'long', hour: 'numeric', minute: '2-digit' });
  /** A scheduled order stays out of the automatic courier hand-out until its time is within the hour. */
  const holdsCouriers = row => { const t = Number((row.data || {}).scheduledFor) || 0; return t > Date.now() + SCHED_HOLD; };
  async function tryAutoAssign(db, row) {
    if (row.courier_user_id) return row;
    if (holdsCouriers(row)) return row;
    const s = await db.query('SELECT auto_assign FROM app_settings WHERE id=1');
    if (!s.rowCount || !s.rows[0].auto_assign) return row;
    if (row.region_id == null) return row;
    const skip = ((row.data && row.data.autoSkip) || []).map(Number).filter(Boolean);
    const c = await db.query(
      `SELECT u.id, u.name, u.phone, u.vehicle, u.available_since,
              (SELECT COUNT(*) FROM orders o WHERE o.courier_user_id=u.id AND o.status = ANY($1))::int AS busy,
              cl.lat, cl.lng
         FROM users u LEFT JOIN courier_locations cl ON cl.courier_id=u.id AND cl.updated_at > NOW() - ${NEAR_FRESH}
        WHERE u.role='courier' AND u.status='active' AND u.available=TRUE AND u.deleted_at IS NULL
          AND u.region_id = $2::bigint AND NOT (u.id = ANY($3::bigint[]))`, [BUSY, row.region_id, skip]);
    if (!c.rowCount) return row;
    let shop = null;
    if (row.provider_id) {
      try { const p = (await db.query('SELECT lat, lng FROM providers WHERE id=$1', [row.provider_id])).rows[0]; if (p && p.lat != null && p.lng != null) shop = { lat: Number(p.lat), lng: Number(p.lng) }; } catch { /* not migrated: no shop position */ }
    }
    const scored = c.rows.map(x => {
      const km = shop && x.lat != null ? tracking.km(shop.lat, shop.lng, Number(x.lat), Number(x.lng)) : null;
      return { x, km, score: shop ? (km == null ? 99 : km) + 2 * x.busy : x.busy };
    }).sort((a, b) => a.score - b.score || (a.x.available_since ? new Date(a.x.available_since).getTime() : Infinity) - (b.x.available_since ? new Date(b.x.available_since).getTime() : Infinity));
    const best = scored[0];
    const updated = await moveOrder(db, row, row.status, { autoAssigned: { at: Date.now() }, courierAck: undefined }, { id: best.x.id, name: best.x.name, phone: best.x.phone, vehicle: best.x.vehicle });
    await sysMsg(db, row.id, `تم تعيين المندوب ${best.x.name} تلقائياً لتوصيل طلبك 🛵${best.km != null ? ` (الأقرب للمتجر، ${best.km < 1 ? 'أقل من كيلو' : Math.round(best.km * 10) / 10 + ' كم'})` : ''}`);
    return updated;
  }
  /** An auto-assigned courier who did not open the order in time loses it: the next nearest gets it, or it opens to every courier. */
  async function sweepUnacked() {
    const due = await pool.query(
      `SELECT id FROM orders WHERE courier_user_id IS NOT NULL AND status IN ('accepted','ready')
          AND data->'autoAssigned' IS NOT NULL AND data->>'courierAck' IS NULL AND (data->'autoAssigned'->>'at')::bigint < $1 LIMIT 50`, [Date.now() - ACK_MS]);
    const moved = [];
    for (const r of due.rows) {
      try {
        const out = await withTx(async db => {
          const f = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [r.id]);
          const row = f.rows[0];
          if (!row || !row.courier_user_id || !['accepted', 'ready'].includes(row.status) || !row.data.autoAssigned || row.data.courierAck || Number(row.data.autoAssigned.at) >= Date.now() - ACK_MS) return null;
          const old = row.data.courierName || '';
          const skip = [...((row.data.autoSkip) || []), Number(row.courier_user_id)];
          let next = await moveOrder(db, row, row.status, { autoSkip: skip, autoAssigned: undefined }, null);
          await sysMsg(db, row.id, `لم يستجب المندوب ${old} في الوقت المحدد، جاري تحويل طلبك لمندوب آخر 🔄`);
          next = await tryAutoAssign(db, next);
          return next;
        });
        if (out) moved.push(out);
      } catch (e) { console.error('sweepUnacked failed:', e.message); }
    }
    if (moved.length) await notifyCouriers(moved);
    return moved.length;
  }
  async function withTx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const audit = (db, actorId, action, entity, entityId, before, after) => db.query(
    `INSERT INTO audit_log(actor_user_id, actor_name, action, entity, entity_id, before, after, note)
     VALUES($1::bigint, COALESCE((SELECT name FROM users WHERE id=$1::bigint), 'النظام'), $2, $3, $4, $5, $6, '')`,
    [actorId || null, action, entity, String(entityId || ''), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) {
      if (e && e.http) return res.status(e.http).json({ error: e.message });
      throw e;
    }
  });
  async function requireOpen() {
    const mt = await maintenanceState();
    if (!mt.enabled) throw fail(503, mt.message);
  }
  function checkContact(b) {
    const address = String(b.address || '').trim();
    const phone = normPhone(b.phone);
    if (address.length < 6) throw fail(400, 'اكتب العنوان بالتفصيل');
    if (!PHONE.test(phone)) throw fail(400, 'رقم الهاتف غير صحيح');
    return { address: address.slice(0, 300), phone };
  }


  /* ---------- phone notifications (Web Push); a failed push never fails the request ---------- */
  const notify = (ids, title, body, tag) => {
    const list = (ids || []).filter(Boolean);
    if (!pushToUsers || !list.length) return Promise.resolve();
    // The customer must not wait for phones to be notified: give the push at most 1.5s, then answer (it keeps going on its own).
    let t;
    const slow = new Promise(r => { t = setTimeout(r, 1500); });
    const job = pushToUsers(list, { title, body, tag, url: '/', requireInteraction: true }).catch(() => {});
    return Promise.race([job, slow]).finally(() => clearTimeout(t));
  };
  async function onlineCourierIds() {
    return (await pool.query("SELECT id FROM users WHERE role='courier' AND status='active' AND available=TRUE")).rows.map(r => r.id);
  }
  /** New jobs: the courier they were auto-assigned to, or every courier who is switched on. */
  async function notifyCouriers(all) {
    try {
      const rows = all.filter(x => !holdsCouriers(x));
      const jobs = [];
      for (const r of rows.filter(x => x.courier_user_id)) jobs.push(notify([r.courier_user_id], 'تم تعيين طلب لك 🛵', `${(r.data || {}).providerName || ''} — ${(r.data || {}).regionName || (r.data || {}).address || ''}`, `order-${r.id}`));
      const open = rows.filter(x => !x.courier_user_id);
      if (open.length) {
        const ids = await onlineCourierIds();
        const d = open[0].data || {};
        jobs.push(notify(ids, open.length > 1 ? `${open.length} طلبات توصيل جديدة 🛵` : 'طلب توصيل جديد 🛵', `${d.regionName ? `منطقة ${d.regionName}` : d.address || ''} — ${d.providerName || ''}`, `offer-${open[0].id}`));
      }
      await Promise.allSettled(jobs);
    } catch (e) { console.error('notifyCouriers failed:', e.message); }
  }
  async function notifyAction(action, row, actorRole) {
    try {
      const d = row.data || {};
      const cust = [row.customer_user_id];
      const shop = d.providerOwnerId ? [d.providerOwnerId] : [];
      const tag = `order-${row.id}`;
      const jobs = [];
      switch (action) {
        case 'accept': jobs.push(notify(cust, services.tplOf(d.providerType) === 'maker' ? 'قبل الصانع طلبك 🧵' : 'قبل المتجر طلبك 👨‍🍳', services.tplOf(d.providerType) === 'maker' && d.readyDate ? `جاهز ${d.readyDate} الساعة ${d.readyTime}` : (row.status === 'ready' ? 'جاهز للتسليم الآن' : (d.providerName || '')), tag), notifyCouriers([row])); break;
        case 'approve_quote':
          if (d.providerType === 'custom') jobs.push(notify([row.courier_user_id], 'وافق العميل على فاتورتك ✅', `${Number(row.total)} ج.م`, tag));
          else jobs.push(notify(shop, 'وافق العميل على السعر ✅', `${d.customerName || ''} — ${Number(row.total)} ج.م`, tag), notifyCouriers([row]));
          break;
        case 'courier_accept': jobs.push(notify(cust, `المندوب ${d.courierName || ''} قبل طلبك 🛵`, 'وسيتولى التوصيل', tag), notify(shop, 'مندوب سيستلم الطلب', d.courierName || '', tag)); break;
        case 'pickup': jobs.push(notify(cust, 'استلم المندوب طلبك 📦', d.providerName || '', tag)); break;
        case 'go': jobs.push(notify(cust, 'المندوب في الطريق إليك 🚀', '', tag)); break;
        case 'arrive': jobs.push(notify(cust, 'وصل المندوب إلى مكانك 📍', 'تفضّل بالاستلام', tag)); break;
        case 'deliver': jobs.push(notify(cust, 'تم تسليم طلبك 💚', 'بالهناء والشفاء', tag), notify(shop, 'تم تسليم الطلب للعميل', `#${row.order_number}`, tag)); break;
        case 'ready': jobs.push(notify(row.courier_user_id ? [row.courier_user_id] : [], 'الطلب جاهز للاستلام ✅', d.providerName || '', tag)); break;
        case 'reject': jobs.push(notify(cust, 'اعتذر المتجر عن طلبك', d.rejectReason || '', tag)); break;
        case 'cancel': jobs.push(actorRole === 'customer' ? notify([...shop, row.courier_user_id], 'ألغى العميل الطلب', `#${row.order_number}`, tag) : notify(cust, 'تم إلغاء طلبك', (d.rejectReason || '') + (d.giftCode ? ` 🎁 كود خصم لك: ${d.giftCode}` : ''), tag)); break;
        case 'decline_quote': jobs.push(d.providerType === 'custom' ? notifyCouriers([row]) : notify(shop, 'رفض العميل السعر', `#${row.order_number}`, tag)); break;
        default: break;
      }
      await Promise.allSettled(jobs);
    } catch (e) { console.error('notifyAction failed:', e.message); }
  }

  /* ---------- who sees what ---------- */
  // a parameter is added only when the returned SQL really uses it (PostgreSQL rejects extra parameters)
  function orderScope(user, values) {
    if (user.role === 'admin') return 'TRUE';
    if (!['customer', 'provider', 'courier', 'supervisor'].includes(user.role)) return 'FALSE';
    values.push(Number(user.sub));
    const i = values.length;
    // a supervisor sees only the orders of the areas the owner gave him
    if (user.role === 'supervisor') return `o.region_id IN (SELECT unnest(string_to_array(NULLIF(sup_regions,''),','))::bigint FROM users WHERE id=$${i})`;
    if (user.role === 'customer') return `o.customer_user_id=$${i}`;
    // a closed day moves the shop's finished orders out of its lists (nothing is deleted; the owner still sees everything)
    if (user.role === 'provider') return `o.provider_id IN (SELECT id FROM providers WHERE owner_user_id=$${i}) AND NOT (o.status IN ('delivered','rejected','cancelled','unavailable') AND COALESCE(o.delivered_at, o.updated_at) <= COALESCE((SELECT MAX(dc.closed_at) FROM day_closings dc WHERE dc.provider_id=o.provider_id AND dc.undone_at IS NULL), 'epoch'::timestamptz))`;
    return `(o.courier_user_id=$${i} OR (o.courier_user_id IS NULL AND o.status IN ('accepted','ready')))`;
  }
  function apptScope(user, values) {
    if (user.role === 'admin') return 'TRUE';
    if (user.role !== 'customer' && user.role !== 'provider') return 'FALSE'; // couriers have no bookings
    values.push(Number(user.sub));
    const i = values.length;
    if (user.role === 'customer') return `a.customer_user_id=$${i}`;
    return `a.provider_id IN (SELECT id FROM providers WHERE owner_user_id=$${i})`;
  }

  /** One request refreshes the whole app: orders, invoices, bookings, chat. */
  /**
   * A tiny fingerprint of everything this user would receive. When the app sends the fingerprint it already has, the answer is
   * just {unchanged:true}: no 300 orders / 1500 messages are read, serialised or sent, so polling stays cheap even with many users.
   * Any trouble computing it simply falls back to the full answer.
   */
  async function syncTag(auth) {
    const p = [Number(auth.sub)];
    const pv = (await loadSettings()).privacy || { on: false, minutes: 1 };
    const so = orderScope(auth, p);
    const sa = apptScope(auth, p);
    const pvOn = pv.on && (auth.role === 'provider' || auth.role === 'courier') ? 'TRUE' : 'FALSE';
    const pvMin = Math.max(0, Math.floor(Number(pv.minutes) || 1));
    const r = await pool.query(`WITH ord AS (SELECT o.id, o.status, o.updated_at, o.delivered_at, o.courier_user_id FROM orders o WHERE ${so} ORDER BY o.created_at DESC LIMIT 300),
        apt AS (SELECT a.id, a.status, a.updated_at FROM appointments a WHERE ${sa} ORDER BY a.created_at DESC LIMIT 300)
      SELECT
        (SELECT md5(u::text) FROM users u WHERE u.id=$1) AS me,
        (SELECT COALESCE(SUM(hashtextextended(ord.id::text||ord.status||ord.updated_at::text||COALESCE(ord.courier_user_id::text,''),0)::numeric),0)::text||':'||COUNT(*) FROM ord) AS o,
        (SELECT COALESCE(SUM(hashtextextended(apt.id::text||apt.status||apt.updated_at::text,0)::numeric),0)::text||':'||COUNT(*) FROM apt) AS a,
        (SELECT COUNT(*)||':'||COALESCE(MAX(m.id),0) FROM messages m WHERE m.order_id IN (SELECT id FROM ord)) AS m,
        (SELECT updated_at::text FROM app_settings WHERE id=1) AS s,
        (SELECT COUNT(*) FROM ord WHERE ${pvOn} AND ord.status='delivered' AND COALESCE(ord.delivered_at, ord.updated_at) < NOW() - make_interval(mins => ${pvMin})) AS pv,
        (SELECT updated_at::text FROM site_images WHERE key='login') AS li,
        (SELECT updated_at::text FROM site_images WHERE key='welcome_logo') AS wl,
        (SELECT MAX(updated_at)::text||':'||COUNT(*) FROM site_images WHERE key LIKE 'cat\\_%') AS ci,
        (SELECT COUNT(*) FROM users WHERE role='courier' AND status='active' AND available=TRUE) AS c,
        (SELECT COALESCE(SUM(hashtextextended(x.id::text||x.status||x.updated_at::text,0)::numeric),0)::text FROM appointments x WHERE x.status IN ('pending','confirmed') AND x.appointment_date >= CURRENT_DATE - 1) AS sl`, p);
    return crypto.createHash('md5').update(JSON.stringify([auth.role, auth.status, r.rows[0]])).digest('hex');
  }

  // the service list (and which order path each service uses) is read before every order route
  if (typeof app.use === 'function') app.use(['/api/orders', '/api/appointments'], (_req, _res, next) => { services.ensure(pool).then(() => next(), () => next()); });
  app.get('/api/sync', authAny, asyncRoute(async (req, res) => {
    let tag = null;
    if (req.auth.status === 'active') {
      try { tag = await syncTag(req.auth); } catch (e) { console.error('sync tag failed:', e.message); }
      if (tag && req.query.tag === tag) { res.set('Cache-Control', 'no-store'); return res.json({ unchanged: true, tag }); }
    }
    const [settings, meRow] = await Promise.all([loadSettings(), pool.query('SELECT * FROM users WHERE id=$1', [Number(req.auth.sub)])]);
    const me = meRow.rows[0] ? cleanUser(meRow.rows[0]) : null;
    if (!me || req.auth.status !== 'active') {
      // an account still waiting for approval only needs its own status and the app settings
      return res.json({ settings, user: me, couriersOnline: 0, orders: [], invoices: [], appointments: [], messages: [], bookedSlots: [] });
    }
    const warnings = [];
    // chat, invoices, slot lists and the courier counter must never hide the orders if one of them fails
    const soft = async (name, fallback, fn) => { try { return await fn(); } catch (e) { console.error(`sync ${name} failed:`, e.message); warnings.push(name); return fallback; } };
    const ov = [];
    const av = [];
    // the server is far from the user: ask the database everything at once instead of one question at a time
    const [ordersRes, apptsRes, online, slotRows] = await Promise.all([
      pool.query(`SELECT o.* FROM orders o WHERE ${orderScope(req.auth, ov)} ORDER BY o.created_at DESC LIMIT 300`, ov),
      pool.query(`${APPT_SQL} WHERE ${apptScope(req.auth, av)} ORDER BY a.created_at DESC LIMIT 300`, av),
      soft('couriers', 0, async () => Number((await pool.query("SELECT COUNT(*) AS n FROM users WHERE role='courier' AND status='active' AND available=TRUE")).rows[0].n)),
      soft('slots', [], async () => (await pool.query(
        "SELECT doctor_product_id, to_char(appointment_date,'YYYY-MM-DD') AS d, appointment_time AS t FROM appointments WHERE status IN ('pending','confirmed') AND appointment_date >= CURRENT_DATE - 1")).rows),
    ]);
    const orders = ordersRes.rows;
    const appts = apptsRes.rows;
    const orderIds = orders.map(o => o.id);
    const invIds = new Set();
    orders.forEach(o => o.data && o.data.invoiceId && invIds.add(Number(o.data.invoiceId)));
    appts.forEach(a => a.data && a.data.invoiceId && invIds.add(Number(a.data.invoiceId)));
    const [messages, invoices] = await Promise.all([
      orderIds.length
        ? soft('messages', [], async () => (await pool.query('SELECT * FROM messages WHERE order_id = ANY($1::bigint[]) ORDER BY created_at DESC LIMIT 1500', [orderIds])).rows.reverse())
        : [],
      soft('invoices', [], async () => {
        if (req.auth.role === 'admin') return (await pool.query('SELECT * FROM invoices ORDER BY created_at DESC LIMIT 300')).rows;
        return invIds.size ? (await pool.query('SELECT * FROM invoices WHERE id = ANY($1::bigint[]) ORDER BY created_at DESC', [[...invIds]])).rows : [];
      }),
    ]);
    const slots = { rows: slotRows };
    const maskInvoice = inv => {
      const parts = inv.parts || [];
      if (!hiddenOrders.size || !parts.length || !parts.every(pt => hiddenOrders.has(String(pt.orderId)))) return inv;
      return { ...inv, customerName: 'عميل', phone: '', address: '', privacyMasked: true };
    };
    const hiddenOrders = new Set(orders.filter(r => privacyMask(r, req.auth.role, settings.privacy)).map(r => String(r.id)));
    res.set('Cache-Control', 'no-store');
    res.json({
      warnings, tag: warnings.length ? undefined : tag || undefined, settings, user: me, couriersOnline: online,
      orders: orders.map(r => orderJsonFor(r, req.auth.role, settings.privacy)), invoices: invoices.map(r => maskInvoice(invoiceJson(r))), appointments: appts.map(r => apptJsonFor(r, req.auth.role)), messages: messages.filter(m => !hiddenOrders.has(String(m.order_id))).map(messageJson),
      bookedSlots: slots.rows.filter(s => s.doctor_product_id).map(s => ({ doctorId: String(s.doctor_product_id), date: s.d, time: s.t })),
    });
  }));

  /* ---------- placing orders ---------- */
  /** The cart lines the app sent, cleaned. */
  const cleanLines = raw => (Array.isArray(raw) ? raw : []).slice(0, 100)
    .map(l => ({ id: positiveId(l && l.productId), qty: Math.floor(Number(l && l.qty)) }))
    .filter(l => l.id && l.qty > 0 && l.qty <= 50);
  /** The server prices a cart: products grouped by shop, with the offers taken off, exactly as the customer saw them. */
  async function buildGroups(lines) {
    if (!lines.length) throw fail(400, 'السلة فارغة');
    const prods = await pool.query(
      `SELECT pr.*, p.name AS pname, p.type AS ptype, p.owner_user_id, p.delivery_fee AS pfee, p.status AS pstatus, p.is_open, p.deleted_at
       FROM products pr JOIN providers p ON p.id=pr.provider_id WHERE pr.id = ANY($1::bigint[])`, [lines.map(l => l.id)]);
    const offersNow = await offersLib.activeOffers(pool);
    for (const r of prods.rows) r.price = offersLib.salePrice(r.price, offersLib.bestOffer(offersNow, r.provider_id));
    const byId = new Map(prods.rows.map(r => [Number(r.id), r]));
    const groups = new Map();
    for (const l of lines) {
      const p = byId.get(l.id);
      if (!p) throw fail(409, 'أحد المنتجات لم يعد متاحاً');
      if (p.deleted_at || p.pstatus !== 'active' || !p.is_open) throw fail(409, `${p.pname} مغلق حالياً`);
      if (!services.isActive(p.ptype)) throw fail(409, `${p.pname}: هذه الخدمة متوقفة حالياً`);
      if (services.tplOf(p.ptype) === 'request') throw fail(409, `${p.pname}: اطلب بكتابة طلبك (بدون سلة منتجات)`);
      if (!p.available) throw fail(409, `${p.name} غير متاح حالياً`);
      if (!groups.has(p.provider_id)) groups.set(p.provider_id, { p, items: [], subtotal: 0, hasOffer: !!offersLib.bestOffer(offersNow, p.provider_id) });
      const g = groups.get(p.provider_id);
      g.items.push({ productId: String(p.id), name: p.name, price: Number(p.price), qty: l.qty, emoji: (p.data && p.data.emoji) || '📦' });
      g.subtotal += Number(p.price) * l.qty;
    }
    return groups;
  }

  /** The private codes (gifts) saved for this customer that he can still use. */
  app.get('/api/coupons/mine', auth, roles('customer'), guard(async (req, res) => {
    const r = await pool.query(
      `SELECT c.* FROM coupons c WHERE c.user_id=$1 AND c.active AND c.starts_at <= NOW() AND c.ends_at > NOW()
         AND (c.per_user IS NULL OR (SELECT COUNT(DISTINCT group_ref) FROM coupon_uses WHERE coupon_id=c.id AND user_id=$1) < c.per_user)
         AND (c.max_uses IS NULL OR (SELECT COUNT(DISTINCT group_ref) FROM coupon_uses WHERE coupon_id=c.id) < c.max_uses)
       ORDER BY c.ends_at LIMIT 20`, [Number(req.auth.sub)]);
    res.json({ coupons: r.rows.map(couponsLib.couponJson) });
  }));

  /** The customer asks, in the cart, what his discount code would take off (nothing is saved). */
  app.post('/api/coupons/check', auth, roles('customer'), guard(async (req, res) => {
    const b = req.body || {};
    const groups = await buildGroups(cleanLines(b.lines));
    const ev = await couponsLib.evaluate(pool, { code: b.code, userId: Number(req.auth.sub), groups: [...groups.values()].map(g => ({ providerId: g.p.provider_id, subtotal: g.subtotal, hasOffer: g.hasOffer })) });
    res.json({ code: ev.coupon.code, discount: ev.discount, kind: ev.coupon.kind, value: Number(ev.coupon.value) });
  }));

  app.post('/api/orders/checkout', auth, roles('customer'), guard(async (req, res) => {
    await requireOpen();
    const b = req.body || {};
    const dest = await destRule(b);
    await rememberSpot(Number(req.auth.sub), dest);
    const name = String(b.name || '').trim();
    if (name.length < 3) throw fail(400, 'اكتب الاسم بالكامل');
    const { address, phone } = checkContact(b);
    const lines = cleanLines(b.lines);
    const scheduledFor = await scheduleOf(b);
    const wantPool = b.pool === true && !scheduledFor && (await poolLib.on(pool));
    const groups = await buildGroups(lines);
    const out = await withTx(async db => {
      const region = await regionOf(db, Number(req.auth.sub));
      const orders = [];
      // a discount code is checked again here, with its row locked, so two customers cannot both take the last use
      const ev = String(b.coupon || '').trim()
        ? await couponsLib.evaluate(db, { code: b.coupon, userId: Number(req.auth.sub), forUpdate: true, groups: [...groups.values()].map(g => ({ providerId: g.p.provider_id, subtotal: g.subtotal, hasOffer: g.hasOffer })) })
        : null;
      const discounts = [];
      for (const g of groups.values()) {
        const disc = ev ? (ev.perGroup.get(String(g.p.provider_id)) || 0) : 0;
        const fee = await deliveryFeeFor(db, { id: g.p.provider_id, type: g.p.ptype, name: g.p.pname }, region, g.p.pfee, Number(req.auth.sub), dest);
        const d = {
          customerName: name, phone, address, notes: String(b.notes || '').slice(0, 500), providerName: g.p.pname, providerType: g.p.ptype,
          ...(scheduledFor ? { scheduledFor } : {}),
          ...(wantPool && fee > 0 && region && services.tplOf(g.p.ptype) !== 'booking' ? { pool: { want: true, fullFee: fee } } : {}),
          providerOwnerId: String(g.p.owner_user_id), items: g.items, subtotal: g.subtotal, ...(disc > 0 ? { discount: disc, couponCode: ev.coupon.code } : {}), deliveryFee: fee, regionName: region ? region.name : undefined, providerRegionName: await providerRegionName(db, g.p.provider_id), ...(await flagData(db, Number(req.auth.sub), dest)),
          // every shop decides first: it must press accept or reject (a maker also picks the ready day and hour); nothing starts by itself
          history: [{ status: 'pending', at: Date.now() }],
        };
        const r = await db.query('INSERT INTO orders(customer_user_id, provider_id, status, total, region_id, data) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
          [Number(req.auth.sub), g.p.provider_id, 'pending', Math.round((g.subtotal - disc + fee) * 100) / 100, region ? region.id : null, JSON.stringify(d)]);
        orders.push(r.rows[0]);
        discounts.push(disc);
      }
      const total = orders.reduce((s, o) => s + Number(o.total), 0);
      const parts = orders.map(o => ({
        orderId: String(o.id), providerId: String(o.provider_id), providerName: o.data.providerName, providerType: o.data.providerType,
        items: o.data.items, subtotal: o.data.subtotal, deliveryFee: o.data.deliveryFee, ...(o.data.discount > 0 ? { discount: o.data.discount, couponCode: o.data.couponCode } : {}),
      }));
      const inv = await db.query('INSERT INTO invoices(customer_user_id, order_id, kind, total, data) VALUES($1,$2,\'delivery\',$3,$4) RETURNING *', [
        Number(req.auth.sub), orders[0].id, total,
        JSON.stringify({ number: `INV-${orders[0].order_number}`, customerName: name, phone, address, parts }),
      ]);
      const finalOrders = [];
      for (const o of orders) {
        const d = { ...o.data, groupId: String(inv.rows[0].id), invoiceId: String(inv.rows[0].id) };
        let row = (await db.query('UPDATE orders SET updated_at=NOW(), data=$1 WHERE id=$2 RETURNING *', [JSON.stringify(d), o.id])).rows[0];
        await sysMsg(db, row.id, services.tplOf((o.data || {}).providerType) === 'maker' ? 'تم إرسال طلبك للصانع، وسيقبله ويحدد موعد جاهزيته أو يعتذر عنه 🧵' : 'تم إرسال طلبك للمتجر ✅');
        finalOrders.push(row);
      }
      if (ev) await couponsLib.record(db, { coupon: ev.coupon, userId: Number(req.auth.sub), groupRef: inv.rows[0].id, orders: finalOrders.map((o, i) => ({ id: o.id, discount: discounts[i] })) });
      const u = await db.query('UPDATE users SET address=$1 WHERE id=$2 RETURNING *', [address, Number(req.auth.sub)]);
      // "شير اللقمة": join an open group of neighbours (price changes are told to the earlier members, anonymously)
      const poolChanges = [];
      if (wantPool) {
        for (const o of finalOrders) {
          if (!(o.data || {}).pool) continue;
          const ch = await poolLib.join(db, o);
          poolChanges.push(...ch.filter(c => Number(c.row.customer_user_id) !== Number(req.auth.sub)));
        }
        for (let i = 0; i < finalOrders.length; i++) finalOrders[i] = (await db.query('SELECT * FROM orders WHERE id=$1', [finalOrders[i].id])).rows[0];
        inv.rows[0] = (await db.query('SELECT * FROM invoices WHERE id=$1', [inv.rows[0].id])).rows[0];
      }
      return { invoice: inv.rows[0], orders: finalOrders, user: u.rows[0], poolChanges };
    });
    await Promise.allSettled([
      ...out.poolChanges.map(c => notify([c.row.customer_user_id], 'جار قرّب طلب من نفس المحل 🤝', `رسوم توصيلك بقت ${c.to} ج.م بدل ${c.from} ج.م`, `order-${c.row.id}`)),
      ...out.orders.map(r => notify([(r.data || {}).providerOwnerId], (r.data || {}).scheduledFor ? 'طلب مجدول جديد ⏰' : 'طلب جديد 🔔', `${name} — ${Number(r.total)} ج.م${(r.data || {}).scheduledFor ? ' — ' + schedText(r.data.scheduledFor) : ''}`, `order-${r.id}`)),
      notifyCouriers(out.orders.filter(r => r.status !== 'pending')),
    ]);
    res.status(201).json({ invoice: invoiceJson(out.invoice), orders: out.orders.map(orderJson), address: out.user.address });
  }));

  /** "شير اللقمة" hint: how many neighbours already wait for the same shop (no names, nothing else). */
  app.get('/api/pool/suggest', auth, roles('customer'), guard(async (req, res) => {
    if (!(await poolLib.on(pool))) return res.json({ on: false, waiting: 0 });
    const pid = positiveId(req.query.providerId);
    if (!pid) return res.json({ on: true, waiting: 0 });
    const region = await regionOf(pool, Number(req.auth.sub));
    res.json({ on: true, waiting: region ? await poolLib.suggest(pool, { providerId: pid, regionId: region.id, customerId: Number(req.auth.sub) }) : 0, max: poolLib.POOL_MAX, minutes: poolLib.POOL_WINDOW_MIN });
  }));

  /** "اطلب أي حاجة": a free errand for the couriers (no shop involved). */
  app.post('/api/orders/custom', auth, roles('customer'), guard(async (req, res) => {
    await requireOpen();
    if (!services.errandActive()) throw fail(409, 'هذه الخدمة متوقفة حالياً');
    const b = req.body || {};
    const dest = await destRule(b);
    await rememberSpot(Number(req.auth.sub), dest);
    const voice = await voiceLib.check(pool, b.voice);
    const text = String(b.text || '').trim() || (voice ? '🎤 رسالة صوتية' : '');
    if (text.length < 3) throw fail(400, 'اكتب ما تريد طلبه');
    const { address, phone } = checkContact(b);
    const out = await withTx(async db => {
      const me = await db.query('SELECT name FROM users WHERE id=$1', [Number(req.auth.sub)]);
      const region = await regionOf(db, Number(req.auth.sub));
      const fee = 0; // the courier who takes the errand sets the price of the goods and his delivery fee
      const d = {
        customerName: me.rows[0].name, phone, address, notes: '', providerName: CUSTOM_NAME, providerType: 'custom', providerOwnerId: '', items: [],
        customText: text.slice(0, 1000), ...(voice ? { hasVoice: true, voiceSecs: voice.seconds } : {}), subtotal: 0, deliveryFee: fee, errandQuote: 'open', regionName: region ? region.name : undefined, ...(await flagData(db, Number(req.auth.sub), dest)),
        history: [{ status: 'pending', at: Date.now() }, { status: 'accepted', at: Date.now() }],
      };
      let o = (await db.query('INSERT INTO orders(customer_user_id, provider_id, status, total, region_id, data) VALUES($1,NULL,\'accepted\',$2,$3,$4) RETURNING *',
        [Number(req.auth.sub), fee, region ? region.id : null, JSON.stringify(d)])).rows[0];
      if (voice) await voiceLib.save(db, o.id, voice);
      const inv = (await db.query('INSERT INTO invoices(customer_user_id, order_id, kind, total, data) VALUES($1,$2,\'delivery\',$3,$4) RETURNING *', [
        Number(req.auth.sub), o.id, fee,
        JSON.stringify({ number: `INV-${o.order_number}`, customerName: d.customerName, phone, address, parts: [
          { orderId: String(o.id), providerId: 'custom', providerName: CUSTOM_NAME, providerType: 'custom', items: [], customText: d.customText, subtotal: 0, deliveryFee: fee }] }),
      ])).rows[0];
      o = (await db.query('UPDATE orders SET updated_at=NOW(), data=$1 WHERE id=$2 RETURNING *', [JSON.stringify({ ...o.data, groupId: String(inv.id), invoiceId: String(inv.id) }), o.id])).rows[0];
      o = await tryAutoAssign(db, o);
      return { o, inv };
    });
    await notifyCouriers([out.o]);
    res.status(201).json({ invoice: invoiceJson(out.inv), orders: [orderJson(out.o)] });
  }));


  /* ---------- free-text requests (supermarket / pharmacy): the shop prices them ---------- */
  const MAX_IMAGE = 600000; // characters of base64 text
  app.post('/api/orders/request', auth, roles('customer'), guard(async (req, res) => {
    await requireOpen();
    const b = req.body || {};
    const dest = await destRule(b);
    await rememberSpot(Number(req.auth.sub), dest);
    const providerId = positiveId(b.providerId);
    const text = String(b.text || '').trim().slice(0, 1500);
    const image = typeof b.image === 'string' && b.image ? b.image : null;
    const voice = await voiceLib.check(pool, b.voice);
    if (!providerId) throw fail(400, 'اختر المتجر');
    if (text.length < 3 && !image && !voice) throw fail(400, 'اكتب طلبك أو ارفع صورة أو سجّل رسالة صوتية');
    if (image && (!/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > MAX_IMAGE)) throw fail(400, 'الصورة غير صالحة أو كبيرة جداً');
    const { address, phone } = checkContact(b);
    const p = await pool.query('SELECT * FROM providers WHERE id=$1 AND deleted_at IS NULL', [providerId]);
    const prov = p.rows[0];
    if (!prov || prov.status !== 'active' || !prov.is_open) throw fail(409, 'المتجر مغلق حالياً');
    if (!services.acceptsRequests(prov.type) && !(['request', 'menu'].includes(prov.order_mode) && await extrasLib.featureOn(pool, 'menu'))) throw fail(400, 'هذا النوع لا يقبل الطلبات المكتوبة');
    if (!services.isActive(prov.type)) throw fail(409, 'هذه الخدمة متوقفة حالياً');
    const out = await withTx(async db => {
      const me = await db.query('SELECT name FROM users WHERE id=$1', [Number(req.auth.sub)]);
      const region = await regionOf(db, Number(req.auth.sub));
      const fee = await deliveryFeeFor(db, prov, region, prov.delivery_fee, Number(req.auth.sub), dest);
      const d = {
        customerName: me.rows[0].name, phone, address, notes: '', providerName: prov.name, providerType: prov.type, providerOwnerId: String(prov.owner_user_id),
        items: [], subtotal: 0, deliveryFee: fee, regionName: region ? region.name : undefined, providerRegionName: await providerRegionName(db, prov.id), ...(await flagData(db, Number(req.auth.sub), dest)),
        request: { text, hasImage: !!image }, ...(voice ? { hasVoice: true, voiceSecs: voice.seconds } : {}), history: [{ status: 'pending', at: Date.now() }],
      };
      const o = (await db.query('INSERT INTO orders(customer_user_id, provider_id, status, total, region_id, data) VALUES($1,$2,\'pending\',0,$3,$4) RETURNING *',
        [Number(req.auth.sub), prov.id, region ? region.id : null, JSON.stringify(d)])).rows[0];
      if (image) await db.query('INSERT INTO order_images(order_id, image) VALUES($1,$2)', [o.id, image]);
      if (voice) await voiceLib.save(db, o.id, voice);
      await sysMsg(db, o.id, services.tplOf(prov.type) === 'maker' ? 'تم إرسال طلبك للصانع، وسيقبله أو يعتذر عنه ويحدد السعر وموعد التسليم 🧵' : 'تم إرسال طلبك للمتجر، وسيقوم بتسعيره وإرسال الفاتورة إليك 📝');
      return o;
    });
    await notify([prov.owner_user_id], 'طلب مكتوب جديد 📝', `${(out.data || {}).customerName || ''} — يحتاج تسعير`, `order-${out.id}`);
    res.status(201).json({ order: orderJson(out) });
  }));

  /** The shop prices the request (lines of name × price × quantity), or says the items are not available. */
  app.post('/api/orders/:id/quote', auth, roles('provider', 'admin', 'supervisor'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف الطلب غير صالح');
    const b = req.body || {};
    const note = String(b.note || '').trim().slice(0, 300);
    const lines = [];
    if (!b.unavailable) {
      let raw = Array.isArray(b.items) ? b.items.slice(0, 50) : [];
      // the usual case: the shop just writes the price of the whole request
      if (!raw.length && b.price !== undefined) {
        if (!(Number(b.price) > 0)) throw fail(400, 'اكتب سعر الطلب');
        raw = [{ name: 'ثمن الطلب', price: Number(b.price), qty: 1 }];
      }
      for (const it of raw) {
        const name = String((it && it.name) || '').trim().slice(0, 80);
        const price = Number(it && it.price);
        const qty = Math.floor(Number(it && it.qty));
        if (!name || !Number.isFinite(price) || price < 0 || price > 100000 || !(qty >= 1 && qty <= 99)) throw fail(400, 'راجع أسماء الأصناف وأسعارها وكمياتها');
        lines.push({ productId: `q${lines.length + 1}`, name, price, qty, emoji: '🛒' });
      }
      if (!lines.length) throw fail(400, 'أضف صنفاً واحداً على الأقل');
    }
    const readyDate = String(b.readyDate || '').trim();
    const readyTime = String(b.readyTime || '').trim();
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
    const out = await withTx(async db => {
      const f = await db.query('SELECT o.*, p.owner_user_id AS powner FROM orders o JOIN providers p ON p.id=o.provider_id WHERE o.id=$1 FOR UPDATE OF o', [id]);
      if (!f.rowCount) throw fail(404, 'الطلب غير موجود');
      const row = f.rows[0];
      if (req.auth.role === 'supervisor') {
        // a supervisor may price a written request only in his areas and only when the shop left it stuck (or he already took it over)
        if (!(await staffCan(db, req.auth, row))) throw fail(403, 'هذا الطلب خارج مناطقك');
        if (!needsStaff(row)) throw fail(409, 'المتجر ما زال أمامه وقت للرد على الطلب');
      } else if (req.auth.role !== 'admin' && Number(row.powner) !== Number(req.auth.sub)) throw fail(403, 'غير مسموح');
      if (!row.data || !row.data.request) throw fail(400, 'هذا ليس طلباً مكتوباً');
      if (!['pending', 'quoted'].includes(row.status)) throw fail(409, 'حالة الطلب لا تسمح بالتسعير الآن');
      const isMaker = services.tplOf(row.data.providerType) === 'maker';
      const fee = Number(row.data.deliveryFee) || 0;
      const unavailable = !!b.unavailable;
      if (isMaker && !unavailable) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(readyDate) || Number.isNaN(Date.parse(readyDate)) || readyDate < today) throw fail(400, 'حدد يوم التسليم (اليوم أو بعده)');
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(readyTime)) throw fail(400, 'حدد ساعة التسليم بشكل صحيح');
      }
      const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
      const total = unavailable ? 0 : subtotal + fee;
      const part = {
        orderId: String(row.id), providerId: String(row.provider_id), providerName: row.data.providerName, providerType: row.data.providerType,
        items: unavailable ? [] : lines, subtotal: unavailable ? 0 : subtotal, deliveryFee: unavailable ? 0 : fee, requestText: row.data.request.text || '',
        ...(isMaker && !unavailable ? { readyDate, readyTime } : {}),
      };
      const invData = { number: `INV-${row.order_number}`, customerName: row.data.customerName, phone: row.data.phone, address: row.data.address, parts: [part], unavailable, note };
      let invoiceId = row.data.invoiceId ? Number(row.data.invoiceId) : null;
      if (invoiceId) await db.query('UPDATE invoices SET total=$1, data=$2 WHERE id=$3', [total, JSON.stringify(invData), invoiceId]);
      else invoiceId = (await db.query('INSERT INTO invoices(customer_user_id, order_id, kind, total, data) VALUES($1,$2,\'delivery\',$3,$4) RETURNING id',
        [row.customer_user_id, row.id, total, JSON.stringify(invData)])).rows[0].id;
      const d = { ...row.data, ...(req.auth.role === 'supervisor' ? { staffHandled: true } : {}), items: unavailable ? [] : lines, subtotal: unavailable ? 0 : subtotal, invoiceId: String(invoiceId), groupId: String(invoiceId), quoteNote: note, ...(isMaker && !unavailable ? { readyDate, readyTime } : {}) };
      const r = await db.query('UPDATE orders SET status=$1, total=$2, data=$3, updated_at=NOW() WHERE id=$4 RETURNING *', [unavailable ? 'unavailable' : 'quoted', total, JSON.stringify({ ...d, history: [...(d.history || []), { status: unavailable ? 'unavailable' : 'quoted', at: Date.now() }] }), row.id]);
      await sysMsg(db, row.id, unavailable
        ? (isMaker ? `اعتذر الصانع عن تنفيذ الطلب${note ? `: ${note}` : ''}` : `للأسف الأصناف المطلوبة غير متوفرة حالياً${note ? `: ${note}` : ''}`)
        : (isMaker ? `قبل الصانع طلبك بسعر ${total} ج.م (شامل التوصيل) ويكون جاهزاً للتسليم ${readyDate} الساعة ${readyTime}. راجع الفاتورة ووافق عليها 🧵`
          : `قام المتجر بتسعير طلبك: ${total} ج.م (شامل التوصيل). راجع الفاتورة ووافق عليها ليبدأ التحضير 🧾`));
      const inv = (await db.query('SELECT * FROM invoices WHERE id=$1', [invoiceId])).rows[0];
      return { order: r.rows[0], invoice: inv };
    });
    await notify([out.order.customer_user_id], out.order.status === 'unavailable' ? 'الأصناف غير متوفرة' : 'المتجر حدد سعر طلبك 🧾', out.order.status === 'unavailable' ? ((out.order.data || {}).providerName || '') : `${Number(out.order.total)} ج.م شامل التوصيل — راجع الفاتورة ووافق`, `order-${out.order.id}`);
    res.json({ order: orderJsonFor(out.order, req.auth.role), invoice: invoiceJson(out.invoice) });
  }));

  /** The request photo, only for people who belong to that order. */
  app.get('/api/orders/:id/image', auth, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف الطلب غير صالح');
    const f = await pool.query('SELECT o.customer_user_id, o.courier_user_id, o.region_id, p.owner_user_id AS powner, i.image FROM orders o LEFT JOIN providers p ON p.id=o.provider_id LEFT JOIN order_images i ON i.order_id=o.id WHERE o.id=$1', [id]);
    if (!f.rowCount) throw fail(404, 'الطلب غير موجود');
    const r = f.rows[0]; const me = Number(req.auth.sub);
    const ok = req.auth.role === 'admin' || (req.auth.role === 'supervisor' && await staffCan(pool, req.auth, r)) || [r.customer_user_id, r.courier_user_id, r.powner].some(v => v && Number(v) === me);
    if (!ok) throw fail(403, 'غير مسموح');
    res.set('Cache-Control', 'private, max-age=3600');
    res.json({ image: r.image || null });
  }));

  /* ---------- supervisors: owner-created staff who step in only when a shop leaves an order stuck ---------- */
  const STAFF_WAIT_MS = 30 * 1000; // a shop that has not answered for this long is considered not to have seen the order
  /** Orders run by themselves. A supervisor may act only on one the shop refused, one it left unanswered, or one he already took over. */
  // restaurants: the supervisor steps in only when the restaurant refused or cancelled; every other shop also when it stays silent
  const needsStaff = row => {
    const d = row.data || {};
    if (row.status === 'rejected' || d.staffHandled || (row.status === 'cancelled' && d.cancelledBy === 'provider')) return true;
    return d.providerType !== 'restaurant' && row.status === 'pending' && Date.now() - new Date(row.updated_at).getTime() >= STAFF_WAIT_MS;
  };
  /** May this account manage that order? The owner: any. A supervisor: only orders of his areas. */
  async function staffCan(db, auth, row) {
    if (auth.role === 'admin') return true;
    if (auth.role !== 'supervisor' || !row.region_id) return false;
    const r = await db.query('SELECT sup_regions FROM users WHERE id=$1', [Number(auth.sub)]);
    const list = String((r.rows[0] || {}).sup_regions || '').split(',').filter(Boolean).map(Number);
    return list.includes(Number(row.region_id));
  }
  app.get('/api/staff/couriers', auth, roles('admin', 'supervisor'), asyncRoute(async (_req, res) => {
    const r = await pool.query(`SELECT u.id, u.name, u.phone, u.vehicle, u.available, u.region_id,
        (SELECT COUNT(*) FROM orders o WHERE o.courier_user_id=u.id AND o.status = ANY($1)) AS busy
      FROM users u WHERE u.role='courier' AND u.status='active' AND u.deleted_at IS NULL ORDER BY u.available DESC, u.name LIMIT 300`, [BUSY]);
    res.json({ couriers: r.rows.map(c => ({ id: String(c.id), name: c.name, phone: c.phone, vehicle: c.vehicle || '', available: !!c.available, regionId: c.region_id ? String(c.region_id) : '', busy: Number(c.busy) })) });
  }));
  /** Link an order to a chosen courier (also moves it from one courier to another while it has not been picked up). */
  // the auto-assigned courier opened the order: it stays with him
  app.post('/api/orders/:id/ack', auth, roles('courier'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'رقم الطلب غير صحيح');
    const out = await withTx(async db => {
      const f = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
      const row = f.rows[0];
      if (!row || String(row.courier_user_id) !== String(req.auth.sub)) throw fail(404, 'الطلب غير موجود');
      if (!row.data.autoAssigned || row.data.courierAck) return row;
      const r = await db.query('UPDATE orders SET data=$1 WHERE id=$2 RETURNING *', [JSON.stringify({ ...row.data, courierAck: Date.now() }), id]);
      return r.rows[0];
    });
    res.json({ order: orderJson(out) });
  }));
  app.post('/api/orders/:id/assign', auth, roles('admin', 'supervisor'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    const cid = positiveId((req.body || {}).courierId);
    if (!id || !cid) throw fail(400, 'اختر المندوب');
    // "breakdown": the courier carrying the order has a problem (vehicle, accident, phone...). The owner or a supervisor of the area hands it to another courier even after pickup.
    const breakdown = (req.body || {}).breakdown === true;
    const out = await withTx(async db => {
      const f = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
      if (!f.rowCount) throw fail(404, 'الطلب غير موجود');
      const row = f.rows[0];
      if (!(await staffCan(db, req.auth, row))) throw fail(403, 'هذا الطلب خارج مناطقك');
      const afterPickup = ['picked_up', 'on_the_way', 'arrived'].includes(row.status);
      if (breakdown) {
        if (!row.courier_user_id || !['accepted', 'ready', 'picked_up', 'on_the_way', 'arrived'].includes(row.status)) throw fail(409, 'لا يوجد مندوب معه هذا الطلب الآن');
      } else {
        if (!['accepted', 'ready'].includes(row.status)) throw fail(409, 'يمكن تعيين مندوب بعد قبول الطلب وقبل استلامه فقط');
        if (req.auth.role === 'supervisor' && !needsStaff(row)) throw fail(409, 'الطلب ماشي طبيعي مع المتجر، لا يمكن التدخل فيه');
      }
      const c = await db.query("SELECT id, name, phone, vehicle FROM users WHERE id=$1 AND role='courier' AND status='active' AND deleted_at IS NULL", [cid]);
      if (!c.rowCount) throw fail(404, 'المندوب غير متاح');
      if (Number(row.courier_user_id) === cid) throw fail(409, 'الطلب معيّن لهذا المندوب بالفعل');
      // after pickup the goods are with the first courier: the order goes back to "ready" so the new courier meets him, takes it (pickup) and delivers
      const handover = breakdown ? { handover: { from: row.data.courierName || '', at: Date.now() } } : {};
      const next = await moveOrder(db, row, afterPickup ? 'ready' : row.status, handover, { id: c.rows[0].id, name: c.rows[0].name, phone: c.rows[0].phone, vehicle: c.rows[0].vehicle });
      await sysMsg(db, id, breakdown
        ? `حصل ظرف طارئ مع المندوب السابق، وتم تحويل طلبك للمندوب ${c.rows[0].name} 🛵 وسيوصله لك`
        : `تم تعيين المندوب ${c.rows[0].name} لتوصيل طلبك 🛵`);
      await audit(db, Number(req.auth.sub), breakdown ? 'order.handover' : 'order.assign', 'order', String(id), { courierId: row.courier_user_id ? String(row.courier_user_id) : null, status: row.status }, { courierId: String(cid), breakdown });
      return { next, prev: row.courier_user_id };
    });
    await Promise.allSettled([
      notify([cid], 'تم تعيين طلب لك 🛵', `${(out.next.data || {}).providerName || ''} — ${(out.next.data || {}).regionName || (out.next.data || {}).address || ''}`, `order-${id}`),
      notify([out.next.customer_user_id], `المندوب ${(out.next.data || {}).courierName || ''} سيوصّل طلبك 🛵`, '', `order-${id}`),
      out.prev && Number(out.prev) !== cid ? notify([out.prev], 'تم سحب الطلب منك', `#${out.next.order_number}`, `order-${id}`) : Promise.resolve(),
      // the order's shop is told too, in case the courier had already collected from it
      notify([(out.next.data || {}).providerOwnerId], `تم تغيير مندوب الطلب #${out.next.order_number}`, (out.next.data || {}).courierName || '', `order-${id}`),
    ]);
    res.json({ order: orderJsonFor(out.next, req.auth.role) });
  }));
  /** Send a written request that its shop refused to another shop / pharmacy / maker. */
  app.post('/api/orders/:id/transfer', auth, roles('admin', 'supervisor'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    const pid = positiveId((req.body || {}).providerId);
    if (!id || !pid) throw fail(400, 'اختر مقدم الخدمة');
    const out = await withTx(async db => {
      const f = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
      if (!f.rowCount) throw fail(404, 'الطلب غير موجود');
      const row = f.rows[0];
      if (!(await staffCan(db, req.auth, row))) throw fail(403, 'هذا الطلب خارج مناطقك');
      const isReq = !!(row.data && row.data.request);
      const byShop = row.status === 'cancelled' && row.data && row.data.cancelledBy === 'provider';
      if (!row.provider_id || !row.data || (!isReq && !(row.data.items || []).length)) throw fail(409, 'هذا الطلب لا يُحوَّل');
      // only an order the shop has not accepted (still waiting, or refused / cancelled by the shop); once accepted it stays with that shop
      if (!['pending', 'rejected'].includes(row.status) && !byShop) throw fail(409, 'لا يمكن تحويل الطلب بعد أن قبله مقدم الخدمة');
      if (req.auth.role === 'supervisor' && !needsStaff(row)) throw fail(409, 'المتجر ما زال أمامه وقت للرد على الطلب');
      if (Number(row.provider_id) === pid) throw fail(409, 'الطلب عند هذا المتجر بالفعل');
      const p = await db.query("SELECT id, owner_user_id, type, name, status FROM providers WHERE id=$1 AND deleted_at IS NULL", [pid]);
      const prov = p.rows[0];
      if (!prov || prov.status !== 'active') throw fail(404, 'مقدم الخدمة غير متاح');
      if (isReq && !services.acceptsRequests(prov.type)) throw fail(400, 'هذا النوع لا يقبل الطلبات المكتوبة');
      if (!isReq && prov.type !== row.data.providerType) throw fail(400, 'حوّل الطلب إلى نفس نوع الخدمة');
      const oldOwner = row.data.providerOwnerId;
      const d = { ...row.data, providerName: prov.name, providerType: prov.type, providerOwnerId: String(prov.owner_user_id), providerRegionName: await providerRegionName(db, prov.id) };
      // back to "waiting" at the new shop: the refusal / cancellation, any courier and (for a written request) the old price are cleared
      let total = 0;
      let patch = { ...d, rejectReason: undefined, cancelledBy: undefined, staffHandled: undefined, readyDate: undefined, readyTime: undefined };
      // the delivery price follows the new shop's area (a route without a price is closed)
      const fee = await deliveryFeeFor(db, prov, row.region_id ? { id: row.region_id } : null, num(row.data.deliveryFee), row.customer_user_id, row.data.destLat != null && row.data.destLng != null ? { lat: Number(row.data.destLat), lng: Number(row.data.destLng) } : null);
      if (isReq) patch = { ...patch, invoiceId: undefined, subtotal: 0, deliveryFee: fee };
      else {
        // the order keeps its items and prices
        total = num(row.data.subtotal) + fee;
        patch = { ...patch, deliveryFee: fee };
        if (row.data.invoiceId) {
          const iv = await db.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [Number(row.data.invoiceId)]);
          if (iv.rowCount) {
            const idata = iv.rows[0].data || {};
            const parts = (idata.parts || []).map(pt => String(pt.orderId) === String(row.id) ? { ...pt, providerId: String(prov.id), providerName: prov.name, providerType: prov.type, deliveryFee: fee } : pt);
            await db.query('UPDATE invoices SET total=total-$1+$2, data=$3 WHERE id=$4', [num(row.total), total, JSON.stringify({ ...idata, parts }), iv.rows[0].id]);
          }
        }
      }
      await moveOrder(db, row, 'pending', patch, null);
      const r = await db.query('UPDATE orders SET provider_id=$1, total=$2 WHERE id=$3 RETURNING *', [prov.id, total, id]);
      await sysMsg(db, id, isReq ? `تم تحويل طلبك إلى ${prov.name}، وسيقوم بتسعيره قريباً 🔁` : `تم تحويل طلبك إلى ${prov.name}، وبانتظار قبوله 🔁`);
      await audit(db, Number(req.auth.sub), 'order.transfer', 'order', String(id), { providerId: row.provider_id ? String(row.provider_id) : null }, { providerId: String(pid) });
      return { next: r.rows[0], oldOwner, isReq };
    });
    await Promise.allSettled([
      notify([out.next.data.providerOwnerId], out.isReq ? 'طلب مكتوب جديد 📝' : 'طلب جديد 🔔', out.isReq ? `${out.next.data.customerName || ''} — يحتاج تسعير` : `${out.next.data.customerName || ''} — ${Number(out.next.total)} ج.م`, `order-${id}`),
      notify([out.next.customer_user_id], 'تم تحويل طلبك لمتجر آخر 🔁', out.next.data.providerName || '', `order-${id}`),
      out.oldOwner ? notify([out.oldOwner], 'تم تحويل الطلب لمتجر آخر', `#${out.next.order_number}`, `order-${id}`) : Promise.resolve(),
    ]);
    res.json({ order: orderJsonFor(out.next, req.auth.role) });
  }));

  /** "اطلب إيه نجيبهولك": the courier who took the errand writes the price of the goods and his delivery fee, and the customer approves or refuses. */
  app.post('/api/orders/:id/errand-quote', auth, roles('courier', 'admin'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف الطلب غير صالح');
    const money = v => Math.round(Number(v) * 100) / 100;
    const subtotal = money((req.body || {}).subtotal), fee = money((req.body || {}).fee);
    if (!(subtotal > 0) || subtotal > 100000) throw fail(400, 'اكتب سعر المشتريات');
    if (!(fee >= 0) || fee > 1000) throw fail(400, 'اكتب رسوم التوصيل (من 0 إلى 1000 ج.م)');
    const out = await withTx(async db => {
      const f = await db.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id]);
      if (!f.rowCount) throw fail(404, 'الطلب غير موجود');
      const row = f.rows[0];
      if (!isErrand(row)) throw fail(400, 'هذا ليس طلب «اطلب إيه نجيبهولك»');
      if (req.auth.role !== 'admin' && Number(row.courier_user_id) !== Number(req.auth.sub)) throw fail(403, 'للمندوب الذي قبل الطلب فقط');
      if (!['accepted', 'quoted'].includes(row.status) || row.data.errandQuote === 'approved') throw fail(409, 'حالة الطلب لا تسمح بالتسعير الآن');
      const total = money(subtotal + fee);
      let invoiceId = row.data.invoiceId ? Number(row.data.invoiceId) : null;
      if (invoiceId) {
        const iv = await db.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [invoiceId]);
        const idata = iv.rowCount ? (iv.rows[0].data || {}) : {};
        const parts = (idata.parts || []).map(pt => String(pt.orderId) === String(row.id) ? { ...pt, subtotal, deliveryFee: fee } : pt);
        await db.query('UPDATE invoices SET total=$1, data=$2 WHERE id=$3', [total, JSON.stringify({ ...idata, parts }), invoiceId]);
      }
      const d = { ...row.data, subtotal, deliveryFee: fee, errandQuote: 'quoted', history: row.status === 'quoted' ? row.data.history : [...(row.data.history || []), { status: 'quoted', at: Date.now() }] };
      const r = await db.query("UPDATE orders SET status='quoted', total=$1, data=$2, updated_at=NOW() WHERE id=$3 RETURNING *", [total, JSON.stringify(d), id]);
      await sysMsg(db, id, `المندوب ${d.courierName || ''} سعّر طلبك: المشتريات ${subtotal} ج.م + التوصيل ${fee} ج.م = ${total} ج.م. راجع الفاتورة ووافق عليها 🧾`);
      return r.rows[0];
    });
    await notify([out.customer_user_id], 'المندوب سعّر طلبك 🧾', `${Number(out.total)} ج.م (شامل التوصيل)`, `order-${id}`);
    res.json({ order: orderJsonFor(out, req.auth.role) });
  }));

  /* ---------- order state machine ---------- */
  app.post('/api/orders/:id/action', auth, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    const action = String((req.body || {}).action || '');
    const reason = String((req.body || {}).reason || '').slice(0, 300);
    if (!id) throw fail(400, 'معرّف الطلب غير صالح');
    const role = req.auth.role; const me = Number(req.auth.sub);
    const out = await withTx(async db => {
      const found = await db.query('SELECT o.*, p.owner_user_id AS powner FROM orders o LEFT JOIN providers p ON p.id=o.provider_id WHERE o.id=$1 FOR UPDATE OF o', [id]);
      if (!found.rowCount) throw fail(404, 'الطلب غير موجود');
      const row = found.rows[0];
      const supOk = role === 'supervisor' && await staffCan(db, req.auth, row) && needsStaff(row); // only for his areas, and only when the shop left the order stuck
      const isShop = role === 'admin' || supOk || (role === 'provider' && Number(row.powner) === me);
      const isCustomer = role === 'admin' || (role === 'customer' && Number(row.customer_user_id) === me);
      const isMyDelivery = role === 'admin' || (role === 'courier' && Number(row.courier_user_id) === me);
      const need = (ok, why = 'غير مسموح بهذا الإجراء') => { if (!ok) throw fail(403, why); };
      const state = (...s) => { if (!s.includes(row.status)) throw fail(409, 'حالة الطلب لا تسمح بهذا الإجراء الآن'); };
      let next = row;
      switch (action) {
        case 'accept':
          need(isShop); state('pending');
          if (row.data && row.data.request) throw fail(409, 'سعّر الطلب أولاً ثم أرسل الفاتورة للعميل');
          {
            const b = req.body || {};
            const maker = !!(row.data && services.tplOf(row.data.providerType) === 'maker');
            const rd = String(b.readyDate || '').trim(), rt = String(b.readyTime || '').trim();
            const patch = role === 'supervisor' ? { staffHandled: true } : {};
            if (maker && rd) {
              const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
              if (!/^\d{4}-\d{2}-\d{2}$/.test(rd) || Number.isNaN(Date.parse(rd)) || rd < today) throw fail(400, 'حدد يوم التسليم (اليوم أو بعده)');
              if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rt)) throw fail(400, 'حدد ساعة التسليم بشكل صحيح');
              patch.readyDate = rd; patch.readyTime = rt;
            }
            next = await moveOrder(db, row, 'accepted', patch);
            if (maker && b.ready === true) {
              next = await moveOrder(db, next, 'ready');
              await sysMsg(db, id, 'الصانع قبل طلبك وهو جاهز للتسليم الآن 🧵');
            } else if (maker && patch.readyDate) {
              await sysMsg(db, id, `الصانع قبل طلبك، ويكون جاهزاً للتسليم ${patch.readyDate} الساعة ${patch.readyTime} 🧵`);
            } else await sysMsg(db, id, 'تم قبول طلبك وجاري التحضير 👨‍🍳');
            next = await tryAutoAssign(db, next);
          }
          break;
        case 'approve_quote':
          need(isCustomer); state('quoted');
          if (isErrand(row)) {
            // the courier's own invoice: he stays on the order and can go and buy it
            next = await moveOrder(db, row, 'accepted', { errandQuote: 'approved' });
            await sysMsg(db, id, 'وافق العميل على فاتورة المندوب، ويمكنه شراء الطلب الآن 🛒');
            break;
          }
          next = await moveOrder(db, row, 'accepted');
          await sysMsg(db, id, 'وافق العميل على الفاتورة وجاري تجهيز الطلب 👨‍🍳');
          next = await tryAutoAssign(db, next);
          break;
        case 'decline_quote':
          need(isCustomer); state('quoted', 'unavailable');
          if (isErrand(row)) {
            // the customer refused this courier's price: the errand goes back to all couriers, with no price and no courier
            await db.query('UPDATE orders SET total=0 WHERE id=$1', [id]);
            if (row.data.invoiceId) await resetErrandInvoice(db, row);
            next = await moveOrder(db, { ...row, total: 0 }, 'accepted', { errandQuote: 'open', subtotal: 0, deliveryFee: 0, declinedBy: [...(row.data.declinedBy || []), String(row.courier_user_id || '')].filter(Boolean) }, null);
            await sysMsg(db, id, 'رفض العميل سعر المندوب، وتم إرجاع الطلب للمناديب ليسعّره مندوب آخر 🔁');
            break;
          }
          next = await moveOrder(db, row, 'cancelled', { rejectReason: 'رفض العميل الفاتورة' });
          break;
        case 'reject':
          need(isShop); state('pending', 'quoted');
          next = await moveOrder(db, row, 'rejected', { rejectReason: reason || 'غير متاح حالياً' });
          break;
        case 'ready':
          need(isShop); state('accepted');
          next = await moveOrder(db, row, 'ready');
          await sysMsg(db, id, 'الطلب جاهز للاستلام من المندوب ✅');
          break;
        case 'cancel':
          need(isCustomer || isShop);
          // the owner / supervisor may also end an order the shop refused, and give the customer the reason
          if (['picked_up', 'on_the_way', 'arrived', 'delivered', 'cancelled'].includes(row.status) || (row.status === 'rejected' && !['admin', 'supervisor'].includes(role))) throw fail(409, 'لا يمكن إلغاء الطلب الآن');
          // the owner may give the customer a private one-use discount code with the cancellation
          let gift = null;
          if (role === 'admin' && (req.body || {}).gift) {
            const g = req.body.gift;
            gift = await couponsLib.makeGift(db, { userId: row.customer_user_id, kind: g.kind, value: g.value, days: g.days });
          }
          next = await moveOrder(db, row, 'cancelled', { ...(gift ? { giftCode: gift.code } : {}), cancelledBy: role, staffDismissed: ['admin', 'supervisor'].includes(role) ? true : undefined, rejectReason: ['admin', 'supervisor'].includes(role) && reason ? reason : role === 'admin' ? 'ألغاه المدير' : role === 'supervisor' ? 'ألغاه المشرف' : role === 'provider' ? 'ألغاه المتجر' : 'ألغاه العميل' });
          if (gift) await sysMsg(db, id, `🎁 كود خصم هدية لك: ${gift.code} (يُستخدم مرة واحدة في سلة الطلب)`);
          break;
        case 'dismiss': // "handled": the order leaves the owner's needs-attention list, nothing else changes
          need(role === 'admin' || supOk, 'للمدير والمشرف فقط');
          next = await moveOrder(db, row, row.status, { staffDismissed: true });
          break;
        case 'courier_accept': {
          need(role === 'courier', 'للمناديب فقط'); state('accepted', 'ready');
          if (row.courier_user_id) throw fail(409, 'تم قبول الطلب بواسطة مندوب آخر');
          if (isErrand(row) && (row.data.declinedBy || []).includes(String(me))) throw fail(409, 'رفض العميل سعرك لهذا الطلب');
          const c = await db.query("SELECT name, phone, vehicle, available FROM users WHERE id=$1 AND role='courier' AND status='active'", [me]);
          if (!c.rowCount) throw fail(403, 'حساب المندوب غير مفعّل');
          if (!c.rows[0].available) throw fail(409, 'فعّل حالتك إلى "متاح" أولاً لقبول الطلبات');
          next = await moveOrder(db, row, row.status, {}, { id: me, name: c.rows[0].name, phone: c.rows[0].phone, vehicle: c.rows[0].vehicle });
          await sysMsg(db, id, isErrand(row) ? `المندوب ${c.rows[0].name} قبل طلبك، وسيرسل لك فاتورة بسعر المشتريات ورسوم التوصيل لتوافق عليها 🧾` : `المندوب ${c.rows[0].name} قبل طلبك وسيتولى التوصيل 🛵`);
          break;
        }
        case 'pickup': // the courier has the order in hand (the shop does not have to tap "ready" first)
          need(isMyDelivery); state('accepted', 'ready');
          if (isErrand(row) && row.data.errandQuote !== 'approved') throw fail(409, 'سعّر الطلب وانتظر موافقة العميل على الفاتورة أولاً');
          next = await moveOrder(db, row, 'picked_up');
          await sysMsg(db, id, 'استلم المندوب طلبك 📦');
          break;
        case 'go':
          need(isMyDelivery); state('picked_up');
          next = await moveOrder(db, row, 'on_the_way');
          await sysMsg(db, id, 'المندوب في الطريق إليك الآن 🚀');
          break;
        case 'arrive':
          need(isMyDelivery); state('on_the_way');
          next = await moveOrder(db, row, 'arrived');
          await sysMsg(db, id, 'وصل المندوب إلى مكانك 📍');
          break;
        case 'deliver':
          need(isMyDelivery); state('on_the_way', 'arrived');
          next = await moveOrder(db, row, 'delivered');
          await commissions.onOrderDelivered(db, next);
          await sysMsg(db, id, 'تم تسليم الطلب بنجاح. بالهناء والشفاء 💚');
          break;
        default: throw fail(400, 'إجراء غير معروف');
      }
      return next;
    });
    await notifyAction(action, out, role);
    res.json({ order: orderJsonFor(out, role) });
  }));

  /* ---------- chat ---------- */
  app.post('/api/orders/:id/messages', auth, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    const body = String((req.body || {}).text || '').trim().slice(0, 2000);
    if (!id || !body) throw fail(400, 'اكتب رسالة');
    const o = await pool.query('SELECT o.status, o.customer_user_id, o.courier_user_id, o.region_id, p.owner_user_id AS powner FROM orders o LEFT JOIN providers p ON p.id=o.provider_id WHERE o.id=$1', [id]);
    if (!o.rowCount) throw fail(404, 'الطلب غير موجود');
    const me = Number(req.auth.sub); const x = o.rows[0];
    // the order chat closes with the order: after delivery / cancellation only the owner and supervisors may still write (everyone else uses support chat)
    if (['delivered', 'cancelled', 'rejected', 'unavailable'].includes(x.status) && req.auth.role !== 'admin' && req.auth.role !== 'supervisor') throw fail(409, 'انتهى الطلب وأُغلقت المحادثة. للتواصل استخدم شات الدعم');
    const allowed = req.auth.role === 'admin' || (req.auth.role === 'supervisor' && await staffCan(pool, req.auth, x)) || [x.customer_user_id, x.courier_user_id, x.powner].some(v => v && Number(v) === me);
    if (!allowed) throw fail(403, 'غير مسموح بالمشاركة في هذه المحادثة');
    const u = await pool.query('SELECT name, role FROM users WHERE id=$1', [me]);
    const r = await pool.query('INSERT INTO messages(order_id, sender_user_id, sender_name, sender_role, body) VALUES($1,$2,$3,$4,$5) RETURNING *', [id, me, u.rows[0].name, u.rows[0].role, body]);
    res.status(201).json({ message: messageJson(r.rows[0]) });
  }));

  /* ---------- clinic bookings ---------- */
  app.post('/api/appointments/book', auth, roles('customer'), guard(async (req, res) => {
    await requireOpen();
    const b = req.body || {};
    const doctorId = positiveId(b.doctorId);
    const patientName = String(b.patientName || '').trim();
    const phone = normPhone(b.phone);
    const date = String(b.date || '');
    const time = String(b.time || '');
    if (!doctorId) throw fail(400, 'اختر الطبيب');
    if (patientName.length < 3) throw fail(400, 'اكتب اسم المريض');
    if (!PHONE.test(phone)) throw fail(400, 'رقم الهاتف غير صحيح');
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || !time) throw fail(400, 'اختر اليوم والموعد');
    const d = await pool.query(
      `SELECT pr.*, p.id AS pid, p.name AS pname, p.owner_user_id, p.address AS paddr, p.status AS pstatus, p.is_open, p.deleted_at
       FROM products pr JOIN providers p ON p.id=pr.provider_id WHERE pr.id=$1`, [doctorId]);
    if (!d.rowCount) throw fail(404, 'الطبيب غير موجود');
    const doc = d.rows[0];
    if (doc.deleted_at || doc.pstatus !== 'active' || !doc.is_open || !doc.available) throw fail(409, 'العيادة لا تستقبل حجوزات حالياً');
    const slots = doc.data && Array.isArray(doc.data.slots) ? doc.data.slots : null;
    if (slots && !slots.includes(time)) throw fail(400, 'هذا الموعد غير متاح لدى الطبيب');
    const past = await pool.query('SELECT ($1::date < CURRENT_DATE) AS past, ($1::date > CURRENT_DATE + 90) AS far', [date]);
    if (past.rows[0].past) throw fail(400, 'لا يمكن الحجز في يوم سابق');
    if (past.rows[0].far) throw fail(400, 'اختر موعداً خلال الأشهر القادمة');
    try {
      const r = await pool.query(
        `INSERT INTO appointments(customer_user_id, provider_id, doctor_product_id, appointment_date, appointment_time, status, fee, data)
         VALUES($1,$2,$3,$4,$5,'pending',$6,$7) RETURNING id`,
        [Number(req.auth.sub), doc.pid, doc.id, date, time, Number(doc.price), JSON.stringify({
          patientName, phone, clinicName: doc.pname, clinicOwnerId: String(doc.owner_user_id), clinicAddress: doc.paddr || '', doctorName: doc.name,
          specialty: (doc.data && doc.data.category) || '', notes: String(b.notes || '').slice(0, 500), ...(await flagData(pool, Number(req.auth.sub))) })]);
      const a = await pool.query(`${APPT_SQL} WHERE a.id=$1`, [r.rows[0].id]);
      await notify([doc.owner_user_id], 'حجز جديد 📅', `${patientName} — ${date} ${time}`, `appt-${r.rows[0].id}`);
      res.status(201).json({ appointment: apptJson(a.rows[0]) });
    } catch (e) {
      if (e.code === '23505') throw fail(409, 'هذا الموعد محجوز، اختر موعداً آخر');
      throw e;
    }
  }));

  app.post('/api/appointments/:id/action', auth, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    const action = String((req.body || {}).action || '');
    if (!id) throw fail(400, 'معرّف الحجز غير صالح');
    const role = req.auth.role; const me = Number(req.auth.sub);
    const out = await withTx(async db => {
      const f = await db.query('SELECT a.*, p.owner_user_id AS powner FROM appointments a JOIN providers p ON p.id=a.provider_id WHERE a.id=$1 FOR UPDATE OF a', [id]);
      if (!f.rowCount) throw fail(404, 'الحجز غير موجود');
      const a = f.rows[0];
      if ((a.data || {}).kind === 'lab') throw fail(409, 'طلبات المعامل لها خطواتها الخاصة');
      const isClinic = role === 'admin' || (role === 'provider' && Number(a.powner) === me);
      const isCustomer = role === 'admin' || (role === 'customer' && Number(a.customer_user_id) === me);
      const dataNow = { ...(a.data || {}) };
      let status;
      if (action === 'confirm' && dataNow.kind === 'clinic_set') throw fail(409, 'العيادة تقترح الميعاد والعميل هو اللي يوافق عليه');
      if (action === 'confirm') { if (!isClinic) throw fail(403, 'غير مسموح'); if (a.status !== 'pending') throw fail(409, 'تم البت في هذا الحجز'); status = 'confirmed'; }
      else if (action === 'reject') { if (!isClinic) throw fail(403, 'غير مسموح'); if (a.status !== 'pending') throw fail(409, 'تم البت في هذا الحجز'); status = 'rejected'; }
      else if (action === 'complete') { if (!isClinic) throw fail(403, 'غير مسموح'); if (a.status !== 'confirmed') throw fail(409, 'يجب تأكيد الحجز أولاً'); status = 'completed'; }
      else if (action === 'cancel') { if (!isCustomer && !isClinic) throw fail(403, 'غير مسموح'); if (!['pending', 'confirmed'].includes(a.status)) throw fail(409, 'لا يمكن إلغاء الحجز الآن'); status = 'cancelled'; }
      else throw fail(400, 'إجراء غير معروف');
      if (status === 'confirmed') {
        const dateStr = (await db.query("SELECT to_char(appointment_date,'YYYY-MM-DD') AS d FROM appointments WHERE id=$1", [a.id])).rows[0].d;
        const inv = await db.query('INSERT INTO invoices(customer_user_id, appointment_id, kind, total, data) VALUES($1,$2,\'booking\',$3,$4) RETURNING *', [
          a.customer_user_id, a.id, Number(a.fee),
          JSON.stringify({ number: `BK-${500 + Number(a.id)}`, customerName: dataNow.patientName, phone: dataNow.phone, address: dataNow.clinicAddress, parts: [],
            appointmentId: String(a.id), ownerId: dataNow.clinicOwnerId, clinicName: dataNow.clinicName, doctorName: dataNow.doctorName,
            specialty: dataNow.specialty, date: dateStr, time: a.appointment_time, fee: Number(a.fee) }),
        ]);
        dataNow.invoiceId = String(inv.rows[0].id);
      }
      await db.query('UPDATE appointments SET status=$1, data=$2, updated_at=NOW() WHERE id=$3', [status, JSON.stringify(dataNow), id]);
      if (status === 'completed') await commissions.onApptCompleted(db, a);
      return (await db.query(`${APPT_SQL} WHERE a.id=$1`, [id])).rows[0];
    });
    if (['confirm', 'reject'].includes(action)) await notify([out.customer_user_id], action === 'confirm' ? 'تم تأكيد حجزك ✅' : 'اعتذرت العيادة عن الحجز', `${(out.data || {}).clinicName || ''} — ${out.date_str} ${out.appointment_time}`, `appt-${out.id}`);
    res.json({ appointment: apptJsonFor(out, (req.auth || {}).role) });
  }));


  /* ---------- clinic sets the time (switch "clinicSchedule" + the clinic's own mode): the customer asks, the clinic writes the day and time,
     the customer accepts (a booking invoice is made) or cancels ---------- */
  const INVOICE_FOR = async (db, a, dataNow) => {
    const dateStr = (await db.query("SELECT to_char(appointment_date,'YYYY-MM-DD') AS d FROM appointments WHERE id=$1", [a.id])).rows[0].d;
    const inv = await db.query('INSERT INTO invoices(customer_user_id, appointment_id, kind, total, data) VALUES($1,$2,\'booking\',$3,$4) RETURNING *', [
      a.customer_user_id, a.id, Number(a.fee),
      JSON.stringify({ number: `BK-${500 + Number(a.id)}`, customerName: dataNow.patientName, phone: dataNow.phone, address: dataNow.clinicAddress, parts: [],
        appointmentId: String(a.id), ownerId: dataNow.clinicOwnerId, clinicName: dataNow.clinicName, doctorName: dataNow.doctorName,
        specialty: dataNow.specialty, date: dateStr, time: a.appointment_time, fee: Number(a.fee) }),
    ]);
    return String(inv.rows[0].id);
  };
  app.post('/api/appointments/request', auth, roles('customer'), guard(async (req, res) => {
    await requireOpen();
    if (!(await extrasLib.featureOn(pool, 'clinicSchedule'))) throw fail(409, 'الميزة غير متاحة حاليًا');
    const b = req.body || {};
    const doctorId = positiveId(b.doctorId);
    const patientName = String(b.patientName || '').trim();
    const phone = normPhone(b.phone);
    if (!doctorId) throw fail(400, 'اختر الطبيب');
    if (patientName.length < 3) throw fail(400, 'اكتب اسم المريض');
    if (!PHONE.test(phone)) throw fail(400, 'رقم الهاتف غير صحيح');
    const d = await pool.query(
      `SELECT pr.*, p.id AS pid, p.name AS pname, p.owner_user_id, p.address AS paddr, p.status AS pstatus, p.is_open, p.deleted_at, p.metadata AS pmeta
       FROM products pr JOIN providers p ON p.id=pr.provider_id WHERE pr.id=$1`, [doctorId]);
    if (!d.rowCount) throw fail(404, 'الطبيب غير موجود');
    const doc = d.rows[0];
    if (doc.deleted_at || doc.pstatus !== 'active' || !doc.is_open || !doc.available) throw fail(409, 'العيادة لا تستقبل حجوزات حالياً');
    if (!doc.pmeta || doc.pmeta.bookMode !== 'clinic') throw fail(409, 'هذه العيادة تحجز بالطريقة العادية');
    const r = await pool.query(
      `INSERT INTO appointments(customer_user_id, provider_id, doctor_product_id, appointment_date, appointment_time, status, fee, data)
       VALUES($1,$2,$3,CURRENT_DATE,'بانتظار-'||substr(md5(random()::text),1,8),'pending',$4,$5) RETURNING id`,
      [Number(req.auth.sub), doc.pid, doc.id, Number(doc.price), JSON.stringify({
        kind: 'clinic_set', stage: 'awaiting', patientName, phone, clinicName: doc.pname, clinicOwnerId: String(doc.owner_user_id), clinicAddress: doc.paddr || '', doctorName: doc.name,
        specialty: (doc.data && doc.data.category) || '', notes: String(b.notes || '').slice(0, 500), ...(await flagData(pool, Number(req.auth.sub))) })]);
    const a = await pool.query(`${APPT_SQL} WHERE a.id=$1`, [r.rows[0].id]);
    await notify([doc.owner_user_id], 'طلب كشف جديد 📅', `${patientName} — حدد له اليوم والساعة`, `appt-${r.rows[0].id}`);
    res.status(201).json({ appointment: apptJson(a.rows[0]) });
  }));
  app.post('/api/appointments/:id/propose', auth, roles('provider', 'admin'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف الحجز غير صالح');
    const date = String((req.body || {}).date || ''), time = String((req.body || {}).time || '').trim();
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw fail(400, 'اكتب اليوم');
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(time)) throw fail(400, 'اكتب الساعة بالشكل 18:30');
    const out = await withTx(async db => {
      const f = await db.query('SELECT a.*, p.owner_user_id AS powner FROM appointments a JOIN providers p ON p.id=a.provider_id WHERE a.id=$1 FOR UPDATE OF a', [id]);
      if (!f.rowCount) throw fail(404, 'الحجز غير موجود');
      const a = f.rows[0]; const d = a.data || {};
      if (d.kind !== 'clinic_set') throw fail(409, 'هذا الحجز ليس من نوع تحديد العيادة للميعاد');
      if (req.auth.role !== 'admin' && Number(a.powner) !== Number(req.auth.sub)) throw fail(403, 'غير مسموح');
      if (a.status !== 'pending') throw fail(409, 'تم البت في هذا الحجز');
      const past = await db.query('SELECT ($1::date < CURRENT_DATE) AS past, ($1::date > CURRENT_DATE + 90) AS far', [date]);
      if (past.rows[0].past) throw fail(400, 'اختر يومًا قادمًا');
      if (past.rows[0].far) throw fail(400, 'اختر ميعادًا خلال الأشهر القادمة');
      try { await db.query("UPDATE appointments SET appointment_date=$1, appointment_time=$2, data=$3, updated_at=NOW() WHERE id=$4", [date, time, JSON.stringify({ ...d, stage: 'proposed' }), id]); }
      catch (e) { if (e.code === '23505' || e.errno === '23505') throw fail(409, 'الميعاد ده محجوز لحد تاني، اكتب ميعاد آخر'); throw e; }
      return (await db.query(`${APPT_SQL} WHERE a.id=$1`, [id])).rows[0];
    });
    await notify([out.customer_user_id], 'العيادة حددت ميعاد كشفك 📅', `${out.date_str} الساعة ${out.appointment_time}، وافق عليه من التطبيق`, `appt-${id}`);
    res.json({ appointment: apptJsonFor(out, req.auth.role) });
  }));
  app.post('/api/appointments/:id/accept', auth, roles('customer'), guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف الحجز غير صالح');
    const out = await withTx(async db => {
      const f = await db.query('SELECT a.*, p.owner_user_id AS powner FROM appointments a JOIN providers p ON p.id=a.provider_id WHERE a.id=$1 FOR UPDATE OF a', [id]);
      if (!f.rowCount || Number(f.rows[0].customer_user_id) !== Number(req.auth.sub)) throw fail(404, 'الحجز غير موجود');
      const a = f.rows[0]; const d = { ...(a.data || {}) };
      if (d.kind !== 'clinic_set' || d.stage !== 'proposed') throw fail(409, 'لا يوجد ميعاد مقترح للموافقة عليه');
      if (a.status !== 'pending') throw fail(409, 'تم البت في هذا الحجز');
      d.stage = 'accepted';
      d.invoiceId = await INVOICE_FOR(db, a, d);
      await db.query("UPDATE appointments SET status='confirmed', data=$1, updated_at=NOW() WHERE id=$2", [JSON.stringify(d), id]);
      return { row: (await db.query(`${APPT_SQL} WHERE a.id=$1`, [id])).rows[0], owner: a.powner };
    });
    await notify([out.owner], 'العميل وافق على الميعاد ✅', `${out.row.date_str} ${out.row.appointment_time}`, `appt-${id}`);
    res.json({ appointment: apptJsonFor(out.row, 'customer') });
  }));

  /* ---------- medical labs: the customer writes the reason / sends a prescription, the lab sets the visit day and price, the customer
     confirms (a booking invoice is made), and after the visit the case stays open until the lab uploads the report (PDF or picture) ---------- */
  const LAB_MAX_FILE = 1800000; // characters of base64 text (about 1.3 MB of file)
  const LAB_MIME = /^data:(image\/(jpeg|png|webp)|application\/pdf);base64,/;
  const labOf = d => (d && d.kind === 'lab' ? { ...(d.lab || {}) } : null);
  const stageStatus = { new: 'pending', quoted: 'pending', confirmed: 'confirmed', visited: 'confirmed', done: 'completed' };

  app.post('/api/lab/request', auth, roles('customer'), guard(async (req, res) => {
    await requireOpen();
    const b = req.body || {};
    const providerId = positiveId(b.providerId);
    const reason = String(b.reason || '').trim().slice(0, 1000);
    const rx = typeof b.rx === 'string' && b.rx ? b.rx : null;
    const patientName = String(b.patientName || '').trim().slice(0, 80);
    const phone = normPhone(b.phone);
    if (!providerId) throw fail(400, 'اختر المعمل');
    if (reason.length < 3 && !rx) throw fail(400, 'اكتب سبب الكشف أو ارفع الروشتة');
    if (rx && (!/^data:image\/(jpeg|png|webp);base64,/.test(rx) || rx.length > 600000)) throw fail(400, 'صورة الروشتة غير صالحة أو كبيرة جداً');
    if (patientName.length < 3) throw fail(400, 'اكتب اسم المريض');
    if (!PHONE.test(phone)) throw fail(400, 'رقم الهاتف غير صحيح');
    await services.ensure(pool);
    const p = await pool.query('SELECT * FROM providers WHERE id=$1 AND deleted_at IS NULL', [providerId]);
    const prov = p.rows[0];
    if (!prov || services.tplOf(prov.type) !== 'lab') throw fail(404, 'المعمل غير موجود');
    if (prov.status !== 'active' || !prov.is_open) throw fail(409, 'المعمل لا يستقبل طلبات حالياً');
    if (!services.isActive(prov.type)) throw fail(409, 'هذه الخدمة متوقفة حالياً');
    const out = await withTx(async db => {
      const r = await db.query(
        `INSERT INTO appointments(customer_user_id, provider_id, doctor_product_id, appointment_date, appointment_time, status, fee, data)
         VALUES($1,$2,NULL,CURRENT_DATE,'--','pending',0,$3) RETURNING id`,
        [Number(req.auth.sub), prov.id, JSON.stringify({
          kind: 'lab', patientName, phone, clinicName: prov.name, clinicOwnerId: String(prov.owner_user_id), clinicAddress: prov.address || '',
          doctorName: 'تحاليل وفحوصات طبية', specialty: 'معمل', notes: reason, lab: { stage: 'new', reason, hasRx: !!rx }, ...(await flagData(db, Number(req.auth.sub))) })]);
      if (rx) await db.query("INSERT INTO lab_files(appointment_id, kind, mime, name, data) VALUES($1,'rx','image','روشتة',$2)", [r.rows[0].id, rx]);
      return (await db.query(`${APPT_SQL} WHERE a.id=$1`, [r.rows[0].id])).rows[0];
    });
    await notify([prov.owner_user_id], 'طلب تحليل جديد 🧪', `${patientName} — يحتاج تحديد موعد وسعر`, `appt-${out.id}`);
    res.status(201).json({ appointment: apptJsonFor(out, 'customer') });
  }));

  app.post('/api/lab/:id/action', auth, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف الطلب غير صالح');
    const b = req.body || {};
    const action = String(b.action || '');
    const role = req.auth.role; const me = Number(req.auth.sub);
    let notifyTo = null, notifyTitle = '', notifyBody = '';
    const out = await withTx(async db => {
      const f = await db.query('SELECT a.*, p.owner_user_id AS powner FROM appointments a JOIN providers p ON p.id=a.provider_id WHERE a.id=$1 FOR UPDATE OF a', [id]);
      if (!f.rowCount) throw fail(404, 'الطلب غير موجود');
      const a = f.rows[0];
      const lab = labOf(a.data);
      if (!lab) throw fail(409, 'هذا ليس طلب تحليل');
      const isLab = role === 'admin' || (role === 'provider' && Number(a.powner) === me);
      const isCust = role === 'admin' || (role === 'customer' && Number(a.customer_user_id) === me);
      const stage = lab.stage || 'new';
      const data = { ...(a.data || {}) };
      let status = a.status, date = null, time = null, fee = null;
      if (action === 'quote') {
        if (!isLab) throw fail(403, 'غير مسموح');
        if (!['new', 'quoted'].includes(stage)) throw fail(409, 'تم البت في هذا الطلب');
        const d = String(b.date || ''); const t = String(b.time || '');
        const parsed = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00Z`) : null;
        if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d) throw fail(400, 'اختر يوم الكشف');
        if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(t)) throw fail(400, 'اختر ساعة الكشف');
        const fv = Number(b.fee);
        if (!Number.isFinite(fv) || fv < 0 || fv > 100000) throw fail(400, 'اكتب سعر الكشف');
        const chk = await db.query('SELECT ($1::date < CURRENT_DATE) AS past, ($1::date > CURRENT_DATE + 180) AS far', [d]);
        if (chk.rows[0].past) throw fail(400, 'لا يمكن اختيار يوم سابق');
        if (chk.rows[0].far) throw fail(400, 'اختر موعداً خلال الأشهر القادمة');
        date = d; time = t.length === 4 ? '0' + t : t; fee = Math.round(fv * 100) / 100;
        lab.stage = 'quoted'; lab.note = String(b.note || '').trim().slice(0, 300);
        notifyTo = a.customer_user_id; notifyTitle = 'حدد المعمل موعد الكشف 🧪'; notifyBody = `${d} ${time} — ${fee} ج، أكّد الحجز من طلبك`;
      } else if (action === 'reject') {
        if (!isLab) throw fail(403, 'غير مسموح');
        if (!['new', 'quoted'].includes(stage)) throw fail(409, 'تم البت في هذا الطلب');
        status = 'rejected'; lab.stage = 'rejected';
        notifyTo = a.customer_user_id; notifyTitle = 'اعتذر المعمل عن الطلب'; notifyBody = (data.clinicName || '');
      } else if (action === 'confirm') {
        if (!isCust) throw fail(403, 'غير مسموح');
        if (stage !== 'quoted') throw fail(409, 'لا يوجد موعد لتأكيده الآن');
        status = 'confirmed'; lab.stage = 'confirmed';
        const dateStr = (await db.query("SELECT to_char(appointment_date,'YYYY-MM-DD') AS d FROM appointments WHERE id=$1", [a.id])).rows[0].d;
        const inv = await db.query('INSERT INTO invoices(customer_user_id, appointment_id, kind, total, data) VALUES($1,$2,\'booking\',$3,$4) RETURNING *', [
          a.customer_user_id, a.id, Number(a.fee),
          JSON.stringify({ number: `BK-${500 + Number(a.id)}`, customerName: data.patientName, phone: data.phone, address: data.clinicAddress, parts: [],
            appointmentId: String(a.id), ownerId: data.clinicOwnerId, clinicName: data.clinicName, doctorName: data.doctorName,
            specialty: data.specialty, date: dateStr, time: a.appointment_time, fee: Number(a.fee) })]);
        data.invoiceId = String(inv.rows[0].id);
        notifyTo = a.powner; notifyTitle = 'أكّد العميل الحجز ✅'; notifyBody = `${data.patientName} — ${dateStr} ${a.appointment_time}`;
      } else if (action === 'cancel') {
        if (!isCust && !isLab) throw fail(403, 'غير مسموح');
        if (!['new', 'quoted', 'confirmed'].includes(stage)) throw fail(409, 'لا يمكن إلغاء هذا الطلب الآن');
        status = 'cancelled'; lab.stage = 'cancelled';
        notifyTo = isLab && role !== 'customer' ? a.customer_user_id : a.powner; notifyTitle = 'تم إلغاء طلب التحليل'; notifyBody = data.patientName || '';
      } else if (action === 'visit') {
        if (!isLab) throw fail(403, 'غير مسموح');
        if (stage !== 'confirmed') throw fail(409, 'يجب أن يؤكد العميل الحجز أولاً');
        lab.stage = 'visited';
        notifyTo = a.customer_user_id; notifyTitle = 'تم الكشف ✅'; notifyBody = 'سيرفع المعمل التقرير في طلبك فور جاهزيته';
      } else if (action === 'report') {
        if (!isLab) throw fail(403, 'غير مسموح');
        if (!['confirmed', 'visited'].includes(stage)) throw fail(409, 'لا يمكن رفع التقرير الآن');
        const file = typeof b.file === 'string' ? b.file : '';
        if (!LAB_MIME.test(file) || file.length > LAB_MAX_FILE) throw fail(400, 'ارفع التقرير بصيغة PDF أو صورة (حتى 1.3 ميجا)');
        const isPdf = file.startsWith('data:application/pdf');
        const name = String(b.name || (isPdf ? 'تقرير.pdf' : 'تقرير.jpg')).slice(0, 80);
        await db.query(`INSERT INTO lab_files(appointment_id, kind, mime, name, data) VALUES($1,'report',$2,$3,$4)
          ON CONFLICT (appointment_id, kind) DO UPDATE SET mime=EXCLUDED.mime, name=EXCLUDED.name, data=EXCLUDED.data, updated_at=NOW()`, [a.id, isPdf ? 'pdf' : 'image', name, file]);
        lab.stage = 'done'; lab.hasReport = true; lab.reportName = name; status = 'completed';
        notifyTo = a.customer_user_id; notifyTitle = 'تقريرك جاهز 📄'; notifyBody = `${data.clinicName || 'المعمل'} رفع نتيجة التحليل`;
      } else throw fail(400, 'إجراء غير معروف');
      data.lab = lab;
      if (date) {
        await db.query('UPDATE appointments SET status=$1, data=$2, appointment_date=$3, appointment_time=$4, fee=$5, updated_at=NOW() WHERE id=$6', [status, JSON.stringify(data), date, time, fee, id]);
      } else {
        await db.query('UPDATE appointments SET status=$1, data=$2, updated_at=NOW() WHERE id=$3', [status, JSON.stringify(data), id]);
      }
      if (status === 'completed' && a.status !== 'completed') await commissions.onApptCompleted(db, a);
      return (await db.query(`${APPT_SQL} WHERE a.id=$1`, [id])).rows[0];
    });
    if (notifyTo) await notify([notifyTo], notifyTitle, notifyBody, `appt-${id}`);
    res.json({ appointment: apptJsonFor(out, role) });
  }));

  /** the prescription (picture) or the report (PDF / picture) of a case: only its customer, its lab and the owner may open it */
  app.get('/api/lab/:id/file/:kind', auth, guard(async (req, res) => {
    const id = positiveId(req.params.id); const kind = req.params.kind === 'report' ? 'report' : req.params.kind === 'rx' ? 'rx' : null;
    if (!id || !kind) throw fail(400, 'طلب غير صالح');
    const f = await pool.query('SELECT a.customer_user_id, p.owner_user_id AS powner, l.mime, l.name, l.data FROM appointments a JOIN providers p ON p.id=a.provider_id LEFT JOIN lab_files l ON l.appointment_id=a.id AND l.kind=$2 WHERE a.id=$1', [id, kind]);
    if (!f.rowCount) throw fail(404, 'الطلب غير موجود');
    const r = f.rows[0]; const me = Number(req.auth.sub);
    if (!(req.auth.role === 'admin' || Number(r.customer_user_id) === me || Number(r.powner) === me)) throw fail(403, 'غير مسموح');
    res.set('Cache-Control', 'private, max-age=600');
    res.json({ file: r.data ? { data: r.data, mime: r.mime, name: r.name } : null });
  }));

  /** a 5-minute link that opens the prescription / report in the phone's browser or PDF viewer (the app cannot show a PDF itself) */
  app.get('/api/lab/:id/link/:kind', auth, guard(async (req, res) => {
    const id = positiveId(req.params.id); const kind = req.params.kind === 'report' ? 'report' : req.params.kind === 'rx' ? 'rx' : null;
    if (!id || !kind) throw fail(400, 'طلب غير صالح');
    const f = await pool.query('SELECT a.customer_user_id, p.owner_user_id AS powner, (SELECT 1 FROM lab_files l WHERE l.appointment_id=a.id AND l.kind=$2) AS has FROM appointments a JOIN providers p ON p.id=a.provider_id WHERE a.id=$1', [id, kind]);
    if (!f.rowCount) throw fail(404, 'الطلب غير موجود');
    const r = f.rows[0]; const me = Number(req.auth.sub);
    if (!(req.auth.role === 'admin' || Number(r.customer_user_id) === me || Number(r.powner) === me)) throw fail(403, 'غير مسموح');
    if (!r.has) throw fail(404, 'لا يوجد ملف');
    const k = require('jsonwebtoken').sign({ lab: id, kind }, process.env.JWT_SECRET, { expiresIn: '5m', audience: 'lab-file', issuer: 'otlob-abis-api' });
    const host = req.get('x-forwarded-host') || req.get('host');
    res.set('Cache-Control', 'no-store');
    res.json({ url: `https://${host}/api/lab/${id}/dl/${kind}?k=${encodeURIComponent(k)}` });
  }));
  app.get('/api/lab/:id/dl/:kind', guard(async (req, res) => {
    const id = positiveId(req.params.id); const kind = req.params.kind;
    let c;
    try { c = require('jsonwebtoken').verify(String(req.query.k || ''), process.env.JWT_SECRET, { audience: 'lab-file', issuer: 'otlob-abis-api' }); } catch { throw fail(403, 'انتهت صلاحية الرابط، افتح الملف من التطبيق مرة أخرى'); }
    if (!id || Number(c.lab) !== id || c.kind !== kind) throw fail(403, 'رابط غير صالح');
    const f = await pool.query('SELECT mime, name, data FROM lab_files WHERE appointment_id=$1 AND kind=$2', [id, kind]);
    if (!f.rowCount) throw fail(404, 'لا يوجد ملف');
    const m = /^data:([a-z\/+.-]+);base64,(.*)$/s.exec(f.rows[0].data);
    if (!m) throw fail(404, 'ملف غير صالح');
    res.set('Content-Type', m[1]); res.set('Content-Disposition', `inline; filename="lab-${id}-${kind}.${m[1] === 'application/pdf' ? 'pdf' : m[1].split('/')[1]}"`); res.set('Cache-Control', 'no-store');
    res.send(Buffer.from(m[2], 'base64'));
  }));

  // an auto-assigned order the courier never opened goes to the next courier (checked every 30 seconds)
  app.sweepUnacked = sweepUnacked;
  if (!process.env.NO_SWEEP) {
    const timer = setInterval(() => { sweepUnacked().catch(e => console.error('sweepUnacked:', e.message)); }, 30 * 1000);
    if (timer.unref) timer.unref();
  }
};
