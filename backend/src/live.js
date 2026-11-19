'use strict';
/**
 * Instant "something changed for you" nudges (Server-Sent Events).
 * Every push the server sends to a user (new order for a shop, order ready for the couriers, a status change for the customer...)
 * also pokes the open app of that user, which then syncs at once instead of waiting for its next 4-second round.
 * The poke carries no data (the app reads everything through its normal, permission-checked sync); losing it only costs a few seconds.
 */
const conns = new Map(); // userId -> Set<res>
const MAX_PER_USER = 4;
let total = 0;

function emit(userIds, tag) {
  if (!userIds || !userIds.length) return 0;
  let n = 0;
  const line = `event: poke\ndata: ${JSON.stringify({ tag: String(tag || '') .slice(0, 40) })}\n\n`;
  for (const id of new Set(userIds.map(String))) {
    const set = conns.get(id);
    if (!set) continue;
    for (const res of set) { try { res.write(line); n++; } catch { /* closed: cleaned up by its close event */ } }
  }
  return n;
}

function register(app, { auth }) {
  app.get('/api/live', auth, (req, res) => {
    const id = String(req.auth.sub);
    let set = conns.get(id);
    if (!set) conns.set(id, set = new Set());
    if (set.size >= MAX_PER_USER) { const old = set.values().next().value; try { old.end(); } catch { /* ignore */ } set.delete(old); total--; }
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Content-Encoding': 'identity',     // never compress a stream: the proxy would hold the pokes back
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    if (res.flushHeaders) res.flushHeaders();
    res.write(`retry: 3000\n: ok\n\n`);
    set.add(res); total++;
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 20000);
    req.on('close', () => { clearInterval(hb); if (set.delete(res)) total--; if (!set.size) conns.delete(id); });
  });
  app.get('/api/live/stats', auth, (req, res) => res.json({ users: conns.size, connections: total }));
}
module.exports = { emit, register, count: () => total };
