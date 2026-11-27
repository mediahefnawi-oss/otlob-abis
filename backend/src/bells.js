'use strict';
/**
 * "الجرس": the owner rings a courier or a shop about ONE order. The phone keeps ringing (a loud push repeated every RING_EVERY_MS)
 * until the person ACCEPTS or REFUSES the order, or the owner stops it, or MAX_MS pass. The owner is told how it ended.
 * Everything here is additive: the normal order flow is untouched; orders.js only calls bells.afterAction() after a decision.
 */
const RING_EVERY_MS = 15 * 1000;
const MAX_MS = 30 * 60 * 1000;
const COURIER_OPEN = ['accepted', 'ready'];      // an order a courier can still take (not picked up yet)
const SHOP_OPEN = ['pending', 'quoted'];         // an order the shop has not decided yet

function register(app, { pool, auth, roles, asyncRoute, positiveId, pushToUsers }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => { try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; } });
  const me = req => Number(req.auth.sub);
  const push = (ids, title, body, tag, ring) => { if (!pushToUsers || !ids.length) return Promise.resolve(); return Promise.resolve(pushToUsers(ids, { title, body, tag, url: '/', requireInteraction: true, ...(ring ? { ring: true } : {}) })).catch(() => {}); };
  const admins = async () => (await pool.query("SELECT id FROM users WHERE role='admin' AND status='active' AND deleted_at IS NULL")).rows.map(x => Number(x.id));
  const tellOwner = async (title, body, tag, extraId) => push([...new Set([...(await admins()), ...(extraId ? [Number(extraId)] : [])])], title, body, tag, false);
  const label = o => `#${o.order_number || o.id}`;
  const orderRow = async id => (await pool.query('SELECT o.*, p.owner_user_id AS powner, p.is_open AS popen, p.name AS pname FROM orders o LEFT JOIN providers p ON p.id=o.provider_id WHERE o.id=$1', [id])).rows[0];
  const bellJson = b => ({ id: Number(b.id), orderId: Number(b.order_id), targetId: Number(b.target_id), role: b.role, status: b.status, startedAt: new Date(b.started_at).getTime(), sends: b.sends });

  /** One loud push for a ringing bell. */
  async function ringOnce(b, o) {
    const d = (o && o.data) || {};
    const where = b.role === 'courier' ? (d.regionName || d.address || '') : (d.customerName ? `العميل ${d.customerName}` : '');
    const title = b.role === 'courier' ? '🔔 طلب من الإدارة يحتاج ردّك' : '🔔 طلب جديد يحتاج ردّك';
    const body = `${o ? label(o) : ''} ${d.providerName || ''}${where ? ' — ' + where : ''}. افتح الطلب واقبل أو ارفض`;
    await push([Number(b.target_id)], title, body.trim(), `bell-${b.id}`, true);
    await pool.query('UPDATE bells SET last_sent_at=NOW(), sends=sends+1 WHERE id=$1', [b.id]);
  }
  async function endBell(b, status, reason) {
    const r = await pool.query("UPDATE bells SET status=$2, ended_at=NOW(), reason=$3 WHERE id=$1 AND status='ringing' RETURNING *", [b.id, status, reason || null]);
    return r.rows[0] || null;
  }
  const whoName = async uid => ((await pool.query('SELECT name FROM users WHERE id=$1', [uid])).rows[0] || {}).name || '';

  /** A supervisor rings only about orders of his own areas (the owner and managers: any). */
  async function areaOk(req, o) {
    if (req.auth.role !== 'supervisor') return true;
    const r = await pool.query('SELECT sup_regions FROM users WHERE id=$1', [me(req)]);
    return !!o.region_id && String((r.rows[0] || {}).sup_regions || '').split(',').filter(Boolean).includes(String(o.region_id));
  }

  /* ---------- the owner and supervisors ---------- */
  app.post('/api/admin/orders/:id/bell', auth, roles('admin', 'supervisor'), guard(async (req, res) => {
    const id = positiveId(req.params.id), role = String((req.body || {}).role || ''), target = positiveId((req.body || {}).targetId);
    if (!id) throw fail(400, 'طلب غير صالح');
    if (!['courier', 'shop'].includes(role)) throw fail(400, 'اختر مندوب أو محل');
    const o = await orderRow(id);
    if (!o) throw fail(404, 'الطلب غير موجود');
    if (!(await areaOk(req, o))) throw fail(403, 'هذا الطلب خارج مناطقك');
    if (req.auth.role === 'supervisor' && role !== 'courier') throw fail(403, 'المشرف يرنّ على المناديب فقط');
    let tid;
    if (role === 'courier') {
      tid = target; if (!tid) throw fail(400, 'اختر المندوب');
      if (!COURIER_OPEN.includes(o.status)) throw fail(409, 'الطلب ده مش متاح للمناديب دلوقتي');
      if (o.courier_user_id && Number(o.courier_user_id) !== tid) throw fail(409, 'الطلب معيّن لمندوب تاني');
      const c = (await pool.query("SELECT available, orders_off, status FROM users WHERE id=$1 AND role='courier' AND deleted_at IS NULL", [tid])).rows[0];
      if (!c || c.status !== 'active' || !c.available || c.orders_off) throw fail(409, 'المندوب غير متاح، جرّب مندوب تاني');
    } else {
      tid = Number(o.powner || 0); if (!tid) throw fail(409, 'المحل ده ملوش حساب مالك');
      if (!SHOP_OPEN.includes(o.status)) throw fail(409, 'المحل خلاص رد على الطلب ده');
      if (!o.popen) throw fail(409, 'المحل غير متاح (مقفول دلوقتي)');
    }
    // one ringing bell per order and person: a second press just returns it
    const had = (await pool.query("SELECT * FROM bells WHERE order_id=$1 AND target_id=$2 AND status='ringing'", [id, tid])).rows[0];
    if (had) return res.json({ bell: bellJson(had), already: true });
    const b = (await pool.query('INSERT INTO bells(order_id, target_id, role, started_by) VALUES($1,$2,$3,$4) RETURNING *', [id, tid, role, me(req)])).rows[0];
    await ringOnce(b, o);
    res.status(201).json({ bell: bellJson(b) });
  }));
  app.delete('/api/admin/orders/:id/bell', auth, roles('admin', 'supervisor'), guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'طلب غير صالح');
    const oo = await orderRow(id); if (!oo) throw fail(404, 'الطلب غير موجود');
    if (!(await areaOk(req, oo))) throw fail(403, 'هذا الطلب خارج مناطقك');
    const rows = (await pool.query("SELECT * FROM bells WHERE order_id=$1 AND status='ringing'", [id])).rows;
    for (const b of rows) {
      if (await endBell(b, 'stopped', 'owner')) push([Number(b.target_id)], 'تم إيقاف التنبيه', 'الإدارة أوقفت الجرس', `bell-${b.id}`, false);
    }
    res.json({ ok: true, stopped: rows.length });
  }));
  app.get('/api/admin/orders/:id/bells', auth, roles('admin', 'supervisor'), guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'طلب غير صالح');
    const oo = await orderRow(id); if (!oo) throw fail(404, 'الطلب غير موجود');
    if (!(await areaOk(req, oo))) throw fail(403, 'هذا الطلب خارج مناطقك');
    const r = await pool.query(`SELECT b.*, u.name FROM bells b JOIN users u ON u.id=b.target_id WHERE b.order_id=$1 ORDER BY b.id DESC LIMIT 10`, [id]);
    res.json({ bells: r.rows.map(b => ({ ...bellJson(b), name: b.name, reason: b.reason || '' })) });
  }));

  /* ---------- the person who is rung ---------- */
  app.get('/api/me/bells', auth, roles('courier', 'provider'), guard(async (req, res) => {
    const r = await pool.query("SELECT * FROM bells WHERE target_id=$1 AND status='ringing' ORDER BY id DESC LIMIT 5", [me(req)]);
    const out = [];
    for (const b of r.rows) {
      const o = await orderRow(b.order_id); if (!o) continue;
      const d = o.data || {};
      out.push({ ...bellJson(b), order: { id: Number(o.id), number: o.order_number, status: o.status, shop: d.providerName || o.pname || '', address: d.address || '', region: d.regionName || '', total: Number(d.total || 0), customer: d.customerName || '', mine: Number(o.courier_user_id) === me(req) } });
    }
    res.json({ bells: out });
  }));
  /** The courier refuses a ringing order: it goes back to the owner without a courier (not yet picked up). */
  app.post('/api/orders/:id/bell/respond', auth, roles('courier'), guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'طلب غير صالح');
    const decision = String((req.body || {}).decision || '');
    if (!['accept', 'reject'].includes(decision)) throw fail(400, 'اختر قبول أو رفض');
    const b = (await pool.query("SELECT * FROM bells WHERE order_id=$1 AND target_id=$2 AND status='ringing' ORDER BY id DESC LIMIT 1", [id, me(req)])).rows[0];
    const o = await orderRow(id); if (!o) throw fail(404, 'الطلب غير موجود');
    if (decision === 'accept') {
      if (Number(o.courier_user_id) !== me(req)) throw fail(409, 'اقبل الطلب من شاشة الطلبات');
      if (b) await afterDecision(b, 'accepted', o);
      return res.json({ ok: true });
    }
    if (!COURIER_OPEN.includes(o.status)) throw fail(409, 'الطلب اتسلّم أو مشي، مينفعش ترفضه دلوقتي');
    if (Number(o.courier_user_id) === me(req)) {
      const d = { ...(o.data || {}) }; delete d.courierName; delete d.courierPhone; delete d.courierVehicle;
      d.history = [...(d.history || []), { status: o.status, at: Date.now(), note: 'courier_refused' }];
      await pool.query('UPDATE orders SET courier_user_id=NULL, data=$2, updated_at=NOW() WHERE id=$1 AND courier_user_id=$3 AND status = ANY($4)', [id, JSON.stringify(d), me(req), COURIER_OPEN]);
    }
    if (b) await afterDecision(b, 'rejected', o); else await tellOwner('مندوب رفض الطلب', `${await whoName(me(req))} رفض الطلب ${label(o)}`, `bell-order-${id}`);
    res.json({ ok: true });
  }));

  async function afterDecision(b, status, o) {
    const ended = await endBell(b, status, status);
    if (!ended) return;
    const name = await whoName(b.target_id);
    const who = b.role === 'shop' ? `المحل ${o.pname || name}` : `المندوب ${name}`;
    await tellOwner(status === 'accepted' ? `✅ ${who} قبل الطلب` : `❌ ${who} رفض الطلب`, `${label(o)} — الجرس وقف`, `bell-${b.id}`, b.started_by);
  }
  /** orders.js calls this after a successful decision on an order: it ends the bells that this decision answers. */
  async function afterAction(orderId, actorId, action) {
    try {
      const acc = ['accept', 'courier_accept'].includes(action), rej = ['reject'].includes(action);
      if (!acc && !rej) return;
      const bells = (await pool.query("SELECT * FROM bells WHERE order_id=$1 AND target_id=$2 AND status='ringing'", [orderId, actorId])).rows;
      if (!bells.length) return;
      const o = await orderRow(orderId);
      for (const b of bells) await afterDecision(b, acc ? 'accepted' : 'rejected', o || { id: orderId });
    } catch (e) { console.error('bells afterAction:', e.message); }
  }

  /** Every RING_EVERY_MS: ring again, or end the bell (too long / the order moved on). */
  async function sweep() {
    const rows = (await pool.query("SELECT * FROM bells WHERE status='ringing'")).rows;
    for (const b of rows) {
      try {
        const o = await orderRow(b.order_id);
        const age = Date.now() - new Date(b.started_at).getTime();
        const open = o && (b.role === 'courier' ? (COURIER_OPEN.includes(o.status) && (!o.courier_user_id || Number(o.courier_user_id) === Number(b.target_id) || true)) : SHOP_OPEN.includes(o.status));
        const taken = o && b.role === 'courier' && o.courier_user_id && Number(o.courier_user_id) !== Number(b.target_id);
        if (!o || !open || taken) { if (await endBell(b, 'closed', 'order_moved')) push([Number(b.target_id)], 'تم إيقاف التنبيه', 'الطلب اتغيّر', `bell-${b.id}`, false); continue; }
        if (age >= MAX_MS) {
          if (await endBell(b, 'expired', 'timeout')) { const nm = await whoName(b.target_id); await tellOwner('⏱️ ما ردّش على الطلب', `${nm} ما ردّش على ${label(o)} خلال 30 دقيقة — الجرس وقف`, `bell-${b.id}`, b.started_by); push([Number(b.target_id)], 'انتهى التنبيه', 'الإدارة هتتابع معاك', `bell-${b.id}`, false); }
          continue;
        }
        if (Date.now() - new Date(b.last_sent_at).getTime() >= RING_EVERY_MS - 500) await ringOnce(b, o);
      } catch (e) { console.error('bell sweep:', e.message); }
    }
  }
  app.sweepBells = sweep; app.bellsAfterAction = afterAction;
  if (!process.env.NO_SWEEP) { const t = setInterval(() => { sweep().catch(() => {}); }, 5000); if (t.unref) t.unref(); }
  return { sweep, afterAction };
}
module.exports = { register, RING_EVERY_MS, MAX_MS };
