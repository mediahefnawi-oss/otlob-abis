'use strict';
/**
 * The delivery means a courier chooses when signing up (موتوسيكل، دراجة، سيارة ...).
 * The owner adds, renames, reorders, hides, deletes and gives each one a picture from the panel.
 * The courier's own account keeps the NAME as plain text, so deleting a means never changes an existing courier.
 */
const DEFAULTS = [{ name: 'موتوسيكل', file: 'bike.jpg' }, { name: 'دراجة', file: null }, { name: 'سيارة', file: 'car.jpg' }];

/** Pure: the clean fields from what the owner sent (null = nothing valid). */
function cleanVehicle(b, partial) {
  if (!b || typeof b !== 'object') return null;
  const out = {};
  if (!partial || b.name !== undefined) {
    const name = String(b.name == null ? '' : b.name).replace(/\s+/g, ' ').trim().slice(0, 30);
    if (name.length < 2) return null;
    out.name = name;
  }
  if (b.active !== undefined) out.active = b.active === true;
  if (b.sort !== undefined) { const n = Math.round(Number(b.sort)); if (!Number.isFinite(n) || n < 0 || n > 9999) return null; out.sort = n; }
  return Object.keys(out).length ? out : null;
}

function register(app, { pool, auth, roles, asyncRoute, positiveId, dir }) {
  const fail = (status, error) => Object.assign(new Error(error), { http: status });
  const guard = fn => asyncRoute(async (req, res) => { try { await fn(req, res); } catch (e) { if (e && e.http) return res.status(e.http).json({ error: e.message }); throw e; } });
  const admin = [auth, roles('admin')];
  const COLS = "id, name, sort_order, active, (image IS NOT NULL) AS has_image, (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v";
  const out = (r, count) => ({ id: Number(r.id), name: r.name, sort: r.sort_order, active: r.active, image: r.has_image ? `/api/courier-vehicle-image/${r.id}?v=${r.v}` : null, ...(count === undefined ? {} : { couriers: count }) });
  let seeded = false;
  /** the first time only: the three means that always existed (never re-added once the owner deleted them) */
  async function ensure() {
    if (seeded) return; 
    const done = await pool.query("SELECT 1 FROM service_meta WHERE key='courier_vehicles_seeded'");
    if (!done.rowCount) {
      const n = await pool.query('SELECT COUNT(*)::int AS c FROM courier_vehicles');
      if (n.rows[0].c === 0) {
        const fs = require('fs'), path = require('path');
        let i = 0;
        for (const d of DEFAULTS) {
          i++; let img = null;
          if (d.file) { try { img = fs.readFileSync(path.join(dir || path.join(__dirname, '..', 'seed', 'rides'), d.file)); } catch { /* without a picture */ } }
          await pool.query('INSERT INTO courier_vehicles(name, sort_order, image, mime) VALUES($1,$2,$3,$4)', [d.name, i, img, img ? 'image/jpeg' : null]);
        }
      }
      await pool.query("INSERT INTO service_meta(key, sub) VALUES('courier_vehicles_seeded','1') ON CONFLICT (key) DO NOTHING");
    }
    seeded = true;
  }

  // the sign-up screen: only the visible ones, no account needed
  app.get('/api/public/courier-vehicles', guard(async (_req, res) => {
    await ensure();
    const r = await pool.query(`SELECT ${COLS} FROM courier_vehicles WHERE active ORDER BY sort_order, id`);
    res.json({ vehicles: r.rows.map(x => { const o = out(x); return { id: o.id, name: o.name, image: o.image }; }) });
  }));
  app.get('/api/courier-vehicle-image/:id', guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) return res.status(404).end();
    const r = await pool.query('SELECT image, mime FROM courier_vehicles WHERE id=$1 AND image IS NOT NULL', [id]);
    if (!r.rowCount) return res.status(404).end();
    res.set('Content-Type', r.rows[0].mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(r.rows[0].image);
  }));

  app.get('/api/admin/courier-vehicles', ...admin, guard(async (_req, res) => {
    await ensure();
    const r = await pool.query(`SELECT ${COLS}, (SELECT COUNT(*)::int FROM users u WHERE u.role='courier' AND u.deleted_at IS NULL AND u.vehicle = courier_vehicles.name) AS couriers FROM courier_vehicles ORDER BY sort_order, id`);
    res.json({ vehicles: r.rows.map(x => out(x, x.couriers)) });
  }));
  app.post('/api/admin/courier-vehicles', ...admin, guard(async (req, res) => {
    await ensure();
    const c = cleanVehicle(req.body, false); if (!c) throw fail(400, 'اكتب اسم الوسيلة (حرفين على الأقل)');
    const dup = await pool.query('SELECT 1 FROM courier_vehicles WHERE lower(name)=lower($1)', [c.name]);
    if (dup.rowCount) throw fail(409, 'الوسيلة دي موجودة بالفعل');
    const mx = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM courier_vehicles');
    const r = await pool.query(`INSERT INTO courier_vehicles(name, sort_order, active) VALUES($1,$2,$3) RETURNING ${COLS}`, [c.name, c.sort !== undefined ? c.sort : mx.rows[0].n, c.active !== false]);
    res.status(201).json({ vehicle: out(r.rows[0]) });
  }));
  app.patch('/api/admin/courier-vehicles/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const c = cleanVehicle(req.body, true); if (!c) throw fail(400, 'بيانات غير صالحة');
    if (c.name) {
      const dup = await pool.query('SELECT 1 FROM courier_vehicles WHERE lower(name)=lower($1) AND id<>$2', [c.name, id]);
      if (dup.rowCount) throw fail(409, 'الوسيلة دي موجودة بالفعل');
    }
    const r = await pool.query(`UPDATE courier_vehicles SET name=COALESCE($2,name), active=COALESCE($3,active), sort_order=COALESCE($4,sort_order), updated_at=NOW() WHERE id=$1 RETURNING ${COLS}`,
      [id, c.name === undefined ? null : c.name, c.active === undefined ? null : c.active, c.sort === undefined ? null : c.sort]);
    if (!r.rowCount) throw fail(404, 'الوسيلة غير موجودة');
    res.json({ vehicle: out(r.rows[0]) });
  }));
  app.delete('/api/admin/courier-vehicles/:id', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const r = await pool.query('DELETE FROM courier_vehicles WHERE id=$1 RETURNING id', [id]);   // couriers keep their own vehicle text
    if (!r.rowCount) throw fail(404, 'الوسيلة غير موجودة');
    res.json({ ok: true });
  }));
  app.put('/api/admin/courier-vehicles/:id/image', ...admin, guard(async (req, res) => {
    const id = positiveId(req.params.id); if (!id) throw fail(400, 'معرّف غير صالح');
    const s = String((req.body || {}).image || '');
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(s);
    if (!m || s.length > 1500000) throw fail(400, 'ارفع صورة صالحة (JPG أو PNG أو WebP) بحجم أصغر');
    const r = await pool.query(`UPDATE courier_vehicles SET image=$2, mime=$3, updated_at=NOW() WHERE id=$1 RETURNING ${COLS}`, [id, Buffer.from(m[2], 'base64'), m[1]]);
    if (!r.rowCount) throw fail(404, 'الوسيلة غير موجودة');
    res.json({ vehicle: out(r.rows[0]) });
  }));
}

module.exports = { register, cleanVehicle, DEFAULTS };
