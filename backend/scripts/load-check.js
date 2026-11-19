'use strict';
/**
 * Read-only speed / load check (creates nothing, changes nothing, needs no account): it only reads the public screens
 * (health, settings, catalog, regions) with many phones at once and prints the response times.
 *   docker compose --env-file .env -f deploy/docker-compose.vps.yml exec -T api node scripts/load-check.js
 *   ... exec -T -e LIVE_URL=https://api.otlobabis.com -e USERS=100 -e SECONDS=20 api node scripts/load-check.js
 * USERS = phones at the same time (default 50, max 300), SECONDS = how long (default 15, max 60). Each phone asks every ~4 seconds, like the real app.
 */
const PORT = process.env.PORT || 4000;
const BASE = (process.env.LIVE_URL || process.env.SMOKE_BASE || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const USERS = Math.min(300, Math.max(1, Number(process.env.USERS) || 50));
const SECONDS = Math.min(60, Math.max(3, Number(process.env.SECONDS) || 15));
const PATHS = ['/api/health', '/api/settings', '/api/catalog', '/api/regions'];
const times = Object.fromEntries(PATHS.map(p => [p, []]));
let errors = 0, slow = 0; const codes = {};

async function phone(i, until) {
  await new Promise(r => setTimeout(r, Math.random() * 3000));   // phones do not start in the same millisecond
  while (Date.now() < until) {
    const path = PATHS[Math.floor(Math.random() * PATHS.length)];
    const t0 = Date.now();
    try {
      const res = await fetch(BASE + path, { signal: AbortSignal.timeout(15000) });
      await res.arrayBuffer();
      const ms = Date.now() - t0; times[path].push(ms); if (ms > 2000) slow++;
      codes[res.status] = (codes[res.status] || 0) + 1; if (res.status >= 500) errors++;
    } catch { errors++; codes.fail = (codes.fail || 0) + 1; }
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
  }
}
const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;

(async () => {
  console.log(`⏱  ${USERS} موبايل في نفس الوقت لمدة ${SECONDS} ثانية على ${BASE}`);
  const until = Date.now() + SECONDS * 1000;
  await Promise.all(Array.from({ length: USERS }, (_, i) => phone(i, until)));
  let total = 0;
  for (const p of PATHS) {
    const a = times[p]; total += a.length;
    console.log(`${p.padEnd(14)} طلبات ${String(a.length).padStart(4)} | متوسط ${String(Math.round(a.reduce((s, x) => s + x, 0) / (a.length || 1))).padStart(5)}ms | 95% ${String(pct(a, 0.95)).padStart(5)}ms | أبطأ ${String(Math.max(0, ...a)).padStart(5)}ms`);
  }
  console.log(`إجمالي ${total} طلب | أخطاء ${errors} | أبطأ من ثانيتين ${slow} | الأكواد ${JSON.stringify(codes)}`);
  const all = [].concat(...PATHS.map(p => times[p]));
  const p95 = pct(all, 0.95);
  console.log(errors === 0 && p95 < 1500 ? `✅ ممتاز: السيرفر شايل ${USERS} موبايل (95% من الطلبات أسرع من ${p95}ms)` : `⚠️ انتبه: ${errors} أخطاء، و95% من الطلبات أبطأ من ${p95}ms — ابعتلي النتيجة`);
  process.exit(errors === 0 ? 0 : 1);
})();
