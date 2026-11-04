/**
 * Opening hours ("مواعيد التشغيل"), client side. Mirrors backend/src/hours.js (the tests compare both).
 * All times are Cairo local time; the server sends the current Cairo offset so the phone never needs time-zone data.
 */
export interface Hours {
  enabled: boolean;
  openTime: string; // "10:00"
  closeTime: string; // "00:00"
  days: number[]; // 0 = Sunday ... 6 = Saturday
  graceMin: number;
  message: string;
}
export type HoursPhase = 'open' | 'grace' | 'closed';
export interface NextOpen { dayDiff: number; minuteOfDay: number; dow: number }

const DAY = 1440;
export const DEFAULT_CLOSED_MESSAGE = 'تم إغلاق التطبيق، سيتم التشغيل الساعة {وقت_الفتح}';
const STAFF = ['provider', 'courier', 'supervisor'];
const DOW = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export const toMin = (s: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h > 23 || mi > 59 ? null : h * 60 + mi;
};
export const fmtTime = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const normDays = (v: unknown): number[] => {
  const a = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
  return [...new Set(a.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((x, y) => x - y);
};

export function phaseAt(h: Hours | null | undefined, nowMs: number, offsetMin: number): { phase: HoursPhase; next: NextOpen | null } {
  const open = { phase: 'open' as HoursPhase, next: null };
  if (!h || !h.enabled) return open;
  const o = toMin(h.openTime), c = toMin(h.closeTime);
  if (o == null || c == null) return open;
  const days = normDays(h.days);
  if (!days.length) return { phase: 'closed', next: null };
  const grace = Math.max(0, Number(h.graceMin) || 0);
  const local = Math.floor(nowMs / 60000) + offsetMin;
  const today = Math.floor(local / DAY);
  const wins: Array<[number, number]> = [];
  for (let dd = -1; dd <= 8; dd++) {
    const day = today + dd;
    if (!days.includes((((day + 4) % 7) + 7) % 7)) continue;
    const start = day * DAY + o;
    const len = c > o ? c - o : c === o ? DAY : c + DAY - o;
    wins.push([start, start + len]);
  }
  if (wins.some(([s, e]) => s <= local && local < e)) return open;
  const nextStart = wins.map((w) => w[0]).filter((s) => s > local).sort((x, y) => x - y)[0];
  const next: NextOpen | null = nextStart == null ? null : { dayDiff: Math.floor(nextStart / DAY) - today, minuteOfDay: nextStart - Math.floor(nextStart / DAY) * DAY, dow: (((Math.floor(nextStart / DAY) + 4) % 7) + 7) % 7 };
  const inGrace = wins.some(([, e]) => e <= local && local < e + grace);
  return { phase: inGrace ? 'grace' : 'closed', next };
}

export function timeLabel(min: number): string {
  if (min === 0) return '12:00 منتصف الليل';
  const h = Math.floor(min / 60), m = min % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'صباحاً' : 'مساءً'}`;
}
export const dayLabel = (next: NextOpen | null) => (!next ? '' : next.dayDiff === 0 ? 'اليوم' : next.dayDiff === 1 ? 'غداً' : `يوم ${DOW[next.dow]}`);

export function renderMessage(h: Pick<Hours, 'message'> | null | undefined, next: NextOpen | null): string {
  const text = String((h && h.message) || DEFAULT_CLOSED_MESSAGE);
  return text.replace(/\{وقت_الفتح\}/g, next ? timeLabel(next.minuteOfDay) : '').replace(/\{يوم_الفتح\}/g, dayLabel(next)).trim();
}

/** may this role work in this phase? (the owner always can; a person who is not signed in counts as a customer) */
export function allowedIn(phase: HoursPhase, role: string | null | undefined): boolean {
  if (role === 'admin') return true;
  return phase === 'open' || (phase === 'grace' && !!role && STAFF.includes(role));
}
