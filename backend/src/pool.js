'use strict';
/**
 * "شير اللقمة" (switch "pool"): neighbours of the same area who order from the same shop within a short window share ONE delivery trip.
 * Rules (kept deliberately small and safe):
 *  - the customer opts in at checkout (pool:true); only delivery orders with a fee, no scheduled time;
 *  - a group is up to 3 orders: same shop, same area, not yet handed to a courier, created in the last POOL_WINDOW_MIN minutes;
 *  - the trip costs ONE single-order fee (the highest of the members); every member pays ceil(fee / members), never more than his own fee;
 *    the courier collects the members' shares in cash as always, which adds up to about one fee;
 *  - once a courier is on any order of the group, the prices are frozen and the SAME courier is put on every order of the group;
 *  - members are never shown to each other: the only thing a member learns is "a neighbour joined" and his new price.
 * Everything lives in orders.data.pool = { want, groupId, fullFee, size, share }; no schema change.
 */
const extrasLib = require('./extras');
const POOL_MAX = 3;
const POOL_WINDOW_MIN = 10;
const DEAD = ['cancelled', 'rejected', 'unavailable', 'delivered'];
const n2 = v => Math.round(Number(v || 0) * 100) / 100;

const on = db => extrasLib.featureOn(db, 'pool');
const memberRows = async (db, gid) => (await db.query(
  `SELECT * FROM orders WHERE data->'pool'->>'groupId' = $1 AND status <> ALL($2) ORDER BY id FOR UPDATE`, [String(gid), DEAD])).rows;

/** Recompute everybody's delivery share for a group; frozen once a courier is on any member. Returns [{row, from, to}] for those whose price changed. */
async function recalc(db, gid) {
  const rows = await memberRows(db, gid);
  if (!rows.length || rows.some(r => r.courier_user_id)) return [];
  const n = rows.length;
  const poolFee = Math.max(...rows.map(r => Number(r.data.pool.fullFee) || 0));
  const changes = [];
  for (const r of rows) {
    const d = r.data, p = d.pool, full = Number(p.fullFee) || 0;
    const share = n > 1 ? Math.min(full, Math.ceil(poolFee / n)) : full;
    const old = Number(d.deliveryFee) || 0;
    const nd = { ...d, deliveryFee: share, pool: { ...p, size: n, share } };
    const total = n2(Number(r.total) - old + share);
    const u = await db.query('UPDATE orders SET data=$1, total=$2, updated_at=NOW() WHERE id=$3 RETURNING *', [JSON.stringify(nd), total, r.id]);
    if (old !== share) {
      changes.push({ row: u.rows[0], from: old, to: share });
      const iid = d.invoiceId;
      if (iid) {
        const iv = await db.query('SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [Number(iid)]);
        if (iv.rowCount) {
          const idata = iv.rows[0].data || {};
          const parts = (idata.parts || []).map(pt => String(pt.orderId) === String(r.id) ? { ...pt, deliveryFee: share } : pt);
          await db.query('UPDATE invoices SET total=$1, data=$2 WHERE id=$3', [n2(Number(iv.rows[0].total) - old + share), JSON.stringify({ ...idata, parts }), iv.rows[0].id]);
        }
      }
    }
  }
  return changes;
}

/** A freshly created order that asked for sharing: join an open group of neighbours, or start waiting. Returns the price changes. */
async function join(db, order) {
  const p = (order.data || {}).pool;
  if (!p || !p.want || !order.provider_id || order.region_id == null || order.courier_user_id) return [];
  await db.query('SELECT pg_advisory_xact_lock($1, $2)', [Number(order.provider_id), Number(order.region_id)]);
  const cands = (await db.query(
    `SELECT * FROM orders WHERE provider_id=$1 AND region_id=$2 AND id<>$3 AND customer_user_id<>$4
        AND status IN ('pending','accepted') AND courier_user_id IS NULL
        AND data->'pool'->>'want'='true' AND created_at > NOW() - ($5 || ' minutes')::interval
      ORDER BY created_at FOR UPDATE`, [order.provider_id, order.region_id, order.id, order.customer_user_id, String(POOL_WINDOW_MIN)])).rows;
  for (const c of cands) {
    const gid = String(c.data.pool.groupId || c.id);
    const members = await memberRows(db, gid);
    const seed = members.length ? members : [c];
    if (seed.length >= POOL_MAX || seed.some(m => m.courier_user_id || Number(m.customer_user_id) === Number(order.customer_user_id))) continue;
    for (const m of (members.length ? [] : [c])) {
      await db.query('UPDATE orders SET data=$1 WHERE id=$2', [JSON.stringify({ ...m.data, pool: { ...m.data.pool, groupId: gid } }), m.id]);
    }
    await db.query('UPDATE orders SET data=$1 WHERE id=$2', [JSON.stringify({ ...order.data, pool: { ...order.data.pool, groupId: gid } }), order.id]);
    return recalc(db, gid);
  }
  return [];
}

/** The same courier takes every order of the group: called whenever a courier is put on one of them. */
async function syncCourier(db, row, courier) {
  const gid = ((row.data || {}).pool || {}).groupId;
  if (!gid || !courier) return;
  const sibs = (await db.query(
    `SELECT id FROM orders WHERE data->'pool'->>'groupId'=$1 AND id<>$2 AND status IN ('accepted','ready') AND courier_user_id IS DISTINCT FROM $3 FOR UPDATE`,
    [String(gid), row.id, courier.id])).rows;
  for (const s of sibs) {
    await db.query(
      `UPDATE orders SET courier_user_id=$1, updated_at=NOW(), data = data || $2::jsonb WHERE id=$3`,
      [courier.id, JSON.stringify({ courierName: courier.name, courierPhone: courier.phone, courierVehicle: courier.vehicle }), s.id]);
  }
}

/** A member whose shop accepts later gets the courier already working on the group. */
async function groupCourier(db, row) {
  const gid = ((row.data || {}).pool || {}).groupId;
  if (!gid) return null;
  const r = await db.query(
    `SELECT u.id, u.name, u.phone, u.vehicle FROM orders o JOIN users u ON u.id=o.courier_user_id
      WHERE o.data->'pool'->>'groupId'=$1 AND o.id<>$2 AND o.status <> ALL($3) LIMIT 1`, [String(gid), row.id, DEAD]);
  return r.rowCount ? r.rows[0] : null;
}

/** Anonymous hint for the checkout: how many neighbours are waiting for the same shop (size of the best open group). */
async function suggest(db, { providerId, regionId, customerId }) {
  if (!providerId || regionId == null) return 0;
  const rows = (await db.query(
    `SELECT data->'pool'->>'groupId' AS gid, COUNT(*)::int AS n FROM (
       SELECT * FROM orders WHERE provider_id=$1 AND region_id=$2 AND customer_user_id<>$3 AND status IN ('pending','accepted') AND courier_user_id IS NULL
          AND data->'pool'->>'want'='true' AND created_at > NOW() - ($4 || ' minutes')::interval) x
      GROUP BY COALESCE(data->'pool'->>'groupId', id::text), data->'pool'->>'groupId'`, [Number(providerId), Number(regionId), Number(customerId), String(POOL_WINDOW_MIN)])).rows;
  let best = 0;
  for (const r of rows) if (r.n < POOL_MAX && r.n > best) best = r.n;
  return best;
}

module.exports = { on, join, recalc, syncCourier, groupCourier, suggest, POOL_MAX, POOL_WINDOW_MIN };
