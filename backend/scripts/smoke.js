'use strict';
/**
 * Read-only health + speed check of the running API (nothing is created or changed).
 *   docker compose ... exec -T api node scripts/smoke.js
 * Logs in as the owner (OWNER_USERNAME / OWNER_PASSWORD from the server's own settings), calls the main routes of every role
 * area and prints OK / FAIL with the time of each, then a short load test of the busiest route.
 */
const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:' + (process.env.PORT || 4000);
const t0 = () => process.hrtime.bigint();
const ms = s => Number(process.hrtime.bigint() - s) / 1e6;
let token = '', fails = 0, slow = 0;
const SLOW = 800;
async function call(method, path, body) {
  const s = t0();
  try {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, j, ms: ms(s), bytes: text.length };
  } catch (e) { return { status: 0, j: null, ms: ms(s), bytes: 0, err: e.message }; }
}
async function check(label, method, path, ok = x => true, body) {
  const r = await call(method, path, body);
  const good = r.status >= 200 && r.status < 300 && (() => { try { return ok(r.j); } catch { return false; } })();
  if (!good) fails++;
  if (good && r.ms > SLOW) slow++;
  console.log(`${good ? (r.ms > SLOW ? '🐢' : '✅') : '❌'} ${label.padEnd(34)} ${String(Math.round(r.ms)).padStart(5)} ms ${(r.bytes / 1024).toFixed(1).padStart(7)} KB${good ? '' : `  ← HTTP ${r.status} ${r.err || (r.j && r.j.error) || ''}`}`);
  return r;
}
(async () => {
  console.log(`فحص السيرفر: ${BASE}\n`);
  await check('health', 'GET', '/api/health', j => j.ok === true);
  await check('settings (public)', 'GET', '/api/settings', j => j && typeof j === 'object');
  await check('catalog (محلات ومنتجات)', 'GET', '/api/catalog', j => Array.isArray(j.providers) && Array.isArray(j.products));
  const cat = await call('GET', '/api/catalog');
  if (cat.j) {
    const bl = (cat.j.providers || []).find(p => /بلبن/.test(p.name));
    console.log(`   محلات: ${(cat.j.providers || []).length} • منتجات: ${(cat.j.products || []).length}${bl ? ` • بلبن: ${(cat.j.products || []).filter(p => p.providerId === bl.id).length} منتج` : ''}`);
  }
  const u = process.env.OWNER_USERNAME, p = process.env.OWNER_PASSWORD;
  if (!u || !p) { console.log('⚠️ مفيش OWNER_USERNAME/OWNER_PASSWORD في بيئة السيرفر، هكتفي بالفحص العام'); }
  else {
    const l = await check('login المالك', 'POST', '/api/auth/login', j => !!j.token, { username: u, password: p });
    token = (l.j && l.j.token) || '';
  }
  if (token) {
    await check('sync (كل بيانات التطبيق)', 'GET', '/api/sync', j => j && typeof j === 'object');
    await check('المناديب', 'GET', '/api/staff/couriers', j => Array.isArray(j.couriers));
    await check('أنواع المركبات', 'GET', '/api/admin/ride-types', j => Array.isArray(j.types));
    await check('الرحلات (أدمن)', 'GET', '/api/admin/trips', j => Array.isArray(j.trips));
    await check('فتح/قفل الطلبات', 'GET', '/api/admin/gates', j => Array.isArray(j.gates) && j.gates.length > 0);
    await check('شكل الرئيسية', 'GET', '/api/admin/home-layout', j => j && typeof j.layout === 'object');
    await check('منتجات ماركت', 'GET', '/api/admin/market-products', j => Array.isArray(j.products));
    await check('كباتن التوصيلة', 'GET', '/api/admin/captains', () => true);
    await check('سجل التغييرات', 'GET', '/api/admin/log', () => true);
    await check('gates (للعملاء)', 'GET', '/api/gates', j => j && typeof j.closed === 'object');
  }
  // speed under load: 25 at once x 6 rounds on the public catalog (and sync when logged in)
  for (const [label, path] of [['catalog', '/api/catalog'], ...(token ? [['sync', '/api/sync']] : [])]) {
    const times = [];
    for (let round = 0; round < 6; round++) {
      const rs = await Promise.all(Array.from({ length: 25 }, () => call('GET', path)));
      for (const r of rs) { times.push(r.ms); if (r.status !== 200) fails++; }
    }
    times.sort((a, b) => a - b);
    const q = f => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * f))]);
    console.log(`\n⚡ ضغط ${label}: 150 طلب (25 مع بعض) — متوسط ${q(0.5)} ms • 95% أسرع من ${q(0.95)} ms • أبطأ ${q(1)} ms`);
    if (q(0.95) > 1500) slow++;
  }
  console.log(`\n${fails ? `❌ فيه ${fails} مشكلة — ابعتلي الصفحة دي كلها` : '✅ كل الفحوصات نجحت'}${slow ? ` (و${slow} حاجة بطيئة 🐢)` : ''}`);
  process.exit(fails ? 1 : 0);
})();
