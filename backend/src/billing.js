'use strict';
/**
 * "عمل فاتورة": invoices the owner (or a manager with the `invoices` permission) writes by hand.
 *  - kinds: customer (items + delivery), provider / courier (items), commission (from a shop or a courier; the app writes the figures or the owner does)
 *  - every invoice keeps a snapshot of the look it was made with, and the stamps placed on it (any number, or none)
 *  - the look (what shows, colour / black-and-white, paper width, fixed lines) and the stamp library are the OWNER's alone (see managers.js)
 * The picture (WhatsApp) / print is drawn by the app from the saved invoice; nothing here renders pixels.
 */
const fail = (status, error) => Object.assign(new Error(error), { http: status });

const BUILTIN_STAMPS = ['circle', 'logo', 'rect', 'gold'];
const DEFAULT_DESIGN = {
  showLogo: true, showSupport: true, showParty: true, showPayment: true, showThanks: true,
  tagline: 'خدمة أسرع لحياة أسهل', supportPhone: '01004379508', website: 'otlobabis.com',
  thanks: 'شكراً لثقتكم في أطلب أبيس', payment: 'كاش عند الاستلام',
  theme: 'color', width: 'wa', fixed: [], defaultStamps: [],
};
const str = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v, lo, hi, what) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw fail(400, `${what} غير صحيح`);
  return Math.round(n * 100) / 100;
};
const money = v => Math.round(Number(v) * 100) / 100;
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const refOk = r => typeof r === 'string' && (/^u:\d{1,12}$/.test(r) || (r.startsWith('b:') && BUILTIN_STAMPS.includes(r.slice(2))));

/** Anything the client sends for the look is cleaned here; unknown keys are dropped. */
function cleanDesign(raw, base = DEFAULT_DESIGN) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const out = { ...base };
  for (const k of ['showLogo', 'showSupport', 'showParty', 'showPayment', 'showThanks']) if (k in b) out[k] = bool(b[k], base[k]);
  for (const [k, max] of [['tagline', 60], ['supportPhone', 20], ['website', 60], ['thanks', 90], ['payment', 60]]) if (k in b) out[k] = str(b[k], max);
  if ('theme' in b) { if (!['color', 'bw'].includes(b.theme)) throw fail(400, 'شكل الفاتورة غير صحيح'); out.theme = b.theme; }
  if ('width' in b) { if (!['wa', '80', '58'].includes(String(b.width))) throw fail(400, 'عرض الورق غير صحيح'); out.width = String(b.width); }
  if ('fixed' in b) {
    if (!Array.isArray(b.fixed) || b.fixed.length > 8) throw fail(400, 'البيانات الثابتة حد أقصى 8');
    out.fixed = b.fixed.map(x => ({ label: str(x && x.label, 40), value: str(x && x.value, 120) })).filter(x => x.label || x.value);
  }
  if ('defaultStamps' in b) {
    if (!Array.isArray(b.defaultStamps) || b.defaultStamps.length > 4 || !b.defaultStamps.every(refOk)) throw fail(400, 'الأختام الافتراضية غير صحيحة');
    out.defaultStamps = [...new Set(b.defaultStamps)];
  }
  return out;
}

function cleanStamps(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 6) throw fail(400, 'حد أقصى 6 أختام على الفاتورة');
  return list.map(s => {
    if (!s || !refOk(s.ref)) throw fail(400, 'ختم غير صحيح');
    const x = Number(s.x), y = Number(s.y), size = Number(s.size);
    if (![x, y, size].every(Number.isFinite) || x < 0 || x > 1 || y < 0 || y > 1 || size < 0.08 || size > 0.7) throw fail(400, 'مكان أو حجم الختم غير صحيح');
    return { ref: s.ref, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, size: Math.round(size * 1000) / 1000 };
  });
}

function cleanPhone(v) {
  const p = String(v == null ? '' : v).replace(/[\s-]/g, '');
  if (!p) return '';
  if (!/^01[0-9]{9}$/.test(p)) throw fail(400, 'رقم الموبايل غير صحيح');
  return p;
}

function register(app, { pool, auth, roles, asyncRoute, positiveId, hashPassword }) {
  const guard = fn => asyncRoute(async (req, res) => { try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; } });
  const admin = [auth, roles('admin')];
  const me = req => Number(req.auth.sub);

  async function loadDesign() {
    try {
      const r = await pool.query('SELECT design FROM invoice_design WHERE id=1');
      return r.rowCount ? cleanDesign(r.rows[0].design) : { ...DEFAULT_DESIGN };
    } catch { return { ...DEFAULT_DESIGN }; }
  }
  const stampRow = r => ({ id: Number(r.id), name: r.name, image: r.image, active: r.active });
  async function loadStamps(all) {
    const r = await pool.query(`SELECT id, name, image, active FROM invoice_stamps ${all ? '' : 'WHERE active'} ORDER BY sort_order, id`);
    return r.rows.map(stampRow);
  }
  async function nextNumber() {
    const r = await pool.query('SELECT last_value, is_called FROM manual_invoice_no_seq');
    return Number(r.rows[0].last_value) + (r.rows[0].is_called ? 1 : 0);
  }
  const invoiceJson = r => ({
    id: Number(r.id), number: Number(r.number), kind: r.kind, partyKind: r.party_kind, partyName: r.party_name, partyPhone: r.party_phone,
    partyUserId: r.party_user_id == null ? null : Number(r.party_user_id), partyProviderId: r.party_provider_id == null ? null : Number(r.party_provider_id),
    lines: r.lines || [], extras: r.extras || [], delivery: Number(r.delivery), discount: Number(r.discount), total: Number(r.total),
    commission: r.commission || null, design: r.design || {}, stamps: r.stamps || [], note: r.note || '',
    voided: !!r.voided_at, createdAt: new Date(r.created_at).getTime(),
  });

  /* ----- what the screens need to start ----- */
  app.get('/api/admin/billing/config', ...admin, guard(async (req, res) => {
    const [design, stamps, nextNo] = await Promise.all([loadDesign(), loadStamps(false), nextNumber()]);
    res.json({ design, stamps, nextNumber: nextNo });
  }));

  /* ----- the look (owner only: managers.js blocks writes) ----- */
  app.put('/api/admin/billing/design', ...admin, guard(async (req, res) => {
    const d = cleanDesign(req.body || {}, await loadDesign());
    await pool.query(`INSERT INTO invoice_design(id, design, updated_at) VALUES(1, $1, NOW())
      ON CONFLICT (id) DO UPDATE SET design=$1, updated_at=NOW()`, [JSON.stringify(d)]);
    res.json({ ok: true, design: d });
  }));

  /* ----- the owner's own stamps ----- */
  app.get('/api/admin/billing/stamps', ...admin, guard(async (req, res) => { res.json({ stamps: await loadStamps(false) }); }));
  app.post('/api/admin/billing/stamps', ...admin, guard(async (req, res) => {
    const b = req.body || {};
    const image = String(b.image || '');
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image)) throw fail(400, 'ارفع صورة PNG أو JPG');
    if (image.length > 480000) throw fail(400, 'الصورة كبيرة، صغّرها لأقل من 350 كيلو');
    const name = str(b.name, 40) || 'ختم';
    const n = Number((await pool.query('SELECT COUNT(*)::int AS n FROM invoice_stamps WHERE active')).rows[0].n);
    if (n >= 20) throw fail(409, 'وصلت للحد الأقصى (20 ختم). احذف ختم قديم أولاً');
    const r = await pool.query('INSERT INTO invoice_stamps(name, image, sort_order) VALUES($1,$2,$3) RETURNING id, name, image, active', [name, image, n]);
    res.status(201).json({ stamp: stampRow(r.rows[0]) });
  }));
  app.patch('/api/admin/billing/stamps/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const name = str((req.body || {}).name, 40);
    if (!name) throw fail(400, 'اكتب اسم الختم');
    const r = await pool.query('UPDATE invoice_stamps SET name=$2 WHERE id=$1 AND active RETURNING id, name, image, active', [id, name]);
    if (!r.rowCount) throw fail(404, 'الختم غير موجود');
    res.json({ stamp: stampRow(r.rows[0]) });
  }));
  app.delete('/api/admin/billing/stamps/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const r = await pool.query('UPDATE invoice_stamps SET active=FALSE WHERE id=$1 AND active', [id]);
    if (!r.rowCount) throw fail(404, 'الختم غير موجود');
    // a deleted stamp must not stay as a default on new invoices
    const d = await loadDesign();
    if (d.defaultStamps.includes('u:' + id)) {
      d.defaultStamps = d.defaultStamps.filter(x => x !== 'u:' + id);
      await pool.query(`INSERT INTO invoice_design(id, design) VALUES(1,$1) ON CONFLICT (id) DO UPDATE SET design=$1, updated_at=NOW()`, [JSON.stringify(d)]);
    }
    res.json({ ok: true });
  }));
  /** the picture of a stamp that an OLD invoice carries but that was removed since (so the invoice still shows it) */
  app.get('/api/admin/billing/stamps/all', ...admin, guard(async (req, res) => { res.json({ stamps: await loadStamps(true) }); }));

  /* ----- who the invoice is for (registered customers, shops, couriers) ----- */
  app.get('/api/admin/billing/parties', ...admin, guard(async (req, res) => {
    const kind = String(req.query.kind || 'customer');
    if (!['customer', 'provider', 'courier'].includes(kind)) throw fail(400, 'نوع غير صحيح');
    const q = str(req.query.q, 40);
    if (q.length < 2) return res.json({ parties: [] });
    const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
    let rows;
    if (kind === 'provider') {
      rows = (await pool.query(
        `SELECT p.id AS provider_id, p.owner_user_id AS user_id, p.name, COALESCE(NULLIF(p.phone,''), u.phone) AS phone
           FROM providers p JOIN users u ON u.id=p.owner_user_id
          WHERE (p.name ILIKE $1 OR p.phone ILIKE $1 OR u.phone ILIKE $1 OR u.name ILIKE $1) AND u.deleted_at IS NULL ORDER BY p.name LIMIT 20`, [like])).rows;
    } else {
      rows = (await pool.query(
        `SELECT NULL::bigint AS provider_id, id AS user_id, name, phone FROM users
          WHERE role=$2 AND deleted_at IS NULL AND (name ILIKE $1 OR phone ILIKE $1) ORDER BY name LIMIT 20`, [like, kind])).rows;
    }
    res.json({ parties: rows.map(r => ({ kind, userId: Number(r.user_id), providerId: r.provider_id == null ? null : Number(r.provider_id), name: r.name, phone: r.phone || '' })) });
  }));

  /* ----- the commission figures the app writes by itself ----- */
  async function commissionFigures(kind, id, from, to) {
    const where = kind === 'provider' ? 'e.kind=\'provider\' AND e.provider_id=$1' : 'e.kind=\'courier\' AND e.courier_user_id=$1';
    const r = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE e.entry_type='accrual')::int AS orders,
              COALESCE(SUM(e.base_amount) FILTER (WHERE e.entry_type='accrual'), 0) AS base,
              COALESCE(SUM(e.amount), 0) AS commission,
              COALESCE(SUM(e.amount) FILTER (WHERE e.status='settled'), 0) AS settled
         FROM commission_entries e
        WHERE ${where} AND e.created_at >= $2::date AND e.created_at < ($3::date + 1)`, [id, from, to]);
    const x = r.rows[0];
    const base = money(x.base), commission = money(x.commission), settled = money(x.settled);
    return { orders: Number(x.orders), base, commission, settled, due: Math.max(0, money(commission - settled)), percent: base > 0 ? Math.round((commission / base) * 1000) / 10 : null };
  }
  const dateOk = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(s));
  app.get('/api/admin/billing/commission-preview', ...admin, guard(async (req, res) => {
    const kind = String(req.query.kind || '');
    if (!['provider', 'courier'].includes(kind)) throw fail(400, 'نوع غير صحيح');
    const id = positiveId(req.query.id); if (!id) throw fail(400, 'اختر الطرف أولاً');
    const from = String(req.query.from || ''), to = String(req.query.to || '');
    if (!dateOk(from) || !dateOk(to) || from > to) throw fail(400, 'الفترة غير صحيحة');
    res.json({ figures: await commissionFigures(kind, id, from, to) });
  }));


  /* ----- the owner adds a delivery courier himself: the account is active at once ----- */
  app.post('/api/admin/couriers', ...admin, guard(async (req, res) => {
    const b = req.body || {};
    const name = str(b.name, 80);
    if (name.length < 3) throw fail(400, 'اكتب الاسم بالكامل');
    const phone = String(b.phone || '').replace(/\s+/g, '');
    if (!/^01[0-9]{9}$/.test(phone)) throw fail(400, 'رقم الهاتف غير صحيح');
    if (typeof b.password !== 'string' || b.password.length < 8) throw fail(400, 'كلمة المرور يجب ألا تقل عن 8 أحرف');
    let vehicle = '';
    if (b.vehicle) {
      const v = await pool.query('SELECT name FROM courier_vehicles WHERE active AND name=$1', [str(b.vehicle, 30)]);
      if (!v.rowCount) throw fail(400, 'وسيلة التوصيل غير موجودة');
      vehicle = v.rows[0].name;
    }
    let region = null;
    if (b.regionId != null && b.regionId !== '') {
      region = positiveId(b.regionId);
      if (!region || !(await pool.query('SELECT 1 FROM regions WHERE id=$1 AND active=TRUE', [region])).rowCount) throw fail(400, 'المنطقة غير متاحة');
    }
    try {
      const r = await pool.query("INSERT INTO users(name,phone,password_hash,role,address,status,region_id,vehicle) VALUES($1,$2,$3,'courier','','active',$4,$5) RETURNING id, name, phone, vehicle, region_id",
        [name, phone, await hashPassword(b.password), region, vehicle || 'موتوسيكل']);
      res.status(201).json({ courier: { id: Number(r.rows[0].id), name: r.rows[0].name, phone: r.rows[0].phone, vehicle: r.rows[0].vehicle, regionId: r.rows[0].region_id } });
    } catch (e) {
      if (e.code === '23505') throw fail(409, 'رقم الهاتف مسجل بالفعل');
      throw e;
    }
  }));

  /* ----- the invoices ----- */
  app.get('/api/admin/billing/invoices', ...admin, guard(async (req, res) => {
    const q = str(req.query.q, 40);
    const lim = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
    const r = q
      ? await pool.query('SELECT * FROM manual_invoices WHERE party_name ILIKE $1 OR party_phone ILIKE $1 OR number::text = $2 ORDER BY id DESC LIMIT $3', [like, q, lim])
      : await pool.query('SELECT * FROM manual_invoices ORDER BY id DESC LIMIT $1', [lim]);
    res.json({ invoices: r.rows.map(x => { const j = invoiceJson(x); return { id: j.id, number: j.number, kind: j.kind, partyName: j.partyName, partyPhone: j.partyPhone, total: j.total, voided: j.voided, createdAt: j.createdAt }; }) });
  }));
  app.get('/api/admin/billing/invoices/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const r = await pool.query('SELECT * FROM manual_invoices WHERE id=$1', [id]);
    if (!r.rowCount) throw fail(404, 'الفاتورة غير موجودة');
    const inv = invoiceJson(r.rows[0]);
    // the stamps an invoice carries are returned with it, even removed ones, so it always draws the same
    const uids = inv.stamps.filter(s => s.ref.startsWith('u:')).map(s => Number(s.ref.slice(2)));
    const st = uids.length ? (await pool.query('SELECT id, name, image, active FROM invoice_stamps WHERE id = ANY($1::bigint[])', [uids])).rows.map(stampRow) : [];
    res.json({ invoice: inv, stamps: st });
  }));

  app.post('/api/admin/billing/invoices', ...admin, guard(async (req, res) => {
    const b = req.body || {};
    const kind = String(b.kind || '');
    if (!['customer', 'provider', 'courier', 'commission'].includes(kind)) throw fail(400, 'نوع الفاتورة غير صحيح');
    const partyKind = kind === 'commission' ? String(b.partyKind || '') : kind;
    if (!['customer', 'provider', 'courier'].includes(partyKind)) throw fail(400, 'اختر نوع الطرف');
    if (kind === 'commission' && partyKind === 'customer') throw fail(400, 'العمولة لمقدم خدمة أو مندوب');
    const partyName = str(b.partyName, 80);
    if (partyName.length < 2) throw fail(400, 'اكتب الاسم');
    const partyPhone = cleanPhone(b.partyPhone);
    const partyUserId = b.partyUserId == null ? null : positiveId(b.partyUserId);
    const partyProviderId = b.partyProviderId == null ? null : positiveId(b.partyProviderId);

    let lines = [], delivery = 0, discount = 0, total = 0, commission = null;
    if (kind === 'commission') {
      const c = b.commission || {};
      const mode = c.mode === 'auto' ? 'auto' : 'manual';
      const from = String(c.from || ''), to = String(c.to || '');
      if (!dateOk(from) || !dateOk(to) || from > to) throw fail(400, 'الفترة غير صحيحة');
      const base = num(c.base || 0, 0, 1e9, 'المبيعات'), cm = num(c.commission, 0, 1e9, 'العمولة'), settled = num(c.settled || 0, 0, 1e9, 'المدفوع سابقاً');
      const orders = Math.max(0, Math.min(1e7, Math.floor(Number(c.orders) || 0)));
      total = Math.max(0, money(cm - settled));
      commission = { mode, from, to, orders, base, commission: cm, settled, due: total, percent: base > 0 ? Math.round((cm / base) * 1000) / 10 : null };
      // the figures the app computed on its own are kept next to what was finally written, so a hand edit is visible later
      if (mode === 'auto') {
        const id = partyKind === 'provider' ? partyProviderId : partyUserId;
        if (id) { try { commission.computed = await commissionFigures(partyKind, id, from, to); } catch { /* no ledger: nothing to compare */ } }
      }
    } else {
      if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 40) throw fail(400, 'أضف صنف واحد على الأقل (حد أقصى 40)');
      lines = b.lines.map(l => {
        const name = str(l && l.name, 80); if (!name) throw fail(400, 'اكتب اسم كل صنف');
        return { name, qty: num(l.qty, 0.01, 9999, 'الكمية'), price: num(l.price, 0, 1e7, 'السعر') };
      });
      delivery = kind === 'customer' ? num(b.delivery || 0, 0, 1e6, 'خدمة التوصيل') : 0;
      discount = num(b.discount || 0, 0, 1e7, 'الخصم');
      const sum = lines.reduce((s, l) => s + l.qty * l.price, 0);
      total = money(sum + delivery - discount);
      if (total < 0) throw fail(400, 'الخصم أكبر من الإجمالي');
    }
    let extras = [];
    if (b.extras != null) {
      if (!Array.isArray(b.extras) || b.extras.length > 10) throw fail(400, 'حد أقصى 10 بيانات إضافية');
      extras = b.extras.map(x => ({ label: str(x && x.label, 40), value: str(x && x.value, 120) })).filter(x => x.label || x.value);
    }
    const stamps = cleanStamps(b.stamps);
    // stamps from the owner's library must exist
    const uids = stamps.filter(s => s.ref.startsWith('u:')).map(s => Number(s.ref.slice(2)));
    if (uids.length && (await pool.query('SELECT COUNT(*)::int AS n FROM invoice_stamps WHERE id = ANY($1::bigint[])', [uids])).rows[0].n !== new Set(uids).size) throw fail(400, 'ختم غير موجود');
    const design = cleanDesign(b.design, await loadDesign());
    let number = null;
    if (b.number != null && b.number !== '') { number = positiveId(b.number); if (!number || number > 2e9) throw fail(400, 'رقم الفاتورة غير صحيح'); }
    const note = str(b.note, 200);

    try {
      const r = await pool.query(
        `INSERT INTO manual_invoices(number, kind, party_kind, party_name, party_phone, party_user_id, party_provider_id, lines, extras, delivery, discount, total, commission, design, stamps, note, created_by)
         VALUES(COALESCE($1::bigint, nextval('manual_invoice_no_seq')), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [number, kind, partyKind, partyName, partyPhone, partyUserId, partyProviderId, JSON.stringify(lines), JSON.stringify(extras), delivery, discount, total,
          commission ? JSON.stringify(commission) : null, JSON.stringify(design), JSON.stringify(stamps), note, me(req)]);
      res.status(201).json({ invoice: invoiceJson(r.rows[0]) });
    } catch (e) {
      if (e.code === '23505') throw fail(409, 'رقم الفاتورة مستخدم قبل كده');
      throw e;
    }
  }));

  /** cancelling an invoice deletes it for good (the number is not reused) */
  app.delete('/api/admin/billing/invoices/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const r = await pool.query('DELETE FROM manual_invoices WHERE id=$1 RETURNING id', [id]);
    if (!r.rowCount) throw fail(404, 'الفاتورة غير موجودة');
    res.json({ ok: true });
  }));
}

module.exports = { register, cleanDesign, cleanStamps, DEFAULT_DESIGN };
