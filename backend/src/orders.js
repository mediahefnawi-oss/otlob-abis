'use strict';
/**
 * Central orders, invoices, bookings and chat.
 * The app mirrors /api/sync into its screens; every state change goes through one of the POST/PATCH routes below,
 * so the server alone decides who may do what (and who wins when two couriers tap "accept" together).
 */
module.exports = function registerOrderRoutes(app, { pool, auth, roles, asyncRoute, positiveId, maintenanceState }) {
  const num = v => Number(v) || 0;
  const ms = d => new Date(d).getTime();
  const PHONE = /^01[0-9]{9}$/;
  const normPhone = v => String(v || '').replace(/\s+/g, '');
  const BUSY = ['accepted', 'ready', 'picked_up', 'on_the_way', 'arrived'];
  const CUSTOM_NAME = 'طلب خاص — اطلب إيه؟';
  const FALLBACK_CUSTOM_FEE = 20;

  /* ---------- row -> app shape ---------- */
  const orderJson = r => {
    const d = r.data || {};
    return {
      id: String(r.id), number: Number(r.order_number), groupId: String(d.groupId || ''), invoiceId: String(d.invoiceId || ''),
      customerId: String(r.customer_user_id), customerName: d.customerName || '', phone: d.phone || '', address: d.address || '', notes: d.notes || '',
      providerId: r.provider_id ? String(r.provider_id) : 'custom', providerName: d.providerName || '', providerType: d.providerType || 'custom',
      providerOwnerId: d.providerOwnerId ? String(d.providerOwnerId) : '', items: d.items || [], customText: d.customText || undefined,
      request: d.request || undefined, subtotal: num(d.subtotal), deliveryFee: num(d.deliveryFee), total: num(r.total), status: r.status,
      courierId: r.courier_user_id ? String(r.courier_user_id) : undefined, courierName: d.courierName || undefined, rejectReason: d.rejectReason || undefined,
      regionId: r.region_id ? String(r.region_id) : undefined, regionName: d.regionName || undefined,
      createdAt: ms(r.created_at), updatedAt: ms(r.updated_at), history: d.history || [],
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
  /** Writes a status change (history + timestamps) on a row that is already locked by the caller. */
  async function moveOrder(db, row, status, dataPatch = {}, courier) {
    const d = { ...(row.data || {}), ...dataPatch };
    if (status !== row.status) d.history = [...(d.history || []), { status, at: Date.now() }];
    const cid = courier === undefined ? row.courier_user_id : courier ? courier.id : null;
    if (courier !== undefined) d.courierName = courier ? courier.name : undefined;
    const r = await db.query('UPDATE orders SET status=$1, data=$2, courier_user_id=$3, updated_at=NOW() WHERE id=$4 RETURNING *', [status, JSON.stringify(d), cid, row.id]);
    return r.rows[0];
  }
  /** Auto-assign: least busy available courier, preferring the order's own area. */
  async function tryAutoAssign(db, row) {
    if (row.courier_user_id) return row;
    const s = await db.query('SELECT auto_assign FROM app_settings WHERE id=1');
    if (!s.rowCount || !s.rows[0].auto_assign) return row;
    const c = await db.query(
      `SELECT u.id, u.name FROM users u WHERE u.role='courier' AND u.status='active' AND u.available=TRUE
       ORDER BY (SELECT COUNT(*) FROM orders o WHERE o.courier_user_id=u.id AND o.status = ANY($1)) ASC,
                (u.region_id IS NOT DISTINCT FROM $2::bigint) DESC, u.available_since ASC NULLS LAST LIMIT 1`, [BUSY, row.region_id]);
    if (!c.rowCount) return row;
    const updated = await moveOrder(db, row, row.status, {}, { id: c.rows[0].id, name: c.rows[0].name });
    await sysMsg(db, row.id, `تم تعيين المندوب ${c.rows[0].name} تلقائياً لتوصيل طلبك 🛵`);
    return updated;
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

  /* ---------- who sees what ---------- */
  function orderScope(user, values) {
    if (user.role === 'admin') return 'TRUE';
    values.push(Number(user.sub));
    const i = values.length;
    if (user.role === 'customer') return `o.customer_user_id=$${i}`;
    if (user.role === 'provider') return `o.provider_id IN (SELECT id FROM providers WHERE owner_user_id=$${i})`;
    if (user.role === 'courier') return `(o.courier_user_id=$${i} OR (o.courier_user_id IS NULL AND o.status IN ('accepted','ready')))`;
    return 'FALSE';
  }
  function apptScope(user, values) {
    if (user.role === 'admin') return 'TRUE';
    values.push(Number(user.sub));
    const i = values.length;
    if (user.role === 'customer') return `a.customer_user_id=$${i}`;
    if (user.role === 'provider') return `a.provider_id IN (SELECT id FROM providers WHERE owner_user_id=$${i})`;
    return 'FALSE';
  }

  /** One request refreshes the whole app: orders, invoices, bookings, chat. */
  app.get('/api/sync', auth, asyncRoute(async (req, res) => {
    const ov = [];
    const orders = (await pool.query(`SELECT o.* FROM orders o WHERE ${orderScope(req.auth, ov)} ORDER BY o.created_at DESC LIMIT 300`, ov)).rows;
    const av = [];
    const appts = (await pool.query(`${APPT_SQL} WHERE ${apptScope(req.auth, av)} ORDER BY a.created_at DESC LIMIT 300`, av)).rows;
    const orderIds = orders.map(o => o.id);
    const messages = orderIds.length
      ? (await pool.query('SELECT * FROM messages WHERE order_id = ANY($1::bigint[]) ORDER BY created_at DESC LIMIT 1500', [orderIds])).rows.reverse()
      : [];
    const invIds = new Set();
    orders.forEach(o => o.data && o.data.invoiceId && invIds.add(Number(o.data.invoiceId)));
    appts.forEach(a => a.data && a.data.invoiceId && invIds.add(Number(a.data.invoiceId)));
    let invoices = [];
    if (req.auth.role === 'admin') invoices = (await pool.query('SELECT * FROM invoices ORDER BY created_at DESC LIMIT 300')).rows;
    else if (invIds.size) invoices = (await pool.query('SELECT * FROM invoices WHERE id = ANY($1::bigint[]) ORDER BY created_at DESC', [[...invIds]])).rows;
    const slots = await pool.query(
      "SELECT doctor_product_id, to_char(appointment_date,'YYYY-MM-DD') AS d, appointment_time AS t FROM appointments WHERE status IN ('pending','confirmed') AND appointment_date >= CURRENT_DATE - 1");
    res.json({
      orders: orders.map(orderJson), invoices: invoices.map(invoiceJson), appointments: appts.map(apptJson), messages: messages.map(messageJson),
      bookedSlots: slots.rows.filter(s => s.doctor_product_id).map(s => ({ doctorId: String(s.doctor_product_id), date: s.d, time: s.t })),
    });
  }));

  /* ---------- placing orders ---------- */
  app.post('/api/orders/checkout', auth, roles('customer'), guard(async (req, res) => {
    await requireOpen();
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (name.length < 3) throw fail(400, 'اكتب الاسم بالكامل');
    const { address, phone } = checkContact(b);
    const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 100)
      .map(l => ({ id: positiveId(l && l.productId), qty: Math.floor(Number(l && l.qty)) }))
      .filter(l => l.id && l.qty > 0 && l.qty <= 50);
    if (!lines.length) throw fail(400, 'السلة فارغة');
    const prods = await pool.query(
      `SELECT pr.*, p.name AS pname, p.type AS ptype, p.owner_user_id, p.delivery_fee AS pfee, p.status AS pstatus, p.is_open, p.deleted_at
       FROM products pr JOIN providers p ON p.id=pr.provider_id WHERE pr.id = ANY($1::bigint[])`, [lines.map(l => l.id)]);
    const byId = new Map(prods.rows.map(r => [Number(r.id), r]));
    const groups = new Map();
    for (const l of lines) {
      const p = byId.get(l.id);
      if (!p) throw fail(409, 'أحد المنتجات لم يعد متاحاً');
      if (p.deleted_at || p.pstatus !== 'active' || !p.is_open) throw fail(409, `${p.pname} مغلق حالياً`);
      if (!p.available) throw fail(409, `${p.name} غير متاح حالياً`);
      if (!groups.has(p.provider_id)) groups.set(p.provider_id, { p, items: [], subtotal: 0 });
      const g = groups.get(p.provider_id);
      g.items.push({ productId: String(p.id), name: p.name, price: Number(p.price), qty: l.qty, emoji: (p.data && p.data.emoji) || '📦' });
      g.subtotal += Number(p.price) * l.qty;
    }
    const out = await withTx(async db => {
      const region = await regionOf(db, Number(req.auth.sub));
      const orders = [];
      for (const g of groups.values()) {
        const fee = g.p.ptype === 'clinic' ? 0 : region ? region.fee : Number(g.p.pfee);
        const d = {
          customerName: name, phone, address, notes: String(b.notes || '').slice(0, 500), providerName: g.p.pname, providerType: g.p.ptype,
          providerOwnerId: String(g.p.owner_user_id), items: g.items, subtotal: g.subtotal, deliveryFee: fee, regionName: region ? region.name : undefined,
          history: [{ status: 'pending', at: Date.now() }],
        };
        const r = await db.query('INSERT INTO orders(customer_user_id, provider_id, status, total, region_id, data) VALUES($1,$2,\'pending\',$3,$4,$5) RETURNING *',
          [Number(req.auth.sub), g.p.id, g.subtotal + fee, region ? region.id : null, JSON.stringify(d)]);
        orders.push(r.rows[0]);
      }
      const total = orders.reduce((s, o) => s + Number(o.total), 0);
      const parts = orders.map(o => ({
        orderId: String(o.id), providerId: String(o.provider_id), providerName: o.data.providerName, providerType: o.data.providerType,
        items: o.data.items, subtotal: o.data.subtotal, deliveryFee: o.data.deliveryFee,
      }));
      const inv = await db.query('INSERT INTO invoices(customer_user_id, order_id, kind, total, data) VALUES($1,$2,\'delivery\',$3,$4) RETURNING *', [
        Number(req.auth.sub), orders[0].id, total,
        JSON.stringify({ number: `INV-${orders[0].order_number}`, customerName: name, phone, address, parts }),
      ]);
      const finalOrders = [];
      for (const o of orders) {
        const d = { ...o.data, groupId: String(inv.rows[0].id), invoiceId: String(inv.rows[0].id) };
        finalOrders.push((await db.query('UPDATE orders SET data=$1 WHERE id=$2 RETURNING *', [JSON.stringify(d), o.id])).rows[0]);
      }
      const u = await db.query('UPDATE users SET address=$1 WHERE id=$2 RETURNING *', [address, Number(req.auth.sub)]);
      return { invoice: inv.rows[0], orders: finalOrders, user: u.rows[0] };
    });
    res.status(201).json({ invoice: invoiceJson(out.invoice), orders: out.orders.map(orderJson), address: out.user.address });
  }));

  /** "اطلب أي حاجة": a free errand for the couriers (no shop involved). */
  app.post('/api/orders/custom', auth, roles('customer'), guard(async (req, res) => {
    await requireOpen();
    const b = req.body || {};
    const text = String(b.text || '').trim();
    if (text.length < 3) throw fail(400, 'اكتب ما تريد طلبه');
    const { address, phone } = checkContact(b);
    const out = await withTx(async db => {
      const me = await db.query('SELECT name FROM users WHERE id=$1', [Number(req.auth.sub)]);
      const region = await regionOf(db, Number(req.auth.sub));
      const fee = region ? region.fee : FALLBACK_CUSTOM_FEE;
      const d = {
        customerName: me.rows[0].name, phone, address, notes: '', providerName: CUSTOM_NAME, providerType: 'custom', providerOwnerId: '', items: [],
        customText: text.slice(0, 1000), subtotal: 0, deliveryFee: fee, regionName: region ? region.name : undefined,
        history: [{ status: 'pending', at: Date.now() }, { status: 'accepted', at: Date.now() }],
      };
      let o = (await db.query('INSERT INTO orders(customer_user_id, provider_id, status, total, region_id, data) VALUES($1,NULL,\'accepted\',$2,$3,$4) RETURNING *',
        [Number(req.auth.sub), fee, region ? region.id : null, JSON.stringify(d)])).rows[0];
      const inv = (await db.query('INSERT INTO invoices(customer_user_id, order_id, kind, total, data) VALUES($1,$2,\'delivery\',$3,$4) RETURNING *', [
        Number(req.auth.sub), o.id, fee,
        JSON.stringify({ number: `INV-${o.order_number}`, customerName: d.customerName, phone, address, parts: [
          { orderId: String(o.id), providerId: 'custom', providerName: CUSTOM_NAME, providerType: 'custom', items: [], customText: d.customText, subtotal: 0, deliveryFee: fee }] }),
      ])).rows[0];
      o = (await db.query('UPDATE orders SET data=$1 WHERE id=$2 RETURNING *', [JSON.stringify({ ...o.data, groupId: String(inv.id), invoiceId: String(inv.id) }), o.id])).rows[0];
      o = await tryAutoAssign(db, o);
      return { o, inv };
    });
    res.status(201).json({ invoice: invoiceJson(out.inv), orders: [orderJson(out.o)] });
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
      const isShop = role === 'admin' || (role === 'provider' && Number(row.powner) === me);
      const isCustomer = role === 'admin' || (role === 'customer' && Number(row.customer_user_id) === me);
      const isMyDelivery = role === 'admin' || (role === 'courier' && Number(row.courier_user_id) === me);
      const need = (ok, why = 'غير مسموح بهذا الإجراء') => { if (!ok) throw fail(403, why); };
      const state = (...s) => { if (!s.includes(row.status)) throw fail(409, 'حالة الطلب لا تسمح بهذا الإجراء الآن'); };
      let next = row;
      switch (action) {
        case 'accept':
          need(isShop); state('pending');
          next = await moveOrder(db, row, 'accepted');
          await sysMsg(db, id, 'تم قبول طلبك وجاري التحضير 👨‍🍳');
          next = await tryAutoAssign(db, next);
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
          if (['picked_up', 'on_the_way', 'arrived', 'delivered', 'rejected', 'cancelled'].includes(row.status)) throw fail(409, 'لا يمكن إلغاء الطلب الآن');
          next = await moveOrder(db, row, 'cancelled', { rejectReason: role === 'admin' ? 'ألغاه المدير' : role === 'provider' ? 'ألغاه المتجر' : 'ألغاه العميل' });
          break;
        case 'courier_accept': {
          need(role === 'courier', 'للمناديب فقط'); state('accepted', 'ready');
          if (row.courier_user_id) throw fail(409, 'تم قبول الطلب بواسطة مندوب آخر');
          const c = await db.query("SELECT name, available FROM users WHERE id=$1 AND role='courier' AND status='active'", [me]);
          if (!c.rowCount) throw fail(403, 'حساب المندوب غير مفعّل');
          if (!c.rows[0].available) throw fail(409, 'فعّل حالتك إلى "متاح" أولاً لقبول الطلبات');
          next = await moveOrder(db, row, row.status, {}, { id: me, name: c.rows[0].name });
          await sysMsg(db, id, `المندوب ${c.rows[0].name} قبل طلبك وسيتولى التوصيل 🛵`);
          break;
        }
        case 'pickup': // the courier has the order in hand (the shop does not have to tap "ready" first)
          need(isMyDelivery); state('accepted', 'ready');
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
          await sysMsg(db, id, 'تم تسليم الطلب بنجاح. بالهناء والشفاء 💚');
          break;
        default: throw fail(400, 'إجراء غير معروف');
      }
      return next;
    });
    res.json({ order: orderJson(out) });
  }));

  /* ---------- chat ---------- */
  app.post('/api/orders/:id/messages', auth, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    const body = String((req.body || {}).text || '').trim().slice(0, 2000);
    if (!id || !body) throw fail(400, 'اكتب رسالة');
    const o = await pool.query('SELECT o.customer_user_id, o.courier_user_id, p.owner_user_id AS powner FROM orders o LEFT JOIN providers p ON p.id=o.provider_id WHERE o.id=$1', [id]);
    if (!o.rowCount) throw fail(404, 'الطلب غير موجود');
    const me = Number(req.auth.sub); const x = o.rows[0];
    const allowed = req.auth.role === 'admin' || [x.customer_user_id, x.courier_user_id, x.powner].some(v => v && Number(v) === me);
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
          specialty: (doc.data && doc.data.category) || '', notes: String(b.notes || '').slice(0, 500) })]);
      const a = await pool.query(`${APPT_SQL} WHERE a.id=$1`, [r.rows[0].id]);
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
      const isClinic = role === 'admin' || (role === 'provider' && Number(a.powner) === me);
      const isCustomer = role === 'admin' || (role === 'customer' && Number(a.customer_user_id) === me);
      const dataNow = { ...(a.data || {}) };
      let status;
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
      return (await db.query(`${APPT_SQL} WHERE a.id=$1`, [id])).rows[0];
    });
    res.json({ appointment: apptJson(out) });
  }));
};
