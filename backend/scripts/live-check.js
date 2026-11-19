'use strict';
/**
 * Read-only check of the instant-notification stream (nothing is created or changed):
 *   docker compose ... exec -T api node scripts/live-check.js
 *   docker compose ... exec -T -e LIVE_URL=https://api.otlob.com api node scripts/live-check.js     (through the public address / Caddy too)
 * Opens the stream (/api/live) with a 10-minute owner token, then prints: HTTP status, content type, whether it is compressed,
 * the time to the first bytes and the heartbeat. A compressed or buffered stream is what would delay the instant "new order" alert.
 */
const PORT = process.env.PORT || 4000;
const targets = [['السيرفر نفسه', process.env.SMOKE_BASE || `http://127.0.0.1:${PORT}`]];
if (process.env.LIVE_URL) targets.push(['العنوان العام (Caddy)', process.env.LIVE_URL.replace(/\/$/, '')]);

async function probe(label, base, token, waitMs) {
  const t0 = Date.now(); let bytes = 0, first = null, text = '';
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), waitMs);
  let res;
  try { res = await fetch(base + '/api/live', { headers: { Authorization: 'Bearer ' + token, Accept: 'text/event-stream' }, signal: ac.signal }); }
  catch (e) { console.log(`❌ ${label}: تعذر الاتصال (${e.message})`); return false; }
  const type = res.headers.get('content-type') || '', enc = res.headers.get('content-encoding') || '';
  let good = res.status === 200 && type.startsWith('text/event-stream') && (!enc || enc === 'identity');
  try {
    const rd = res.body.getReader(); const dec = new TextDecoder();
    for (;;) { const { value, done } = await rd.read(); if (done) break; if (first === null) first = Date.now() - t0; bytes += value.length; text += dec.decode(value); if (text.includes('retry:')) break; }
  } catch { /* aborted by the timer */ }
  clearTimeout(timer); ac.abort();
  if (first === null || !text.includes('retry:')) good = false;
  console.log(`${good ? '✅' : '❌'} ${label}: HTTP ${res.status} • ${type || '—'} • ضغط: ${enc || 'لا'} • أول بيانات بعد ${first === null ? 'لم تصل' : first + ' ms'}${good ? '' : '  ← المشكلة: البث متأخر أو مضغوط أو مش شغال'}`);
  return good;
}
(async () => {
  const jwt = require('jsonwebtoken'), { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'false' ? false : undefined, max: 1 });
  const r = await pool.query("SELECT id FROM users WHERE role='admin' AND status='active' AND deleted_at IS NULL ORDER BY id LIMIT 1");
  await pool.end();
  if (!r.rowCount) { console.log('❌ مفيش حساب مالك نشط'); process.exit(1); }
  const token = jwt.sign({ sub: String(r.rows[0].id), role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '10m', issuer: 'otlob-abis-api', audience: 'otlob-abis-app' });
  let allGood = true;
  for (const [label, base] of targets) allGood = (await probe(label, base, token, 6000)) && allGood;
  console.log(allGood ? '\n✅ البث اللحظي سليم' : '\n❌ في مشكلة في البث اللحظي');
  process.exit(allGood ? 0 : 1);
})().catch(e => { console.error('CRASH', e.message); process.exit(2); });
