// Tests the standby-read fallback block of server.js with a "main" database that is down and a healthy standby.
const fs = require('fs'); const { Pool: Good } = require('./shim');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const src = fs.readFileSync(__dirname + '/../src/server.js', 'utf8');
const block = src.slice(src.indexOf('// ---- standby database'), src.indexOf("app.disable('x-powered-by');"));
(async () => {
  let down = true, mainCalls = 0;
  const pool = { async query(t) { mainCalls++; if (down) { const e = new Error('connect ECONNREFUSED 127.0.0.1:1'); e.code = 'ECONNREFUSED'; throw e; } return { rows: [{ from: 'main' }] }; } };
  class StandbyPool extends Good { on() {} }
  const run = new Function('pool', 'Pool', 'process', block + '; return { standby, get down() { return Date.now() < mainDownUntil; } };');
  const env = { ...process.env, DATABASE_URL_BACKUP: 'postgres://x', NODE_ENV: 'test' };
  const st = run(pool, StandbyPool, { env });
  let r = await pool.query('SELECT 1 AS one');
  ok(r.rows[0].one === 1, 'read served by standby when main is down');
  const before = mainCalls;
  for (let i = 0; i < 5; i++) await pool.query('SELECT 2 AS two');
  ok(mainCalls === before, 'circuit breaker: main not hammered while down');
  let threw = false; try { await pool.query("UPDATE orders SET status='x' WHERE id=-1"); } catch (e) { threw = e.code === 'ECONNREFUSED'; }
  ok(threw, 'writes are NOT sent to the standby');
  threw = false; try { await pool.query("WITH x AS (INSERT INTO audit_log(action) VALUES('a') RETURNING 1) SELECT * FROM x"); } catch (e) { threw = e.code === 'ECONNREFUSED'; }
  ok(threw, 'data-changing WITH is not treated as a read');
  ok(st.down, 'state reports main as down');
  down = false;
  const sql = pool.query; // after the breaker window main is used again
  await new Promise(r => setTimeout(r, 15200));
  r = await pool.query('SELECT 3 AS three');
  ok(r.rows[0].from === 'main', 'main database is used again after it recovers');
  console.log(`failover tests: ${pass} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
