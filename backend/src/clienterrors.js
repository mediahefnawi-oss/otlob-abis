'use strict';
/**
 * Silent error reporting from the app: a crash or a failed background step on a phone is sent here (never shown to the customer),
 * grouped by fingerprint so the same error is one row with a counter. The owner reads it in the panel.
 * Reporting can never break anything: it always answers 204 and swallows its own failures.
 */
const crypto = require('crypto');
const rateLimit = (() => { try { return require('express-rate-limit'); } catch { return () => (_q, _r, n) => n(); } })();

const cut = (v, n) => String(v == null ? '' : v).slice(0, n);

/** Pure: the clean row from whatever the app sent (or null when there is nothing worth keeping). */
function cleanReport(b) {
  if (!b || typeof b !== 'object') return null;
  const message = cut(b.message, 400).trim();
  if (!message) return null;
  const where = cut(b.where, 80).trim() || 'app';
  const stack = cut(b.stack, 1800);
  const platform = cut(b.platform, 20);
  const version = cut(b.version, 20);
  // the fingerprint ignores numbers so "order 15 failed" and "order 16 failed" are one error
  const norm = message.replace(/\d+/g, '#').toLowerCase();
  const fp = crypto.createHash('sha1').update(where + '|' + norm).digest('hex').slice(0, 20);
  return { fp, where, message, stack, platform, version };
}

function register(app, { pool, auth, roles, asyncRoute }) {
  const limiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: false, legacyHeaders: false, handler: (_req, res) => res.status(204).end() });

  app.post('/api/client-errors', limiter, async (req, res) => {
    res.status(204).end();   // answer first: reporting must never slow the app down
    try {
      const r = cleanReport(req.body);
      if (!r) return;
      let uid = null;
      const h = (req.headers && req.headers.authorization) || '';
      if (h.startsWith('Bearer ')) {
        try { const jwt = require('jsonwebtoken'); uid = Number(jwt.verify(h.slice(7), process.env.JWT_SECRET, { issuer: 'otlob-abis-api', audience: 'otlob-abis-app' }).sub) || null; } catch { /* anonymous report */ }
      }
      await pool.query(
        `INSERT INTO client_errors(fp, where_, message, stack, platform, version, user_id) VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (fp) DO UPDATE SET cnt = client_errors.cnt + 1, last_at = NOW(), stack = EXCLUDED.stack, platform = EXCLUDED.platform, version = EXCLUDED.version, user_id = COALESCE(EXCLUDED.user_id, client_errors.user_id)`,
        [r.fp, r.where, r.message, r.stack, r.platform, r.version, uid]);
      // keep the table small: only the newest 300 kinds of errors
      await pool.query('DELETE FROM client_errors WHERE id IN (SELECT id FROM client_errors ORDER BY last_at DESC OFFSET 300)');
    } catch (e) { if (process.env.DEBUG_CE) console.error(e); }
  });

  app.get('/api/admin/client-errors', auth, roles('admin'), asyncRoute(async (_req, res) => {
    const q = await pool.query('SELECT id, where_, message, stack, platform, version, user_id, cnt, first_at, last_at FROM client_errors ORDER BY last_at DESC LIMIT 100');
    res.json({ errors: q.rows.map(x => ({ id: String(x.id), where: x.where_, message: x.message, stack: x.stack, platform: x.platform, version: x.version, userId: x.user_id ? String(x.user_id) : null, count: x.cnt, first: new Date(x.first_at).getTime(), last: new Date(x.last_at).getTime() })) });
  }));

  app.delete('/api/admin/client-errors', auth, roles('admin'), asyncRoute(async (_req, res) => {
    await pool.query('DELETE FROM client_errors');
    res.json({ ok: true });
  }));
}

module.exports = { register, cleanReport };
