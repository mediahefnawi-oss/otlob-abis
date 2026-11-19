process.env.NO_SWEEP = '1';
const { Pool } = require('./shim');
const H = require('./h26');
const CE = require('../src/clienterrors.js');
const { ok, eq, done } = H.counters();
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  await q('DELETE FROM client_errors');
  const { app, asyncRoute, auth, roles, call } = H;
  CE.register(app, { pool, auth, roles, asyncRoute });
  const adm = Number((await q("INSERT INTO users(name, phone, password_hash, role, status) VALUES('own','0100'||floor(random()*1e7)::int,'x','admin','active') RETURNING id")).rows[0].id);
  const A = { sub: String(adm), role: 'admin' }, C = { sub: '999', role: 'customer' };

  eq(CE.cleanReport(null), null, 'null report ignored');
  eq(CE.cleanReport({ message: '  ' }), null, 'empty message ignored');
  const a = CE.cleanReport({ message: 'order 15 failed', where: 'sync' }), b = CE.cleanReport({ message: 'order 16 failed', where: 'sync' });
  eq(a.fp, b.fp, 'numbers do not split one error into many');
  ok(CE.cleanReport({ message: 'x'.repeat(5000), stack: 'y'.repeat(9000) }).message.length === 400, 'message is cut');

  const r1 = await call('POST /api/client-errors', { body: { message: 'boom 1', where: 'sync', platform: 'android', version: '1.0.5' } });
  eq(r1.status, 204, 'report answers 204');
  await call('POST /api/client-errors', { body: { message: 'boom 2', where: 'sync' } });
  await call('POST /api/client-errors', { body: { garbage: true } });
  await new Promise(r => setTimeout(r, 200));
  const rows = (await q('SELECT * FROM client_errors')).rows;
  eq(rows.length, 1, 'same error grouped to one row');
  eq(Number(rows[0].cnt), 2, 'counter counts repeats');

  eq((await call('GET /api/admin/client-errors', { as: C })).status, 403, 'customer cannot read reports');
  const g = await call('GET /api/admin/client-errors', { as: A });
  eq(g.status, 200, 'admin reads'); eq(g.json.errors.length, 1, 'one grouped error'); eq(g.json.errors[0].count, 2, 'count returned');
  eq((await call('DELETE /api/admin/client-errors', { as: A })).status, 200, 'admin clears');
  eq((await q('SELECT 1 FROM client_errors')).rowCount, 0, 'table empty after clear');
  done();
})().catch(e => { console.error(e); process.exit(1); });
