'use strict';
/**
 * Double-order guard. On a weak connection the app may time out (20 s) after the server already created the order,
 * and the customer then taps "order" again, or taps twice. The same account sending the exact same order request
 * again within a short time gets the answer of the first one, and no second order is created.
 * - Nothing changes for different orders, different accounts, or the same order after the window.
 * - A request that failed is never remembered, so a real retry after an error still works.
 * - Kept in memory only (no database change); old app versions are covered because the app sends nothing new.
 */
const crypto = require('crypto');

function create({ ttlMs = 90 * 1000, max = 2000, now = () => Date.now() } = {}) {
  const seen = new Map();   // key -> { at, done, status, body, waiters }
  const sweep = () => {
    const t = now();
    for (const [k, v] of seen) if (t - v.at > ttlMs) seen.delete(k);
    while (seen.size > max) seen.delete(seen.keys().next().value);
  };
  return function dedupe(req, res, next) {
    if (req.method !== 'POST') return next();
    const token = String((req.headers && req.headers.authorization) || '');
    if (!token) return next();
    let body = '';
    try { body = JSON.stringify(req.body || {}); } catch { return next(); }
    const key = crypto.createHash('sha1').update(token + '\n' + (req.originalUrl || req.url || '') + '\n' + body).digest('hex');
    sweep();
    const hit = seen.get(key);
    if (hit) {
      const send = ok => {
        if (!ok) return next();   // the first one failed: this is a genuine retry, let it run
        if (res.set) res.set('X-Duplicate-Request', '1');
        res.status(hit.status).json(hit.body);
      };
      if (hit.done) return send(true);
      hit.waiters.push(send);   // the first request is still running: answer with its result
      return;
    }
    const entry = { at: now(), done: false, status: 0, body: null, waiters: [] };
    seen.set(key, entry);
    const finish = ok => {
      if (ok) { entry.done = true; entry.at = now(); } else seen.delete(key);
      const ws = entry.waiters.splice(0);
      ws.forEach(w => w(ok));
    };
    const json = res.json.bind(res);
    res.json = payload => {
      entry.status = res.statusCode || 200; entry.body = payload;
      if (!entry.finished) { entry.finished = true; finish(entry.status >= 200 && entry.status < 300); }
      return json(payload);
    };
    if (res.on) res.on('close', () => { if (!entry.finished) { entry.finished = true; finish(false); } });
    next();
  };
}

const PATHS = ['/api/orders/checkout', '/api/orders/custom', '/api/orders/market', '/api/orders/request'];
function install(app, opts) { app.use(PATHS, create(opts)); }

module.exports = { create, install, PATHS };
