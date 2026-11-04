// Opening hours: the server rules and the app rules must give identical answers. Run: bun tests/hours.test.js
const H = require('../src/hours.js');
const A = require('../../lib/hours.ts');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)} expected ${JSON.stringify(b)}`);

// Cairo local time -> ms (offset +2, winter)
const at = (y, mo, d, h, mi, off = 2) => Date.UTC(y, mo - 1, d, h, mi) - off * 3600000;
// 2026-11-04 is a Wednesday (dow 3)
const sched = { enabled: true, openTime: '10:00', closeTime: '00:00', days: [0, 1, 2, 3, 4, 5, 6], graceMin: 30, message: 'x {وقت_الفتح}' };
const ph = (h, t, off = 2) => H.phaseAt(h, t, off * 60).phase;

// basic day
eq(ph(sched, at(2026, 11, 4, 9, 59)), 'closed', 'before opening');
eq(ph(sched, at(2026, 11, 4, 10, 0)), 'open', 'at opening');
eq(ph(sched, at(2026, 11, 4, 23, 59)), 'open', 'just before closing (midnight)');
eq(ph(sched, at(2026, 11, 5, 0, 0)), 'grace', 'just after closing');
eq(ph(sched, at(2026, 11, 5, 0, 29)), 'grace', 'end of grace');
eq(ph(sched, at(2026, 11, 5, 0, 30)), 'closed', 'after grace');
eq(ph(sched, at(2026, 11, 5, 9, 59)), 'closed', 'night');
// disabled = always open
eq(ph({ ...sched, enabled: false }, at(2026, 11, 5, 3, 0)), 'open', 'disabled');
// same-day close
const day = { ...sched, closeTime: '22:00' };
eq(ph(day, at(2026, 11, 4, 21, 59)), 'open', 'same-day open');
eq(ph(day, at(2026, 11, 4, 22, 10)), 'grace', 'same-day grace');
eq(ph(day, at(2026, 11, 4, 22, 31)), 'closed', 'same-day closed');
// a window running past midnight to 02:00
const late = { ...sched, closeTime: '02:00' };
eq(ph(late, at(2026, 11, 5, 1, 0)), 'open', 'after midnight still open');
eq(ph(late, at(2026, 11, 5, 2, 10)), 'grace', 'grace after 02:00');
// off day: Friday (5) closed. 2026-11-06 is a Friday
const noFri = { ...sched, closeTime: '22:00', days: [0, 1, 2, 3, 4, 6] };
eq(ph(noFri, at(2026, 11, 6, 12, 0)), 'closed', 'friday closed');
const nx = H.phaseAt(noFri, at(2026, 11, 6, 12, 0), 120).next;
eq([nx.dayDiff, nx.minuteOfDay, nx.dow], [1, 600, 6], 'next open is Saturday 10:00');
eq(H.renderMessage({ message: 'يفتح {يوم_الفتح} {وقت_الفتح}' }, nx), 'يفتح غداً 10:00 صباحاً', 'message tokens');
// window starting on an off day does not run into the next day
const oddWin = { ...sched, closeTime: '02:00', days: [3] }; // wednesdays only, 10:00 -> 02:00 Thursday
eq(ph(oddWin, at(2026, 11, 5, 1, 0)), 'open', 'wednesday window runs to thursday 02:00');
eq(ph(oddWin, at(2026, 11, 5, 11, 0)), 'closed', 'thursday itself closed');
// no working day
eq(ph({ ...sched, days: [] }, at(2026, 11, 4, 12, 0)), 'closed', 'no days');
// open == close means 24h
eq(ph({ ...sched, closeTime: '10:00' }, at(2026, 11, 4, 3, 0)), 'open', '24h');
// bad time falls back to open (never lock everybody out because of a typo)
eq(ph({ ...sched, openTime: 'abc' }, at(2026, 11, 4, 3, 0)), 'open', 'bad time');
// labels
eq(H.timeLabel(600), '10:00 صباحاً', 'label morning'); eq(H.timeLabel(0), '12:00 منتصف الليل', 'label midnight');
eq(H.timeLabel(12 * 60), '12:00 مساءً', 'label noon'); eq(H.timeLabel(21 * 60 + 5), '9:05 مساءً', 'label evening');
// roles
eq(H.allowed('grace', 'courier'), true, 'courier in grace'); eq(H.allowed('grace', 'customer'), false, 'customer in grace');
eq(H.allowed('closed', 'provider'), false, 'provider closed'); eq(H.allowed('closed', 'admin'), true, 'admin always');
eq(H.allowed('closed', undefined), false, 'anonymous closed');
// Cairo offset: winter +2, summer +3
eq(H.cairoOffsetMin(Date.UTC(2026, 0, 15, 12, 0)), 120, 'offset winter');
eq(H.cairoOffsetMin(Date.UTC(2026, 6, 15, 12, 0)), 180, 'offset summer');
// input checks
eq(H.parseInput({ openTime: '9:5' }).ok, false, 'bad input time');
eq(H.parseInput({ openTime: '9:05', graceMin: 45, openDays: [6, 0, 0, 9] }).value, { open_time: '09:05', open_days: '0,6', grace_min: 45 }, 'clean input');
eq(H.parseInput({ graceMin: 500 }).ok, false, 'bad grace'); eq(H.parseInput({ closedMessage: 'x' }).ok, false, 'short message');

// server and app agree on 20000 random moments with random schedules
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
let same = 0;
for (let i = 0; i < 20000; i++) {
  const h = { enabled: true, openTime: H.toMin('00:00') !== null ? `${String(Math.floor(rnd() * 24)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}` : '', closeTime: `${String(Math.floor(rnd() * 24)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`, days: [0, 1, 2, 3, 4, 5, 6].filter(() => rnd() > 0.3), graceMin: Math.floor(rnd() * 90), message: 'm' };
  const t = Date.UTC(2026, 0, 1) + Math.floor(rnd() * 400 * 86400000);
  const off = H.cairoOffsetMin(t);
  const a = JSON.stringify(H.phaseAt(h, t, off)), b = JSON.stringify(A.phaseAt(h, t, off));
  if (a === b) same++; else if (fail < 5) { fail++; console.log('MISMATCH', JSON.stringify(h), t, a, b); }
}
ok(same === 20000, `server/app agree (${same}/20000)`);
eq(A.renderMessage({ message: 'a {وقت_الفتح} {يوم_الفتح}' }, { dayDiff: 1, minuteOfDay: 600, dow: 4 }), H.renderMessage({ message: 'a {وقت_الفتح} {يوم_الفتح}' }, { dayDiff: 1, minuteOfDay: 600, dow: 4 }), 'same message');
console.log(`hours tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
