const { Pool } = require('./shim');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const pass1 = (req, res, next) => next();
(async () => {
  const pool = new Pool();
  const q = (t, p) => pool.query(t, p);
  await q('TRUNCATE ratings'); // throw-away test database only
  const R = require('../src/ratings.js');
  R.registerRatingRoutes(app, { pool, auth: pass1, roles: () => pass1, asyncRoute, positiveId });
  const call = async (key, as, params, body) => {
    const chain = routes[key]; const out = { status: 200, json: null };
    const req = { auth: as, params: params || {}, body: body || {}, query: {} };
    const res = { status(c) { out.status = c; return this; }, json(j) { out.json = j; return this; } };
    let err = null; chain[chain.length - 1](req, res, e => { err = e; });
    const t0 = Date.now(); while (!err && out.json === null && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 2));
    if (err) throw err; return out;
  };
  const u = async (n, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status) VALUES($1,$2,'x',$3,'active') RETURNING id", [n, '011' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const admin = await u('مالك', 'admin'), cust = await u('محمد أحمد', 'customer'), other = await u('سارة', 'customer'), cour = await u('علي', 'courier'), po = await u('ص', 'provider');
  const p = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open,metadata) VALUES($1,'restaurant','مطعم','01000000000','active',TRUE,'{}') RETURNING id", [po])).rows[0].id;
  const mk = async (status, courier) => (await q("INSERT INTO orders(customer_user_id, provider_id, courier_user_id, status, total, data) VALUES($1,$2,$3,$4,100,'{}') RETURNING id", [cust, p, courier || null, status])).rows[0].id;
  const C = { sub: String(cust), role: 'customer' }, O = { sub: String(other), role: 'customer' }, A = { sub: String(admin), role: 'admin' };
  const oDel = await mk('delivered', cour), oWay = await mk('on_the_way', cour), oNoC = await mk('delivered', null);

  let r = await call('POST /api/orders/:id/rating', C, { id: String(oWay) }, { providerStars: 5 });
  ok(r.status === 409, 'cannot rate before delivery');
  r = await call('POST /api/orders/:id/rating', C, { id: String(oDel) }, { providerStars: 0 });
  ok(r.status === 400, 'stars must be 1..5 (0)');
  r = await call('POST /api/orders/:id/rating', C, { id: String(oDel) }, { providerStars: 6 });
  ok(r.status === 400, 'stars must be 1..5 (6)');
  r = await call('POST /api/orders/:id/rating', C, { id: String(oDel) }, { providerStars: 4.5 });
  ok(r.status === 400, 'whole stars only');
  r = await call('POST /api/orders/:id/rating', C, { id: String(oDel) }, { providerStars: 5, courierStars: 9 });
  ok(r.status === 400, 'bad courier stars refused');
  r = await call('POST /api/orders/:id/rating', O, { id: String(oDel) }, { providerStars: 5 });
  ok(r.status === 404, "another customer cannot rate someone else's order");
  r = await call('POST /api/orders/:id/rating', C, { id: 'abc' }, { providerStars: 5 });
  ok(r.status === 400, 'bad id');

  r = await call('POST /api/orders/:id/rating', C, { id: String(oDel) }, { providerStars: 5, courierStars: 4, comment: '  الأكل وصل سخن  ' });
  ok(r.status === 201 && r.json.rating.providerStars === 5 && r.json.rating.courierStars === 4 && r.json.rating.comment === 'الأكل وصل سخن' && r.json.rating.canEdit === true, 'rating created: ' + JSON.stringify(r.json));
  let row = (await q('SELECT * FROM ratings WHERE order_id=$1', [oDel])).rows[0];
  ok(Number(row.provider_id) === Number(p) && Number(row.courier_user_id) === Number(cour), 'shop and courier recorded from the order');
  // edit inside 24h
  r = await call('POST /api/orders/:id/rating', C, { id: String(oDel) }, { providerStars: 4, courierStars: 5, comment: 'تمام' });
  ok(r.status === 200 && r.json.rating.providerStars === 4, 'edit allowed within 24h');
  ok((await q('SELECT COUNT(*)::int n FROM ratings WHERE order_id=$1', [oDel])).rows[0].n === 1, 'still one rating per order');
  // reading it back
  r = await call('GET /api/orders/:id/rating', C, { id: String(oDel) });
  ok(r.json.rating && r.json.rating.comment === 'تمام', 'customer reads his rating');
  r = await call('GET /api/orders/:id/rating', O, { id: String(oDel) });
  ok(r.json.rating === null, "another customer sees nothing");
  r = await call('GET /api/orders/:id/rating', C, { id: String(oWay) });
  ok(r.json.rating === null, 'null before rating');
  // no courier on the order: courier stars dropped
  r = await call('POST /api/orders/:id/rating', C, { id: String(oNoC) }, { providerStars: 3, courierStars: 5 });
  ok(r.status === 201 && r.json.rating.courierStars === null, 'courier stars ignored when no courier');
  // edit window closed
  await q("UPDATE ratings SET created_at = NOW() - INTERVAL '25 hours' WHERE order_id=$1", [oDel]);
  r = await call('POST /api/orders/:id/rating', C, { id: String(oDel) }, { providerStars: 1 });
  ok(r.status === 409, 'edit refused after 24h');

  // shop public ratings
  r = await call('GET /api/providers/:id/ratings', C, { id: String(p) });
  ok(r.json.count === 2 && r.json.avg === 3.5, 'average of 4 and 3 = 3.5: ' + JSON.stringify(r.json).slice(0, 160));
  ok(r.json.dist['4'] === 1 && r.json.dist['3'] === 1 && r.json.dist['5'] === 0, 'distribution');
  ok(r.json.comments.length === 1 && r.json.comments[0].who === 'محمد' && r.json.comments[0].comment === 'تمام', 'comment shows the first name only');
  // staff view + hide
  r = await call('GET /api/staff/ratings', A);
  ok(r.json.ratings.length === 2 && r.json.couriers[String(cour)] && r.json.couriers[String(cour)].count === 1 && r.json.couriers[String(cour)].avg === 5, 'staff sees ratings and the courier average: ' + JSON.stringify(r.json.couriers));
  const rid = r.json.ratings.find(x => x.comment === 'تمام').id;
  r = await call('PATCH /api/admin/ratings/:id', A, { id: rid }, { hidden: true });
  ok(r.status === 200 && r.json.hidden === true, 'owner hides a comment');
  r = await call('GET /api/providers/:id/ratings', C, { id: String(p) });
  ok(r.json.comments.length === 0 && r.json.count === 2, 'hidden comment disappears but the stars still count');
  r = await call('PATCH /api/admin/ratings/:id', A, { id: rid }, { hidden: 'yes' });
  ok(r.status === 400, 'hidden must be true/false');
  r = await call('PATCH /api/admin/ratings/:id', A, { id: '99999999' }, { hidden: true });
  ok(r.status === 404, 'unknown rating');

  // real average replaces the hand-set one only after MIN_REAL ratings
  let stats = await R.providerStats(pool);
  let pj = R.withStats({ id: String(p), rating: 4.9 }, stats);
  ok(pj.rating === 4.9 && pj.ratingCount === 2 && pj.ratingAvg === 3.5, 'under 5 ratings the hand-set number stays: ' + JSON.stringify(pj));
  for (let i = 0; i < 3; i++) { const o = await mk('delivered', null); await q('INSERT INTO ratings(order_id, customer_user_id, provider_id, provider_stars) VALUES($1,$2,$3,5)', [o, cust, p]); }
  stats = await R.providerStats(pool); pj = R.withStats({ id: String(p), rating: 4.9 }, stats);
  ok(pj.ratingCount === 5 && pj.rating === 4.4 && pj.ratingAvg === 4.4, 'from 5 ratings the real average (4.4 = (4+3+5+5+5)/5) replaces it: ' + JSON.stringify(pj));
  ok(R.withStats({ id: '123456', rating: 4 }, stats).rating === 4 && R.withStats({ id: '123456', rating: 4 }, stats).ratingCount === undefined, 'shop without ratings untouched');
  // not migrated yet: no crash
  const emp = await R.providerStats({ query: async () => { throw new Error('no table'); } });
  ok(emp instanceof Map && emp.size === 0, 'missing table = no ratings, no crash');
  console.log(`ratings: ${pass} passed, ${bad} failed`); await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
