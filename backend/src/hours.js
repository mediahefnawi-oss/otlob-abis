/**
 * Opening hours ("مواعيد التشغيل"). Every time is Cairo local time.
 * The same rules are mirrored in lib/hours.ts for the app (tests/hours.test.js checks that both give the same answers).
 *
 * phase: 'open'   everybody works
 *        'grace'  the closing time has passed: customers see the closed screen, shops / couriers / supervisors keep working
 *                 for `graceMin` more minutes so orders already on the way can be finished
 *        'closed' everybody except the owner sees the closed screen
 */
const DAY = 1440;
const DEFAULT_MESSAGE = 'تم إغلاق التطبيق، سيتم التشغيل الساعة {وقت_الفتح}';
const STAFF = new Set(['provider', 'courier', 'supervisor']);
const DOW = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']; // 0 = Sunday (same as JS getDay)

const toMin = s => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h > 23 || mi > 59 ? null : h * 60 + mi;
};
const fmt = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const normDays = v => {
  const a = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
  return [...new Set(a.map(x => Number(x)).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort((x, y) => x - y);
};

/** Cairo clock for a moment: offset from UTC in minutes (2 or 3 with summer time) */
function cairoOffsetMin(nowMs) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(nowMs)).map(x => [x.type, x.value]));
  const localAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return Math.round((localAsUtc - Math.floor(nowMs / 60000) * 60000) / 60000);
}

/** the schedule as stored in app_settings */
function fromRow(r) {
  r = r || {};
  return {
    enabled: !!r.hours_enabled,
    openTime: toMin(r.open_time) == null ? '10:00' : fmt(toMin(r.open_time)),
    closeTime: toMin(r.close_time) == null ? '00:00' : fmt(toMin(r.close_time)),
    days: normDays(r.open_days == null ? '0,1,2,3,4,5,6' : r.open_days),
    graceMin: Number.isInteger(r.grace_min) ? Math.max(0, Math.min(180, r.grace_min)) : 30,
    message: String(r.closed_message || DEFAULT_MESSAGE),
  };
}

/** @returns {{phase:'open'|'grace'|'closed', next:null|{dayDiff:number, minuteOfDay:number, dow:number}}} */
function phaseAt(h, nowMs, offsetMin) {
  const open = { phase: 'open', next: null };
  if (!h || !h.enabled) return open;
  const o = toMin(h.openTime), c = toMin(h.closeTime);
  if (o == null || c == null) return open;
  const days = normDays(h.days);
  if (!days.length) return { phase: 'closed', next: null }; // no working day at all
  const grace = Math.max(0, Number(h.graceMin) || 0);
  const local = Math.floor(nowMs / 60000) + offsetMin; // minutes since 1970 in Cairo time
  const today = Math.floor(local / DAY);
  const wins = [];
  for (let dd = -1; dd <= 8; dd++) {
    const day = today + dd;
    if (!days.includes((((day + 4) % 7) + 7) % 7)) continue; // 1970-01-01 was a Thursday
    const start = day * DAY + o;
    const len = c > o ? c - o : c === o ? DAY : c + DAY - o; // a window may run past midnight; it belongs to the day it starts
    wins.push([start, start + len]);
  }
  if (wins.some(([s, e]) => s <= local && local < e)) return open;
  const nextStart = wins.map(w => w[0]).filter(s => s > local).sort((x, y) => x - y)[0];
  const next = nextStart == null ? null : { dayDiff: Math.floor(nextStart / DAY) - today, minuteOfDay: nextStart - Math.floor(nextStart / DAY) * DAY, dow: (((Math.floor(nextStart / DAY) + 4) % 7) + 7) % 7 };
  const inGrace = wins.some(([, e]) => e <= local && local < e + grace);
  return { phase: inGrace ? 'grace' : 'closed', next };
}

/** "10:00 صباحاً" */
function timeLabel(min) {
  if (min === 0) return '12:00 منتصف الليل';
  const h = Math.floor(min / 60), m = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'صباحاً' : 'مساءً'}`;
}
const dayLabel = next => (!next ? '' : next.dayDiff === 0 ? 'اليوم' : next.dayDiff === 1 ? 'غداً' : `يوم ${DOW[next.dow]}`);

/** the text the customer reads; {وقت_الفتح} = the opening time, {يوم_الفتح} = today / tomorrow / the weekday */
function renderMessage(h, next) {
  const text = String((h && h.message) || DEFAULT_MESSAGE);
  return text.replace(/\{وقت_الفتح\}/g, next ? timeLabel(next.minuteOfDay) : '').replace(/\{يوم_الفتح\}/g, dayLabel(next)).trim();
}

/** may this role work right now? (the owner always can) */
function allowed(phase, role) {
  if (role === 'admin') return true;
  return phase === 'open' || (phase === 'grace' && STAFF.has(role));
}

/** validate the owner's input; returns { ok, value } or { ok:false, error } */
function parseInput(b) {
  const out = {};
  if (b.hoursEnabled !== undefined) out.hours_enabled = !!b.hoursEnabled;
  for (const [k, col] of [['openTime', 'open_time'], ['closeTime', 'close_time']]) {
    if (b[k] === undefined) continue;
    const m = toMin(b[k]);
    if (m == null) return { ok: false, error: 'وقت غير صالح، اكتبه بالشكل 10:00' };
    out[col] = fmt(m);
  }
  if (b.openDays !== undefined) out.open_days = normDays(b.openDays).join(',');
  if (b.graceMin !== undefined) {
    const g = Number(b.graceMin);
    if (!Number.isInteger(g) || g < 0 || g > 180) return { ok: false, error: 'مدة المهلة من 0 إلى 180 دقيقة' };
    out.grace_min = g;
  }
  if (b.closedMessage !== undefined) {
    const t = String(b.closedMessage).trim().slice(0, 300);
    if (t.length < 3) return { ok: false, error: 'اكتب رسالة الغلق' };
    out.closed_message = t;
  }
  return { ok: true, value: out };
}

module.exports = { DEFAULT_MESSAGE, STAFF, cairoOffsetMin, fromRow, phaseAt, timeLabel, dayLabel, renderMessage, allowed, parseInput, toMin, normDays };
