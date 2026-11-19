// small shared helpers for the 2026-11 batch tests
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
app.use = () => {};
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const auth = (req, res, next) => { if (!req.auth) return res.status(401).json({ error: 'auth' }); next(); };
const roles = (...a) => (req, res, next) => { if (!req.auth || !a.includes(req.auth.role)) return res.status(403).json({ error: 'forbidden' }); next(); };
async function call(key, { as, params, body, query, table } = {}) {
  const chain = (table || routes)[key]; if (!chain) throw new Error('no route ' + key);
  const req = { auth: as, params: params || {}, body: body || {}, query: query || {} };
  const out = { status: 200, json: null, headers: {} };
  const res = { status(c) { out.status = c; return this; }, json(j) { out.json = j; return this; }, set(k, v) { out.headers[k] = v; return this; }, send(b) { out.sent = b; return this; }, end() { out.ended = true; return this; } };
  let i = 0, err = null; const next = e => { if (e) { err = e; return; } const f = chain[i++]; if (f) return f(req, res, next); }; next();
  const t0 = Date.now(); while (!err && out.json === null && out.sent === undefined && !out.ended && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 2));
  if (err) throw err; return out;
}
function counters() {
  let pass = 0, bad = 0;
  const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
  const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
  return { ok, eq, done: name => { console.log(`${name}: ${pass} pass, ${bad} fail`); return bad; } };
}
const phone = () => '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
module.exports = { routes, app, asyncRoute, positiveId, auth, roles, call, counters, phone };
