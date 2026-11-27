'use strict';
// Managers: staff accounts the owner creates with a chosen set of admin permissions.
// A manager runs through the same code as the admin (auth maps him to role 'admin'), but every request first passes gate():
// what is not explicitly allowed for his permissions is refused, and the owner-only areas are never open to him.
const PERMS = ['orders', 'users', 'support', 'providers', 'couriers', 'finance_view', 'finance_edit', 'notify', 'bell', 'delivery_prices', 'export'];

function parsePerms(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(',');
  const out = [...new Set(list.map(x => String(x).trim()).filter(x => PERMS.includes(x)))];
  if (out.includes('finance_edit') && !out.includes('finance_view')) out.push('finance_view'); // editing money implies seeing it
  return out;
}

// [regex on the path after /api/admin/, permission needed | 'block' | 'any', only these methods (optional)]
const ADMIN_RULES = [
  [/^managers(\/|$)/, 'block'],
  [/^users\/[^/]+\/password$/, 'block'],
  [/^users\/[^/]+\/role$/, 'block'],        // turning an account into a supervisor / manager is the owner's alone
  [/^users$/, 'any_perm', ['GET']], // the user list feeds every screen (couriers, shops, orders); any granted permission may read it
  [/^(users|customers|ratings)(\/|$)/, 'users'],
  [/^rides\/settings$/, 'block'],
  [/^rides(\/|$)/, 'orders'],
  [/^(gates|trips)(\/|$)/, 'orders'],        // open / close of new orders and the intercity trips
  [/^chat-reports(\/|$)/, 'support'],
  [/^(providers|market-products|offers|coupons|ads|provider-cover)(\/|$)/, 'providers'],
  [/^captains\/[^/]+\/balance$/, 'finance_edit'],
  [/^(couriers|captains|courier-photos)(\/|$)/, 'couriers'],
  [/^orders\/[^/]+\/bells?$/, 'bell'],        // the bell on a courier / shop
  [/^(route-prices|route-vehicle-prices|delivery-mode)$/, 'delivery_prices'],
  [/^commissions\/export/, 'export'],
  [/^(commissions|closings|daily-report|counters|premium)(\/|$)/, 'finance'],
  [/^broadcasts(\/|$)/, 'notify'],
  [/^log\/[^/]+\/undo$/, 'block'],
  [/^(log|audit)$/, 'any', ['GET']],
];
// outside /api/admin: orders and staff tools are shared with the admin; they need the matching permission
const OTHER_RULES = [
  [/^\/api\/staff\/ratings$/, 'users'],
  [/^\/api\/staff\/courier-locations$/, 'couriers'],
  [/^\/api\/(orders|staff|appointments|rx|invoices)(\/|$)/, 'orders'],
  [/^\/api\/support(\/|$)/, 'support'],
  [/^\/api\/(providers|products|menu)(\/|$)/, 'providers', ['POST', 'PUT', 'PATCH', 'DELETE']],
];
const OWNER_ONLY_TARGETS = ['admin', 'manager', 'supervisor'];
const DENY = 'ليس لديك صلاحية لتنفيذ هذا الإجراء';

/** null = allowed, otherwise the Arabic reason. perms: the manager's permission list. */
async function gate(pool, method, rawUrl, perms) {
  const url = String(rawUrl || '').split('?')[0].replace(/\/+$/, '');
  const m = String(method || 'GET').toUpperCase();
  const have = p => perms.includes(p);
  if (url.startsWith('/api/admin/')) {
    const p = url.slice('/api/admin/'.length);
    let hit = null;
    for (const [re, need, methods] of ADMIN_RULES) {
      if (!re.test(p)) continue;
      if (methods && !methods.includes(m)) continue;
      hit = need; break;
    }
    if (!hit || hit === 'block') return DENY;
    if (hit === 'finance') hit = m === 'GET' ? 'finance_view' : 'finance_edit';
    if (hit === 'any_perm') { if (!perms.length) return DENY; } else if (hit !== 'any' && !have(hit)) return DENY;
    // a manager may not touch an owner/staff account through the user tools
    const t = /^users\/(\d+)(\/|$)/.exec(p);
    if (t && m !== 'GET') {
      const r = await pool.query('SELECT role FROM users WHERE id=$1', [Number(t[1])]);
      if (!r.rowCount || OWNER_ONLY_TARGETS.includes(r.rows[0].role)) return DENY;
    }
    return null;
  }
  for (const [re, need, methods] of OTHER_RULES) {
    if (!re.test(url)) continue;
    if (methods && !methods.includes(m)) continue;
    return have(need) ? null : DENY;
  }
  return null;
}

function register(app, { pool, auth, roles, asyncRoute, positiveId, hashPassword, clearAuth, freePhone, cleanUser }) {
  const owner = [auth, roles('admin'), (req, res, next) => (req.auth.baseRole === 'manager' ? res.status(403).json({ error: DENY }) : next())];
  const shape = row => ({ ...cleanUser(row), accountFlag: '', flagNote: '' });
  app.post('/api/admin/managers', ...owner, asyncRoute(async (req, res) => {
    const { name, phone, password, perms } = req.body || {};
    const p = String(phone || '').replace(/\s+/g, '');
    if (!name || String(name).trim().length < 3) return res.status(400).json({ error: 'اكتب اسم المدير بالكامل' });
    if (!/^01[0-9]{9}$/.test(p)) return res.status(400).json({ error: 'رقم الهاتف غير صحيح' });
    if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'كلمة المرور يجب ألا تقل عن 8 أحرف' });
    try {
      const r = await pool.query("INSERT INTO users(name,phone,password_hash,role,address,status,mgr_perms) VALUES($1,$2,$3,'manager','مدير','active',$4) RETURNING *",
        [String(name).trim(), p, await hashPassword(password), parsePerms(perms).join(',')]);
      res.status(201).json({ user: shape(r.rows[0]) });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل' });
      throw e;
    }
  }));
  app.patch('/api/admin/managers/:id', ...owner, asyncRoute(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'معرّف غير صالح' });
    const b = req.body || {};
    const cur = await pool.query("SELECT * FROM users WHERE id=$1 AND role='manager' AND deleted_at IS NULL", [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'المدير غير موجود' });
    const name = typeof b.name === 'string' && b.name.trim().length >= 3 ? b.name.trim().slice(0, 100) : cur.rows[0].name;
    const perms = Array.isArray(b.perms) ? parsePerms(b.perms).join(',') : cur.rows[0].mgr_perms;
    const r = await pool.query('UPDATE users SET name=$1, mgr_perms=$2 WHERE id=$3 RETURNING *', [name, perms, id]);
    clearAuth();
    res.json({ user: shape(r.rows[0]) });
  }));
  /**
   * The owner turns an existing account into a supervisor (with his areas), a manager (with permissions) or back into a normal customer.
   * Only customers, supervisors and managers can be changed this way: shops, couriers and the owner accounts keep their type.
   */
  const CHANGEABLE = ['customer', 'supervisor', 'manager'];
  app.post('/api/admin/users/:id/role', ...owner, asyncRoute(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'معرّف غير صالح' });
    const b = req.body || {}, role = String(b.role || '');
    if (!CHANGEABLE.includes(role)) return res.status(400).json({ error: 'اختار عميل أو مشرف أو مدير' });
    const cur = await pool.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL', [id]);
    if (!cur.rowCount) return res.status(404).json({ error: 'الحساب غير موجود' });
    const u = cur.rows[0];
    if (Number(u.id) === Number(req.auth.sub)) return res.status(409).json({ error: 'مينفعش تغيّر نوع حسابك إنت' });
    if (!CHANGEABLE.includes(u.role)) return res.status(409).json({ error: 'الحساب ده نوعه مختلف (متجر أو مندوب أو أدمن)، التحويل متاح للعملاء والمشرفين والمديرين بس' });
    if (u.status !== 'active') return res.status(409).json({ error: 'فعّل الحساب الأول' });
    let regions = '', perms = '';
    if (role === 'supervisor') {
      const want = [...new Set((Array.isArray(b.regions) ? b.regions : []).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 50);
      if (!want.length) return res.status(400).json({ error: 'اختار منطقة واحدة على الأقل للمشرف' });
      const ok = await pool.query('SELECT id FROM regions WHERE id = ANY($1::bigint[])', [want]);
      if (ok.rowCount !== want.length) return res.status(400).json({ error: 'منطقة غير موجودة' });
      regions = want.join(',');
    } else if (role === 'manager') {
      const list = parsePerms(b.perms);
      if (!list.length) return res.status(400).json({ error: 'اختار صلاحية واحدة على الأقل للمدير' });
      perms = list.join(',');
    }
    const r = await pool.query('UPDATE users SET role=$2, sup_regions=$3, mgr_perms=$4 WHERE id=$1 RETURNING *', [id, role, regions, perms]);
    clearAuth();
    res.json({ user: shape(r.rows[0]) });
  }));
  app.delete('/api/admin/managers/:id', ...owner, asyncRoute(async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'معرّف غير صالح' });
    const r = await pool.query("SELECT id FROM users WHERE id=$1 AND role='manager' AND deleted_at IS NULL", [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'المدير غير موجود' });
    await freePhone(pool, id);
    res.json({ ok: true });
  }));
}
module.exports = { PERMS, parsePerms, gate, register, DENY };
