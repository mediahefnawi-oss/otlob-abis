// a shop owner using the app as a customer: the token claim is honoured for providers only. Run: bun tests/switch.test.js
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../src/server.js', 'utf8');
const core = src.slice(src.indexOf('function tokenFor('), src.indexOf('const auth = (req, res, next)'));
const meSrc = src.slice(src.indexOf('const meJson ='), src.indexOf('app.get(\'/api/me\''));
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
(async () => {
  const jwt = { sign: (c) => 'T' + Buffer.from(JSON.stringify(c)).toString('base64'), verify: (t) => JSON.parse(Buffer.from(t.slice(1), 'base64').toString()) };
  let row; const pool = { query: async () => ({ rowCount: 1, rows: [row] }) };
  const authMemo = { get: () => null, set: (k, v) => v };
  const env = { JWT_SECRET: 'x'.repeat(40) };
  const mk = new Function('jwt', 'pool', 'authMemo', 'process', 'cleanUser', `${core}; ${meSrc}; return { tokenFor, authCore, meJson };`)(jwt, pool, authMemo, { env }, (r) => ({ id: String(r.id), role: r.role, name: r.name }));
  const run = async (token) => { const req = { headers: { authorization: 'Bearer ' + token } }; let status = 200; const res = { status(c) { status = c; return this; }, json() { return this; } }; await mk.authCore(req, res, () => {}, false); return { req, status }; };

  row = { id: 7, role: 'provider', status: 'active', name: 'صاحب محل' };
  let r = await run(mk.tokenFor(row));
  eq(r.req.auth.role, 'provider', 'normal token = provider'); eq(r.req.auth.baseRole, 'provider', 'base role kept');
  r = await run(mk.tokenFor(row, 'customer'));
  eq(r.req.auth.role, 'customer', 'switched token = customer'); eq(r.req.auth.baseRole, 'provider', 'base role is still provider');
  eq(mk.meJson(row, r.req.auth).role, 'customer', '/me shows customer'); eq(mk.meJson(row, r.req.auth).baseRole, 'provider', '/me tells the real role');
  eq(mk.meJson(row, (await run(mk.tokenFor(row))).req.auth).baseRole, undefined, 'no baseRole when not switched');

  row = { id: 9, role: 'courier', status: 'active', name: 'مندوب' };
  r = await run(mk.tokenFor(row, 'customer')); eq(r.req.auth.role, 'customer', 'a courier can switch to the customer view'); eq(r.req.auth.baseRole, 'courier', 'courier base role kept');
  eq(mk.meJson(row, r.req.auth).baseRole, 'courier', '/me tells the real role (courier)');
  for (const role of ['admin', 'supervisor', 'customer']) {            // the claim can never lift or change anyone else's role
    row = { id: 8, role, status: 'active', name: 'x' };
    const forged = jwt.sign({ sub: '8', role, as: 'customer' });
    r = await run(forged);
    eq(r.req.auth.role, role, `${role} with a forged as:customer keeps the real role`);
  }
  row = { id: 7, role: 'provider', status: 'active' };
  const t = jwt.sign({ sub: '7', role: 'admin', as: 'customer' });                 // an old/forged claim of role admin: the DB decides
  r = await run(t); eq(r.req.auth.role, 'customer', 'a provider can only ever become a customer, never admin');
  console.log(`switch tests: ${pass} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
