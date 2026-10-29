'use strict';
// Dependency-free preflight checks. These are static checks, not a live DB integration test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const server = path.join(root, 'src', 'server.js');
const ordersFile = path.join(root, 'src', 'orders.js');
const source = fs.readFileSync(server, 'utf8') + '\n' + fs.readFileSync(ordersFile, 'utf8');
const schema = fs.readFileSync(path.join(root, 'sql', 'schema.sql'), 'utf8');
const clientApi = fs.readFileSync(path.resolve(root, '..', 'lib', 'api.ts'), 'utf8');

for (const file of [server, ordersFile]) {
  const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, `Syntax check failed for ${file}:\n${syntax.stderr}`);
}
for (const table of ['users', 'providers', 'products', 'orders', 'messages', 'appointments', 'invoices', 'app_settings']) {
  assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `Missing SQL table: ${table}`);
}
for (const route of ['/api/health', '/api/auth/register', '/api/auth/login', '/api/me', '/api/providers', '/api/products', '/api/orders/checkout', '/api/orders/custom', '/api/orders/:id/action', '/api/orders/:id/messages', '/api/sync', '/api/appointments/book', '/api/appointments/:id/action', '/api/settings', '/api/admin/settings', '/api/admin/users/:id/status', '/api/me/password', '/api/admin/users', '/api/admin/users/:id/password', '/api/admin/providers', '/api/providers/:id', '/api/admin/providers/:id', '/api/regions', '/api/admin/regions', '/api/admin/regions/:id', '/api/admin/ads', '/api/admin/ads/:id', '/api/ads/:id/image', '/api/push/key', '/api/push/subscribe', '/api/push/unsubscribe']) {
  assert.ok(source.includes(`'${route}'`) || source.includes(`"${route}"`), `Missing expected API route: ${route}`);
}
assert.match(source, /jwt\.verify\(/, 'JWT verification must remain enabled');
assert.match(source, /SELECT id, role, status FROM users WHERE id=\$1/, 'Protected requests must re-check current account status/role');
assert.match(source, /roles\('admin'\)/, 'Admin-only route guards must remain enabled');
assert.match(source, /positiveId\s*=\s*value\s*=>/, 'Positive integer ID validation must remain enabled');
assert.match(source, /requireOpen\(\)/, 'Maintenance mode must block order/appointment creation');
for (const wrapper of ['apiHealth', 'apiSync', 'apiCheckout', 'apiCustomOrder', 'apiOrderAction', 'apiSendMessage', 'apiBookAppointment', 'apiApptAction', 'apiListProviders', 'apiListProducts', 'apiCreateProduct', 'apiUpdateProduct', 'apiDeleteProduct', 'apiListPendingProviders', 'apiDecideProvider', 'apiGetSettings', 'apiUpdateSettings', 'apiSetUserStatus', 'apiMe', 'apiUpdateProfile', 'apiChangePassword', 'apiListUsers', 'apiAdminResetPassword', 'apiAdminCreateProvider', 'apiUpdateProvider', 'apiAdminDeleteProvider', 'apiListRegions', 'apiAdminCreateRegion', 'apiAdminUpdateRegion', 'apiAdminDeleteRegion']) {
  assert.match(clientApi, new RegExp(`export async function ${wrapper}\\b`), `Missing client API wrapper: ${wrapper}`);
}
assert.match(source, /authAny/, '/api/me must answer for pending accounts');
assert.match(source, /maintenanceState\(\)/, 'Register/login must honor maintenance mode');
const store = fs.readFileSync(path.resolve(root, '..', 'lib', 'store.ts'), 'utf8');
for (const call of ['apiListProviders', 'apiListProducts', 'apiCreateProduct(', 'apiUpdateProduct(', 'apiDeleteProduct(', 'apiUpdateProvider(', 'apiLogin(', 'apiRegister(', 'apiGetSettings(', 'apiUpdateSettings(', 'apiMe(']) {
  assert.ok(store.includes(call), `lib/store.ts must call ${call}`);
}

// PostgreSQL rejects a query whose number of parameters differs from its $n placeholders (that once made every
// courier sync fail with a 500). Check every query written as a plain string with an inline parameter list.
function topLevelCount(text) {
  // number of non-empty items separated by top-level commas (a trailing comma adds no item)
  let depth = 0; let items = 0; let hasContent = false; let quote = null;
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; hasContent = true; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { if (hasContent) items++; hasContent = false; continue; }
    if (!/\s/.test(ch)) hasContent = true;
  }
  return hasContent ? items + 1 : items;
}
let checkedQueries = 0;
for (const text of [fs.readFileSync(server, 'utf8'), fs.readFileSync(ordersFile, 'utf8')]) {
  const re = /\.query\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*\[/g;
  let m;
  while ((m = re.exec(text))) {
    let i = re.lastIndex; let depth = 1; let quote = null;
    while (depth && i < text.length) {
      const ch = text[i];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '[') depth++;
      else if (ch === ']') depth--;
      i++;
    }
    const given = topLevelCount(text.slice(re.lastIndex, i - 1));
    const used = Math.max(0, ...[...m[2].matchAll(/\$(\d+)/g)].map(x => Number(x[1])));
    assert.equal(given, used, `Query has ${given} parameters but uses $1..$${used}: ${m[2].slice(0, 80)}`);
    checkedQueries++;
  }
}
assert.ok(checkedQueries > 30, 'Parameter check did not find the queries');

console.log('Static backend release checks passed.');
console.log('Note: this does not verify a live PostgreSQL connection, deployed API, or app-to-API integration.');
