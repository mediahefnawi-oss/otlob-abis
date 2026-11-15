/**
 * "Coming soon" opening screen. The owner's settings are kept inside the existing maintenance message
 * (a short JSON text with a prefix), so a plain-text maintenance message keeps working exactly as before
 * and nothing changes on the server.
 */
export type SoonCfg = {
  m: string;      // the big headline message
  at: number;     // opening time (ms since 1970); 0 = no countdown
  u: string;      // the download button's link (https)
  sup: boolean;   // show the support button
  ad: string;     // optional banner id to use instead of the built-in picture ('' = built-in)
  av: number;     // that banner's version
  pl: string;     // pill text
  br: string;     // small brand line under the logo
  wl: string;     // text before the opening time
  cl: string;     // countdown title
  dn: string;     // text when the time has come
  dl: string;     // download button text
  sp: string;     // support button text
  wa: string;     // welcome title (Arabic)
  we: string;     // welcome line (English)
  rb: string;     // gold ribbon text
};

/** Every text the owner can replace, with its default (a text equal to the default is not stored). */
export const SOON_TEXT_DEFAULTS = {
  pl: 'قريبًا جدًا في منطقتك',
  br: 'OTLOBABIS',
  wl: 'وهنبدأ الشغل',
  cl: '⏳ باقي على الافتتاح',
  dn: '🎉 بنفتح حالًا.. ثواني!',
  dl: 'حمّل التطبيق الآن',
  sp: 'تواصل معنا',
  wa: 'أهلاً بيك في أبيس',
  we: 'WELCOME TO ABIS',
  rb: 'كل خدماتك.. أقرب ليك.',
} as const;
export type SoonTextKey = keyof typeof SOON_TEXT_DEFAULTS;
export const SOON_TEXT_KEYS = Object.keys(SOON_TEXT_DEFAULTS) as SoonTextKey[];
const TEXT_MAX = 40;
const tx = (v: any, k: SoonTextKey) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, TEXT_MAX) : SOON_TEXT_DEFAULTS[k]);

const PREFIX = 'SOON1:';
export const DEFAULT_SOON_MSG = 'حمّلوا التطبيق وجهّزوا حساباتكم';

export function parseSoon(text: string | undefined | null): SoonCfg | null {
  const s = String(text || '');
  if (!s.startsWith(PREFIX)) return null;
  try {
    const j = JSON.parse(s.slice(PREFIX.length));
    return {
      m: typeof j.m === 'string' && j.m.trim() ? j.m.trim().slice(0, 120) : DEFAULT_SOON_MSG,
      at: Number.isFinite(j.at) ? Number(j.at) : 0,
      u: typeof j.u === 'string' && /^https:\/\/[^\s]+$/i.test(j.u) ? j.u : '',
      sup: j.sup !== false,
      ad: typeof j.ad === 'string' ? j.ad.slice(0, 12) : '',
      av: Number.isFinite(j.av) ? Number(j.av) : 0,
      pl: tx(j.pl, 'pl'), br: tx(j.br, 'br'), wl: tx(j.wl, 'wl'), cl: tx(j.cl, 'cl'), dn: tx(j.dn, 'dn'), dl: tx(j.dl, 'dl'), sp: tx(j.sp, 'sp'), wa: tx(j.wa, 'wa'), we: tx(j.we, 'we'), rb: tx(j.rb, 'rb'),
    };
  } catch {
    return null;
  }
}

/** The text that is stored (the server keeps up to 500 characters). */
export function buildSoon(c: SoonCfg): string {
  const o: any = { m: c.m.trim().slice(0, 120), at: Math.round(c.at) || 0, u: c.u.trim().slice(0, 200), sup: !!c.sup, ad: c.ad || '', av: c.av || 0 };
  for (const k of SOON_TEXT_KEYS) {
    const v = String((c as any)[k] || '').trim().slice(0, TEXT_MAX);
    if (v && v !== SOON_TEXT_DEFAULTS[k]) o[k] = v;
  }
  return PREFIX + JSON.stringify(o);
}

export function pad2(n: number) { return n < 10 ? `0${n}` : String(n); }

/** Time left split into days / hours / minutes / seconds (all 0 once the time has come). */
export function countdown(at: number, now = Date.now()) {
  const left = Math.max(0, Math.floor((at - now) / 1000));
  return { left, d: Math.floor(left / 86400), h: Math.floor((left % 86400) / 3600), m: Math.floor((left % 3600) / 60), s: left % 60 };
}

const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const WEEK = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

export function timeLabel(at: number) {
  const d = new Date(at);
  const h = d.getHours();
  const m = d.getMinutes();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const part = h < 12 ? 'الصبح' : h < 17 ? 'العصر' : h < 20 ? 'المغرب' : 'بالليل';
  return `${h12}${m ? ':' + pad2(m) : ''} ${part}`;
}

/** "بكرا الساعة 3 العصر" / "النهاردة الساعة 3 العصر" / "الاثنين 16 نوفمبر الساعة 3 العصر" */
export function whenLabel(at: number, now = Date.now()) {
  const d = new Date(at);
  const a = new Date(now); a.setHours(0, 0, 0, 0);
  const b = new Date(at); b.setHours(0, 0, 0, 0);
  const diff = Math.round((b.getTime() - a.getTime()) / 86400000);
  const day = diff === 0 ? 'النهاردة' : diff === 1 ? 'بكرا' : `${WEEK[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return `${day} الساعة ${timeLabel(at)}`;
}

/** Owner input helpers: "2026-11-16" + "15:00" (the owner's own clock) → ms; NaN when not valid. */
export function parseWhen(date: string, time: string): number {
  const dm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date.trim());
  const tm = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!dm || !tm) return NaN;
  const y = +dm[1], mo = +dm[2], d = +dm[3], h = +tm[1], mi = +tm[2];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return NaN;
  const t = new Date(y, mo - 1, d, h, mi, 0, 0);
  return t.getMonth() === mo - 1 ? t.getTime() : NaN;
}
export function dateText(at: number) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function clockText(at: number) {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
