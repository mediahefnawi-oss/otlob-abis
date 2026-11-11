// late-order alerts and the nightly report
const { Pool } = require('./shim');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m}: got ${a}, want ${b}`);
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const w = require('../src/watch');
  const sent = []; const notify = async (ids, payload) => { sent.push({ ids: ids.map(String), payload }); };
  await q("UPDATE app_settings SET features='{}'::jsonb WHERE id=1");
  await q('DELETE FROM report_log'); await q("UPDATE orders SET created_at = NOW() - INTERVAL '3 days'");
  const mk = async (n, role) => (await q("INSERT INTO users(name, phone, password_hash, role, status) VALUES($1,$2,'x',$3,'active') RETURNING id", [n, '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'), role])).rows[0].id;
  const adm = await mk('مالك', 'admin'), cust = await mk('عميل', 'customer'), own = await mk('صاحب', 'provider');
  const prov = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'restaurant','مطعم الاختبار','01000000000','active',TRUE) RETURNING id", [own])).rows[0].id;
  const order = async (status, minsAgo, hoursOld = 1) => (await q(`INSERT INTO orders(customer_user_id, provider_id, status, total, data, created_at, updated_at) VALUES($1,$2,$3,100,'{}', NOW() - ($4 || ' hours')::interval, NOW() - ($5 || ' minutes')::interval) RETURNING id`, [cust, prov, status, String(hoursOld), String(minsAgo)])).rows[0].id;
  await q("DELETE FROM late_alerts");

  console.log('A) late alerts');
  const late = await order('pending', 30), fresh = await order('pending', 2), oldDone = await order('delivered', 500), ancient = await order('pending', 3000, 30);
  eq(await w.lateSweep(pool, notify), 0, 'OFF: nothing is sent');
  await q("UPDATE app_settings SET features = features || '{\"lateAlert\": true}'::jsonb WHERE id=1");
  eq(await w.lateSweep(pool, notify), 1, 'ON: one late order alerted (not the fresh, the delivered or the ancient one)');
  const m = sent[0]; ok(m.ids.includes(String(adm)) && m.ids.includes(String(own)), 'the owner and the shop are told'); ok(!m.ids.includes(String(cust)), 'the customer is not');
  ok(/متأخر/.test(m.payload.title), 'title says late');
  eq(await w.lateSweep(pool, notify), 0, 'the same order is not alerted twice at the same stage');
  await q("UPDATE orders SET status='accepted', updated_at = NOW() - INTERVAL '60 minutes' WHERE id=$1", [late]);
  eq(await w.lateSweep(pool, notify), 1, 'the next stage can alert again');
  const way = await order('on_the_way', 70);
  sent.length = 0; eq(await w.lateSweep(pool, notify), 1, 'on the way too long');
  ok(sent[0].ids.includes(String(adm)) && !sent[0].ids.includes(String(own)), 'on-the-way alerts go to the owner only');

  console.log('B) daily report');
  eq(await w.dailyReport(pool, notify), false, 'OFF: no report');
  await q("UPDATE app_settings SET features = features || '{\"dailyReport\": true}'::jsonb WHERE id=1");
  const hour = (await q("SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE 'Africa/Cairo')::int AS h")).rows[0].h;
  eq(await w.dailyReport(pool, notify), hour >= 22, 'sent only from 22:00 Cairo time');
  await q('DELETE FROM report_log'); await q("UPDATE orders SET created_at = NOW() - INTERVAL '3 days'"); sent.length = 0;
  const done = await order('delivered', 5, 0);
  eq(await w.dailyReport(pool, notify, { force: true }), true, 'forced report goes out');
  ok(sent.length === 1 && sent[0].ids.includes(String(adm)) && /تقرير/.test(sent[0].payload.title), 'it reaches the owner');
  ok(/اتسلّم/.test(sent[0].payload.body) && /مطعم الاختبار/.test(sent[0].payload.body), 'with the numbers and the top shop: ' + sent[0].payload.body);
  eq(await w.dailyReport(pool, notify, { force: true }), false, 'only once a day');
  const s = await w.dayStats(pool); ok(s.delivered >= 1 && s.revenue >= 100, 'stats count the delivered order');

  console.log(bad ? `FAILED ${bad}` : 'ALL OK', 'pass=' + pass);
  await pool.end(); process.exit(bad ? 1 : 0);
})().catch(e => { console.error('CRASH', e); process.exit(2); });
