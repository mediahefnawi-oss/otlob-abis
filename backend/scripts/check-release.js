'use strict';
// Dependency-free preflight checks. These are static checks, not a live DB integration test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const server = path.join(root, 'src', 'server.js');
const source = fs.readFileSync(server, 'utf8');
const schema = fs.readFileSync(path.join(root, 'sql', 'schema.sql'), 'utf8');
const clientApi = fs.readFileSync(path.resolve(root, '..', 'lib', 'api.ts'), 'utf8');

const syntax = spawnSync(process.execPath, ['--check', server], { encoding: 'utf8' });
assert.equal(syntax.status, 0, `Server syntax check failed:\n${syntax.stderr}`);
for (const table of ['users', 'providers', 'products', 'orders', 'messages', 'appointments', 'invoices', 'app_settings']) {
  assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`), `Missing SQL table: ${table}`);
}
for (const route of ['/api/health', '/api/auth/register', '/api/auth/login', '/api/me', '/api/providers', '/api/products', '/api/orders', '/api/settings', '/api/admin/settings', '/api/appointments', '/api/invoices', '/api/admin/users/:id/status', '/api/me/password', '/api/admin/users', '/api/admin/users/:id/password', '/api/admin/providers', '/api/providers/:id', '/api/admin/providers/:id']) {
  assert.ok(source.includes(`'${route}'`) || source.includes(`"${route}"`), `Missing expected API route: ${route}`);
}
assert.match(source, /jwt\.verify\(/, 'JWT verification must remain enabled');
assert.match(source, /SELECT id, role, status FROM users WHERE id=\$1/, 'Protected requests must re-check current account status/role');
assert.match(source, /roles\('admin'\)/, 'Admin-only route guards must remain enabled');
assert.match(source, /positiveId\s*=\s*value\s*=>/, 'Positive integer ID validation must remain enabled');
assert.match(source, /appState\.rows\[0\]\.app_enabled/, 'Maintenance mode must block order/appointment creation');
for (const wrapper of ['apiHealth', 'apiListProviders', 'apiListProducts', 'apiCreateProduct', 'apiUpdateProduct', 'apiDeleteProduct', 'apiListOrders', 'apiCreateOrder', 'apiUpdateOrderStatus', 'apiListOrderMessages', 'apiSendOrderMessage', 'apiListPendingProviders', 'apiDecideProvider', 'apiListAppointments', 'apiCreateAppointment', 'apiListInvoices', 'apiCreateInvoice', 'apiGetSettings', 'apiUpdateSettings', 'apiSetUserStatus', 'apiMe', 'apiUpdateProfile', 'apiChangePassword', 'apiListUsers', 'apiAdminResetPassword', 'apiAdminCreateProvider', 'apiUpdateProvider', 'apiAdminDeleteProvider']) {
  assert.match(clientApi, new RegExp(`export async function ${wrapper}\\b`), `Missing client API wrapper: ${wrapper}`);
}
assert.match(source, /authAny/, '/api/me must answer for pending accounts');
assert.match(source, /maintenanceState\(\)/, 'Register/login must honor maintenance mode');
const store = fs.readFileSync(path.resolve(root, '..', 'lib', 'store.ts'), 'utf8');
for (const call of ['apiListProviders', 'apiListProducts', 'apiCreateProduct(', 'apiUpdateProduct(', 'apiDeleteProduct(', 'apiUpdateProvider(', 'apiLogin(', 'apiRegister(', 'apiGetSettings(', 'apiUpdateSettings(', 'apiMe(']) {
  assert.ok(store.includes(call), `lib/store.ts must call ${call}`);
}
console.log('Static backend release checks passed.');
console.log('Note: this does not verify a live PostgreSQL connection, deployed API, or app-to-API integration.');
