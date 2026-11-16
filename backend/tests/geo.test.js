const G = require('../src/geo.js');
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);
const routes = {}; const app = {};
app.get = (path, ...chain) => { routes['GET ' + path] = chain; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
let calls = [], mode = 'ok';
const fakeFetch = async (url, opt) => {
  calls.push({ url, ua: opt.headers['User-Agent'] });
  if (mode === 'down') return { ok: false, status: 403, json: async () => ({}) };
  if (url.includes('/reverse')) return { ok: true, json: async () => ({ display_name: 'x، y', address: { road: 'شارع النصر', suburb: 'سموحة', city: 'الإسكندرية', secret: 'no' } }) };
  return { ok: true, json: async () => (url.includes('nothing') ? [] : [{ lat: '31.2', lon: '29.9' }]) };
};
G.register(app, { asyncRoute, fetchFn: fakeFetch, limiter: (q, r, n) => n() });
async function call(key, query) {
  const chain = routes[key]; const req = { query, ip: '1.2.3.4', headers: {}, app: { get: () => false } };
  const out = { status: 200, json: null }; const res = { status(c) { out.status = c; return this; }, json(j) { out.json = j; return this; }, set() { return this; }, setHeader() {}, getHeader() {} };
  let i = 0, err = null; const next = e => { if (e) { err = e; return; } const f = chain[i++]; if (f) return f(req, res, next); }; next();
  const t0 = Date.now(); while (!err && out.json === null && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 5));
  if (err) throw err; return out;
}
(async () => {
  eq((await call('GET /api/geo/reverse', { lat: 'abc', lng: '29' })).status, 400, 'bad coordinates');
  eq((await call('GET /api/geo/reverse', { lat: '95', lng: '29' })).status, 400, 'out of range');
  const r = await call('GET /api/geo/reverse', { lat: '31.2001', lng: '29.9187' });
  eq(r.status, 200, 'reverse ok'); eq(r.json.address.road, 'شارع النصر', 'road returned'); ok(!('secret' in r.json.address), 'only the address parts we use');
  ok(calls[0].ua.startsWith('OtlobAbis/'), 'server names the app to the map service');
  const n = calls.length; await call('GET /api/geo/reverse', { lat: '31.20011', lng: '29.91871' });
  eq(calls.length, n, 'same spot answered from memory');
  const s = await call('GET /api/geo/search', { q: 'سموحة', lat: '31.2', lng: '29.9' });
  eq([s.status, s.json.found, s.json.lat, s.json.lng], [200, true, 31.2, 29.9], 'search found');
  eq((await call('GET /api/geo/search', { q: 'nothing here' })).json, { found: false }, 'search not found');
  eq((await call('GET /api/geo/search', { q: 'a' })).status, 400, 'too short');
  mode = 'down';
  eq((await call('GET /api/geo/reverse', { lat: '30.1', lng: '31.3' })).status, 502, 'upstream refusing → 502, not a crash');
  console.log(`geo: ${pass} pass, ${failN} fail`); process.exit(failN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
