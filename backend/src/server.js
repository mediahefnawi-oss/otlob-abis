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
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined, max: Number(process.env.DB_POOL_MAX) || (process.env.VERCEL ? 4 : 10), idleTimeoutMillis: 20000, connectionTimeoutMillis: 8000, statement_timeout: 15000, query_timeout: 20000, keepAlive: true });
// ---- standby database (optional): DATABASE_URL_BACKUP is a continuously-copied second database ----
// While the main database does not answer, READ queries (catalog, orders, chat history...) are served from the standby, so the app keeps
// working on screen. WRITES never go to the standby automatically (two databases accepting orders at once would split the data);
// promoting the standby to main is a deliberate switch of DATABASE_URL.
const standby = process.env.DATABASE_URL_BACKUP
  ? new Pool({ connectionString: process.env.DATABASE_URL_BACKUP, ssl: process.env.DATABASE_SSL === 'false' ? false : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined, max: 3, idleTimeoutMillis: 20000, connectionTimeoutMillis: 5000, statement_timeout: 15000, keepAlive: true })
  : null;
let mainDownUntil = 0;
const connectionFailure = e => !!e && (['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', '57P01', '57P02', '57P03', '53300'].includes(e.code)
  || /connection terminated|timeout exceeded|connect ETIMEDOUT|Connection terminated|the database system is/i.test(String(e.message)));
const isReadOnlySql = t => typeof t === 'string' && /^\s*(select|with)\b/i.test(t) && !/\b(insert|update|delete|truncate|alter|drop|create|nextval|pg_advisory)\b/i.test(t);
if (standby) {
  standby.on('error', err => console.error('Standby pool error:', err.message));
  const mainQuery = pool.query.bind(pool);
  pool.query = async function (text, params) {
    if (typeof text !== 'string' || !isReadOnlySql(text)) return mainQuery(text, params);
    if (Date.now() < mainDownUntil) {
      try { return await standby.query(text, params); } catch { /* standby also failing: try the main one once more */ }
    }
    try { return await mainQuery(text, params); }
    catch (e) {
      if (!connectionFailure(e)) throw e;
      mainDownUntil = Date.now() + 15000;   // stop waiting on the main database for a few seconds
      console.error('Main database unreachable, reading from standby:', e.message);
      return standby.query(text, params);
    }
  };
}
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
if (process.env.NODE_ENV === 'production' && allowedOrigins.length === 0) {
  console.error('CORS_ORIGINS must contain the exact deployed Vercel origin in production.');
  process.exit(1);
}
app.use(cors({ origin(origin, cb) { if (!origin || allowedOrigins.includes(origin)) return cb(null, true); return cb(new Error('Origin not allowed')); }, methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '2mb' })); // a request photo is shrunk by the app to well under 600 KB
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }));
// Creating orders / uploading pictures is never needed in bursts: a generous cap per address stops abuse without bothering real users.
const writeLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 400, standardHeaders: true, legacyHeaders: false, skip: req => req.method === 'GET' || req.method === 'OPTIONS', message: { error: 'طلبات كثيرة جداً. انتظر قليلاً ثم حاول مرة أخرى' } });
app.use('/api', writeLimiter);

// ---- small in-memory caches (one per server instance): they spare PostgreSQL the thousands of identical questions that polling asks ----
const memo = (ttl, max = 2000) => {
  const m = new Map();
  return {
    get(k) { const e = m.get(k); if (e && Date.now() - e.at < ttl) return e.v; if (e) m.delete(k); return undefined; },
    set(k, v) { if (m.size >= max) m.clear(); m.set(k, { v, at: Date.now() }); return v; },
    clear() { m.clear(); },
  };
};
const authMemo = memo(4000, 5000);     // who is this token (role / status)
const settingsMemo = memo(2000, 4);    // maintenance mode + announcement
const catalogMemo = memo(5000, 200);   // providers + products + regions + ads
// anything that changes data empties the caches of this instance at once (other instances catch up within seconds)
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'OPTIONS') res.on('finish', () => { authMemo.clear(); settingsMemo.clear(); catalogMemo.clear(); });
  next();
});
// When the database is saturated, polite clients wait and retry instead of piling more work on it.
app.use(['/api/sync', '/api/catalog', '/api/counters'], (req, res, next) => {
  if (pool.waitingCount > 30) { res.set('Retry-After', '3'); return res.status(503).json({ error: 'الخادم مشغول حالياً، سيعاد المحاولة تلقائياً' }); }
  next();
});
process.on('unhandledRejection', e => console.error('unhandledRejection:', e && e.message ? e.message : e));
process.on('uncaughtException', e => console.error('uncaughtException:', e && e.message ? e.message : e));

// Is the app open for this role right now? Manual stop (app_enabled) always wins; otherwise the opening hours decide.
// The row is cached for a couple of seconds, the clock is read on every call.
async function maintenanceState(role) {
  let row = settingsMemo.get('m');
  if (!row) {
    let r;
    try { r = await pool.query('SELECT app_enabled,maintenance_message,hours_enabled,open_time,close_time,open_days,grace_min,closed_message FROM app_settings WHERE id=1'); }
    catch (e) { if (e.code !== '42703') throw e; r = await pool.query('SELECT app_enabled,maintenance_message FROM app_settings WHERE id=1'); } // columns not migrated yet
    row = settingsMemo.set('m', r.rowCount ? r.rows[0] : null);
  }
  if (!row) return { enabled: true, message: '' };
  const manual = row.maintenance_message || 'التطبيق متوقف مؤقتًا للصيانة';
  if (!row.app_enabled) return { enabled: false, message: manual, phase: 'manual' };
  const h = hours.fromRow(row);
  const now = Date.now();
  const { phase, next } = hours.phaseAt(h, now, hours.cairoOffsetMin(now));
  if (hours.allowed(phase, role)) return { enabled: true, message: '', phase };
  return { enabled: false, message: hours.renderMessage(h, next), phase };
}
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const cleanUser = row => ({ id: String(row.id), name: row.name, phone: row.phone, phone2: row.phone2 || '', role: row.role, address: row.address, ...(row.home_lat != null && row.home_lng != null ? { homeLat: Number(row.home_lat), homeLng: Number(row.home_lng) } : {}), status: row.status, createdAt: row.created_at, regionId: row.region_id ? String(row.region_id) : null, vehicle: row.vehicle || '', available: !!row.available, availableSince: row.available_since ? new Date(row.available_since).getTime() : undefined, supportChat: row.role === 'supervisor' ? !!row.support_chat : undefined, supRegions: row.role === 'supervisor' ? String(row.sup_regions || '').split(',').filter(Boolean) : undefined });
const positiveId = value => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
// an optional second number (no code confirmation); empty is fine, otherwise it must look like a mobile number and differ from the main one
function backupPhone(v, mainPhone) {
  const p = String(v || '').replace(/\s+/g, '');
  if (!p) return { ok: true, phone: '' };
  if (!/^01[0-9]{9}$/.test(p)) return { ok: false, error: 'رقم الهاتف الآخر غير صحيح' };
  if (p === String(mainPhone || '').replace(/\s+/g, '')) return { ok: false, error: 'الرقم الآخر يجب أن يختلف عن رقمك الأساسي' };
  return { ok: true, phone: p };
}
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
    let user = authMemo.get(String(claims.sub));
    if (!user) {
      const result = await pool.query('SELECT id, role, status, deleted_at FROM users WHERE id=$1', [claims.sub]);
      if (!result.rowCount || result.rows[0].deleted_at) return res.status(401).json({ error: 'الحساب غير موجود' });
      user = authMemo.set(String(claims.sub), result.rows[0]);
    }
    if (!allowInactive && user.status !== 'active') return res.status(403).json({ error: 'الحساب غير مفعّل. تواصل مع الدعم' });
    req.auth = { ...claims, sub: String(user.id), role: user.role, status: user.status };
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
    let row = authMemo.get(String(claims.sub));
    if (!row) { const r = await pool.query('SELECT id, role, status FROM users WHERE id=$1', [claims.sub]); if (r.rowCount) row = authMemo.set(String(claims.sub), r.rows[0]); }
    if (row) req.viewer = { id: String(row.id), role: row.role, status: row.status };
  } catch {}
  next();
}
// SQL fragment + params: which providers this viewer may see (never soft-deleted ones).
function providerVisibility(viewer, values) {
  if (viewer && viewer.role === 'admin') return 'p.deleted_at IS NULL';
  if (viewer && viewer.role === 'provider') { values.push(Number(viewer.id)); return `p.deleted_at IS NULL AND (p.status='active' OR p.owner_user_id=$${values.length})`; }
  return "p.deleted_at IS NULL AND p.status='active'";
}
const services = require('./services');
const hours = require('./hours');
const providerJson = p => ({ ...p.metadata, featured: !!(p.metadata && p.metadata.featured), regionId: p.owner_region_id ? String(p.owner_region_id) : '', regionName: p.region_name || '', logoV: p.logo_v ? Number(p.logo_v) : 0, id: String(p.id), ownerId: String(p.owner_user_id), type: p.type, name: p.name, desc: p.description, address: p.address, phone: p.phone, deliveryFee: Number(p.delivery_fee), ...(p.lat != null && p.lng != null ? { lat: Number(p.lat), lng: Number(p.lng) } : {}), status: p.status, open: p.is_open, createdAt: new Date(p.created_at).getTime() });
const roles = (...allowed) => (req, res, next) => { if (!req.auth || !allowed.includes(req.auth.role)) return res.status(403).json({ error: 'ليس لديك صلاحية لتنفيذ هذا الإجراء' }); next(); };

// Bump this whenever sql/schema.sql changes. Serverless instances start often; the heavy DDL must not run on every start
// (concurrent ALTER TABLEs lock each other and fail), so it runs once per version, by one instance at a time.
const offersLib = require('./offers');
const SCHEMA_VERSION = 20261125;
let schemaState = 'pending';
async function ensureSchema() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  try { await pool.query('CREATE TABLE IF NOT EXISTS schema_meta (id INT PRIMARY KEY, version BIGINT NOT NULL)'); }
  catch (e) { if (e.code !== '23505' && e.code !== '42P07') throw e; } // another instance created it at the same moment
  const cur = await pool.query('SELECT version FROM schema_meta WHERE id=1');
  if (cur.rowCount && Number(cur.rows[0].version) >= SCHEMA_VERSION) schemaState = 'ok';
  else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(74201)');
      const again = await client.query('SELECT version FROM schema_meta WHERE id=1');
      if (!again.rowCount || Number(again.rows[0].version) < SCHEMA_VERSION) {
        await client.query(schema);
        await client.query('INSERT INTO schema_meta(id, version) VALUES(1,$1) ON CONFLICT (id) DO UPDATE SET version=EXCLUDED.version', [SCHEMA_VERSION]);
      }
      await client.query('COMMIT');
      schemaState = 'ok';
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      // do not take the whole API down for a migration problem: log it, report it on /api/health and retry on the next start
      schemaState = 'failed';
      console.error('Schema migration failed:', e.message);
    } finally {
      client.release();
    }
  }
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


// ---------- Web Push (phone notifications even when the app is closed) ----------
let webpush = null;
try { webpush = require('web-push'); } catch (e) { console.warn('web-push is not installed: push notifications are off'); }
const pushEnabled = !!(webpush && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
// Phone app (Android): notifications go through Firebase Cloud Messaging. Needs FIREBASE_SERVICE_ACCOUNT (the service-account JSON, as text).
let fcm = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    fcm = admin.messaging();
  } catch (e) { console.warn('Firebase push is off:', e.message); }
}
if (pushEnabled) webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
/** Sends one notification to every device of the given users. Never throws (a failed push must not fail an order). */
async function pushToUsers(userIds, payload) {
  if ((!pushEnabled && !fcm) || !userIds || !userIds.length) return;
  try {
    const subs = (await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY($1::bigint[])', [[...new Set(userIds.map(Number))]])).rows;
    const body = JSON.stringify(payload);
    const device = subs.filter(s => String(s.endpoint).startsWith('fcm:'));
    await Promise.allSettled(device.map(s => Promise.race([
      !fcm ? Promise.resolve() : fcm.send({
        token: String(s.endpoint).slice(4),
        notification: { title: String(payload.title || ''), body: String(payload.body || '') },
        data: { tag: String(payload.tag || ''), url: String(payload.url || '/') },
        android: { priority: 'high', ttl: 3600 * 1000, notification: { channelId: 'orders', sound: 'default', priority: 'max', visibility: 'public', defaultVibrateTimings: false, vibrateTimingsMillis: [0, 500, 200, 500, 200, 500], tag: String(payload.tag || '') || undefined } },
      }).catch(async e => {
        if (e && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(String(e.code || e.message))) await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]);
        else console.error('fcm push failed:', e && (e.code || e.message));
      }),
      new Promise(r => setTimeout(r, 4000)),
    ])));
    if (!pushEnabled) return;
    await Promise.allSettled(subs.filter(s => !String(s.endpoint).startsWith('fcm:')).map(s => Promise.race([
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 3600, urgency: 'high' }).catch(async e => {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) await pool.query('DELETE FROM push_subscriptions WHERE id=$1', [s.id]); // the device unsubscribed
        else console.error('push failed:', e && (e.statusCode || e.message));
      }),
      new Promise(r => setTimeout(r, 4000)),
    ])));
  } catch (e) { console.error('push error:', e.message); }
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
  // 'standby' = the main database is not answering and reads come from the copy (writes are paused): worth an alert
  res.json({ ok: true, service: 'otlob-abis-api', database: standby && Date.now() < mainDownUntil ? 'standby' : 'connected', standbyConfigured: !!standby, schema: schemaState });
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const { name, phone, phone2, password, address = '', role = 'customer', provider, regionId, vehicle } = req.body || {};
  await services.ensure(pool);
  const mt = await maintenanceState(role);
  if (!mt.enabled) return res.status(503).json({ error: mt.message });
  const normalizedPhone = String(phone || '').replace(/\s+/g, '');
  if (!name || String(name).trim().length < 3) return res.status(400).json({ error: 'اكتب الاسم بالكامل' });
  if (!/^01[0-9]{9}$/.test(normalizedPhone)) return res.status(400).json({ error: 'رقم الهاتف غير صحيح' });
  const second = backupPhone(phone2, normalizedPhone);
  if (!second.ok) return res.status(400).json({ error: second.error });
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
  if (role === 'provider' && !region) return res.status(400).json({ error: 'اختر منطقة مكانك' });
  if (role === 'provider' && String(address).trim().length < 6) return res.status(400).json({ error: 'اكتب عنوان المكان بالتفصيل' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const hash = await bcrypt.hash(password, 12);
    // a number that was deleted before always waits for the owner's approval (even a customer); a brand-new customer number is active at once
    const wasDeleted = await client.query('SAVEPOINT wd').then(() => client.query('SELECT 1 FROM users WHERE orig_phone=$1 AND deleted_at IS NOT NULL LIMIT 1', [normalizedPhone])).then(r => r.rowCount > 0, async () => { await client.query('ROLLBACK TO SAVEPOINT wd'); return false; });
    const status = role === 'customer' && !wasDeleted ? 'active' : 'pending';
    const result = await client.query('INSERT INTO users(name,phone,password_hash,role,address,status,region_id,vehicle,phone2) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [String(name).trim(), normalizedPhone, hash, role, String(address).trim(), status, region, role === 'courier' ? String(vehicle || 'موتوسيكل').slice(0, 30) : '', second.phone || null]);
    const user = result.rows[0];
    if (role === 'provider') {
      await client.query('INSERT INTO providers(owner_user_id,type,name,description,address,phone,delivery_fee,status,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,\'pending\',$8)', [user.id, services.isKnown(provider.type) ? provider.type : 'other', String(provider.name).trim(), String(provider.desc || ''), String(address).trim(), normalizedPhone, Math.max(0, Number(provider.deliveryFee) || 0), JSON.stringify({ specialty: provider.specialty || '' })]);
    }
    await client.query('COMMIT');
    res.status(201).json({ token: tokenFor(user), user: cleanUser(user) });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل' });
    throw e;
  } finally { client.release(); }
}));

// Failed-login guard per phone / owner name (kept in the database so every server instance sees the same count).
const LOGIN_MAX_FAILS = 8, LOGIN_WINDOW_MIN = 15;
const loginKey = (username, phone) => username ? 'owner:' + String(username).toLowerCase() : 'ph:' + String(phone || '').replace(/\s+/g, '');
async function loginLocked(key) {
  try {
    const r = await pool.query('SELECT CEIL(EXTRACT(EPOCH FROM (locked_until - NOW())) / 60)::int AS mins FROM login_attempts WHERE key=$1 AND locked_until > NOW()', [key]);
    return r.rowCount ? Math.max(1, r.rows[0].mins) : 0;
  } catch { return 0; } // table not migrated yet: never block a real login because of it
}
async function loginFailed(key) {
  try {
    await pool.query(`INSERT INTO login_attempts(key, fails, first_at) VALUES($1, 1, NOW())
      ON CONFLICT (key) DO UPDATE SET
        fails = CASE WHEN login_attempts.locked_until IS NOT NULL OR login_attempts.first_at < NOW() - make_interval(mins => $3) THEN 1 ELSE login_attempts.fails + 1 END,
        first_at = CASE WHEN login_attempts.locked_until IS NOT NULL OR login_attempts.first_at < NOW() - make_interval(mins => $3) THEN NOW() ELSE login_attempts.first_at END,
        locked_until = CASE WHEN login_attempts.locked_until IS NULL AND login_attempts.first_at >= NOW() - make_interval(mins => $3) AND login_attempts.fails + 1 >= $2 THEN NOW() + make_interval(mins => $3) ELSE NULL END`, [key, LOGIN_MAX_FAILS, LOGIN_WINDOW_MIN]);
  } catch {}
}
const loginOk = key => pool.query('DELETE FROM login_attempts WHERE key=$1', [key]).catch(() => {});

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { phone, password, username } = req.body || {};
  const lkey = loginKey(username && String(username) === process.env.OWNER_USERNAME ? username : '', phone);
  const wait = await loginLocked(lkey);
  if (wait) return res.status(429).json({ error: `محاولات كثيرة خاطئة. حاول بعد ${wait} دقيقة` });
  let result;
  const bad = async msg => { await loginFailed(lkey); return res.status(401).json({ error: msg }); };
  if (username && String(username) === process.env.OWNER_USERNAME) {
    result = await pool.query("SELECT * FROM users WHERE role='admin' AND phone=$1 LIMIT 1", [process.env.OWNER_PHONE || '01000000000']);
    if (!result.rowCount || !(await bcrypt.compare(String(password || ''), result.rows[0].password_hash))) return bad('بيانات الدخول غير صحيحة');
  } else {
    const ph = String(phone || '').replace(/\s+/g, '');
    result = await pool.query('SELECT * FROM users WHERE phone=$1 LIMIT 1', [ph]);
    if (!result.rowCount || !(await bcrypt.compare(String(password || ''), result.rows[0].password_hash))) return bad('رقم الهاتف أو كلمة المرور غير صحيحة');
  }
  loginOk(lkey);
  const user = result.rows[0];
  if (user.status === 'suspended' || user.status === 'rejected') return res.status(403).json({ error: 'الحساب غير مفعّل. تواصل مع الدعم' });
  if (user.role !== 'admin') {
    const mt = await maintenanceState(user.role);
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
  let phone2Set = false; let phone2 = null;
  if ('phone2' in b) {
    const cur = await pool.query('SELECT phone FROM users WHERE id=$1', [Number(req.auth.sub)]);
    const second = backupPhone(b.phone2, cur.rows[0] && cur.rows[0].phone);
    if (!second.ok) return res.status(400).json({ error: second.error });
    phone2Set = true; phone2 = second.phone || null;
  }
  const availSet = typeof b.available === 'boolean' && req.auth.role === 'courier';
  if (availSet && !b.available) {
    const open = await pool.query("SELECT 1 FROM orders WHERE courier_user_id=$1 AND status IN ('accepted','ready','picked_up','on_the_way','arrived') LIMIT 1", [Number(req.auth.sub)]);
    if (open.rowCount) return res.status(409).json({ error: 'أكمل طلباتك الحالية قبل إيقاف الاستقبال' });
  }
  const r = await pool.query('UPDATE users SET name=COALESCE($1,name), address=COALESCE($2,address), region_id=CASE WHEN $3 THEN $4::bigint ELSE region_id END, available=CASE WHEN $6 THEN $7::boolean ELSE available END, available_since=CASE WHEN $6 AND $7::boolean AND NOT available THEN NOW() WHEN $6 AND NOT $7::boolean THEN NULL ELSE available_since END, phone2=CASE WHEN $8 THEN $9::varchar ELSE phone2 END WHERE id=$5 RETURNING *', [name, address, regionSet, region, Number(req.auth.sub), availSet, availSet ? b.available : false, phone2Set, phone2]);
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
// Live copy of the database: the owner can pause / resume the replication (a paused copy lets the main database sleep when nobody orders).
// It runs ALTER SUBSCRIPTION on the standby, so it needs DATABASE_URL_BACKUP; it never touches data.
const SUB_NAME = /^[a-z_][a-z0-9_]{0,40}$/.test(process.env.REPLICATION_SUB || '') ? process.env.REPLICATION_SUB : 'otlob_sub';
async function replicationStatus() {
  if (!standby) return { configured: false };
  const out = { configured: true, subscription: SUB_NAME };
  const s = await standby.query('SELECT subenabled FROM pg_subscription WHERE subname=$1', [SUB_NAME]);
  if (!s.rowCount) return { ...out, found: false };
  out.found = true; out.enabled = !!s.rows[0].subenabled;
  try { // how far behind the copy is, and how much log the main database keeps for it
    const l = await pool.query('SELECT active, pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::bigint AS lag FROM pg_replication_slots WHERE slot_name=$1', [SUB_NAME]);
    if (l.rowCount) { out.slotActive = !!l.rows[0].active; out.lagBytes = Number(l.rows[0].lag) || 0; }
  } catch { /* the slot view is only readable by the database owner: the on/off switch still works */ }
  return out;
}
app.get('/api/admin/replication', auth, roles('admin'), asyncRoute(async (_req, res) => {
  try { res.json(await replicationStatus()); }
  catch (e) { res.status(502).json({ error: 'تعذر الوصول للقاعدة الاحتياطية الآن' }); }
}));
app.post('/api/admin/replication', auth, roles('admin'), asyncRoute(async (req, res) => {
  if (!standby) return res.status(409).json({ error: 'القاعدة الاحتياطية غير مربوطة بالسيرفر' });
  if (typeof (req.body || {}).enabled !== 'boolean') return res.status(400).json({ error: 'اختر تشغيل أو إيقاف' });
  try {
    const cur = await standby.query('SELECT subenabled FROM pg_subscription WHERE subname=$1', [SUB_NAME]);
    if (!cur.rowCount) return res.status(404).json({ error: 'لا يوجد ربط على القاعدة الاحتياطية' });
    if (!!cur.rows[0].subenabled !== req.body.enabled) await standby.query(`ALTER SUBSCRIPTION ${SUB_NAME} ${req.body.enabled ? 'ENABLE' : 'DISABLE'}`);
    res.json(await replicationStatus());
  } catch (e) {
    console.error('replication switch failed:', e.message);
    res.status(502).json({ error: 'تعذر تغيير حالة الربط: ' + (/permission|must be owner|superuser/i.test(String(e.message)) ? 'صلاحيات الاتصال بالقاعدة الاحتياطية لا تسمح بذلك' : 'القاعدة الاحتياطية لا ترد') });
  }
}));

app.get('/api/admin/users', auth, roles('admin'), asyncRoute(async (req, res) => {
  const values = []; let sql = 'SELECT * FROM users WHERE deleted_at IS NULL';
  if (req.query.role) { values.push(String(req.query.role)); sql += ` AND role=$${values.length}`; }
  if (req.query.status) { values.push(String(req.query.status)); sql += ` AND status=$${values.length}`; }
  sql += ' ORDER BY created_at DESC LIMIT 500';
  const r = await pool.query(sql, values);
  res.json({ users: r.rows.map(row => ({ ...cleanUser(row), accountFlag: row.account_flag || '', flagNote: row.flag_note || '' })) });
}));
// Deleting an account frees its phone number: the old row keeps its history under a dead number, the real number can register again
// (as a pending account the owner must approve).
const FREE_PHONE_SQL = "UPDATE users SET deleted_at=NOW(), status='suspended', orig_phone=COALESCE(orig_phone, phone), phone='d'||id||'_'||right(phone,11) WHERE id=$1 AND deleted_at IS NULL";
async function freePhone(db, id) { await db.query(FREE_PHONE_SQL, [id]); authMemo.clear(); }

// Deleting a customer: his orders, bookings, invoices and chats go with him (the shops' accounting entries stay).
app.delete('/api/admin/customers/:id', auth, roles('admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف العميل غير صالح' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query("SELECT id FROM users WHERE id=$1 AND role='customer' AND deleted_at IS NULL FOR UPDATE", [id]);
    if (!u.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'العميل غير موجود' }); }
    await client.query('DELETE FROM invoices WHERE customer_user_id=$1', [id]);
    await client.query('DELETE FROM orders WHERE customer_user_id=$1', [id]);
    await client.query('DELETE FROM appointments WHERE customer_user_id=$1', [id]);
    await client.query('DELETE FROM push_subscriptions WHERE user_id=$1', [id]).catch(() => {});
    await freePhone(client, id);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  res.json({ ok: true });
}));
// Supervisors: staff accounts the owner creates. They run the orders of the areas given to them and nothing else.
async function cleanRegionIds(list) {
  const ids = [...new Set((Array.isArray(list) ? list : []).map(positiveId).filter(Boolean))].slice(0, 200);
  if (!ids.length) return '';
  const ok = await pool.query('SELECT id FROM regions WHERE id = ANY($1::bigint[])', [ids]);
  return ok.rows.map(r => r.id).join(',');
}
app.post('/api/admin/supervisors', auth, roles('admin'), asyncRoute(async (req, res) => {
  const { name, phone, password, regionIds } = req.body || {};
  const p = String(phone || '').replace(/\s+/g, '');
  if (!name || String(name).trim().length < 3) return res.status(400).json({ error: 'اكتب اسم المشرف بالكامل' });
  if (!/^01[0-9]{9}$/.test(p)) return res.status(400).json({ error: 'رقم الهاتف غير صحيح' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'كلمة المرور يجب ألا تقل عن 8 أحرف' });
  const regions = await cleanRegionIds(regionIds);
  try {
    const r = await pool.query("INSERT INTO users(name,phone,password_hash,role,address,status,sup_regions) VALUES($1,$2,$3,'supervisor','مشرف','active',$4) RETURNING *", [String(name).trim(), p, await bcrypt.hash(password, 12), regions]);
    res.status(201).json({ user: { ...cleanUser(r.rows[0]), accountFlag: '', flagNote: '' } });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'رقم الهاتف مسجل بالفعل' });
    throw e;
  }
}));
app.patch('/api/admin/supervisors/:id', auth, roles('admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صالح' });
  const b = req.body || {};
  const cur = await pool.query("SELECT * FROM users WHERE id=$1 AND role='supervisor' AND deleted_at IS NULL", [id]);
  if (!cur.rowCount) return res.status(404).json({ error: 'المشرف غير موجود' });
  const name = typeof b.name === 'string' && b.name.trim().length >= 3 ? b.name.trim().slice(0, 100) : cur.rows[0].name;
  const regions = Array.isArray(b.regionIds) ? await cleanRegionIds(b.regionIds) : cur.rows[0].sup_regions;
  const r = await pool.query('UPDATE users SET name=$1, sup_regions=$2 WHERE id=$3 RETURNING *', [name, regions, id]);
  authMemo.clear();
  res.json({ user: { ...cleanUser(r.rows[0]), accountFlag: '', flagNote: '' } });
}));
app.delete('/api/admin/supervisors/:id', auth, roles('admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف غير صالح' });
  const r = await pool.query("SELECT id FROM users WHERE id=$1 AND role='supervisor' AND deleted_at IS NULL", [id]);
  if (!r.rowCount) return res.status(404).json({ error: 'المشرف غير موجود' });
  await freePhone(pool, id);
  res.json({ ok: true });
}));
// Deleting a courier: orders keep pointing at the account, so it is suspended and hidden for good (never listed again).
app.delete('/api/admin/couriers/:id', auth, roles('admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف المندوب غير صالح' });
  const r = await pool.query("SELECT id FROM users WHERE id=$1 AND role='courier' AND deleted_at IS NULL", [id]);
  if (!r.rowCount) return res.status(404).json({ error: 'المندوب غير موجود' });
  await freePhone(pool, id);
  res.json({ ok: true });
}));
// The owner labels a customer account (trusted / watch / fraud). The label is copied onto that customer's open orders
// and bookings so the shops and couriers handling them see it; the customer never sees it.
app.patch('/api/admin/users/:id/flag', auth, roles('admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  const flag = String((req.body || {}).flag || '');
  const note = String((req.body || {}).note || '').trim().slice(0, 200);
  if (!id || !['', 'trusted', 'watch', 'fraud'].includes(flag)) return res.status(400).json({ error: 'اختر علامة صالحة للحساب' });
  const db = await pool.connect();
  let out = false;
  try {
    await db.query('BEGIN');
    const u = await db.query("UPDATE users SET account_flag=$1, flag_note=$2 WHERE id=$3 AND role='customer' RETURNING id", [flag, flag ? note : '', id]);
    if (u.rowCount) {
      const patch = JSON.stringify({ customerFlag: flag, customerFlagNote: flag ? note : '' });
      await db.query("UPDATE orders SET data = data || $2::jsonb, updated_at=NOW() WHERE customer_user_id=$1 AND status NOT IN ('delivered','cancelled','rejected','unavailable')", [id, patch]);
      await db.query("UPDATE appointments SET data = data || $2::jsonb, updated_at=NOW() WHERE customer_user_id=$1 AND status IN ('pending','confirmed')", [id, patch]);
      out = true;
    }
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; } finally { db.release(); }
  if (!out) return res.status(404).json({ error: 'حساب العميل غير موجود' });
  res.json({ ok: true, flag, note: flag ? note : '' });
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
  await services.ensure(pool);
  if (!services.isKnown(type)) return res.status(400).json({ error: 'نوع الخدمة غير صالح' });
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
  res.json({ regions: await listRegions(req.viewer) });
}));
app.post('/api/admin/regions', auth, roles('admin'), asyncRoute(async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'اكتب اسم المنطقة' });
  try {
    // delivery prices are set per route in "أسعار التوصيل", never on the area itself (the old column stays 0)
    const next = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM regions');
    const r = await pool.query('INSERT INTO regions(name, delivery_fee, sort_order) VALUES($1,0,$2) RETURNING *', [name.slice(0, 80), next.rows[0].n]);
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
  if (name.length < 2) return res.status(400).json({ error: 'اكتب اسم المنطقة' });
  try {
    const r = await pool.query('UPDATE regions SET name=$1, delivery_fee=$2, active=$3 WHERE id=$4 RETURNING *', [name, Number(old.rows[0].delivery_fee), b.active === undefined ? old.rows[0].active : Boolean(b.active), id]);
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


// ---------- Announcements board: the owner adds / pauses / deletes; everyone sees the active ones ----------
const MAX_AD_IMAGE = 700000; // characters of base64 text
function parseImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m || String(dataUrl).length > MAX_AD_IMAGE) return null;
  return { mime: m[1], buf: Buffer.from(m[2], 'base64') };
}
const adJson = x => ({ id: String(x.id), title: x.title, link: x.link, active: x.active, sortOrder: x.sort_order, v: new Date(x.updated_at).getTime() });
app.get('/api/ads/:id/image', asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).end();
  const r = await pool.query('SELECT image, mime FROM ads WHERE id=$1', [id]);
  if (!r.rowCount) return res.status(404).end();
  res.set('Content-Type', r.rows[0].mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable'); // the link changes (?v=) when the picture changes
  res.set('Cross-Origin-Resource-Policy', 'cross-origin'); // the web app lives on another address
  res.send(r.rows[0].image);
}));
app.post('/api/admin/ads', auth, roles('admin'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const img = parseImage(b.image);
  if (!img) return res.status(400).json({ error: 'ارفع صورة صالحة (JPG أو PNG)' });
  const title = String(b.title || '').trim().slice(0, 80);
  const link = String(b.link || '').trim().slice(0, 300);
  if (link && !/^https?:\/\//i.test(link)) return res.status(400).json({ error: 'الرابط يجب أن يبدأ بـ http أو https' });
  const next = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM ads');
  const r = await pool.query('INSERT INTO ads(title, link, image, mime, sort_order) VALUES($1,$2,$3,$4,$5) RETURNING id, title, link, active, sort_order, updated_at', [title, link, img.buf, img.mime, next.rows[0].n]);
  res.status(201).json({ ad: adJson(r.rows[0]) });
}));
app.patch('/api/admin/ads/:id', auth, roles('admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف الإعلان غير صالح' });
  const b = req.body || {};
  const old = await pool.query('SELECT * FROM ads WHERE id=$1', [id]);
  if (!old.rowCount) return res.status(404).json({ error: 'الإعلان غير موجود' });
  let image = old.rows[0].image; let mime = old.rows[0].mime;
  if (b.image) {
    const img = parseImage(b.image);
    if (!img) return res.status(400).json({ error: 'الصورة غير صالحة' });
    image = img.buf; mime = img.mime;
  }
  const link = b.link === undefined ? old.rows[0].link : String(b.link).trim().slice(0, 300);
  if (link && !/^https?:\/\//i.test(link)) return res.status(400).json({ error: 'الرابط يجب أن يبدأ بـ http أو https' });
  const r = await pool.query('UPDATE ads SET title=$1, link=$2, image=$3, mime=$4, active=$5, sort_order=$6, updated_at=NOW() WHERE id=$7 RETURNING id, title, link, active, sort_order, updated_at', [
    b.title === undefined ? old.rows[0].title : String(b.title).trim().slice(0, 80), link, image, mime,
    b.active === undefined ? old.rows[0].active : Boolean(b.active),
    b.sortOrder === undefined ? old.rows[0].sort_order : Math.floor(Number(b.sortOrder) || 0), id]);
  res.json({ ad: adJson(r.rows[0]) });
}));
app.delete('/api/admin/ads/:id', auth, roles('admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف الإعلان غير صالح' });
  const r = await pool.query('DELETE FROM ads WHERE id=$1 RETURNING id', [id]);
  if (!r.rowCount) return res.status(404).json({ error: 'الإعلان غير موجود' });
  res.json({ ok: true });
}));

// ---------- Push subscriptions (one per browser/device, owned by whoever is signed in there) ----------
app.get('/api/push/key', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ key: pushEnabled ? process.env.VAPID_PUBLIC_KEY : null }); });
app.post('/api/push/subscribe', auth, asyncRoute(async (req, res) => {
  const sub = (req.body || {}).subscription || {};
  const endpoint = String(sub.endpoint || '');
  const p256dh = String((sub.keys || {}).p256dh || '');
  const authKey = String((sub.keys || {}).auth || '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !authKey) return res.status(400).json({ error: 'اشتراك غير صالح' });
  await pool.query('INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth) VALUES($1,$2,$3,$4) ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth', [Number(req.auth.sub), endpoint, p256dh, authKey]);
  res.status(201).json({ ok: true });
}));
// Android app: the phone's Firebase token (stored like a web subscription, with an "fcm:" prefix).
app.post('/api/push/subscribe-device', auth, asyncRoute(async (req, res) => {
  const token = String((req.body || {}).token || '');
  if (token.length < 20 || token.length > 400 || /\s/.test(token)) return res.status(400).json({ error: 'رمز الجهاز غير صالح' });
  await pool.query("INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth) VALUES($1,$2,'fcm','fcm') ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id", [Number(req.auth.sub), `fcm:${token}`]);
  res.status(201).json({ ok: true });
}));
app.post('/api/push/unsubscribe', auth, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2', [String((req.body || {}).endpoint || ''), Number(req.auth.sub)]);
  res.json({ ok: true });
}));

// Public runtime settings are read from PostgreSQL, so maintenance mode and announcements
// apply consistently to every client using this API.
async function loadSettingsBase() {
  const hit = settingsMemo.get('s');
  if (hit) return hit;
  const r = await pool.query('SELECT * FROM app_settings WHERE id=1');
  const x = r.rows[0];
  let welcomeLogoV = 0;
  try { const wl = await pool.query("SELECT (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v FROM site_images WHERE key='welcome_logo'"); if (wl.rowCount) welcomeLogoV = Number(wl.rows[0].v); } catch { /* table not migrated yet */ }
  let credits = null;
  try { const c = JSON.parse(x.credits || 'null'); if (c && typeof c === 'object') credits = { a: String(c.a || ''), b: String(c.b || ''), c: String(c.c || ''), d: String(c.d || '') }; } catch { credits = null; }
  let loginImageV = 0;
  try { const li = await pool.query("SELECT (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v FROM site_images WHERE key='login'"); if (li.rowCount) loginImageV = Number(li.rows[0].v); } catch { /* table not migrated yet */ }
  let appIconV = 0;
  try { const ai = await pool.query("SELECT (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v FROM site_images WHERE key='app_icon'"); if (ai.rowCount) appIconV = Number(ai.rows[0].v); } catch { /* table not migrated yet */ }
  const catIconV = {};
  try { const ci = await pool.query("SELECT substr(key,5) AS t, (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v FROM site_images WHERE key LIKE 'cat\\_%'"); for (const row of ci.rows) catIconV[row.t] = Number(row.v); } catch { /* table not migrated yet */ }
  return settingsMemo.set('s', { hours: hours.fromRow(x), welcomeLogoV, credits, loginImageV, appIconV, catIconV, apkUrl: x.apk_url || '', update: { version: x.update_version || '', message: x.update_message || '', required: !!x.update_required }, appEnabled: x.app_enabled, maintenanceMessage: x.maintenance_message, announcement: x.announcement, theme: x.theme || 'default', map: { enabled: x.map_enabled !== false, required: x.map_required !== false }, delivery: require('./kmfee').cfgFromRow(x), autoAssign: x.auto_assign, supportPhone: x.support_phone, supportName: x.support_name, updatedAt: x.updated_at });
}
// the clock part is never cached: the app uses it to know when to open / close without asking again
async function loadSettings() {
  const base = await loadSettingsBase();
  const now = Date.now();
  return { ...base, tzOffsetMin: hours.cairoOffsetMin(now), serverNow: now };
}
app.get('/api/settings', asyncRoute(async (_req, res) => {
  res.json({ settings: await loadSettings() });
}));
app.patch('/api/admin/settings', auth, roles('admin'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const hp = hours.parseInput(b); // checked first so a wrong time never half-saves the other settings
  if (!hp.ok) return res.status(400).json({ error: hp.error });
  const current = (await pool.query('SELECT * FROM app_settings WHERE id=1')).rows[0];
  const boolField = (v, old) => typeof v === 'boolean' ? v : old;
  const textField = (v, old, max=500) => typeof v === 'string' ? v.trim().slice(0,max) : old;
  const r = await pool.query(`UPDATE app_settings SET app_enabled=$1,maintenance_message=$2,announcement=$3,auto_assign=$4,support_phone=$5,support_name=$6,apk_url=$7,credits=$8,updated_at=NOW() WHERE id=1 RETURNING *`, [
    boolField(b.appEnabled,current.app_enabled), textField(b.maintenanceMessage,current.maintenance_message), textField(b.announcement,current.announcement), boolField(b.autoAssign,current.auto_assign), textField(b.supportPhone,current.support_phone,40), textField(b.supportName,current.support_name,100), (() => { const u = textField(b.apkUrl, current.apk_url, 500); return u === '' || /^https:\/\/[^\s]+$/i.test(u) ? u : current.apk_url; })(),
    (() => { if (b.credits === null) return ''; if (!b.credits || typeof b.credits !== 'object') return current.credits || ''; const f = (v) => String(v == null ? '' : v).trim().slice(0, 120); return JSON.stringify({ a: f(b.credits.a), b: f(b.credits.b), c: f(b.credits.c), d: f(b.credits.d) }); })()
  ]);
  const hcols = Object.keys(hp.value);
  if (hcols.length) {
    try { await pool.query(`UPDATE app_settings SET ${hcols.map((c, i) => `${c}=$${i + 1}`).join(',')}, updated_at=NOW() WHERE id=1`, hcols.map(c => hp.value[c])); }
    catch (e) { if (e.code === '42703') return res.status(503).json({ error: 'قاعدة البيانات لم تُحدَّث بعد' }); throw e; }
  }
  settingsMemo.clear();
  res.json({ settings: await loadSettings() });
}));

// The owner announces (or withdraws) a new app version; everyone below that version sees the update banner.
app.patch('/api/admin/update-notice', auth, roles('admin'), asyncRoute(async (req, res) => {
  const b = req.body || {};
  const version = b.clear ? '' : String(b.version || '').trim();
  if (version && !/^\d+(\.\d+){0,3}$/.test(version)) return res.status(400).json({ error: 'رقم النسخة بصيغة مثل 1.1.0' });
  const message = b.clear ? '' : String(b.message || '').trim().slice(0, 300);
  const required = b.clear ? false : b.required === true;
  try {
    await pool.query('UPDATE app_settings SET update_version=$1, update_message=$2, update_required=$3, updated_at=NOW() WHERE id=1', [version, message, required]);
  } catch (e) { if (e.code === '42703') return res.status(503).json({ error: 'قاعدة البيانات لم تُحدَّث بعد' }); throw e; }
  settingsMemo.clear();
  res.json({ settings: await loadSettings() });
}));

// The owner alone chooses the colour theme of the whole app (a fixed list, so text always stays readable).
const THEME_IDS = ['default', 'ocean', 'royal', 'maroon', 'charcoal', 'teal', 'sunset', 'rose'];
app.patch('/api/admin/theme', auth, roles('admin'), asyncRoute(async (req, res) => {
  const theme = String((req.body || {}).theme || '');
  if (!THEME_IDS.includes(theme)) return res.status(400).json({ error: 'لون غير صالح' });
  try { await pool.query('UPDATE app_settings SET theme=$1, updated_at=NOW() WHERE id=1', [theme]); }
  catch (e) { if (e.code === '42703') return res.status(503).json({ error: 'قاعدة البيانات لم تُحدَّث بعد' }); throw e; }
  settingsMemo.clear();
  res.json({ settings: await loadSettings() });
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

async function listProviders(viewer, type) {
  await services.ensure(pool);
  const values = [];
  let sql = `SELECT p.*, u.region_id AS owner_region_id, g.name AS region_name, (SELECT (EXTRACT(EPOCH FROM l.updated_at)*1000)::bigint FROM provider_logos l WHERE l.provider_id=p.id) AS logo_v FROM providers p LEFT JOIN users u ON u.id=p.owner_user_id LEFT JOIN regions g ON g.id=u.region_id WHERE ${providerVisibility(viewer, values)}`;
  if (type) { values.push(String(type)); sql += ` AND p.type=$${values.length}`; }
  sql += ' ORDER BY p.created_at DESC LIMIT 500';
  const hide = !viewer || viewer.role === 'customer'; // a maker's address is for couriers and staff only; customers see the area
  const rows = (await pool.query(sql, values)).rows.map(providerJson);
  // a stopped service disappears for customers and couriers (the owner and the provider still see it)
  const visible = viewer && (viewer.role === 'admin' || viewer.role === 'provider') ? rows : rows.filter(p => services.isActive(p.type));
  return visible.map(p => (hide && services.tplOf(p.type) === 'maker' ? { ...p, address: '' } : p));
}
async function listProducts(viewer, providerId) {
  await services.ensure(pool);
  const values = [];
  const noProd = vals => { const t = services.noProductTypes(); if (!t.length) return 'TRUE'; vals.push(t); return `NOT (p.type = ANY($${vals.length}::text[]))`; };
  // supermarkets and pharmacies work by written requests only: their old product rows are kept in the database but no longer offered
  let sql = `SELECT pr.*, (SELECT (EXTRACT(EPOCH FROM i.updated_at)*1000)::bigint FROM product_images i WHERE i.product_id=pr.id) AS image_v FROM products pr JOIN providers p ON p.id=pr.provider_id WHERE ${noProd(values)} AND ${providerVisibility(viewer, values)}`;
  if (providerId) { values.push(providerId); sql += ` AND pr.provider_id=$${values.length}`; }
  sql += ' ORDER BY pr.created_at ASC LIMIT 2000';
  const offers = await offersLib.activeOffers(pool);
  // the owner and the shop keep seeing the NORMAL price (so saving a product can never write the discounted price by mistake); customers get the discounted one
  const keepBase = !!viewer && ['admin', 'provider', 'supervisor'].includes(viewer.role);
  return (await pool.query(sql, values)).rows.map(x => {
    const of = offersLib.bestOffer(offers, x.provider_id);
    const base = { ...x.data, id: String(x.id), providerId: String(x.provider_id), name: x.name, available: x.available, imageV: x.image_v ? Number(x.image_v) : 0 };
    if (!of) return { ...base, price: Number(x.price) };
    if (keepBase) return { ...base, price: Number(x.price), offer: offersLib.offerJson(of) };
    return { ...base, price: offersLib.salePrice(x.price, of), oldPrice: Number(x.price), offer: offersLib.offerJson(of) };
  });
}
/** "fromAreaId:toAreaId" -> delivery price (shop's area -> customer's area) */
async function listRoutePrices() {
  try {
    const r = await pool.query('SELECT from_region_id, to_region_id, price FROM route_prices');
    return Object.fromEntries(r.rows.map(x => [`${x.from_region_id}:${x.to_region_id}`, Number(x.price)]));
  } catch { return {}; } // table not migrated yet
}
app.put('/api/admin/route-prices', auth, roles('admin'), asyncRoute(async (req, res) => {
  const from = positiveId((req.body || {}).fromId);
  const list = Array.isArray((req.body || {}).prices) ? req.body.prices.slice(0, 300) : [];
  if (!from) return res.status(400).json({ error: 'اختر منطقة المتجر' });
  const known = new Set((await pool.query('SELECT id FROM regions')).rows.map(r => Number(r.id)));
  if (!known.has(from)) return res.status(400).json({ error: 'المنطقة غير موجودة' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const it of list) {
      const to = positiveId(it && it.toId);
      if (!to || !known.has(to)) continue;
      const empty = it.price === null || it.price === undefined || it.price === '';
      if (empty) { await client.query('DELETE FROM route_prices WHERE from_region_id=$1 AND to_region_id=$2', [from, to]); continue; }
      const price = Number(it.price);
      if (!Number.isFinite(price) || price < 0 || price > 100000) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'السعر غير صحيح' }); }
      await client.query('INSERT INTO route_prices(from_region_id, to_region_id, price, updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT (from_region_id, to_region_id) DO UPDATE SET price=EXCLUDED.price, updated_at=NOW()', [from, to, Math.round(price * 100) / 100]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  res.json({ routePrices: await listRoutePrices() });
}));
async function listRegions(viewer) {
  const all = viewer && viewer.role === 'admin';
  const r = await pool.query(`SELECT * FROM regions ${all ? '' : 'WHERE active=TRUE'} ORDER BY sort_order, id`);
  return r.rows.map(x => ({ id: String(x.id), name: x.name, deliveryFee: Number(x.delivery_fee), active: x.active }));
}
app.get('/api/providers', optionalAuth, asyncRoute(async (req, res) => {
  res.json({ providers: await listProviders(req.viewer, req.query.type) });
}));
app.get('/api/products', optionalAuth, asyncRoute(async (req, res) => {
  let providerId = null;
  if (req.query.providerId) { providerId = positiveId(req.query.providerId); if (!providerId) return res.status(400).json({ error: 'معرّف مقدم الخدمة غير صالح' }); }
  res.json({ products: await listProducts(req.viewer, providerId) });
}));
// Everything the home screen needs in ONE request (fewer calls = faster app and a lighter server).
async function listAds(viewer) {
  const all = viewer && viewer.role === 'admin';
  const r = await pool.query(`SELECT id, title, link, active, sort_order, updated_at FROM ads ${all ? '' : 'WHERE active=TRUE'} ORDER BY sort_order, id DESC LIMIT 30`);
  return r.rows.map(x => ({ id: String(x.id), title: x.title, link: x.link, active: x.active, sortOrder: x.sort_order, v: new Date(x.updated_at).getTime() }));
}
app.get('/api/catalog', optionalAuth, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  // Same answer for every customer / courier / visitor; owners and providers see a bit more, so they get their own copies.
  const v = req.viewer;
  const key = v && (v.role === 'admin' || v.role === 'provider') ? `${v.role}:${v.id}` : 'public';
  const hit = req.query.fresh ? undefined : catalogMemo.get(key);
  if (hit) return res.json(hit);
  const [providers, products, regions, ads, routePrices] = await Promise.all([listProviders(v), listProducts(v), listRegions(v), listAds(v).catch(() => []), listRoutePrices()]);
  res.json(catalogMemo.set(key, { providers, products, regions, ads, routePrices, services: services.listJson() }));
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
  if (!left.rowCount) { await pool.query("SELECT 1 FROM users WHERE id=$1 AND role='provider'", [owner]).then(async q => { if (q.rowCount) await freePhone(pool, owner); }); }
  res.json({ ok: true });
}));

app.post('/api/products', auth, roles('provider','admin'), asyncRoute(async (req, res) => {
  const { providerId, name, price, data = {} } = req.body || {};
  const validProviderId = positiveId(providerId);
  if (!validProviderId || typeof name !== 'string' || !name.trim() || !Number.isFinite(Number(price)) || Number(price) < 0 || !isRecord(data)) return res.status(400).json({ error: 'بيانات المنتج غير صالحة' });
  const p = await pool.query('SELECT id,owner_user_id,type FROM providers WHERE id=$1', [validProviderId]);
  if (!p.rowCount) return res.status(404).json({ error: 'مقدم الخدمة غير موجود' });
  if (req.auth.role !== 'admin' && String(p.rows[0].owner_user_id) !== req.auth.sub) return res.status(403).json({ error: 'لا يمكنك إدارة منتجات مقدم خدمة آخر' });
  await services.ensure(pool);
  if (!services.canProducts(p.rows[0].type)) return res.status(400).json({ error: 'هذه الخدمة تعمل بدون منتجات (طلب مكتوب أو حجز)' });
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


// ---------- Provider logos and product pictures (stored apart so the sync never downloads them) ----------
function sendImage(res, row) {
  res.set('Content-Type', row.mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable'); // the link changes (?v=) when the picture changes
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.send(row.image);
}
async function ownsProvider(req, providerId) {
  const p = await pool.query('SELECT owner_user_id FROM providers WHERE id=$1 AND deleted_at IS NULL', [providerId]);
  if (!p.rowCount) return 404;
  if (req.auth.role !== 'admin' && String(p.rows[0].owner_user_id) !== req.auth.sub) return 403;
  return 0;
}
app.get('/api/providers/:id/logo', asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).end();
  const r = await pool.query('SELECT image, mime FROM provider_logos WHERE provider_id=$1', [id]);
  if (!r.rowCount) return res.status(404).end();
  sendImage(res, r.rows[0]);
}));
app.put('/api/providers/:id/logo', auth, roles('provider','admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف مقدم الخدمة غير صالح' });
  const bad = await ownsProvider(req, id);
  if (bad) return res.status(bad).json({ error: bad === 404 ? 'مقدم الخدمة غير موجود' : 'غير مسموح' });
  const img = parseImage((req.body || {}).image);
  if (!img) return res.status(400).json({ error: 'ارفع صورة صالحة (JPG أو PNG)' });
  await pool.query('INSERT INTO provider_logos(provider_id, image, mime, updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT (provider_id) DO UPDATE SET image=EXCLUDED.image, mime=EXCLUDED.mime, updated_at=NOW()', [id, img.buf, img.mime]);
  const v = await pool.query('SELECT (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v FROM provider_logos WHERE provider_id=$1', [id]);
  res.json({ logoV: Number(v.rows[0].v) });
}));
app.delete('/api/providers/:id/logo', auth, roles('provider','admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'معرّف مقدم الخدمة غير صالح' });
  const bad = await ownsProvider(req, id);
  if (bad) return res.status(bad).json({ error: bad === 404 ? 'مقدم الخدمة غير موجود' : 'غير مسموح' });
  await pool.query('DELETE FROM provider_logos WHERE provider_id=$1', [id]);
  res.json({ logoV: 0 });
}));
async function productProvider(req) {
  const id = positiveId(req.params.id);
  if (!id) return { code: 400 };
  const f = await pool.query('SELECT pr.id, p.owner_user_id FROM products pr JOIN providers p ON p.id=pr.provider_id WHERE pr.id=$1', [id]);
  if (!f.rowCount) return { code: 404 };
  if (req.auth.role !== 'admin' && String(f.rows[0].owner_user_id) !== req.auth.sub) return { code: 403 };
  return { id };
}
app.get('/api/products/:id/image', asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).end();
  const r = await pool.query('SELECT image, mime FROM product_images WHERE product_id=$1', [id]);
  if (!r.rowCount) return res.status(404).end();
  sendImage(res, r.rows[0]);
}));
app.put('/api/products/:id/image', auth, roles('provider','admin'), asyncRoute(async (req, res) => {
  const f = await productProvider(req);
  if (f.code) return res.status(f.code).json({ error: 'تعذّر حفظ صورة المنتج' });
  const img = parseImage((req.body || {}).image);
  if (!img) return res.status(400).json({ error: 'ارفع صورة صالحة (JPG أو PNG)' });
  await pool.query('INSERT INTO product_images(product_id, image, mime, updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT (product_id) DO UPDATE SET image=EXCLUDED.image, mime=EXCLUDED.mime, updated_at=NOW()', [f.id, img.buf, img.mime]);
  const v = await pool.query('SELECT (EXTRACT(EPOCH FROM updated_at)*1000)::bigint AS v FROM product_images WHERE product_id=$1', [f.id]);
  res.json({ imageV: Number(v.rows[0].v) });
}));
app.delete('/api/products/:id/image', auth, roles('provider','admin'), asyncRoute(async (req, res) => {
  const f = await productProvider(req);
  if (f.code) return res.status(f.code).json({ error: 'تعذّر حذف صورة المنتج' });
  await pool.query('DELETE FROM product_images WHERE product_id=$1', [f.id]);
  res.json({ imageV: 0 });
}));

// Orders, invoices, bookings and chat live in orders.js
require('./commissions')(app, { pool, auth, roles, asyncRoute, positiveId });
services.register(app, { pool, auth, roles, asyncRoute });
require('./mapmode').registerMapModeRoutes(app, { pool, auth, roles, asyncRoute, settingsMemo });
require('./kmfee').registerKmFeeRoutes(app, { pool, auth, roles, asyncRoute, settingsMemo });
require('./offers').registerOfferRoutes(app, { pool, auth, roles, asyncRoute, positiveId });
require('./tracking')(app, { pool, auth, roles, asyncRoute, positiveId });
require('./support')(app, { pool, auth, roles, asyncRoute, positiveId, pushToUsers });
require('./orders')(app, { pool, auth, authAny, roles, asyncRoute, positiveId, maintenanceState, loadSettings, cleanUser, pushToUsers });

app.get('/api/admin/providers/pending', auth, roles('admin'), asyncRoute(async (_req, res) => {
  const r = await pool.query("SELECT p.*,u.name AS owner_name FROM providers p JOIN users u ON u.id=p.owner_user_id WHERE p.status='pending' AND p.deleted_at IS NULL ORDER BY p.created_at ASC");
  res.json({ providers: r.rows.map(p => ({ ...p.metadata, id: String(p.id), ownerId: String(p.owner_user_id), ownerName: p.owner_name, type: p.type, name: p.name, desc: p.description, address: p.address, phone: p.phone, deliveryFee: Number(p.delivery_fee), status: p.status })) });
}));
// The owner can set / change the area a place is in (it follows the place's owner account).
app.patch('/api/admin/providers/:id/region', auth, roles('admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id), rid = positiveId(req.body && req.body.regionId);
  if (!id || !rid) return res.status(400).json({ error: 'بيانات غير صحيحة' });
  if (!(await pool.query('SELECT 1 FROM regions WHERE id=$1', [rid])).rowCount) return res.status(400).json({ error: 'المنطقة غير موجودة' });
  const r = await pool.query('UPDATE users SET region_id=$2 WHERE id=(SELECT owner_user_id FROM providers WHERE id=$1) RETURNING id', [id, rid]);
  if (!r.rowCount) return res.status(404).json({ error: 'غير موجود' });
  res.json({ ok: true });
}));
// The owner chooses which places appear in the customers' "الأعلى تقييماً" row.
app.patch('/api/admin/providers/:id/featured', auth, roles('admin'), asyncRoute(async (req, res) => {
  const id = positiveId(req.params.id);
  if (!id) return res.status(400).json({ error: 'رقم غير صحيح' });
  const r = await pool.query("UPDATE providers SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{featured}', to_jsonb($2::boolean), TRUE) WHERE id=$1 AND deleted_at IS NULL RETURNING *", [id, !!(req.body && req.body.featured)]);
  if (!r.rowCount) return res.status(404).json({ error: 'غير موجود' });
  res.json({ provider: providerJson(r.rows[0]) });
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
    if (!process.env.VERCEL) require('./releaseWatch').startReleaseWatch({ pool, onChange: () => settingsMemo.clear() });
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
