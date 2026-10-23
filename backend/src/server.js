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
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined, max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
app.disable('x-powered-by');
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
const cleanUser = row => ({ id: String(row.id), name: row.name, phone: row.phone, role: row.role, address: row.address, status: row.status, createdAt: row.created_at });
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
const roles = (...allowed) => (req, res, next) => { if (!req.auth || !allowed.includes(req.auth.role)) return res.status(403).json({ error: 'ليس لديك صلاحية لتنفيذ هذا الإجراء' }); next(); };

async function ensureSchema() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  await pool.query(schema);
  const username = process.env.OWNER_USERNAME;
  const phone = process.env.OWNER_PHONE || '01000000000';
  const passwordHash = await bcrypt.hash(process.env.OWNER_PASSWORD, 12);
  const existing = await pool.query("SELECT id FROM users WHERE role='admin' AND phone=$1", [phone]);
  if (!existing.rowCount) {
    await pool.query("INSERT INTO users(name, phone, password_hash, role, address, status) VALUES($1,$2,$3,'admin','إدارة التطبيق','active')", [username, phone, passwordHash]);
    console.log('Initial owner account created from environment settings.');
  }
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, service: 'otlob-abis-api', database: 'connected' });
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const { name, phone, password, address = '', role = 'customer', provider } = req.body || {};
  const mt = await maintenanceState();
  if (!mt.enabled) return res.status(503).json({ error: mt.message });
  const normalizedPhone = String(phone || '').replace(/\s+/g, '');
  if (!name || String(name).trim().length < 3) return res.status(400).json({ error: 'اكتب الاسم بالكامل' });
  if (!/^01[0-9]{9}$/.test(normalizedPhone)) return res.status(400).json({ error: 'رقم الهاتف غير صحيح' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'كلمة المرور يجب ألا تقل عن 8 أحرف' });
  if (!['customer','provider','courier'].includes(role)) return res.status(400).json({ error: 'نوع الحساب غير صالح' });
  if (role === 'provider' && (!provider || !String(provider.name || '').trim())) return res.status(400).json({ error: 'بيانات مقدم الخدمة مطلوبة' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 12);
    const status = role === 'customer' ? 'active' : 'pending';
    const result = await client.query('INSERT INTO users(name,phone,password_hash,role,address,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [String(name).trim(), normalizedPhone, hash, role, String(address).trim(), status]);
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
  const r = await pool.query('UPDATE users SET name=COALESCE($1,name), address=COALESCE($2,address) WHERE id=$3 RETURNING *', [name, address, Number(req.auth.sub)]);
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
app.post('/api/appointments', auth, roles('customer'), asyncRoute(async (req, res) => {
  const appState = await pool.query('SELECT app_enabled,maintenance_message FROM app_settings WHERE id=1');
  if (appState.rowCount && !appState.rows[0].app_enabled) return res.status(503).json({ error: appState.rows[0].maintenance_message || 'التطبيق متوقف مؤقتًا' });
  const b = req.body || {}; const providerId = positiveId(b.providerId);
  const date = String(b.date || ''); const time = String(b.time || '').trim();
  const fee = Number(b.fee || 0); const data = b.data === undefined ? {} : b.data;
  if (!providerId || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !time || time.length > 40 || !Number.isFinite(fee) || fee < 0 || !isRecord(data)) return res.status(400).json({ error:'بيانات الموعد غير صالحة' });
  const p = await pool.query("SELECT id FROM providers WHERE id=$1 AND type='clinic' AND status='active'",[providerId]);
  if (!p.rowCount) return res.status(400).json({ error:'العيادة غير متاحة' });
  const dup = await pool.query("SELECT id FROM appointments WHERE provider_id=$1 AND appointment_date=$2 AND appointment_time=$3 AND status IN ('pending','confirmed')",[providerId,date,time]);
  if (dup.rowCount) return res.status(409).json({ error:'هذا الموعد محجوز بالفعل' });
  const r = await pool.query('INSERT INTO appointments(customer_user_id,provider_id,doctor_product_id,appointment_date,appointment_time,fee,data) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[Number(req.auth.sub),providerId,positiveId(b.doctorId),date,time,fee,JSON.stringify(data)]);
  const a=r.rows[0]; res.status(201).json({ appointment:{ id:String(a.id),customerId:String(a.customer_user_id),providerId:String(a.provider_id),doctorId:a.doctor_product_id?String(a.doctor_product_id):null,date:a.appointment_date.toISOString ? a.appointment_date.toISOString().slice(0,10) : String(a.appointment_date),time:a.appointment_time,status:a.status,fee:Number(a.fee),...a.data,createdAt:a.created_at,updatedAt:a.updated_at } });
}));
app.get('/api/appointments', auth, asyncRoute(async (req,res) => {
  let sql, params=[];
  if(req.auth.role==='admin') sql='SELECT a.*,p.name AS provider_name,p.owner_user_id FROM appointments a JOIN providers p ON p.id=a.provider_id ORDER BY a.created_at DESC LIMIT 300';
  else if(req.auth.role==='customer'){sql='SELECT a.*,p.name AS provider_name,p.owner_user_id FROM appointments a JOIN providers p ON p.id=a.provider_id WHERE a.customer_user_id=$1 ORDER BY a.created_at DESC LIMIT 200';params=[Number(req.auth.sub)];}
  else if(req.auth.role==='provider'){sql='SELECT a.*,p.name AS provider_name,p.owner_user_id FROM appointments a JOIN providers p ON p.id=a.provider_id WHERE p.owner_user_id=$1 ORDER BY a.created_at DESC LIMIT 300';params=[Number(req.auth.sub)];}
  else return res.json({appointments:[]});
  const r=await pool.query(sql,params); res.json({appointments:r.rows.map(a=>({...a.data,id:String(a.id),customerId:String(a.customer_user_id),providerId:String(a.provider_id),providerName:a.provider_name,ownerId:String(a.owner_user_id),doctorId:a.doctor_product_id?String(a.doctor_product_id):undefined,date:a.appointment_date.toISOString?a.appointment_date.toISOString().slice(0,10):String(a.appointment_date),time:a.appointment_time,status:a.status,fee:Number(a.fee),createdAt:a.created_at,updatedAt:a.updated_at}))});
}));
app.patch('/api/appointments/:id/status', auth, roles('provider','admin'), asyncRoute(async(req,res)=>{
  const id=positiveId(req.params.id); const status=req.body && req.body.status;
  if(!id || !['confirmed','rejected','completed','cancelled'].includes(status)) return res.status(400).json({error:'حالة الموعد غير صالحة'});
  const found=await pool.query('SELECT a.id,p.owner_user_id FROM appointments a JOIN providers p ON p.id=a.provider_id WHERE a.id=$1',[id]);
  if(!found.rowCount) return res.status(404).json({error:'الموعد غير موجود'});
  if(req.auth.role==='provider' && String(found.rows[0].owner_user_id)!==req.auth.sub) return res.status(403).json({error:'غير مسموح'});
  const r=await pool.query('UPDATE appointments SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING *',[status,id]); const a=r.rows[0];
  res.json({appointment:{...a.data,id:String(a.id),customerId:String(a.customer_user_id),providerId:String(a.provider_id),date:a.appointment_date.toISOString?a.appointment_date.toISOString().slice(0,10):String(a.appointment_date),time:a.appointment_time,status:a.status,fee:Number(a.fee),createdAt:a.created_at,updatedAt:a.updated_at}});
}));
app.get('/api/invoices', auth, asyncRoute(async(req,res)=>{
  let sql,params=[];
  if(req.auth.role==='admin'){sql='SELECT * FROM invoices ORDER BY created_at DESC LIMIT 500';}
  else {sql='SELECT * FROM invoices WHERE customer_user_id=$1 ORDER BY created_at DESC LIMIT 200';params=[Number(req.auth.sub)];}
  const r=await pool.query(sql,params);res.json({invoices:r.rows.map(i=>({...i.data,id:String(i.id),number:String(i.invoice_number),customerId:String(i.customer_user_id),orderId:i.order_id?String(i.order_id):undefined,appointmentId:i.appointment_id?String(i.appointment_id):undefined,kind:i.kind,total:Number(i.total),createdAt:i.created_at}))});
}));
app.post('/api/invoices', auth, roles('admin'), asyncRoute(async(req,res)=>{
  const b=req.body||{}; const orderId=positiveId(b.orderId); const appointmentId=positiveId(b.appointmentId); const customerId=positiveId(b.customerId); const total=Number(b.total); const kind=b.kind; const data=b.data===undefined?{}:b.data;
  if((!orderId&&!appointmentId)||!customerId||!['delivery','booking'].includes(kind)||!Number.isFinite(total)||total<0||!isRecord(data)) return res.status(400).json({error:'بيانات الفاتورة غير صالحة'});
  const r=await pool.query('INSERT INTO invoices(customer_user_id,order_id,appointment_id,kind,total,data) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[customerId,orderId,appointmentId,kind,total,JSON.stringify(data)]);const i=r.rows[0];res.status(201).json({invoice:{...i.data,id:String(i.id),number:String(i.invoice_number),customerId:String(i.customer_user_id),orderId:i.order_id?String(i.order_id):undefined,appointmentId:i.appointment_id?String(i.appointment_id):undefined,kind:i.kind,total:Number(i.total),createdAt:i.created_at}});
}));
app.patch('/api/admin/users/:id/status', auth, roles('admin'), asyncRoute(async(req,res)=>{
  const id=positiveId(req.params.id); const status=req.body&&req.body.status;
  if(!id||!['active','pending','rejected','suspended'].includes(status)) return res.status(400).json({error:'حالة الحساب غير صالحة'});
  if(String(id)===req.auth.sub) return res.status(400).json({error:'لا يمكن للمدير إيقاف حسابه بنفسه'});
  const r=await pool.query('UPDATE users SET status=$1 WHERE id=$2 RETURNING id,name,role,status',[status,id]);
  if(!r.rowCount) return res.status(404).json({error:'الحساب غير موجود'});
  res.json({user:{id:String(r.rows[0].id),name:r.rows[0].name,role:r.rows[0].role,status:r.rows[0].status}});
}));

app.get('/api/providers', asyncRoute(async (req, res) => {
  const { type } = req.query;
  const values = [];
  let sql = "SELECT p.* FROM providers p WHERE p.status='active'";
  if (type) { values.push(String(type)); sql += ` AND p.type=$${values.length}`; }
  sql += ' ORDER BY p.created_at DESC LIMIT 200';
  const r = await pool.query(sql, values);
  res.json({ providers: r.rows.map(p => ({ ...p.metadata, id: String(p.id), ownerId: String(p.owner_user_id), type: p.type, name: p.name, desc: p.description, address: p.address, phone: p.phone, deliveryFee: Number(p.delivery_fee), status: p.status, open: p.is_open })) });
}));
app.get('/api/products', asyncRoute(async (req, res) => {
  const values = []; let sql = "SELECT pr.*, p.name AS provider_name FROM products pr JOIN providers p ON p.id=pr.provider_id WHERE pr.available=TRUE AND p.status='active'";
  if (req.query.providerId) { const providerId = positiveId(req.query.providerId); if (!providerId) return res.status(400).json({ error: 'معرّف مقدم الخدمة غير صالح' }); values.push(providerId); sql += ` AND pr.provider_id=$${values.length}`; }
  sql += ' ORDER BY pr.created_at DESC LIMIT 500';
  const r = await pool.query(sql, values);
  res.json({ products: r.rows.map(x => ({ ...x.data, id: String(x.id), providerId: String(x.provider_id), name: x.name, price: Number(x.price), available: x.available })) });
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

app.post('/api/orders', auth, roles('customer'), asyncRoute(async (req, res) => {
  const appState = await pool.query('SELECT app_enabled,maintenance_message FROM app_settings WHERE id=1');
  if (appState.rowCount && !appState.rows[0].app_enabled) return res.status(503).json({ error: appState.rows[0].maintenance_message || 'التطبيق متوقف مؤقتًا' });
  const { providerId = null, total = 0, data = {} } = req.body || {};
  const validProviderId = providerId === null ? null : positiveId(providerId);
  if ((providerId !== null && !validProviderId) || !Number.isFinite(Number(total)) || Number(total) < 0 || !isRecord(data)) return res.status(400).json({ error: 'بيانات الطلب غير صالحة' });
  if (validProviderId !== null) { const p = await pool.query("SELECT id FROM providers WHERE id=$1 AND status='active'", [validProviderId]); if (!p.rowCount) return res.status(400).json({ error: 'مقدم الخدمة غير متاح' }); }
  const r = await pool.query('INSERT INTO orders(customer_user_id,provider_id,total,data) VALUES($1,$2,$3,$4) RETURNING *', [Number(req.auth.sub), validProviderId, Number(total), JSON.stringify(data)]);
  res.status(201).json({ order: { id: String(r.rows[0].id), number: Number(r.rows[0].order_number), status: r.rows[0].status, total: Number(r.rows[0].total), ...r.rows[0].data, createdAt: r.rows[0].created_at } });
}));
app.get('/api/orders', auth, asyncRoute(async (req, res) => {
  let sql, params;
  if (req.auth.role === 'admin') { sql = 'SELECT * FROM orders ORDER BY created_at DESC LIMIT 200'; params = []; }
  else if (req.auth.role === 'customer') { sql = 'SELECT * FROM orders WHERE customer_user_id=$1 ORDER BY created_at DESC LIMIT 200'; params = [Number(req.auth.sub)]; }
  else if (req.auth.role === 'provider') { sql = 'SELECT o.* FROM orders o JOIN providers p ON p.id=o.provider_id WHERE p.owner_user_id=$1 ORDER BY o.created_at DESC LIMIT 200'; params = [Number(req.auth.sub)]; }
  else { sql = 'SELECT * FROM orders WHERE courier_user_id=$1 ORDER BY created_at DESC LIMIT 200'; params = [Number(req.auth.sub)]; }
  const r = await pool.query(sql, params);
  res.json({ orders: r.rows.map(o => ({ ...o.data, id: String(o.id), number: Number(o.order_number), customerId: String(o.customer_user_id), providerId: o.provider_id === null ? null : String(o.provider_id), courierId: o.courier_user_id === null ? null : String(o.courier_user_id), status: o.status, total: Number(o.total), createdAt: o.created_at, updatedAt: o.updated_at })) });
}));
app.patch('/api/orders/:id/status', auth, roles('provider','courier','admin'), asyncRoute(async (req, res) => {
  const allowed = ['accepted','ready','on_the_way','delivered','rejected','cancelled'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({ error: 'حالة الطلب غير صالحة' });
  const found = await pool.query('SELECT o.*,p.owner_user_id FROM orders o LEFT JOIN providers p ON p.id=o.provider_id WHERE o.id=$1', [Number(req.params.id)]);
  if (!found.rowCount) return res.status(404).json({ error: 'الطلب غير موجود' });
  const o = found.rows[0];
  if (req.auth.role === 'provider' && String(o.owner_user_id) !== req.auth.sub) return res.status(403).json({ error: 'غير مسموح' });
  if (req.auth.role === 'courier' && o.courier_user_id !== null && String(o.courier_user_id) !== req.auth.sub) return res.status(403).json({ error: 'الطلب ليس مسندًا إليك' });
  const r = await pool.query('UPDATE orders SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING *', [req.body.status, o.id]);
  res.json({ order: { id: String(r.rows[0].id), number: Number(r.rows[0].order_number), status: r.rows[0].status, total: Number(r.rows[0].total), ...r.rows[0].data, updatedAt: r.rows[0].updated_at } });
}));

app.get('/api/orders/:id/messages', auth, asyncRoute(async (req, res) => {
  const order = await pool.query('SELECT o.*,p.owner_user_id FROM orders o LEFT JOIN providers p ON p.id=o.provider_id WHERE o.id=$1', [Number(req.params.id)]);
  if (!order.rowCount) return res.status(404).json({ error: 'الطلب غير موجود' });
  const o = order.rows[0];
  const allowed = req.auth.role === 'admin' || String(o.customer_user_id) === req.auth.sub || String(o.owner_user_id) === req.auth.sub || String(o.courier_user_id || '') === req.auth.sub;
  if (!allowed) return res.status(403).json({ error: 'غير مسموح بالاطلاع على المحادثة' });
  const r = await pool.query('SELECT m.id,m.order_id,m.sender_user_id,m.body,m.created_at,u.name,u.role FROM messages m JOIN users u ON u.id=m.sender_user_id WHERE m.order_id=$1 ORDER BY m.created_at ASC LIMIT 500', [o.id]);
  res.json({ messages: r.rows.map(m => ({ id: String(m.id), orderId: String(m.order_id), senderId: String(m.sender_user_id), senderName: m.name, senderRole: m.role, text: m.body, createdAt: m.created_at })) });
}));
app.post('/api/orders/:id/messages', auth, asyncRoute(async (req, res) => {
  const body = String(req.body.text || '').trim();
  if (!body || body.length > 2000) return res.status(400).json({ error: 'الرسالة فارغة أو طويلة جدًا' });
  const order = await pool.query('SELECT o.*,p.owner_user_id FROM orders o LEFT JOIN providers p ON p.id=o.provider_id WHERE o.id=$1', [Number(req.params.id)]);
  if (!order.rowCount) return res.status(404).json({ error: 'الطلب غير موجود' });
  const o = order.rows[0];
  const allowed = req.auth.role === 'admin' || String(o.customer_user_id) === req.auth.sub || String(o.owner_user_id) === req.auth.sub || String(o.courier_user_id || '') === req.auth.sub;
  if (!allowed) return res.status(403).json({ error: 'غير مسموح بإرسال رسالة في هذه المحادثة' });
  const r = await pool.query('INSERT INTO messages(order_id,sender_user_id,body) VALUES($1,$2,$3) RETURNING *', [o.id, Number(req.auth.sub), body]);
  const u = await pool.query('SELECT name,role FROM users WHERE id=$1', [Number(req.auth.sub)]);
  res.status(201).json({ message: { id: String(r.rows[0].id), orderId: String(r.rows[0].order_id), senderId: String(req.auth.sub), senderName: u.rows[0].name, senderRole: u.rows[0].role, text: body, createdAt: r.rows[0].created_at } });
}));

app.get('/api/admin/providers/pending', auth, roles('admin'), asyncRoute(async (_req, res) => {
  const r = await pool.query("SELECT p.*,u.name AS owner_name FROM providers p JOIN users u ON u.id=p.owner_user_id WHERE p.status='pending' ORDER BY p.created_at ASC");
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
