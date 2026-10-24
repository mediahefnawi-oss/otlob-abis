require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const required = ['DATABASE_URL', 'JWT_SECRET', 'OWNER_USERNAME', 'OWNER_PASSWORD'];
for (const key of required) {
  if (!process.env[key]) { console.error(`Missing required environment variable: ${key}`); process.exit(1); }
}
if (process.env.JWT_SECRET.length < 32) { console.error('JWT_SECRET must be at least 32 characters.'); process.exit(1); }

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined, max: process.env.VERCEL ? 3 : 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
  console.error('CORS_ORIGINS must contain the exact deployed Vercel origin in production.');
  process.exit(1);
}
app.use(cors({ origin(origin, cb) { if (!origin || allowedOrigins.includes(origin)) return cb(null, true); return cb(new Error('Origin not allowed')); }, methods: ['GET','POST','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '256kb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));

async function maintenanceState() {
  const r = await pool.query('SELECT app_enabled,maintenance_message FROM app_settings WHERE id=1');
  if (!r.rowCount) return { enabled: true, message: '' };
  return { enabled: r.rows[0].app_enabled, message: r.rows[0].maintenance_message || 'التطبيق متوقف مؤقتًا للصيانة' };
}
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const cleanUser = row => ({ id: String(row.id), name: row.name, phone: row.phone, role: row.role, address: row.address, status: row.status, createdAt: row.created_at, regionId: row.region_id ? String(row.region_id) : null, vehicle: row.vehicle || '', available: !!row.available, availableSince: row.available_since ? new Date(row.available_since).getTime() : undefined });
const positiveId = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function tokenFor(user) { return jwt.sign({ sub: String(user.id), role: user.role }, process.env.JWT_SECRET, { expiresIn: '12h', issuer: 'otlob-abis-api', audience: 'otlob-abis-app' }); }
async function authCore(req, res, next, allowInactive) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
  let claims;
  try {
    claims = jwt.verify(h.slice(7), process.env.JWT_SECRET, { issuer: 'otlob-abis-api', audience: 'otlob-abis-app' });
  } catch {
    return res.status(401).json({ error: 'انتهت الجلسة أو رمز الدخول غير صالح' });
  }
  try {
    // Never trust a role embedded in an old token: account suspension and role
    // changes must take effect immediately for every protected API request.
    const result = await pool.query('SELECT id, role, status FROM users WHERE id=$1', [claims.sub]);
    if (!result.rowCount) return res.status(401).json({ error: 'الحساب غير موجود' });
    const user = result.rows[0];
    if (!allowInactive && user.status !== 'active') return res.status(403).json({ error: 'الحساب غير مفعّل. تواصل مع الدعم' });
    req.auth = { ...claims, sub: String(user.id), role: user.role };
    return next();
  } catch (err) { return next(err); }
}
// Normal routes need an active account; /api/me must also answer for pending accounts so the app can show approval status.
const auth = (req, res, next) => authCore(req, res, next, false);
const authAny = (req, res, next) => authCore(req, res, next, true);
// Public routes that show more to a signed-in owner/admin: a bad or missing token just means "anonymous".
async function optionalAuth(req, _res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return next();
  try {
    const claims = jwt.verify(h.slice(7), process.env.JWT_SECRET, { issuer: 'otlob-abis-api', audience: 'otlob-abis-app' });
    const r = await pool.query('SELECT id, role, status FROM users WHERE id=$1', [claims.sub]);
    if (r.rowCount) req.viewer = { id: String(r.rows[0].id), role: r.rows[0].role, status: r.rows[0].status };
  } catch {}
  next();
}
// SQL fragment + params: which providers this viewer may see (never soft-deleted ones).
function providerVisibility(viewer, values) {
  if (viewer && viewer.role === 'admin') return 'p.deleted_at IS NULL';
  if (viewer && viewer.role === 'provider') { values.push(Number(viewer.id)); return `p.deleted_at IS NULL AND (p.status='active' OR p.owner_user_id=$${values.length})`; }
  return "p.deleted_at IS NULL AND p.status='active'";
}
const providerJson = p => ({ ...p.metadata, id: String(p.id), ownerId: String(p.owner_user_id), type: p.type, name: p.name, desc: p.description, address: p.address, phone: p.phone, deliveryFee: Number(p.delivery_fee), status: p.status, open: p.is_open, createdAt: new Date(p.created_at).getTime() });
const roles = (...allowed) => (req, res, next) => { if (!req.auth || !allowed.includes(req.auth.role)) return res.status(403).json({ error: 'ليس لديك صلاحية لتنفيذ هذا الإجراء' }); next(); };

async function ensureSchema() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  await pool.query(schema);
  const username = process.env.OWNER_USERNAME;
  const phone = process.env.OWNER_PHONE || '01000000000';
  const existing = await pool.query("SELECT id FROM users WHERE role='admin' AND phone=$1", [phone]);
  if (!existing.rowCount) {
    const passwordHash = await bcrypt.hash(process.env.OWNER_PASSWORD, 12);
    await pool.query("INSERT INTO users(name, phone, password_hash, role, address, status) VALUES($1,$2,$3,'admin','إدارة التطبيق','active')", [username, phone, passwordHash]);
    console.log('Initial owner account created from environment settings.');
  }
  // First boot only: the areas the app works in (the owner edits names and prices from the control panel).
  const flag = await pool.query('SELECT regions_seeded FROM app_settings WHERE id=1');
  if (flag.rowCount && !flag.rows[0].regions_seeded) {
    const names = ['ابيس التمنيات', 'ابيس 7/8', 'ابيس 8/8', 'ابيس 4/8', 'التحرير', 'السلام', 'ابيس 5/8', 'ابيس 6/8', 'ابيس 10/8', 'ابيس 12/8', 'ابيس 9/8', 'باب الاحرار', 'هربط', 'القومية', 'ابيس محمود سليم', 'ابيس 2/7', 'السبعات الرئيسية', 'الرابعة'];
    for (let i = 0; i < names.length; i++) await pool.query('INSERT INTO regions(name, sort_order) VALUES($1,$2) ON CONFLICT (name) DO NOTHING', [names[i], i]);
    await pool.query('UPDATE app_settings SET regions_seeded=TRUE WHERE id=1');
  }
}

// Serverless hosting (Vercel) has no long-running boot step, so prepare the schema once per instance.
let schemaReady = null;
const ready = () => schemaReady || (schemaReady = ensureSchema().catch(e => { schemaReady = null; throw e; }));
app.use((_req, _res, next) => {
  if (!process.env.VERCEL) return next();
  ready().then(() => next(), next);
});

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, service: 'otlob-abis-api', database: 'connected' });
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const { name, phone, password, address = '', role = 'customer', provider, regionId, vehicle } = req.body || {};
  const mt = await maintenanceState();
  if (!mt.enabled) return res.status(503).json({ error: mt.message });
  const normalizedPhone = String(phone || '').replace(/\s+/g, '');
  if (!name || String(name).trim().length < 3) return res.status(400).json({ error: 'اكتب الاسم بالكامل' });
  if (!/^01[0-9]{9}$/.test(normalizedPhone)) return res.status(400).json({ error: 'رقم الهاتف غير صحيح' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'كلمة المرور يجب ألا تقل عن 8 أحرف' });
  if (!['customer','provider','courier'].includes(role)) return res.status(400).json({ error: 'نوع الحساب غير صالح' });
  if (role === 'provider' && (!provider || !String(provider.name || '').trim())) return res.status(400).json({ error: 'بيانات مقدم الخدمة مطلوبة' });
  let region = null;
  if (regionId !== undefined && regionId !== null && regionId !== '') {
    const rid = positiveId(regionId);
    const rr = rid ? await pool.query('SELECT id FROM regions WHERE id=$1 AND active=TRUE', [rid]) : { rowCount: 0 };
    if (!rr.rowCount) return res.status(400).json({ error: 'المنطقة غير متاحة' });
    region = rid;
  }
  if (role === 'customer' && !region) return res.status(400).json({ error: 'اختر منطقتك' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 12);
    const status = role === 'customer' ? 'active' : 'pending';
    const result = await client.query('INSERT INTO users(name,phone,password_hash,role,address,status,region_id,vehicle) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [String(name).trim(), normalizedPhone, hash, role, String(address).trim(), status, region, role === 'courier' ? String(vehicle || 'موتوسيكل').slice(0, 30) : '']);
    const user = result.rows[0];
    if (role === 'provider') {
      await client.query('INSERT INTO providers(owner_user_id,type,name,description,address,phone,delivery_fee,status,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,\'pending\',$8)', [user.id, provider.type || 'other', String(provider.name).trim(), String(provider.desc || ''), String(address).trim(), normalizedPhone, Math.max(0, Number(provider.deliveryFee) || 0), JSON.stringify({ specialty: provider.specialty || '' })]);
    }
    await client.query('COMMIT');
    res.status(201).json({ token: tokenFor(user), user: cleanUser(user) });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل' });
    throw e;
  } finally { client.release(); }
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { phone, password, username } = req.body || {};
  let result;
  if (username && String(username) === process.env.OWNER_USERNAME) {
    result = await pool.query("SELECT * FROM users WHERE role='admin' AND phone=$1 LIMIT 1", [process.env.OWNER_PHONE || '01000000000']);
    if (!result.rowCount || !(await bcrypt.compare(String(password || ''), result.rows[0].password_hash))) return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  } else {
    const ph = String(phone || '').replace(/\s+/g, '');
    result = await pool.query('SELECT * FROM users WHERE phone=$1 LIMIT 1', [ph]);
    if (!result.rowCount || !(await bcrypt.compare(String(password || ''), result.rows[0].password_hash))) return res.status(401).json({ error: 'رقم الهاتف أو كلمة المرور غير صحيحة' });
  }
  const user = result.rows[0];
  if (user.status === 'suspended' || user.status === 'rejected') return res.status(403).json({ error: 'الحساب غير مفعّل. تواصل مع الدعم' });
  if (user.role !== 'admin') {
    const mt = await maintenanceState();
    if (!mt.enabled) return res.status(503).json({ error: mt.message });
  }
  res.json({ token: tokenFor(user), user: cleanUser(user) });
}));

app.get('/api/me', authAny, asyncRoute(async (req, res) => {
  const r = await pool.query('SELECT * FROM users WHERE id=$1', [req.auth.sub]);
  if (!r.rowCount) return res.status(404).json({ error: 'الحساب غير موجود' });
  res.json({ user: cleanUser(r.rows[0]) });
}));


// Profile + password: the server is the only place that knows password hashes.
app.patch('/api/me', auth, asyncRoute(async (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : null;
  const address = typeof b.address === 'string' ? b.address.trim().slice(0, 300) : null;
  if (name !== null && name.length < 3) return res.status(400).json({ error: 'اكتب الاسم بالكامل' });
  let regionSet = false; let region = null;
  if ('regionId' in b) {
    regionSet = true;
    if (b.regionId !== null && b.regionId !== '') {
      const rid = positiveId(b.regionId);
      const rr = rid ? await pool.query('SELECT id FROM regions WHERE id=$1 AND active=TRUE', [rid]) : { rowCount: 0 };
      if (!rr.rowCount) return res.status(400).json({ error: 'المنطقة غير متاحة' });
      region = rid;
    }
  }
  const availSet = typeof b.available === 'boolean' && req.auth.role === 'courier';
  if (availSet && !b.available) {
    const open = await pool.query("SELECT 1 FROM orders WHERE courier_user_id=$1 AND status IN ('accepted','ready','picked_up','on_the_way','arrived') LIMIT 1", [Number(req.auth.sub)]);
    if (open.rowCount) return res.status(409).json({ error: 'أكمل طلباتك الحالية قبل إيقاف الاستقبال' });
  }
  const r = await pool.query('UPDATE users SET name=COALESCE($1,name), address=COALESCE($2,address), region_id=CASE WHEN $3 THEN $4::bigint ELSE region_id END, available=CASE WHEN $6 THEN $7::boolean ELSE available END, available_since=CASE WHEN $6 AND $7::boolean AND NOT available THEN NOW() WHEN $6 AND NOT $7::boolean THEN NULL ELSE available_since END WHERE id=$5 RETURNING *', [name, address, regionSet, region, Number(req.auth.sub), availSet, availSet ? b.available : false]);
  res.json({ user: cleanUser(r.rows[0]) });
}));
app.patch('/api/me/password', auth, asyncRoute(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف' });
  const r = await pool.query('SELECT password_hash FROM users WHERE id=$1', [Number(req.auth.sub)]);
  if (!r.rowCount || !(await bcrypt.compare(String(oldPassword || ''), r.rows[0].password_hash))) return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await bcrypt.hash(newPassword, 12), Number(req.auth.sub)]);
  res.json({ ok: true });
}));

// Owner tools: list accounts (e.g. pending couriers), reset a password, create a service with its manager account.
app.get('/api/admin/users', auth, roles('admin'), asyncRoute(async (req, res) => {
  const values = []; let sql = 'SELECT * FROM users WHERE 1=1';
  if (req.query.role) { values.push(String(req.query.role)); sql += ` AND role=$${values.length}`; }
  if (req.query.status) { values.push(String(req.query.status)); sql += ` AND status=$${values.length}`; }
  sql += ' ORDER BY created_at DESC LIMIT 500';
  const r = await pool.query(sql, values);
  res.json({ users: r.rows.map(cleanUser) });
}));
app.patch('/api/admin/users/:id/password', auth, roles('admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id); const pw = req.body && req.body.password;
  if (!id) return res.status(400).json({ error: 'معرّف الحساب غير صالح' });
  if (typeof pw !== 'string' || pw.length < 8) return res.status(400).json({ error: 'كلمة المرور يجب ألا تقل عن 8 أحرف' });
  const r = await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id', [await bcrypt.hash(pw, 12), id]);
  if (!r.rowCount) return res.status(404).json({ error: 'الحساب غير موجود' });
  res.json({ ok: true });
}));
app.post('/api/admin/providers', auth, roles('admin'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const type = String(b.type || '');
  if (!['restaurant','supermarket','pharmacy','clinic'].includes(type)) return res.status(400).json({ error: 'نوع الخدمة غير صالح' });
  if (!b.name || String(b.name).trim().length < 2) return res.status(400).json({ error: 'اكتب اسم الخدمة' });
  const mPhone = String(b.managerPhone || '').replace(/\s+/g, '');
  if (!/^01[0-9]{9}$/.test(mPhone)) return res.status(400).json({ error: 'رقم هاتف المسؤول غير صحيح' });
  if (typeof b.managerPass !== 'string' || b.managerPass.length < 8) return res.status(400).json({ error: 'كلمة مرور المسؤول 8 أحرف على الأقل' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query("INSERT INTO users(name,phone,password_hash,role,address,status) VALUES($1,$2,$3,'provider',$4,'active') RETURNING *", [String(b.managerName || b.name).trim(), mPhone, await bcrypt.hash(b.managerPass, 12), String(b.address || '').trim()]);
    const p = await client.query("INSERT INTO providers(owner_user_id,type,name,description,address,phone,delivery_fee,status,is_open,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,'active',TRUE,$8) RETURNING *", [u.rows[0].id, type, String(b.name).trim(), String(b.desc || ''), String(b.address || '').trim(), String(b.phone || mPhone).replace(/\s+/g, ''), type === 'clinic' ? 0 : Math.max(0, Number(b.deliveryFee) || 0), JSON.stringify({ specialty: b.specialty || '', emoji: b.emoji || '' })]);
    await client.query('COMMIT');
    res.status(201).json({ user: cleanUser(u.rows[0]), providerId: String(p.rows[0].id) });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return res.status(409).json({ error: 'رقم هاتف المسؤول مسجل بالفعل' });
    throw e;
  } finally { client.release(); }
}));

// Delivery areas: everyone reads the active list; only the owner edits it.
const regionJson = r => ({ id: String(r.id), name: r.name, deliveryFee: Number(r.delivery_fee), active: r.active });
app.get('/api/regions', optionalAuth, asyncRoute(async (req, res) => {
  const all = req.viewer && req.viewer.role === 'admin';
  const r = await pool.query(`SELECT * FROM regions ${all ? '' : 'WHERE active=TRUE'} ORDER BY sort_order, id`);
  res.json({ regions: r.rows.map(regionJson) });
}));
app.post('/api/admin/regions', auth, roles('admin'), asyncRoute(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const fee = Number((req.body || {}).deliveryFee);
  if (name.length < 2) return res.status(400).json({ error: 'اكتب اسم المنطقة' });
  if (!Number.isFinite(fee) || fee < 0) return res.status(400).json({ error: 'سعر التوصيل غير صالح' });
  try {
    const next = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM regions');
    const r = await pool.query('INSERT INTO regions(name, delivery_fee, sort_order) VALUES($1,$2,$3) RETURNING *', [name.slice(0, 80), fee, next.rows[0].n]);
    res.status(201).json({ region: regionJson(r.rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'المنطقة موجودة بالفعل' });
    throw e;
  }
}));
app.patch('/api/admin/regions/:id', auth, roles('admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف المنطقة غير صالح' });
  const b = req.body || {};
  const old = await pool.query('SELECT * FROM regions WHERE id=$1', [id]);
  if (!old.rowCount) return res.status(404).json({ error: 'المنطقة غير موجودة' });
  const name = b.name === undefined ? old.rows[0].name : String(b.name).trim().slice(0, 80);
  const fee = b.deliveryFee === undefined ? Number(old.rows[0].delivery_fee) : Number(b.deliveryFee);
  if (name.length < 2) return res.status(400).json({ error: 'اكتب اسم المنطقة' });
  if (!Number.isFinite(fee) || fee < 0) return res.status(400).json({ error: 'سعر التوصيل غير صالح' });
  try {
    const r = await pool.query('UPDATE regions SET name=$1, delivery_fee=$2, active=$3 WHERE id=$4 RETURNING *', [name, fee, b.active === undefined ? old.rows[0].active : Boolean(b.active), id]);
    res.json({ region: regionJson(r.rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'المنطقة موجودة بالفعل' });
    throw e;
  }
}));
app.delete('/api/admin/regions/:id', auth, roles('admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف المنطقة غير صالح' });
  const r = await pool.query('DELETE FROM regions WHERE id=$1 RETURNING id', [id]);
  if (!r.rowCount) return res.status(404).json({ error: 'المنطقة غير موجودة' });
  res.json({ ok: true });
}));

// Public runtime settings are read from PostgreSQL, so maintenance mode and announcements
// apply consistently to every client using this API.
app.get('/api/settings', asyncRoute(async (_req, res) => {
  const r = await pool.query('SELECT app_enabled,maintenance_message,announcement,auto_assign,support_phone,support_name,updated_at FROM app_settings WHERE id=1');
  const x = r.rows[0];
  res.json({ settings: { appEnabled: x.app_enabled, maintenanceMessage: x.maintenance_message, announcement: x.announcement, autoAssign: x.auto_assign, supportPhone: x.support_phone, supportName: x.support_name, updatedAt: x.updated_at } });
}));
app.patch('/api/admin/settings', auth, roles('admin'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const current = (await pool.query('SELECT * FROM app_settings WHERE id=1')).rows[0];
  const boolField = (v, old) => typeof v === 'boolean' ? v : old;
  const textField = (v, old, max=500) => typeof v === 'string' ? v.trim().slice(0,max) : old;
  const r = await pool.query(`UPDATE app_settings SET app_enabled=$1,maintenance_message=$2,announcement=$3,auto_assign=$4,support_phone=$5,support_name=$6,updated_at=NOW() WHERE id=1 RETURNING *`, [
    boolField(b.appEnabled,current.app_enabled), textField(b.maintenanceMessage,current.maintenance_message), textField(b.announcement,current.announcement), boolField(b.autoAssign,current.auto_assign), textField(b.supportPhone,current.support_phone,40), textField(b.supportName,current.support_name,100)
  ]);
  const x = r.rows[0];
  res.json({ settings: { appEnabled:x.app_enabled, maintenanceMessage:x.maintenance_message, announcement:x.announcement, autoAssign:x.auto_assign, supportPhone:x.support_phone, supportName:x.support_name, updatedAt:x.updated_at } });
}));

// Appointment records are server-owned and visible only to the customer, clinic owner, or admin.
app.patch('/api/admin/users/:id/status', auth, roles('admin'), asyncRoute(async(req,res)=>{
  const id=positiveId(req.params.id); const status=req.body&&req.body.status;
  if(!id||!['active','pending','rejected','suspended'].includes(status)) return res.status(400).json({error:'حالة الحساب غير صالحة'});
  if(String(id)===req.auth.sub) return res.status(400).json({error:'لا يمكن للمدير إيقاف حسابه بنفسه'});
  const r=await pool.query('UPDATE users SET status=$1 WHERE id=$2 RETURNING id,name,role,status',[status,id]);
  if(!r.rowCount) return res.status(404).json({error:'الحساب غير موجود'});
  res.json({user:{id:String(r.rows[0].id),name:r.rows[0].name,role:r.rows[0].role,status:r.rows[0].status}});
}));

app.get('/api/providers', optionalAuth, asyncRoute(async (req, res) => {
  const values = [];
  let sql = `SELECT p.* FROM providers p WHERE ${providerVisibility(req.viewer, values)}`;
  if (req.query.type) { values.push(String(req.query.type)); sql += ` AND p.type=$${values.length}`; }
  sql += ' ORDER BY p.created_at DESC LIMIT 500';
  const r = await pool.query(sql, values);
  res.json({ providers: r.rows.map(providerJson) });
}));
app.get('/api/products', optionalAuth, asyncRoute(async (req, res) => {
  const values = [];
  let sql = `SELECT pr.* FROM products pr JOIN providers p ON p.id=pr.provider_id WHERE ${providerVisibility(req.viewer, values)}`;
  if (req.query.providerId) { const providerId = positiveId(req.query.providerId); if (!providerId) return res.status(400).json({ error: 'معرّف مقدم الخدمة غير صالح' }); values.push(providerId); sql += ` AND pr.provider_id=$${values.length}`; }
  sql += ' ORDER BY pr.created_at ASC LIMIT 2000';
  const r = await pool.query(sql, values);
  res.json({ products: r.rows.map(x => ({ ...x.data, id: String(x.id), providerId: String(x.provider_id), name: x.name, price: Number(x.price), available: x.available })) });
}));

// Owner of the service (or the app owner) edits the service details / open-closed switch.
app.patch('/api/providers/:id', auth, roles('provider','admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف مقدم الخدمة غير صالح' });
  const found = await pool.query('SELECT * FROM providers WHERE id=$1 AND deleted_at IS NULL', [id]);
  if (!found.rowCount) return res.status(404).json({ error: 'مقدم الخدمة غير موجود' });
  const old = found.rows[0];
  if (req.auth.role !== 'admin' && String(old.owner_user_id) !== req.auth.sub) return res.status(403).json({ error: 'غير مسموح' });
  const b = req.body || {};
  const name = b.name === undefined ? old.name : String(b.name).trim();
  if (name.length < 2) return res.status(400).json({ error: 'اكتب اسم الخدمة' });
  const fee = b.deliveryFee === undefined ? Number(old.delivery_fee) : Number(b.deliveryFee);
  if (!Number.isFinite(fee) || fee < 0) return res.status(400).json({ error: 'رسوم التوصيل غير صالحة' });
  const meta = { ...old.metadata };
  for (const k of ['specialty', 'emoji', 'eta']) if (typeof b[k] === 'string') meta[k] = b[k].slice(0, 100);
  const r = await pool.query('UPDATE providers SET name=$1, description=$2, address=$3, phone=$4, delivery_fee=$5, is_open=$6, metadata=$7 WHERE id=$8 RETURNING *', [
    name,
    b.desc === undefined ? old.description : String(b.desc).slice(0, 1000),
    b.address === undefined ? old.address : String(b.address).slice(0, 300),
    b.phone === undefined ? old.phone : String(b.phone).replace(/\s+/g, '').slice(0, 20),
    fee,
    b.open === undefined ? old.is_open : Boolean(b.open),
    JSON.stringify(meta), id,
  ]);
  res.json({ provider: providerJson(r.rows[0]) });
}));
// Owner removes a service: it disappears everywhere, but old orders/invoices keep working.
app.delete('/api/admin/providers/:id', auth, roles('admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف مقدم الخدمة غير صالح' });
  const r = await pool.query('UPDATE providers SET deleted_at=NOW(), is_open=FALSE WHERE id=$1 AND deleted_at IS NULL RETURNING owner_user_id', [id]);
  if (!r.rowCount) return res.status(404).json({ error: 'مقدم الخدمة غير موجود' });
  const owner = r.rows[0].owner_user_id;
  const left = await pool.query("SELECT 1 FROM providers WHERE owner_user_id=$1 AND deleted_at IS NULL LIMIT 1", [owner]);
  if (!left.rowCount) await pool.query("UPDATE users SET status='suspended' WHERE id=$1 AND role='provider'", [owner]);
  res.json({ ok: true });
}));

app.post('/api/products', auth, roles('provider','admin'), asyncRoute(async (req, res) => {
  const { providerId, name, price, data = {} } = req.body || {};
  const validProviderId = positiveId(providerId);
  if (!validProviderId || typeof name !== 'string' || !name.trim() || !Number.isFinite(Number(price)) || Number(price) < 0 || !isRecord(data)) return res.status(400).json({ error: 'بيانات المنتج غير صالحة' });
  const p = await pool.query('SELECT id,owner_user_id FROM providers WHERE id=$1', [validProviderId]);
  if (!p.rowCount) return res.status(404).json({ error: 'مقدم الخدمة غير موجود' });
  if (req.auth.role !== 'admin' && String(p.rows[0].owner_user_id) !== req.auth.sub) return res.status(403).json({ error: 'لا يمكنك إدارة منتجات مقدم خدمة آخر' });
  const r = await pool.query('INSERT INTO products(provider_id,name,price,data) VALUES($1,$2,$3,$4) RETURNING *', [Number(providerId), String(name).trim(), Number(price), JSON.stringify(data)]);
  res.status(201).json({ product: { id: String(r.rows[0].id), providerId: String(r.rows[0].provider_id), name: r.rows[0].name, price: Number(r.rows[0].price), available: r.rows[0].available, ...r.rows[0].data } });
}));

app.patch('/api/products/:id', auth, roles('provider','admin'), asyncRoute(async (req, res) => {
  const found = await pool.query('SELECT pr.*, p.owner_user_id FROM products pr JOIN providers p ON p.id=pr.provider_id WHERE pr.id=$1', [Number(req.params.id)]);
  if (!found.rowCount) return res.status(404).json({ error: 'المنتج غير موجود' });
  if (req.auth.role !== 'admin' && String(found.rows[0].owner_user_id) !== req.auth.sub) return res.status(403).json({ error: 'غير مسموح' });
  const old = found.rows[0]; const name = req.body.name === undefined ? old.name : String(req.body.name).trim();
  const price = req.body.price === undefined ? Number(old.price) : Number(req.body.price);
  const available = req.body.available === undefined ? old.available : Boolean(req.body.available);
  if (!name || !Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'بيانات المنتج غير صالحة' });
  const data = { ...old.data, ...(req.body.data || {}) };
  const r = await pool.query('UPDATE products SET name=$1,price=$2,available=$3,data=$4,updated_at=NOW() WHERE id=$5 RETURNING *', [name, price, available, JSON.stringify(data), old.id]);
  res.json({ product: { id: String(r.rows[0].id), providerId: String(r.rows[0].provider_id), name: r.rows[0].name, price: Number(r.rows[0].price), available: r.rows[0].available, ...r.rows[0].data } });
}));
app.delete('/api/products/:id', auth, roles('provider','admin'), asyncRoute(async (req, res) => {
  const found = await pool.query('SELECT pr.id,p.owner_user_id FROM products pr JOIN providers p ON p.id=pr.provider_id WHERE pr.id=$1', [Number(req.params.id)]);
  if (!found.rowCount) return res.status(404).json({ error: 'المنتج غير موجود' });
  if (req.auth.role !== 'admin' && String(found.rows[0].owner_user_id) !== req.auth.sub) return res.status(403).json({ error: 'غير مسموح' });
  await pool.query('DELETE FROM products WHERE id=$1', [found.rows[0].id]); res.status(204).end();
}));

// Orders, invoices, bookings and chat live in orders.js
require('./orders')(app, { pool, auth, roles, asyncRoute, positiveId, maintenanceState });

app.get('/api/admin/providers/pending', auth, roles('admin'), asyncRoute(async (_req, res) => {
  const r = await pool.query("SELECT p.*,u.name AS owner_name FROM providers p JOIN users u ON u.id=p.owner_user_id WHERE p.status='pending' AND p.deleted_at IS NULL ORDER BY p.created_at ASC");
  res.json({ providers: r.rows.map(p => ({ ...p.metadata, id: String(p.id), ownerId: String(p.owner_user_id), ownerName: p.owner_name, type: p.type, name: p.name, desc: p.description, address: p.address, phone: p.phone, deliveryFee: Number(p.delivery_fee), status: p.status })) });
}));
app.patch('/api/admin/providers/:id/decision', auth, roles('admin'), asyncRoute(async (req, res) => {
  const status = req.body.status;
  if (!['active','rejected','suspended'].includes(status)) return res.status(400).json({ error: 'قرار غير صالح' });
  const providerId = positiveId(req.params.id);
  if (!providerId) return res.status(400).json({ error: 'معرّف مقدم الخدمة غير صالح' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('UPDATE providers SET status=$1 WHERE id=$2 RETURNING id,owner_user_id,status', [status, providerId]);
    if (!r.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'مقدم الخدمة غير موجود' }); }
    await client.query('UPDATE users SET status=$1 WHERE id=$2', [status === 'active' ? 'active' : status, r.rows[0].owner_user_id]);
    await client.query('COMMIT');
    res.json({ ok: true, providerId: String(r.rows[0].id), status });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}));

app.use((err, _req, res, _next) => {
  if (err && err.message === 'Origin not allowed') return res.status(403).json({ error: 'مصدر الاتصال غير مسموح' });
  if (err && err.code === '23505') return res.status(409).json({ error: 'البيانات مسجلة بالفعل' });
  console.error(err);
  res.status(500).json({ error: 'حدث خطأ داخلي. حاول لاحقًا' });
});
pool.on('error', err => console.error('Unexpected PostgreSQL pool error:', err.message));
if (require.main === module) {
  const port = Number(process.env.PORT || 4000);
  let server;
  ensureSchema().then(() => {
    server = app.listen(port, () => console.log(`Otlob Abis API listening on ${port}`));
  }).catch(err => { console.error('API startup failed:', err.message); process.exit(1); });
  async function shutdown(signal) {
    console.log(`${signal} received; shutting down API`);
    if (server) server.close();
    try { await pool.end(); } finally { process.exit(0); }
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
module.exports = app;
