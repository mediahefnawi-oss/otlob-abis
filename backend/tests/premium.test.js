const { Pool } = require('./shim');
let pass = 0, bad = 0; const ok = (c, m) => { if (c) pass++; else { bad++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m}: got ${a}, want ${b}`);
const near = (a, b, m) => ok(Math.abs(Number(a) - Number(b)) < 0.005, `${m}: got ${a}, want ${b}`);
const routes = {}; const app = {};
for (const m of ['get', 'post', 'patch', 'put', 'delete']) app[m] = (p, ...c) => { routes[`${m.toUpperCase()} ${p}`] = c; };
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const positiveId = v => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const pass1 = (req, res, next) => next();
const pushes = [];
(async () => {
  const pool = new Pool(); const q = (t, p) => pool.query(t, p);
  const prem = require('../src/premium.js');
  const deps = { pool, auth: pass1, authAny: pass1, roles: () => pass1, asyncRoute, positiveId };
  require('../src/orders.js')(app, { ...deps, maintenanceState: async () => ({ enabled: true }), loadSettings: async () => ({}), cleanUser: x => x, pushToUsers: async () => {} });
  require('../src/coupons.js').registerCouponRoutes(app, deps);
  prem.register(app, { ...deps, clearCaches() {}, pushToUsers: async (ids, p) => { pushes.push({ ids, p }); } });
  const call = (key, as, body, params) => new Promise(resolve => {
    const res = { set() { return this; }, status(c) { this.c = c; return this; }, json(j) { resolve({ status: this.c || 200, json: j }); return this; } };
    const chain = routes[key];
    chain[chain.length - 1]({ auth: as, params: params || {}, body: body || {}, query: {} }, res, e => resolve({ status: e.status || e.http || 500, json: { error: e.message } }));
  });
  const F = async o => { await q("UPDATE app_settings SET features = '{}'::jsonb || $1::jsonb WHERE id=1", [JSON.stringify(o)]); };
  const phone = () => '010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const mk = async (n, role, extra = '') => (await q(`INSERT INTO users(name, phone, password_hash, role, status${role === 'courier' ? ', available' : ''}) VALUES($1,$2,'x',$3,'active'${role === 'courier' ? ',TRUE' : ''}) RETURNING id`, [n, phone(), role])).rows[0].id;
  await F({});
  await q("UPDATE app_settings SET premium='{}'::jsonb WHERE id=1");
  await q('TRUNCATE coupon_uses, coupons CASCADE');
  const adm = await mk('مالك', 'admin'), cM = await mk('مشترك', 'customer'), cN = await mk('عادي', 'customer'), cE = await mk('منتهي', 'customer'), oA = await mk('صاحب', 'provider'), oB = await mk('صيدلي', 'provider'), cour = await mk('مندوب', 'courier');
  const shop = async (o, type, n, fee) => (await q("INSERT INTO providers(owner_user_id,type,name,phone,status,is_open,delivery_fee) VALUES($1,$2,$3,'01000000000','active',TRUE,$4) RETURNING id", [o, type, n, fee])).rows[0].id;
  const pA = await shop(oA, 'maker', 'محل أ', 10), pB = await shop(oB, 'pharmacy', 'صيدلية', 20), pC = await shop(oA, 'maker', 'محل ج', 30);
  const prod = async (p, price) => (await q("INSERT INTO products(provider_id,name,price) VALUES($1,'منتج',$2) RETURNING id", [p, price])).rows[0].id;
  const x100 = await prod(pA, 100), x200 = await prod(pA, 200), xC = await prod(pC, 100);
  const ADM = { sub: String(adm), role: 'admin', status: 'active' }, CM = { sub: String(cM), role: 'customer', status: 'active' }, CN = { sub: String(cN), role: 'customer', status: 'active' }, CE = { sub: String(cE), role: 'customer', status: 'active' };
  const PA = { sub: String(oA), role: 'provider', status: 'active' }, PB = { sub: String(oB), role: 'provider', status: 'active' }, COUR = { sub: String(cour), role: 'courier', status: 'active' };
  const base = { name: 'عميل', phone: '01012345678', address: 'شارع 5 عمارة 3 الدور 2', notes: '' };
  const buy = (as, lines, extra = {}) => call('POST /api/orders/checkout', as, { ...base, lines, ...extra });
  const member = async (id, days) => q("UPDATE users SET premium_until = NOW() + make_interval(days => $1) WHERE id=$2", [days, id]);
  await member(cM, 30); await member(cE, -2);

  console.log('A) settings are checked');
  const dflt = prem.cfgOf({});
  eq(dflt.price, 99, 'default price'); eq(dflt.days, 30, 'default days'); eq(dflt.discountPct, 5, 'default percent'); eq(dflt.freeAbove, 150, 'default free-delivery amount');
  for (const [b, m] of [[{ price: -1 }, 'negative price'], [{ days: 0 }, 'zero days'], [{ days: 400 }, 'too many days'], [{ discountPct: 60 }, 'percent above 50'], [{ freeAbove: -5 }, 'negative free-delivery amount'], [{ lines: new Array(9).fill('x') }, 'nine lines'], [{ lines: ['x'.repeat(81)] }, 'a long line']]) {
    let threw = false; try { prem.cleanCfg({ price: 99, days: 30, discountPct: 5, freeAbove: 150, ...b }); } catch (e) { threw = e.http === 400; }
    ok(threw, m + ' refused');
  }
  let r = await call('PUT /api/admin/premium', ADM, { price: 120, days: 30, discountPct: 10, freeAbove: 150, transfer: '01012345678', promo: 'عرض', lines: ['توصيل مجاني', 'خصم', '  '] });
  eq(r.status, 200, 'owner saves the settings'); eq(r.json.cfg.price, 120, 'price saved'); eq(r.json.cfg.lines.length, 2, 'empty lines dropped'); eq(r.json.cfg.discountPct, 10, 'percent saved');
  eq((await call('PUT /api/admin/premium', ADM, { price: 'abc', days: 30, discountPct: 5, freeAbove: 1 })).status, 400, 'junk refused over the API');
  const pub = prem.publicView(r.json.cfg, { premium: true, premiumDiscount: true, premiumFreeDelivery: false, premiumOffers: true, premiumPriority: false });
  eq(pub.discountPct, 10, 'public view shows a benefit that is on'); eq(pub.freeAbove, null, 'public view hides a benefit that is off'); eq(pub.on, true, 'master on');

  console.log('B) the owner activates, extends and cancels');
  const sub0 = await q('SELECT premium_until FROM users WHERE id=$1', [cN]);
  eq(sub0.rows[0].premium_until, null, 'a new customer has no subscription');
  eq((await call('POST /api/admin/premium/activate', ADM, { phone: '123', days: 30 })).status, 400, 'bad phone refused');
  eq((await call('POST /api/admin/premium/activate', ADM, { phone: '01000000000', days: 30 })).status, 404, 'unknown customer refused');
  eq((await call('POST /api/admin/premium/activate', ADM, { phone: (await q('SELECT phone FROM users WHERE id=$1', [cN])).rows[0].phone, days: 0 })).status, 400, 'zero days refused');
  eq((await call('POST /api/admin/premium/activate', ADM, { phone: (await q('SELECT phone FROM users WHERE id=$1', [oA])).rows[0].phone, days: 30 })).status, 404, 'a shop owner is not a customer');
  const pN = (await q('SELECT phone FROM users WHERE id=$1', [cN])).rows[0].phone;
  r = await call('POST /api/admin/premium/activate', ADM, { phone: ` ${pN} `, days: 30 });
  eq(r.status, 200, 'activated'); near((r.json.activated.until - Date.now()) / 864e5, 30, 'about 30 days from now');
  eq(pushes.length, 1, 'the customer is told'); eq(String(pushes[0].ids[0]), String(cN), 'the right customer is told');
  r = await call('POST /api/admin/premium/activate', ADM, { phone: pN, days: 10 });
  near((r.json.activated.until - Date.now()) / 864e5, 40, 'an active subscription is extended from its end');
  const pE = (await q('SELECT phone FROM users WHERE id=$1', [cE])).rows[0].phone;
  r = await call('POST /api/admin/premium/activate', ADM, { phone: pE, days: 5 });
  near((r.json.activated.until - Date.now()) / 864e5, 5, 'an ended subscription starts from now');
  r = await call('GET /api/admin/premium', ADM);
  ok(r.json.subscribers.length >= 3 && r.json.activeCount >= 3, 'the subscribers are listed');
  r = await call('POST /api/admin/premium/cancel', ADM, { phone: pN });
  eq(r.status, 200, 'cancelled'); eq((await q('SELECT premium_until FROM users WHERE id=$1', [cN])).rows[0].premium_until, null, 'the subscription is gone');
  eq((await call('POST /api/admin/premium/cancel', ADM, { phone: '01000000000' })).status, 404, 'cancel unknown refused');
  eq(Number((await q("SELECT COUNT(*) FROM premium_log WHERE user_id=$1", [cN])).rows[0].count), 3, 'every change is logged');
  await member(cE, -2);

  console.log('C) master switch off: nothing changes for anybody');
  await F({ premiumDiscount: true, premiumFreeDelivery: true, premiumPriority: true, premiumOffers: true }); // sub-switches on, master off
  r = await buy(CM, [{ productId: x200, qty: 1 }]);
  eq(r.status, 201, 'order placed'); eq(r.json.orders[0].total, 210, 'full price (200 + 10)'); eq(r.json.orders[0].deliveryFee, 10, 'delivery charged'); eq(r.json.orders[0].discount, undefined, 'no discount'); eq(r.json.orders[0].premium, undefined, 'no PRO mark');

  console.log('D) discount only');
  await F({ premium: true, premiumDiscount: true });
  r = await buy(CM, [{ productId: x200, qty: 1 }]);
  let o = r.json.orders[0];
  eq(o.discount, 20, '10% of 200 (the owner set 10%)');
  eq(o.total, 200 - 20 + 10, 'total = products - discount + delivery'); eq(o.deliveryFee, 10, 'delivery still charged'); eq(o.couponCode, 'PREMIUM', 'marked as a premium discount');
  eq(r.json.invoice.total, 190, 'invoice follows'); eq(r.json.invoice.parts[0].discount, 20, 'invoice part shows the discount');
  eq(Number((await q('SELECT total FROM orders WHERE id=$1', [o.id])).rows[0].total), 190, 'stored total');
  r = await buy(CN, [{ productId: x200, qty: 1 }]);
  eq(r.json.orders[0].total, 210, 'a customer without a subscription pays full price');
  r = await buy(CE, [{ productId: x200, qty: 1 }]);
  eq(r.json.orders[0].total, 210, 'an ended subscription pays full price');

  console.log('E) free delivery only');
  await F({ premium: true, premiumFreeDelivery: true });
  r = await buy(CM, [{ productId: x200, qty: 1 }]); o = r.json.orders[0];
  eq(o.deliveryFee, 0, 'free delivery above the amount'); eq(o.total, 200, 'total = products'); eq(o.discount, undefined, 'no percent off'); eq(o.courierFee, 10, 'the courier still sees the normal fee');
  r = await buy(CM, [{ productId: x100, qty: 1 }]); o = r.json.orders[0];
  eq(o.deliveryFee, 10, 'below the amount the delivery is charged'); eq(o.total, 110, 'total = 100 + 10'); eq(o.courierFee, undefined, 'no courier fee mark');
  r = await buy(CM, [{ productId: x100, qty: 1 }, { productId: xC, qty: 2 }]);
  eq(r.json.orders.length, 2, 'two shops'); const oa = r.json.orders.find(x => x.providerId === String(pA)), oc = r.json.orders.find(x => x.providerId === String(pC));
  eq(oa.deliveryFee, 10, 'shop A below the amount is charged');
  eq(oc.deliveryFee, 0, 'shop C above the amount is free'); eq(r.json.invoice.total, oa.total + oc.total, 'invoice = both orders');

  console.log('F) both together, with a discount code and a shared delivery');
  await F({ premium: true, premiumDiscount: true, premiumFreeDelivery: true });
  r = await buy(CM, [{ productId: x200, qty: 1 }]); o = r.json.orders[0];
  eq(o.total, 200 - 20, 'free delivery and 10% off'); eq(o.deliveryFee, 0, 'delivery free'); eq(o.discount, 20, 'percent off');
  eq((await call('POST /api/admin/coupons', ADM, { code: 'SAVE30', kind: 'amount', value: 30, days: 3 })).status, 201, 'a normal code exists');
  r = await buy(CM, [{ productId: x200, qty: 1 }], { coupon: 'save30' }); o = r.json.orders[0];
  eq(o.discount, 30, 'one discount only: the code, not the percent'); eq(o.couponCode, 'SAVE30', 'the code is shown'); eq(o.deliveryFee, 0, 'free delivery still applies with a code'); eq(o.total, 170, 'total = 200 - 30');
  eq(Number((await q('SELECT COUNT(*) FROM coupon_uses WHERE user_id=$1', [cM])).rows[0].count), 1, 'the code use is recorded once');
  r = await call('POST /api/orders/:id/action', CM, { action: 'cancel', reason: 'غيرت رأيي' }, { id: o.id });
  eq(r.status, 200, 'cancelled'); eq(Number((await q('SELECT COUNT(*) FROM coupon_uses WHERE user_id=$1', [cM])).rows[0].count), 0, 'the code is given back');
  // pure rules
  const ben = { member: true, discountPct: 10, freeAbove: 150, priority: true, offers: true };
  let p = prem.priceGroup({ subtotal: 200, fee: 10 }, ben); eq(p.discount, 20, 'unit: percent'); eq(p.fee, 0, 'unit: free'); eq(p.free, true, 'unit: free flag');
  p = prem.priceGroup({ subtotal: 200, fee: 10, hasOffer: true }, ben); eq(p.discount, 0, 'unit: no percent on a shop with an offer'); eq(p.fee, 0, 'unit: free delivery still applies');
  p = prem.priceGroup({ subtotal: 200, fee: 10, pooled: true }, ben); eq(p.fee, 10, 'unit: no free delivery for a shared delivery'); eq(p.discount, 20, 'unit: percent still applies');
  p = prem.priceGroup({ subtotal: 200, fee: 0 }, ben); eq(p.free, false, 'unit: nothing to waive when the fee is 0');
  p = prem.priceGroup({ subtotal: 200, fee: 10 }, prem.NONE); eq(p.discount + p.fee, 10, 'unit: a non-member pays the normal price');
  p = prem.priceGroup({ subtotal: 150, fee: 10 }, ben); eq(p.fee, 0, 'unit: exactly the amount is free');
  p = prem.priceGroup({ subtotal: 149.99, fee: 10 }, ben); eq(p.fee, 10, 'unit: just below is not');
  p = prem.priceGroup({ subtotal: 40, fee: 10 }, { ...ben, discountPct: 50 }); near(p.discount, 20, 'unit: 50% of 40');

  console.log('G) codes only for subscribers');
  await F({ premium: true, premiumOffers: true });
  eq((await call('POST /api/admin/coupons', ADM, { code: 'VIP15', kind: 'amount', value: 15, days: 3, premiumOnly: true })).status, 201, 'a subscribers-only code is created');
  eq((await q("SELECT premium_only FROM coupons WHERE code='VIP15'")).rows[0].premium_only, true, 'stored as premium only');
  r = await buy(CN, [{ productId: x200, qty: 1 }], { coupon: 'vip15' }); eq(r.status, 400, 'a non-subscriber is refused'); ok(/بريميم/.test(r.json.error), 'the reason names premium: ' + r.json.error);
  r = await buy(CE, [{ productId: x200, qty: 1 }], { coupon: 'vip15' }); eq(r.status, 400, 'an ended subscription is refused');
  r = await buy(CM, [{ productId: x200, qty: 1 }], { coupon: 'vip15' }); eq(r.status, 201, 'a subscriber can use it'); eq(r.json.orders[0].discount, 15, 'the discount is taken');
  r = await call('POST /api/coupons/check', CN, { lines: [{ productId: x200, qty: 1 }], code: 'VIP15' }); eq(r.status, 400, 'the cart check refuses a non-subscriber too');
  await F({ premium: true, premiumOffers: false });
  r = await buy(CM, [{ productId: x200, qty: 1 }], { coupon: 'vip15' }); eq(r.status, 400, 'with "exclusive offers" off the code does not work');
  await F({});
  r = await buy(CM, [{ productId: x200, qty: 1 }], { coupon: 'vip15' }); eq(r.status, 400, 'with premium off the code does not work');

  console.log('H) the PRO mark and the courier priority');
  await F({ premium: true, premiumPriority: true });
  r = await buy(CM, [{ productId: x100, qty: 1 }]); eq(r.json.orders[0].premium, true, 'a subscriber order is marked PRO');
  r = await buy(CN, [{ productId: x100, qty: 1 }]); eq(r.json.orders[0].premium, undefined, 'a normal order is not');
  await F({ premium: true, premiumPriority: false });
  r = await buy(CM, [{ productId: x100, qty: 1 }]); eq(r.json.orders[0].premium, undefined, 'priority off: no mark');

  console.log('I) a full order from start to delivery with free delivery + percent');
  await F({ premium: true, premiumDiscount: true, premiumFreeDelivery: true, premiumPriority: true });
  r = await buy(CM, [{ productId: x200, qty: 1 }]); o = r.json.orders[0]; const id = o.id;
  eq(o.total, 180, 'ordered at 180');
  for (const [who, act, st] of [[PA, 'accept', 'accepted'], [COUR, 'courier_accept', 'accepted'], [COUR, 'pickup', 'picked_up'], [COUR, 'go', 'on_the_way'], [COUR, 'arrive', 'arrived'], [COUR, 'deliver', 'delivered']]) {
    r = await call('POST /api/orders/:id/action', who, { action: act }, { id });
    eq(r.status, 200, `${act} works: ${r.json.error || ''}`); if (r.status === 200) eq(r.json.order.status, st, `${act} -> ${st}`);
  }
  r = await q('SELECT total, data FROM orders WHERE id=$1', [id]);
  eq(Number(r.rows[0].total), 180, 'the total did not move through the flow'); eq(r.rows[0].data.premiumFree, true, 'free delivery stays recorded'); near(r.rows[0].data.normalFee, 10, 'the normal fee is remembered');
  const ce = (await q("SELECT kind, base_amount FROM commission_entries WHERE order_id=$1", [id])).rows;
  ok(ce.every(x => x.kind !== 'courier' || Number(x.base_amount) === 10), 'the courier commission is figured on the normal fee (10), not 0');
  r = await call('GET /api/admin/premium', ADM);
  ok(r.json.cost30.freeDelivery >= 10 && r.json.cost30.discount >= 20, 'the owner sees what the benefits cost: ' + JSON.stringify(r.json.cost30));

  console.log('J) a written request (pharmacy): the shop prices, the subscriber gets the benefits');
  await F({ premium: true, premiumDiscount: true, premiumFreeDelivery: true, premiumPriority: true });
  r = await call('POST /api/orders/request', CM, { ...base, providerId: pB, text: 'علبة دواء وفيتامين' });
  eq(r.status, 201, 'request placed: ' + (r.json.error || '')); const ro = r.json.order || r.json.orders?.[0];
  eq(ro.premium, true, 'the request is marked PRO'); eq(ro.deliveryFee, 20, 'delivery shown before the price');
  r = await call('POST /api/orders/:id/quote', PB, { price: 300 }, { id: ro.id });
  eq(r.status, 200, 'priced: ' + (r.json.error || '')); eq(r.json.order.status, 'quoted', 'quoted');
  eq(r.json.order.discount, 30, '10% of 300'); eq(r.json.order.deliveryFee, 0, 'free delivery above the amount'); eq(r.json.order.total, 270, 'total = 300 - 30 + 0'); eq(r.json.invoice.total, 270, 'invoice = 270');
  r = await call('POST /api/orders/:id/quote', PB, { price: 100 }, { id: ro.id });
  eq(r.json.order.total, 100 - 10 + 20, 're-quoted lower: the normal delivery comes back (the free delivery is figured again)'); eq(r.json.order.deliveryFee, 20, 'delivery charged below the amount'); eq(r.json.order.courierFee, undefined, 'no courier fee mark');
  r = await call('POST /api/orders/:id/quote', PB, { price: 300 }, { id: ro.id });
  eq(r.json.order.total, 270, 're-quoted again: back to free delivery');
  r = await call('POST /api/orders/:id/action', CM, { action: 'approve_quote' }, { id: ro.id });
  eq(r.status, 200, 'customer approves'); eq(r.json.order.total, 270, 'approving does not change the total');
  r = await call('POST /api/orders/request', CN, { ...base, providerId: pB, text: 'علبة دواء' });
  const rn = r.json.order || r.json.orders?.[0];
  r = await call('POST /api/orders/:id/quote', PB, { price: 300 }, { id: rn.id });
  eq(r.json.order.total, 320, 'a normal customer pays the normal price (300 + 20)'); eq(r.json.order.discount, undefined, 'no discount');
  r = await call('POST /api/orders/:id/quote', PB, { unavailable: true }, { id: ro.id }).then(x => x); // approved already: refused
  ok(r.status === 409 || r.status === 400, 'a priced and approved order cannot be priced again');

  console.log('K) moving an order to another shop keeps the price right');
  await F({ premium: true, premiumDiscount: true, premiumFreeDelivery: true });
  r = await buy(CM, [{ productId: x200, qty: 1 }]); o = r.json.orders[0];
  r = await call('POST /api/orders/:id/transfer', ADM, { providerId: pC }, { id: o.id });
  eq(r.status, 200, 'transferred: ' + (r.json.error || '')); eq(Number((await q('SELECT total FROM orders WHERE id=$1', [o.id])).rows[0].total), 180, 'the total keeps the discount and the free delivery');
  { const iv = (await q("SELECT data->>'invoiceId' AS i FROM orders WHERE id=$1", [o.id])).rows[0].i; eq(Number((await q('SELECT total FROM invoices WHERE id=$1', [iv])).rows[0].total), 180, 'the invoice agrees'); }
  r = await buy(CN, [{ productId: x200, qty: 1 }]); o = r.json.orders[0];
  r = await call('POST /api/orders/:id/transfer', ADM, { providerId: pC }, { id: o.id });
  eq(Number((await q('SELECT total FROM orders WHERE id=$1', [o.id])).rows[0].total), 200 + 10, 'a normal order moves with its delivery price (a customer with no area keeps the old price, as before)');
  await F({ premium: true });
  r = await buy(CN, [{ productId: x200, qty: 1 }], { coupon: 'save30' }); o = r.json.orders[0];
  r = await call('POST /api/orders/:id/transfer', ADM, { providerId: pC }, { id: o.id });
  eq(Number((await q('SELECT total FROM orders WHERE id=$1', [o.id])).rows[0].total), 200 - 30 + 10, 'a coupon order keeps its discount when moved');

  console.log('L) the errand and the pooled delivery are not touched');
  await F({ premium: true, premiumDiscount: true, premiumFreeDelivery: true, premiumPriority: true });
  r = await call('POST /api/orders/custom', CM, { ...base, text: 'اشتري لي حاجة من السوق' });
  eq(r.status, 201, 'errand placed: ' + (r.json.error || '')); const eo = r.json.order || r.json.orders?.[0]; eq(eo.deliveryFee, 0, 'errand fee starts at 0'); eq(eo.total, 0, 'errand total starts at 0');
  eq(eo.premium, true, 'an errand by a subscriber is first in line for couriers');

  console.log('M) public settings and my account carry the data');
  const settingsView = prem.publicView((await call('GET /api/admin/premium', ADM)).json.cfg, { premium: true, premiumDiscount: true, premiumFreeDelivery: true, premiumOffers: false, premiumPriority: true });
  ok(settingsView.on && settingsView.price === 120 && settingsView.lines.length === 2 && settingsView.transfer === '01012345678', 'the public view has price, lines and the transfer number');
  console.log(`premium tests: ${pass} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
