'use strict';
// Place lookups for the app (reverse address of a GPS point, search by name).
// OpenStreetMap's free service refuses requests that do not carry an app name (the phone app sends none), so the server asks on the app's behalf:
// one request a second at most, answers kept for a while, and a per-address limit so nobody can use us as a free proxy.
const UA = 'OtlobAbis/1.0 (+https://otlobabis.com)';
const BASE = 'https://nominatim.openstreetmap.org';
const KEEP_MS = 6 * 3600 * 1000, MAX = 3000;
const cache = new Map();
let chain = Promise.resolve();
let lastCall = 0;

function remember(k, v) { if (cache.size >= MAX) cache.delete(cache.keys().next().value); cache.set(k, { v, at: Date.now() }); return v; }
function recall(k) { const h = cache.get(k); if (!h) return undefined; if (Date.now() - h.at > KEEP_MS) { cache.delete(k); return undefined; } return h.v; }
/** upstream calls go one at a time, at least 1.1 s apart (the service's rule) */
function upstream(url, fetchFn) {
  const run = async () => {
    const wait = lastCall + 1100 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 9000);
    try {
      const r = await fetchFn(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'ar' } });
      if (!r.ok) throw new Error('geo ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function register(app, { asyncRoute, fetchFn = (...a) => fetch(...a), limiter: injected }) {
  const limiter = injected || require('express-rate-limit')({ windowMs: 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'طلبات كثيرة، حاول بعد دقيقة' } });
  app.get('/api/geo/reverse', limiter, asyncRoute(async (req, res) => {
    const lat = num(req.query.lat), lng = num(req.query.lng);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return res.status(400).json({ error: 'إحداثيات غير صالحة' });
    const key = `r:${lat.toFixed(4)}:${lng.toFixed(4)}`;
    let out = recall(key);
    if (out === undefined) {
      try {
        const j = await upstream(`${BASE}/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=ar&lat=${lat}&lon=${lng}`, fetchFn);
        const a = (j && j.address) || {};
        out = remember(key, { address: { house_number: a.house_number, road: a.road, neighbourhood: a.neighbourhood, suburb: a.suburb, quarter: a.quarter, city: a.city, town: a.town, village: a.village, county: a.county }, display_name: String((j && j.display_name) || '') });
      } catch (e) { return res.status(502).json({ error: 'خدمة العناوين مش متاحة دلوقتي' }); }
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.json(out);
  }));
  app.get('/api/geo/search', limiter, asyncRoute(async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 120);
    if (q.length < 2) return res.status(400).json({ error: 'اكتب اسم المكان' });
    const lat = num(req.query.lat), lng = num(req.query.lng);
    const box = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? `&viewbox=${lng - 0.5},${lat + 0.5},${lng + 0.5},${lat - 0.5}` : '';
    const key = `s:${q.toLowerCase()}:${lat === null ? '' : lat.toFixed(1)}:${lng === null ? '' : lng.toFixed(1)}`;
    let out = recall(key);
    if (out === undefined) {
      try {
        const j = await upstream(`${BASE}/search?format=jsonv2&limit=1&countrycodes=eg&accept-language=ar${box}&q=${encodeURIComponent(q)}`, fetchFn);
        const h = Array.isArray(j) ? j[0] : null;
        const la = h ? num(h.lat) : null, lo = h ? num(h.lon) : null;
        out = remember(key, la === null || lo === null ? { found: false } : { found: true, lat: la, lng: lo });
      } catch (e) { return res.status(502).json({ error: 'خدمة البحث مش متاحة دلوقتي' }); }
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.json(out);
  }));
}
module.exports = { register, _cache: cache };
