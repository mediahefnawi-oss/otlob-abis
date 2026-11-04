// the server glue: maintenanceState() decides per role from the stored row. Run: bun tests/hours_glue.test.js
const fs = require('fs'); const hours = require('../src/hours.js');
const src = fs.readFileSync(__dirname + '/../src/server.js', 'utf8');
const fnSrc = src.slice(src.indexOf('async function maintenanceState(role)'), src.indexOf('const asyncRoute = fn =>'));
let pass = 0, fail = 0; const eq = (a, b, m) => { if (JSON.stringify(a) === JSON.stringify(b)) pass++; else { fail++; console.log('FAIL', m, JSON.stringify(a), JSON.stringify(b)); } };
(async () => {
  let row, realNow = Date.now;
  const memo = { v: null, get() { return this.v; }, set(k, v) { this.v = v; return v; }, clear() { this.v = null; } };
  const pool = { query: async () => ({ rowCount: row ? 1 : 0, rows: row ? [row] : [] }) };
  const mk = new Function('pool', 'settingsMemo', 'hours', `${fnSrc}; return maintenanceState;`)(pool, memo, hours);
  const base = { app_enabled: true, maintenance_message: 'صيانة', hours_enabled: true, open_time: '10:00', close_time: '00:00', open_days: '0,1,2,3,4,5,6', grace_min: 30, closed_message: 'مغلق، نفتح {وقت_الفتح}' };
  const setNow = (y, mo, d, h, mi) => { Date.now = () => Date.UTC(y, mo - 1, d, h, mi) - 2 * 3600000; memo.clear(); };
  row = base;
  setNow(2026, 11, 4, 12, 0); eq((await mk('customer')).enabled, true, 'customer open');
  setNow(2026, 11, 5, 0, 10); eq(await mk('customer'), { enabled: false, message: 'مغلق، نفتح 10:00 صباحاً', phase: 'grace' }, 'customer in grace');
  eq((await mk('courier')).enabled, true, 'courier in grace'); eq((await mk()).enabled, false, 'anonymous in grace');
  setNow(2026, 11, 5, 3, 0); eq((await mk('provider')).enabled, false, 'provider closed'); eq((await mk('admin')).enabled, true, 'admin closed');
  row = { ...base, app_enabled: false }; memo.clear(); eq(await mk('customer'), { enabled: false, message: 'صيانة', phase: 'manual' }, 'manual stop shows maintenance text');
  row = { ...base, hours_enabled: false }; memo.clear(); eq((await mk('customer')).enabled, true, 'hours off'); 
  row = { app_enabled: true, maintenance_message: '' }; memo.clear(); eq((await mk('customer')).enabled, true, 'old row without the new columns');
  Date.now = realNow;
  console.log(`hours glue tests: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
