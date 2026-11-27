process.env.NO_SWEEP = '1';
const { Pool } = require('./shim');
const H = require('./h26');
const B = require('../src/billing.js');
const M = require('../src/managers.js');
const { ok, eq, done } = H.counters();
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  await q('TRUNCATE manual_invoices, invoice_stamps, invoice_design RESTART IDENTITY CASCADE');
  const { app, asyncRoute, positiveId, auth, roles, call } = H;
  B.register(app, { pool, auth, roles, asyncRoute, positiveId, hashPassword: async p => 'h:' + p });
  const mk = async (n, role) => Number((await q("INSERT INTO users(name, phone, password_hash, role, status) VALUES($1,$2,'x',$3,'active') RETURNING id", [n, H.phone(), role])).rows[0].id);
  const adm = await mk('owner', 'admin'), cust = await mk('أحمد عميل', 'customer'), cour = await mk('مندوب', 'courier');
  const A = { sub: String(adm), role: 'admin' }, C = { sub: String(cust), role: 'customer' };
  const post = (p, body, as = A) => call('POST ' + p, { as, body });
  const lines = [{ name: 'بيتزا', qty: 2, price: 100 }, { name: 'مشروب', qty: 1, price: 15.5 }];

  eq((await call('GET /api/admin/billing/config', { as: C })).status, 403, 'customers cannot');
  const cfg = (await call('GET /api/admin/billing/config', { as: A })).json;
  eq([cfg.design.theme, cfg.design.width, cfg.nextNumber], ['color', 'wa', 1001], 'defaults');

  // customer invoice: totals, optional stamps, extras
  let r = await post('/api/admin/billing/invoices', { kind: 'customer', partyName: 'أحمد', partyPhone: '01012345678', lines, delivery: 20, discount: 5.5, extras: [{ label: 'ملاحظة', value: 'بدون بصل' }], stamps: [] });
  eq(r.status, 201, 'created without a stamp');
  eq([r.json.invoice.total, r.json.invoice.number, r.json.invoice.stamps.length], [230, 1001, 0], 'total 215.5+20-5.5, no stamp');
  const id1 = r.json.invoice.id;
  eq((await post('/api/admin/billing/invoices', { kind: 'customer', partyName: 'أ', lines })).status, 400, 'name too short');
  eq((await post('/api/admin/billing/invoices', { kind: 'customer', partyName: 'أحمد', partyPhone: '123', lines })).status, 400, 'bad phone');
  eq((await post('/api/admin/billing/invoices', { kind: 'customer', partyName: 'أحمد', lines: [] })).status, 400, 'items needed');
  eq((await post('/api/admin/billing/invoices', { kind: 'customer', partyName: 'أحمد', lines, discount: 9999 })).status, 400, 'discount over total');
  eq((await post('/api/admin/billing/invoices', { kind: 'customer', partyName: 'أحمد', lines, number: 1001 })).status, 409, 'duplicate number');
  eq((await post('/api/admin/billing/invoices', { kind: 'customer', partyName: 'أحمد', lines, number: 5000 })).json.invoice.number, 5000, 'own number');

  // stamps: built-in + uploaded
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  eq((await post('/api/admin/billing/stamps', { name: 'x', image: 'nope' })).status, 400, 'bad image');
  const st = (await post('/api/admin/billing/stamps', { name: 'ختمي', image: png })).json.stamp;
  ok(st && st.id, 'stamp saved');
  eq((await post('/api/admin/billing/invoices', { kind: 'customer', partyName: 'أحمد', lines, stamps: [{ ref: 'u:' + st.id, x: 0.7, y: 0.8, size: 0.3 }, { ref: 'b:gold', x: 0.2, y: 0.8, size: 0.25 }] })).status, 201, 'two stamps');
  eq((await post('/api/admin/billing/invoices', { kind: 'customer', partyName: 'أحمد', lines, stamps: [{ ref: 'u:99999', x: 0.5, y: 0.5, size: 0.3 }] })).status, 400, 'unknown stamp');
  eq((await post('/api/admin/billing/invoices', { kind: 'customer', partyName: 'أحمد', lines, stamps: [{ ref: 'b:zzz', x: 0.5, y: 0.5, size: 0.3 }] })).status, 400, 'unknown builtin');
  eq((await post('/api/admin/billing/invoices', { kind: 'customer', partyName: 'أحمد', lines, stamps: [{ ref: 'b:gold', x: 2, y: 0.5, size: 0.3 }] })).status, 400, 'position out of page');

  // design
  eq((await call('PUT /api/admin/billing/design', { as: A, body: { theme: 'bw', width: '58', fixed: [{ label: 'ضريبي', value: '123' }], defaultStamps: ['b:circle'] } })).status, 200, 'design saved');
  const d2 = (await call('GET /api/admin/billing/config', { as: A })).json.design;
  eq([d2.theme, d2.width, d2.fixed.length, d2.showLogo], ['bw', '58', 1, true], 'design kept, rest default');
  eq((await call('PUT /api/admin/billing/design', { as: A, body: { theme: 'neon' } })).status, 400, 'bad theme');
  r = await post('/api/admin/billing/invoices', { kind: 'provider', partyName: 'مطعم', lines });
  eq([r.json.invoice.design.theme, r.json.invoice.delivery], ['bw', 0], 'invoice snapshots the look; delivery only for customers');
  await call('PUT /api/admin/billing/design', { as: A, body: { theme: 'color' } });
  eq((await call('GET /api/admin/billing/invoices/:id', { as: A, params: { id: r.json.invoice.id } })).json.invoice.design.theme, 'bw', 'old invoice keeps its look');

  // delete a stamp: invoice still returns it
  const wi = (await post('/api/admin/billing/invoices', { kind: 'customer', partyName: 'أحمد', lines, stamps: [{ ref: 'u:' + st.id, x: 0.5, y: 0.8, size: 0.3 }] })).json.invoice;
  eq((await call('DELETE /api/admin/billing/stamps/:id', { as: A, params: { id: st.id } })).status, 200, 'stamp deleted');
  eq((await call('GET /api/admin/billing/stamps', { as: A })).json.stamps.length, 0, 'gone from the library');
  eq((await call('GET /api/admin/billing/invoices/:id', { as: A, params: { id: wi.id } })).json.stamps.length, 1, 'old invoice still draws it');

  // commission: auto figures from the ledger, hand edit allowed
  const prov = Number((await q("INSERT INTO providers(owner_user_id,type,name,phone,status) VALUES($1,'restaurant','مطعم س','01099999999','active') RETURNING id", [await mk('صاحب', 'provider')])).rows[0].id);
  try {
    await q("INSERT INTO commission_entries(entry_type, kind, provider_id, base_amount, amount, status) VALUES('accrual','provider',$1,1000,100,'due'),('accrual','provider',$1,500,50,'settled')", [prov]);
    const pv = (await call('GET /api/admin/billing/commission-preview', { as: A, query: { kind: 'provider', id: String(prov), from: '2020-01-01', to: '2099-01-01' } })).json.figures;
    eq([pv.orders, pv.base, pv.commission, pv.settled, pv.due, pv.percent], [2, 1500, 150, 50, 100, 10], 'ledger figures');
    r = await post('/api/admin/billing/invoices', { kind: 'commission', partyKind: 'provider', partyName: 'مطعم س', partyProviderId: prov, commission: { mode: 'auto', from: '2020-01-01', to: '2099-01-01', orders: 2, base: 1500, commission: 140, settled: 50 } });
    eq([r.status, r.json.invoice.total, r.json.invoice.commission.computed.due], [201, 90, 100], 'edited figure used, computed kept for comparison');
  } catch (e) { console.log('commission schema differs:', e.message); throw e; }
  eq((await post('/api/admin/billing/invoices', { kind: 'commission', partyKind: 'customer', partyName: 'أحمد', commission: { from: '2020-01-01', to: '2020-02-01', commission: 5 } })).status, 400, 'no customer commission');
  eq((await post('/api/admin/billing/invoices', { kind: 'commission', partyKind: 'courier', partyName: 'مندوب', commission: { mode: 'manual', from: '2020-03-01', to: '2020-02-01', commission: 5 } })).status, 400, 'bad period');
  r = await post('/api/admin/billing/invoices', { kind: 'commission', partyKind: 'courier', partyName: 'مندوب', commission: { mode: 'manual', from: '2020-01-01', to: '2020-02-01', commission: 70 } });
  eq([r.status, r.json.invoice.total], [201, 70], 'manual commission');

  // parties, list, void
  eq((await call('GET /api/admin/billing/parties', { as: A, query: { kind: 'customer', q: 'أحمد' } })).json.parties.length, 1, 'customer picker');
  eq((await call('GET /api/admin/billing/parties', { as: A, query: { kind: 'provider', q: 'مطعم' } })).json.parties[0].providerId, prov, 'shop picker');
  eq((await call('GET /api/admin/billing/parties', { as: A, query: { kind: 'courier', q: 'مند' } })).json.parties[0].userId, cour, 'courier picker');
  ok((await call('GET /api/admin/billing/invoices', { as: A })).json.invoices.length >= 6, 'list');
  eq((await call('GET /api/admin/billing/invoices', { as: A, query: { q: '1001' } })).json.invoices.length, 1, 'search by number');
  eq((await call('POST /api/admin/billing/invoices/:id/void', { as: A, params: { id: id1 } })).status, 200, 'void');
  eq((await call('POST /api/admin/billing/invoices/:id/void', { as: A, params: { id: id1 } })).status, 404, 'void once');

  // manager permissions
  const g = (m, u, perms) => M.gate(pool, m, u, perms);
  eq(await g('POST', '/api/admin/billing/invoices', ['invoices']), null, 'manager with the permission makes invoices');
  eq(await g('GET', '/api/admin/billing/config', ['invoices']), null, 'and reads config');
  ok(await g('POST', '/api/admin/billing/invoices', ['orders']), 'without it: refused');
  ok(await g('PUT', '/api/admin/billing/design', ['invoices']), 'design is owner only');
  ok(await g('POST', '/api/admin/billing/stamps', ['invoices']), 'stamps are owner only');
  eq(await g('GET', '/api/admin/billing/stamps', ['invoices']), null, 'manager may read stamps');
  ok(M.PERMS.includes('invoices'), 'perm exists');
  process.exit(done('billing'));
})().catch(e => { console.error(e); process.exit(1); });
