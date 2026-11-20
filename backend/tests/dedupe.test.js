// Double-order guard: same account + same request within the window answers with the first result, one creation only.
const { create } = require('../src/dedupe');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
function mk(token, url, body) {
  const req = { method: 'POST', headers: { authorization: token }, originalUrl: url, body };
  const out = { statusCode: 200, headers: {}, sent: null, closed: [] };
  const res = { statusCode: 200, set(k, v) { out.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(p) { out.sent = { status: this.statusCode, body: p }; return this; }, on(ev, fn) { if (ev === 'close') out.closed.push(fn); } };
  return { req, res, out };
}
(async () => {
  let t = 1000; const d = create({ ttlMs: 90000, now: () => t });
  let created = 0;
  const handler = (res, status = 201) => setTimeout(() => { created++; res.status(status).json({ id: created }); }, 20);
  const fire = (token, url, body) => new Promise(resolve => { const x = mk(token, url, body); d(x.req, x.res, () => handler(x.res)); setTimeout(() => resolve(x.out), 80); });

  // 1) a double tap (two at once): one creation, both get the same answer
  const [a, b] = await Promise.all([fire('Bearer A', '/api/orders/checkout', { items: [1, 2] }), fire('Bearer A', '/api/orders/checkout', { items: [1, 2] })]);
  ok(created === 1, 'double tap creates one order: ' + created);
  ok(a.sent && b.sent && a.sent.body.id === b.sent.body.id, 'both taps get the same order');
  ok(b.headers['X-Duplicate-Request'] === '1', 'the second one is marked as a duplicate');

  // 2) a retry after the app timed out (later, inside the window): same answer, no new order
  t += 30000;
  const c = await fire('Bearer A', '/api/orders/checkout', { items: [1, 2] });
  ok(created === 1 && c.sent.body.id === 1, 'retry within the window returns the first order');

  // 3) a different order / a different customer is untouched
  const d1 = await fire('Bearer A', '/api/orders/checkout', { items: [1, 2, 3] });
  const d2 = await fire('Bearer B', '/api/orders/checkout', { items: [1, 2] });
  ok(created === 3 && d1.sent.body.id === 2 && d2.sent.body.id === 3, 'different order or customer creates a new order');

  // 4) the same order after the window is a new order
  t += 100000;
  const e = await fire('Bearer A', '/api/orders/checkout', { items: [1, 2] });
  ok(created === 4 && e.sent.body.id === 4, 'after the window the same order is allowed again');

  // 5) a failed first attempt is never remembered: the retry runs
  const failFire = (token, body, status) => new Promise(resolve => { const x = mk(token, '/api/orders/market', body); d(x.req, x.res, () => handler(x.res, status)); setTimeout(() => resolve(x.out), 80); });
  const f1 = await failFire('Bearer C', { q: 1 }, 400); const before = created;
  const f2 = await failFire('Bearer C', { q: 1 }, 201);
  ok(f1.sent.status === 400 && f2.sent.status === 201 && created === before + 1, 'a retry after an error still creates the order');

  // 6) GET and unauthenticated requests are not touched
  const g = mk('Bearer A', '/api/orders/checkout', {}); g.req.method = 'GET'; let passed = false; d(g.req, g.res, () => { passed = true; });
  const h = mk('', '/api/orders/checkout', {}); let passed2 = false; d(h.req, h.res, () => { passed2 = true; });
  ok(passed && passed2, 'GET and requests without a token pass straight through');

  console.log(`dedupe: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
})();
