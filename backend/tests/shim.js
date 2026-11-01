const { SQL } = require('bun');
const url = process.env.TEST_DB || 'postgres://pgt@127.0.0.1:5544/t1';
const wrap = r => ({ rows: [...r], rowCount: r.count ?? r.length });
const jsonish = x => { if (typeof x !== 'string' || !/^\{.*\}$/s.test(x)) return x; try { return JSON.parse(x); } catch { return x; } };
// node-pg sends JSON text to jsonb columns as-is; Bun would double-encode it, so hand Bun the parsed object instead
const norm = p => (p || []).map(x => (x instanceof Date ? x.toISOString() : jsonish(x)));
class Pool {
  constructor() { this.sql = new SQL(url, { max: 10 }); }
  async query(t, p) { return wrap(await this.sql.unsafe(t, norm(p))); }
  async connect() { const c = await this.sql.reserve(); return { query: async (t, p) => wrap(await c.unsafe(t, norm(p))), release: () => c.release() }; }
  async end() { await this.sql.close(); }
}
module.exports = { Pool };
