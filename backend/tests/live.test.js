// instant pokes: reach only the user's own open connections, survive closed ones, limit connections per user
const live = require('../src/live');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + m); } };
const handlers = {}; const app = { get: (p, ...h) => { handlers[p] = h[h.length - 1]; } };
live.register(app, { auth: (q, s, n) => n() });
const mk = () => { const r = { out: [], ended: false, hdr: null, status() { return this; }, set(h) { this.hdr = h; return this; }, flushHeaders() {}, write(x) { if (this.broken) throw new Error('closed'); this.out.push(x); }, end() { this.ended = true; } }; return r; };
const open = (uid) => { const res = mk(), listeners = {}; handlers['/api/live']({ auth: { sub: uid }, on: (e, f) => { listeners[e] = f; } }, res); return { res, close: () => listeners.close && listeners.close() }; };
const a1 = open('7'), b = open('8');
ok(a1.res.hdr['Content-Type'].startsWith('text/event-stream') && a1.res.hdr['Content-Encoding'] === 'identity', 'stream headers');
ok(live.emit([7], 'order-1') === 1, 'one poke to user 7');
ok(a1.res.out.some(x => x.includes('event: poke') && x.includes('order-1')), 'user 7 got the poke');
ok(!b.res.out.some(x => x.includes('poke')), 'user 8 did not');
ok(live.emit([99], 'x') === 0, 'nobody connected = 0');
a1.res.broken = true; ok(live.emit([7], 'x') === 0, 'a broken connection does not throw');
a1.close(); ok(live.count() === 1, 'closing frees the slot');
const many = [1, 2, 3, 4, 5].map(() => open('9')); ok(many[0].res.ended, 'the 5th connection of one user closes the oldest');
ok(live.emit([9], 't') === 4, 'only 4 stay');
console.log(`live: ${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
