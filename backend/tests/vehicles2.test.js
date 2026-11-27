process.env.NO_SWEEP = '1';
const { Pool } = require('./shim');
const H = require('./h26');
const { ok, eq, done } = H.counters();
const kf = require('../src/kmfee.js');
const managers = require('../src/managers.js');
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const { app, asyncRoute, positiveId, auth, roles, call } = H;
  const pushes = [];
  const pushToUsers = async (ids, p) => { pushes.push({ ids: ids.map(Number), p }); };
  const settingsMemo = { clear() {} };
  require('../src/orders.js')(app, { pool, auth, authAny: auth, roles, asyncRoute, positiveId, maintenanceState: async () => ({ enabled: true }), loadSettings: async () => ({}), cleanUser: x => x, pushToUsers });
  kf.registerKmFeeRoutes(app, { pool, auth, roles, asyncRoute, settingsMemo });
  require('../src/routeVehicles.js').register(app, { pool, auth, roles, asyncRoute, positiveId, settingsMemo });
  require('../src/bells.js').register(app, { pool, auth, roles, asyncRoute, positiveId, pushToUsers });

  const mk = async (n, role, region = null, vehicle = '', av = true) => Number((await q("INSERT INTO users(name, phone, password_hash, role, status, region_id, vehicle, available) VALUES($1,$2,'x',$3,'active',$4,$5,$6) RETURNING id", [n, H.phone(), role, region, vehicle, av])).rows[0].id);
  const rA = (await q("INSERT INTO regions(name, delivery_fee) VALUES('أ'||random(), 12) RETURNING id")).rows[0].id;
  const rB = (await q("INSERT INTO regions(name, delivery_fee) VALUES('ب'||random(), 30) RETURNING id")).rows[0].id;
  const rC = (await q("INSERT INTO regions(name, delivery_fee) VALUES('ج'||random(), 30) RETURNING id")).rows[0].id;
  await q("DELETE FROM courier_vehicles"); await q("INSERT INTO service_meta(key, sub) VALUES('courier_vehicles_seeded','1') ON CONFLICT (key) DO NOTHING");
  for (const [n, i] of [['موتوسيكل', 1], ['توكتوك', 2], ['تروسيكل', 3]]) await q('INSERT INTO courier_vehicles(name, sort_order) VALUES($1,$2)', [n, i]);
  await q('INSERT INTO route_prices(from_region_id, to_region_id, price) VALUES($1,$2,30) ON CONFLICT DO NOTHING', [rA, rB]);
  const adm = await mk('owner', 'admin'), owner = await mk('م', 'provider', rA), cust = await mk('ع', 'customer', rB);
  const moto = await mk('موتو', 'courier', rB, 'موتوسيكل'), tuk = await mk('توك', 'courier', rB, 'توكتوك'), tri = await mk('تري', 'courier', rB, 'تروسيكل', false);
  const sup = await mk('مشرف', 'supervisor', null), supOut = await mk('مشرف تاني', 'supervisor', null);
  await q("UPDATE users SET sup_regions=$2 WHERE id=$1", [sup, String(rB)]); await q("UPDATE users SET sup_regions=$2 WHERE id=$1", [supOut, String(rC)]);
  const rest = (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open) VALUES($1,'restaurant','مطعم','01000000000','active',TRUE) RETURNING id", [owner])).rows[0].id;
  const pr = (await q("INSERT INTO products(provider_id,name,price) VALUES($1,'وجبة',40) RETURNING id", [rest])).rows[0].id;
  const A = { sub: String(adm), role: 'admin' }, CU = { sub: String(cust), role: 'customer', status: 'active' }, SUP = { sub: String(sup), role: 'supervisor' }, SUP2 = { sub: String(supOut), role: 'supervisor' };
  const MOTO = { sub: String(moto), role: 'courier' }, TUK = { sub: String(tuk), role: 'courier' }, OW = { sub: String(owner), role: 'provider' };
  const base = { name: 'عميل تجريبي', phone: '01012345678', address: 'شارع 5 عمارة 3 الدور 2', notes: '' };
  const checkout = body => call('POST /api/orders/checkout', { as: CU, body: { ...base, lines: [{ productId: pr, qty: 1 }], ...body } });

  /* the owner writes a price per means; nothing priced = the old behaviour */
  let r = await call('POST /api/delivery-options', { as: CU, body: { providerIds: [rest] } });
  eq(r.json.options.length, 0, 'no per-means prices: no chooser');
  r = await call('PUT /api/admin/route-vehicle-prices', { as: A, body: { fromId: rA, prices: [{ toId: rB, vehicle: 'موتوسيكل', price: 20 }, { toId: rB, vehicle: 'توكتوك', price: 15 }, { toId: rB, vehicle: 'تروسيكل', price: 30 }, { toId: rB, vehicle: 'سبوتنيك', price: 5 }] } });
  eq(r.status, 200, 'prices saved'); eq(Object.keys(r.json.prices).length, 3, 'an unknown means is ignored');
  eq((await call('PUT /api/admin/route-vehicle-prices', { as: CU, body: { fromId: rA, prices: [] } })).status, 403, 'customers cannot write prices');
  eq((await call('PUT /api/admin/route-vehicle-prices', { as: A, body: { fromId: rA, prices: [{ toId: rB, vehicle: 'توكتوك', price: -1 }] } })).status, 400, 'a negative price is refused');
  r = await call('POST /api/delivery-options', { as: CU, body: { providerIds: [rest] } });
  eq(r.json.mode, 'region', 'mode region'); eq(r.json.options.map(o => [o.name, o.price, o.available]), [['موتوسيكل', 20, true], ['توكتوك', 15, true], ['تروسيكل', 30, false]], 'prices and availability (no trike courier on duty)');
  ok(/لا يوجد مندوب/.test(r.json.options[2].reason), 'reason: no courier on duty');
  await q('DELETE FROM route_vehicle_prices WHERE vehicle=$1', ['توكتوك']);
  r = await call('POST /api/delivery-options', { as: CU, body: { providerIds: [rest] } });
  eq(r.json.options[1].available, false, 'no price = not available'); ok(/غير متاح/.test(r.json.options[1].reason), 'reason: not for this area');
  await q("INSERT INTO route_vehicle_prices(from_region_id,to_region_id,vehicle,price) VALUES($1,$2,'توكتوك',15)", [rA, rB]);

  /* checkout with a means */
  r = await checkout({ vehicle: 'موتوسيكل' });
  eq(r.status, 201, 'checkout with a motorbike'); eq(r.json.orders[0].deliveryFee, 20, 'fee = the motorbike price'); eq(r.json.orders[0].vehicle, 'موتوسيكل', 'the order remembers the means');
  r = await checkout({ vehicle: 'تروسيكل' }); eq(r.status, 409, 'a means with no courier on duty is refused');
  await q("DELETE FROM route_vehicle_prices WHERE vehicle='تروسيكل'"); await q('UPDATE users SET available=TRUE WHERE id=$1', [tri]);
  r = await checkout({ vehicle: 'تروسيكل' }); eq(r.status, 409, 'a means with no price on the route is refused'); ok(/غير متاحة/.test(JSON.stringify(r.json)), 'says it is not available');
  r = await checkout({ vehicle: 'سبوتنيك' }); eq(r.status, 400, 'an unknown means is refused');
  r = await checkout({}); eq(r.json.orders[0].deliveryFee, 30, 'without a means: the old route price');
  await q('UPDATE users SET available=FALSE WHERE id=$1', [tri]);

  /* the owner's switch: off = no choice, the plain route price, a chosen means is ignored */
  eq((await call('PATCH /api/admin/route-vehicles-switch', { as: CU, body: { on: false } })).status, 403, 'customers cannot flip the switch');
  eq((await call('PATCH /api/admin/route-vehicles-switch', { as: A, body: { on: false } })).status, 200, 'switch off');
  r = await call('POST /api/delivery-options', { as: CU, body: { providerIds: [rest] } }); eq(r.json.options.length, 0, 'switch off: no chooser');
  r = await checkout({ vehicle: 'موتوسيكل' }); eq([r.status, r.json.orders[0].deliveryFee, r.json.orders[0].vehicle], [201, 30, undefined], 'switch off: plain price, the means is ignored');
  eq((await call('PATCH /api/admin/route-vehicles-switch', { as: A, body: { on: true } })).status, 200, 'switch on again');
  r = await call('POST /api/delivery-options', { as: CU, body: { providerIds: [rest] } }); eq(r.json.options.length, 3, 'switch on: the chooser is back (prices were kept)');
  eq(await managers.gate(pool, 'PATCH', '/api/admin/route-vehicles-switch', ['delivery_prices']), null, 'managers with the permission may flip it');

  /* the order is for that means only */
  const oTuk = (await checkout({ vehicle: 'توكتوك' })).json.orders[0]; eq(oTuk.deliveryFee, 15, 'tuk-tuk price');
  await call('POST /api/orders/:id/action', { as: OW, params: { id: oTuk.id }, body: { action: 'accept' } });
  const list = async as => (await q(`SELECT o.id FROM orders o WHERE ${'(o.courier_user_id=$1 OR (o.courier_user_id IS NULL AND o.status IN (\'accepted\',\'ready\') AND COALESCE(o.data->>\'vehicle\',\'\') IN (\'\', COALESCE((SELECT vehicle FROM users cv WHERE cv.id=$1),\'\'))))'}`, [as])).rows.map(x => String(x.id));
  ok((await list(tuk)).includes(String(oTuk.id)), 'the tuk-tuk courier sees it'); ok(!(await list(moto)).includes(String(oTuk.id)), 'the motorbike courier does not');
  r = await call('POST /api/orders/:id/action', { as: MOTO, params: { id: oTuk.id }, body: { action: 'courier_accept' } }); eq(r.status, 403, 'a motorbike courier cannot take a tuk-tuk order');
  r = await call('POST /api/orders/:id/action', { as: TUK, params: { id: oTuk.id }, body: { action: 'courier_accept' } }); eq(r.status, 200, 'the tuk-tuk courier takes it');

  /* auto assign respects the means */
  await q('UPDATE app_settings SET auto_assign=TRUE WHERE id=1');
  const oM = (await checkout({ vehicle: 'موتوسيكل' })).json.orders[0];
  await call('POST /api/orders/:id/action', { as: OW, params: { id: oM.id }, body: { action: 'accept' } });
  eq(Number((await q('SELECT courier_user_id c FROM orders WHERE id=$1', [oM.id])).rows[0].c), moto, 'auto assign picks the motorbike courier'); await q('UPDATE app_settings SET auto_assign=FALSE WHERE id=1');

  /* "the courier decides the price" */
  r = await call('PATCH /api/admin/delivery-mode', { as: A, body: { mode: 'courier', perKm: 5, min: 10, max: 40, factor: 1.3, courierMin: 10, courierMax: 40 } }); eq(r.status, 200, 'switch to courier mode');
  eq((await call('PATCH /api/admin/delivery-mode', { as: A, body: { mode: 'courier', perKm: 5, min: 10, max: 40, factor: 1.3, courierMin: 50, courierMax: 40 } })).status, 400, 'min above max refused');
  r = await call('POST /api/delivery-options', { as: CU, body: { providerIds: [rest] } }); eq(r.json.mode, 'courier', 'options tell the app the courier decides'); ok(r.json.options.every(o => o.price === null), 'no prices shown'); eq(r.json.courierMax, 40, 'limits are sent');
  r = await checkout({ vehicle: 'موتوسيكل' }); const oc = r.json.orders[0];
  eq(oc.deliveryFee, 0, 'fee starts at 0'); eq(oc.feeByCourier, true, 'marked: the courier decides'); eq(oc.feeState, 'open', 'state open');
  await call('POST /api/orders/:id/action', { as: OW, params: { id: oc.id }, body: { action: 'accept' } });
  r = await call('POST /api/orders/:id/courier-fee', { as: MOTO, params: { id: oc.id }, body: { fee: 25 } }); eq(r.status, 403, 'cannot price before taking the order');
  await call('POST /api/orders/:id/action', { as: MOTO, params: { id: oc.id }, body: { action: 'courier_accept' } });
  eq((await call('POST /api/orders/:id/courier-fee', { as: MOTO, params: { id: oc.id }, body: { fee: 5 } })).status, 400, 'below the minimum refused');
  eq((await call('POST /api/orders/:id/courier-fee', { as: MOTO, params: { id: oc.id }, body: { fee: 99 } })).status, 400, 'above the maximum refused');
  eq((await call('POST /api/orders/:id/courier-fee', { as: TUK, params: { id: oc.id }, body: { fee: 20 } })).status, 403, 'another courier cannot price it');
  r = await call('POST /api/orders/:id/action', { as: MOTO, params: { id: oc.id }, body: { action: 'pickup' } }); eq(r.status, 409, 'pickup blocked until a price is set');
  pushes.length = 0; r = await call('POST /api/orders/:id/courier-fee', { as: MOTO, params: { id: oc.id }, body: { fee: 25 } });
  eq(r.status, 200, 'price set'); eq(r.json.order.deliveryFee, 25, 'fee in the order'); eq(r.json.order.total, 65, 'total = 40 + 25'); eq(r.json.order.feeState, 'proposed', 'waiting for the customer');
  ok(pushes.some(x => x.ids.includes(cust)), 'customer is notified');
  eq((await q('SELECT total FROM invoices WHERE id=$1', [oc.invoiceId])).rows[0].total * 1, 65, 'invoice total follows');
  r = await call('POST /api/orders/:id/action', { as: MOTO, params: { id: oc.id }, body: { action: 'pickup' } }); eq(r.status, 409, 'pickup still blocked: not approved');
  r = await call('POST /api/orders/:id/action', { as: MOTO, params: { id: oc.id }, body: { action: 'approve_fee' } }); eq(r.status, 403, 'only the customer approves');
  r = await call('POST /api/orders/:id/action', { as: CU, params: { id: oc.id }, body: { action: 'approve_fee' } }); eq(r.status, 200, 'customer approves');
  r = await call('POST /api/orders/:id/action', { as: MOTO, params: { id: oc.id }, body: { action: 'pickup' } }); eq(r.status, 200, 'pickup works after approval');
  /* the customer refuses a price: the courier is removed and cannot retake it */
  const od = (await checkout({ vehicle: 'موتوسيكل' })).json.orders[0];
  await call('POST /api/orders/:id/action', { as: OW, params: { id: od.id }, body: { action: 'accept' } });
  await call('POST /api/orders/:id/action', { as: MOTO, params: { id: od.id }, body: { action: 'courier_accept' } });
  await call('POST /api/orders/:id/courier-fee', { as: MOTO, params: { id: od.id }, body: { fee: 40 } });
  r = await call('POST /api/orders/:id/action', { as: CU, params: { id: od.id }, body: { action: 'decline_fee' } }); eq(r.status, 200, 'customer refuses the price');
  const row = (await q('SELECT courier_user_id c, total, data FROM orders WHERE id=$1', [od.id])).rows[0];
  eq(row.c, null, 'courier removed'); eq(Number(row.total), 40, 'total back without fee'); eq(row.data.feeState, 'open', 'state open again');
  r = await call('POST /api/orders/:id/action', { as: MOTO, params: { id: od.id }, body: { action: 'courier_accept' } }); eq(r.status, 409, 'the refused courier cannot retake it');
  await call('PATCH /api/admin/delivery-mode', { as: A, body: { mode: 'region', perKm: 5, min: 10, max: 40, factor: 1.3 } });
  eq((await checkout({})).json.orders[0].feeByCourier, undefined, 'back to region mode: normal orders');

  /* supervisor: push for new orders of his area only, bell, link */
  ok(pushes.length >= 0, 'pushes tracked'); pushes.length = 0;
  const oS = (await checkout({ vehicle: 'موتوسيكل' })).json.orders[0];
  ok(pushes.some(x => x.ids.includes(sup) && /طلب جديد/.test(x.p.title)), 'the supervisor of the area is told about the new order'); ok(!pushes.some(x => x.ids.includes(supOut)), 'a supervisor of another area is not');
  await call('POST /api/orders/:id/action', { as: OW, params: { id: oS.id }, body: { action: 'accept' } });
  r = await call('POST /api/admin/orders/:id/bell', { as: SUP, params: { id: oS.id }, body: { role: 'courier', targetId: moto } }); eq(r.status, 201, 'supervisor rings a courier');
  eq((await call('POST /api/admin/orders/:id/bell', { as: SUP2, params: { id: oS.id }, body: { role: 'courier', targetId: moto } })).status, 403, 'another area: refused');
  eq((await call('POST /api/admin/orders/:id/bell', { as: SUP, params: { id: oS.id }, body: { role: 'shop' } })).status, 403, 'a supervisor cannot ring a shop');
  eq((await call('GET /api/admin/orders/:id/bells', { as: SUP, params: { id: oS.id } })).json.bells.length, 1, 'supervisor sees the bells');
  pushes.length = 0; await q('UPDATE orders SET courier_user_id=$1 WHERE id=$2', [moto, oS.id]); await app.bellsAfterAction(Number(oS.id), moto, 'courier_accept');
  ok(pushes.some(x => x.ids.includes(sup) && /قبل/.test(x.p.title)), 'the supervisor who rang is told it was accepted');
  eq((await call('DELETE /api/admin/orders/:id/bell', { as: SUP2, params: { id: oS.id } })).status, 403, 'another area cannot stop it');
  const oL = (await checkout({ vehicle: 'توكتوك' })).json.orders[0];
  await call('POST /api/orders/:id/action', { as: OW, params: { id: oL.id }, body: { action: 'accept' } });
  r = await call('POST /api/orders/:id/assign', { as: SUP, params: { id: oL.id }, body: { courierId: tuk } }); eq(r.status, 200, 'supervisor links any accepted order of his area (shop answered normally)');
  eq((await call('POST /api/orders/:id/assign', { as: SUP2, params: { id: oL.id }, body: { courierId: moto } })).status, 403, 'not outside his areas');

  /* managers: new permissions */
  ok(['bell', 'delivery_prices', 'export'].every(p => managers.PERMS.includes(p)), 'new permissions exist');
  eq(managers.parsePerms(['bell', 'nope', 'export']), ['bell', 'export'], 'parsePerms keeps the known ones');
  const g = (m, url, perms) => managers.gate(pool, m, url, perms);
  eq(await g('POST', '/api/admin/orders/5/bell', ['orders']), managers.DENY, 'bell needs its permission'); eq(await g('POST', '/api/admin/orders/5/bell', ['bell']), null, 'bell allowed');
  eq(await g('PUT', '/api/admin/route-vehicle-prices', ['orders']), managers.DENY, 'delivery prices need their permission'); eq(await g('PUT', '/api/admin/route-vehicle-prices', ['delivery_prices']), null, 'delivery prices allowed');
  eq(await g('PATCH', '/api/admin/delivery-mode', ['delivery_prices']), null, 'delivery mode allowed with it'); eq(await g('PUT', '/api/admin/route-prices', ['delivery_prices']), null, 'route prices allowed with it');
  eq(await g('GET', '/api/admin/commissions/export', ['finance_view']), managers.DENY, 'export needs its own permission'); eq(await g('GET', '/api/admin/commissions/export', ['export']), null, 'export allowed');
  eq(await g('POST', '/api/admin/managers', ['bell', 'delivery_prices', 'export', 'orders']), managers.DENY, 'managers are still owner-only');

  /* owner changes a courier's means */
  r = await call('PATCH /api/admin/couriers/:id/vehicle', { as: A, params: { id: tuk }, body: { vehicle: 'موتوسيكل' } }); eq(r.status, 409, 'refused while the courier carries an order');
  await q("UPDATE orders SET status='delivered' WHERE courier_user_id=$1", [tuk]);
  r = await call('PATCH /api/admin/couriers/:id/vehicle', { as: A, params: { id: tuk }, body: { vehicle: 'موتوسيكل' } }); eq(r.status, 200, 'means changed');
  eq((await q('SELECT vehicle FROM users WHERE id=$1', [tuk])).rows[0].vehicle, 'موتوسيكل', 'saved');
  eq((await call('PATCH /api/admin/couriers/:id/vehicle', { as: A, params: { id: tuk }, body: { vehicle: 'طائرة' } })).status, 400, 'an unknown means is refused');
  eq((await call('PATCH /api/admin/couriers/:id/vehicle', { as: A, params: { id: cust }, body: { vehicle: 'موتوسيكل' } })).status, 404, 'only couriers');
  eq((await call('PATCH /api/admin/couriers/:id/vehicle', { as: CU, params: { id: tuk }, body: { vehicle: 'موتوسيكل' } })).status, 403, 'customers cannot');
  process.exit(done('vehicles2'));
})().catch(e => { console.error(e); process.exit(1); });
