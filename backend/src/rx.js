'use strict';
/**
 * Prescription forwarding (switch "rx"). The clinic writes the medicines (or attaches a photo) for a patient who booked with it and
 * suggests a pharmacy; the patient approves or changes the pharmacy; only then does the pharmacy see it. The pharmacy marks it ready and the
 * patient collects it or asks for delivery. A prescription is valid for 7 days. Visible only to the patient, the clinic that wrote it,
 * the chosen pharmacy (after the patient approved) and the app owner.
 */
const extrasLib = require('./extras');
const MAX_IMG = 900000;
const MAX_MEDS = 1500;

module.exports = function registerRx(app, { pool, auth, roles, asyncRoute, positiveId, pushToUsers }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => {
    try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; }
  });
  const me = req => Number(req.auth.sub);
  const notify = (ids, payload) => { try { const p = pushToUsers && pushToUsers(ids.filter(Boolean), payload); if (p && p.catch) p.catch(() => {}); } catch { /* never fails the request */ } };
  const on = async () => { if (!(await extrasLib.featureOn(pool, 'rx'))) throw fail(409, 'الميزة غير متاحة حاليًا'); };
  const num = id => `RX-${1000 + Number(id)}`;
  const SQL = `SELECT x.*, pu.name AS patient_name, cp.name AS clinic_name, cp.owner_user_id AS clinic_owner, ph.name AS pharmacy_name, ph.owner_user_id AS pharmacy_owner,
      (x.image IS NOT NULL) AS has_image, (x.expires_at < NOW()) AS expired
    FROM prescriptions x JOIN users pu ON pu.id=x.patient_user_id JOIN providers cp ON cp.id=x.clinic_provider_id LEFT JOIN providers ph ON ph.id=x.pharmacy_provider_id`;
  const FINAL = ['picked_up', 'cancelled'];
  const json = (r, role) => ({
    id: String(r.id), number: num(r.id), patientName: r.patient_name, clinicName: r.clinic_name,
    pharmacyId: r.pharmacy_provider_id ? String(r.pharmacy_provider_id) : '', pharmacyName: r.pharmacy_name || '',
    meds: r.meds, price: r.price == null ? null : Number(r.price), hasImage: r.has_image, status: r.expired && !FINAL.includes(r.status) ? 'expired' : r.status,
    expiresAt: new Date(r.expires_at).getTime(), createdAt: new Date(r.created_at).getTime(), role,
    // the app opens the prescription by itself for whoever has to act now: the patient (choose a pharmacy / collect or deliver) or the pharmacy (prepare it)
    needsAction: !r.expired && ((role === 'patient' && ['issued', 'ready'].includes(r.status)) || (role === 'pharmacy' && r.status === 'sent')),
  });
  const roleIn = (r, req) => {
    const u = me(req);
    if (req.auth.role === 'admin') return 'admin';
    if (Number(r.patient_user_id) === u) return 'patient';
    if (Number(r.clinic_owner) === u) return 'clinic';
    if (r.pharmacy_owner && Number(r.pharmacy_owner) === u && r.status !== 'issued') return 'pharmacy';
    return null;
  };
  const load = async (req, id) => {
    const r = await pool.query(`${SQL} WHERE x.id=$1`, [id]);
    if (!r.rowCount) throw fail(404, 'الروشتة غير موجودة');
    const role = roleIn(r.rows[0], req);
    if (!role) throw fail(404, 'الروشتة غير موجودة');
    return { row: r.rows[0], role };
  };
  const live = row => {
    if (row.expired && !FINAL.includes(row.status)) throw fail(409, 'انتهت صلاحية الروشتة (7 أيام)');
    if (row.status === 'cancelled') throw fail(409, 'الروشتة ملغية');
  };
  const parseImg = v => { if (!v) return null; const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(v)); if (!m || String(v).length > MAX_IMG) throw fail(400, 'ارفع صورة صالحة (JPG أو PNG) وبحجم أصغر'); return { mime: m[1], buf: Buffer.from(m[2], 'base64') }; };

  /* pharmacies the clinic can pick from: the patient's own area first (the "nearest" suggestion) */
  app.get('/api/rx/pharmacies/:appointmentId', auth, roles('provider', 'admin'), guard(async (req, res) => {
    await on();
    const aid = positiveId(req.params.appointmentId);
    if (!aid) throw fail(400, 'معرّف غير صالح');
    const a = await pool.query('SELECT a.customer_user_id, p.owner_user_id FROM appointments a JOIN providers p ON p.id=a.provider_id WHERE a.id=$1', [aid]);
    if (!a.rowCount || (req.auth.role !== 'admin' && Number(a.rows[0].owner_user_id) !== me(req))) throw fail(404, 'الحجز غير موجود');
    const r = await pool.query(`SELECT p.id, p.name, g.name AS region, COALESCE(u.region_id IS NOT NULL AND u.region_id = o.region_id, FALSE) AS suggested
      FROM providers p JOIN users o ON o.id=p.owner_user_id LEFT JOIN regions g ON g.id=o.region_id, users u
      WHERE u.id=$1 AND p.type='pharmacy' AND p.status='active' AND p.deleted_at IS NULL ORDER BY suggested DESC, p.name LIMIT 40`, [a.rows[0].customer_user_id]);
    res.set('Cache-Control', 'no-store');
    res.json({ pharmacies: r.rows.map(x => ({ id: String(x.id), name: x.name, region: x.region || '', suggested: !!x.suggested })) });
  }));

  app.post('/api/rx', auth, roles('provider', 'admin'), guard(async (req, res) => {
    await on();
    const b = req.body || {};
    const aid = positiveId(b.appointmentId);
    const meds = String(b.meds || '').trim().slice(0, MAX_MEDS);
    const img = parseImg(b.image);
    if (!aid) throw fail(400, 'اختر الحجز');
    if (!meds && !img) throw fail(400, 'اكتب الأدوية أو ارفع صورة الروشتة');
    const a = await pool.query('SELECT a.customer_user_id, a.provider_id, a.status, p.owner_user_id FROM appointments a JOIN providers p ON p.id=a.provider_id WHERE a.id=$1', [aid]);
    if (!a.rowCount || (req.auth.role !== 'admin' && Number(a.rows[0].owner_user_id) !== me(req))) throw fail(404, 'الحجز غير موجود');
    if (!['confirmed', 'completed'].includes(a.rows[0].status)) throw fail(409, 'الروشتة بعد تأكيد الحجز');
    let pharmacy = null;
    if (b.pharmacyId) {
      const pid = positiveId(b.pharmacyId);
      const ph = pid && await pool.query("SELECT id FROM providers WHERE id=$1 AND type='pharmacy' AND status='active' AND deleted_at IS NULL", [pid]);
      if (!ph || !ph.rowCount) throw fail(400, 'الصيدلية غير صالحة');
      pharmacy = pid;
    }
    const r = await pool.query('INSERT INTO prescriptions(patient_user_id, clinic_provider_id, appointment_id, pharmacy_provider_id, meds, image, mime) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [a.rows[0].customer_user_id, a.rows[0].provider_id, aid, pharmacy, meds, img ? img.buf : null, img ? img.mime : null]);
    const cl = await pool.query('SELECT name FROM providers WHERE id=$1', [a.rows[0].provider_id]);
    const phn = pharmacy ? (await pool.query('SELECT name FROM providers WHERE id=$1', [pharmacy])).rows[0] : null;
    notify([a.rows[0].customer_user_id], { title: `${(cl.rows[0] || {}).name || 'العيادة'} كتبت لك روشتة 💊`, body: phn ? `رقم ${num(r.rows[0].id)} — رشّحنا لك صيدلية ${phn.name}. افتح التطبيق وأكّد الصيدلية` : `رقم ${num(r.rows[0].id)} — افتح التطبيق واختار الصيدلية`, tag: 'rx-' + r.rows[0].id, url: '/' });
    const out = await pool.query(`${SQL} WHERE x.id=$1`, [r.rows[0].id]);
    res.status(201).json({ rx: json(out.rows[0], 'clinic') });
  }));

  app.get('/api/rx', auth, guard(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!(await extrasLib.featureOn(pool, 'rx'))) return res.json({ enabled: false, list: [] });
    const u = me(req);
    const r = await pool.query(`${SQL} WHERE x.patient_user_id=$1 OR cp.owner_user_id=$1 OR (ph.owner_user_id=$1 AND x.status <> 'issued') OR $2 = 'admin' ORDER BY x.id DESC LIMIT 100`, [u, req.auth.role]);
    res.json({ enabled: true, list: r.rows.map(x => json(x, roleIn(x, req))) });
  }));
  app.get('/api/rx/:id/image', auth, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    await on();
    await load(req, id);
    const r = await pool.query('SELECT image, mime FROM prescriptions WHERE id=$1 AND image IS NOT NULL', [id]);
    if (!r.rowCount) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime); res.set('Cache-Control', 'private, no-store');
    res.send(r.rows[0].image);
  }));
  // the picture as a data URL, for the apps (an <Image> cannot send the sign-in header)
  app.get('/api/rx/:id/photo', auth, guard(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    await on();
    await load(req, id);
    const r = await pool.query('SELECT image, mime FROM prescriptions WHERE id=$1 AND image IS NOT NULL', [id]);
    res.set('Cache-Control', 'private, no-store');
    res.json({ image: r.rowCount ? `data:${r.rows[0].mime};base64,${r.rows[0].image.toString('base64')}` : null });
  }));

  const step = async (req, res, allowed, from, make) => {
    const id = positiveId(req.params.id);
    if (!id) throw fail(400, 'معرّف غير صالح');
    await on();
    const { row, role } = await load(req, id);
    if (!allowed.includes(role)) throw fail(403, 'غير مسموح');
    live(row);
    if (!from.includes(row.status)) throw fail(409, 'لا يمكن تنفيذ هذه الخطوة الآن');
    const out = await make(row, role);
    const r = await pool.query(`${SQL} WHERE x.id=$1`, [id]);
    res.json({ rx: json(r.rows[0], role), ...(out || {}) });
  };
  app.post('/api/rx/:id/choose', auth, roles('customer'), guard((req, res) => step(req, res, ['patient'], ['issued', 'sent'], async row => {
    const pid = positiveId((req.body || {}).pharmacyId) || (row.pharmacy_provider_id && Number(row.pharmacy_provider_id));
    if (!pid) throw fail(400, 'اختر الصيدلية');
    const ph = await pool.query("SELECT owner_user_id FROM providers WHERE id=$1 AND type='pharmacy' AND status='active' AND deleted_at IS NULL", [pid]);
    if (!ph.rowCount) throw fail(400, 'الصيدلية غير صالحة');
    await pool.query("UPDATE prescriptions SET pharmacy_provider_id=$1, status='sent', updated_at=NOW() WHERE id=$2", [pid, row.id]);
    notify([ph.rows[0].owner_user_id], { title: 'روشتة جديدة للتجهيز 💊', body: `${num(row.id)} من ${row.patient_name} — جهّزها وبلّغ العميل`, tag: 'rx-' + row.id, url: '/' });
    notify([row.clinic_owner], { title: 'المريض أكّد الصيدلية ✅', body: `${row.patient_name} بعت ${num(row.id)} للصيدلية`, tag: 'rx-c-' + row.id, url: '/' });
  })));
  // the pharmacy's price for the medicines (optional on the server, the app asks for it); the patient sees it before choosing pickup or delivery
  const parsePrice = v => {
    if (v === undefined || v === null || v === '') return null;
    const n = Math.round(Number(v) * 100) / 100;
    if (!Number.isFinite(n) || n <= 0 || n > 100000) throw fail(400, 'اكتب سعر الأدوية بشكل صحيح');
    return n;
  };
  const egp = n => `${Number(n)} ج`;
  app.post('/api/rx/:id/ready', auth, roles('provider'), guard((req, res) => step(req, res, ['pharmacy'], ['sent'], async row => {
    const price = parsePrice((req.body || {}).price);
    await pool.query("UPDATE prescriptions SET status='ready', price=COALESCE($2, price), updated_at=NOW() WHERE id=$1", [row.id, price]);
    notify([row.patient_user_id], { title: `روشتتك جاهزة في ${row.pharmacy_name} 💊`, body: `${num(row.id)}${price ? ` — الأدوية بـ ${egp(price)}` : ''} — تحب تستلمها بنفسك ولا نوصّلهالك؟ افتح التطبيق واختار`, tag: 'rx-' + row.id, url: '/' });
  })));
  app.post('/api/rx/:id/price', auth, roles('provider'), guard((req, res) => step(req, res, ['pharmacy'], ['sent', 'ready'], async row => {
    const price = parsePrice((req.body || {}).price);
    if (!price) throw fail(400, 'اكتب سعر الأدوية');
    await pool.query('UPDATE prescriptions SET price=$2, updated_at=NOW() WHERE id=$1', [row.id, price]);
    if (row.status === 'ready' && Number(row.price) !== price) notify([row.patient_user_id], { title: 'سعر أدوية روشتتك اتغيّر 💊', body: `${num(row.id)} — السعر الجديد ${egp(price)}`, tag: 'rx-p-' + row.id, url: '/' });
  })));
  app.post('/api/rx/:id/pickup', auth, roles('customer', 'provider', 'admin'), guard((req, res) => step(req, res, ['patient', 'pharmacy', 'admin'], ['sent', 'ready', 'delivery'], async row => {
    await pool.query("UPDATE prescriptions SET status='picked_up', updated_at=NOW() WHERE id=$1", [row.id]);
    // collected from the pharmacy: the platform's commission on the medicines' price (a delivered one is already an ordinary order with its own commission)
    if (row.status !== 'delivery') await accrue(row);
  })));
  // collected from the pharmacy: exactly like any other commission, the owner's ordinary provider rules decide (percent / fixed, minimum, scope, dates)
  const accrue = async row => {
    try {
      if (!row.pharmacy_provider_id || row.price == null || Number(row.price) <= 0) return;
      const comm = require('./commissions');
      const type = ((await pool.query('SELECT type FROM providers WHERE id=$1', [row.pharmacy_provider_id])).rows[0] || {}).type || 'pharmacy';
      const rule = await comm.ruleFor(pool, 'provider', new Date(), type, row.pharmacy_provider_id, null);
      const amount = comm.computeAmount(rule, Number(row.price));
      if (!rule || !(amount > 0)) return;
      await pool.query(`INSERT INTO commission_entries(entry_type, kind, rx_id, provider_id, base_amount, amount, rule_id, rule_snapshot, note)
        VALUES('accrual','provider',$1,$2,$3,$4,$5,$6,$7) ON CONFLICT (rx_id, kind) WHERE entry_type='accrual' AND rx_id IS NOT NULL DO NOTHING`,
      [row.id, row.pharmacy_provider_id, row.price, amount, rule.id, JSON.stringify({ id: String(rule.id), scope: rule.scope, kind: rule.kind, value: Number(rule.value), minAmount: Number(rule.min_amount), effectiveFrom: new Date(rule.effective_from).getTime() }), `روشتة ${num(row.id)}`]);
    } catch (e) { console.error('rx commission failed:', e.message); }
  };
  // "deliver it to me": the patient then sends an ordinary written order to the pharmacy that carries the RX number
  app.post('/api/rx/:id/delivery', auth, roles('customer'), guard((req, res) => step(req, res, ['patient'], ['sent', 'ready'], async row => {
    await pool.query("UPDATE prescriptions SET status='delivery', updated_at=NOW() WHERE id=$1", [row.id]);
    if (row.pharmacy_owner) notify([row.pharmacy_owner], { title: 'العميل عايز توصيل الروشتة 🛵', body: `${num(row.id)} — هيوصلك طلب مكتوب بالتفاصيل`, tag: 'rx-d-' + row.id, url: '/' });
    return { orderText: `روشتة ${num(row.id)}${row.price != null ? ` (سعر الأدوية ${egp(row.price)})` : ''}: ${row.meds || 'بالصورة المرفقة'}`.slice(0, 600), pharmacyId: String(row.pharmacy_provider_id) };
  })));
  app.post('/api/rx/:id/cancel', auth, roles('customer', 'provider', 'admin'), guard((req, res) => step(req, res, ['patient', 'clinic', 'admin'], ['issued', 'sent'], async row => {
    await pool.query("UPDATE prescriptions SET status='cancelled', updated_at=NOW() WHERE id=$1", [row.id]);
  })));
};
