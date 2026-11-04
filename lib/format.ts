import { OrderStatus, ApptStatus, ProviderType, ServiceTemplate, ServiceDef } from './types';
import { C } from './theme';

export const money = (n: number) => `${Math.round(n * 100) / 100} ج.م`;

const pad = (n: number) => String(n).padStart(2, '0');
export const fmtDate = (t: number) => {
  const d = new Date(t);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
};
export const fmtTime = (t: number) => {
  const d = new Date(t);
  let h = d.getHours();
  const ap = h >= 12 ? 'م' : 'ص';
  h = h % 12 || 12;
  return `${h}:${pad(d.getMinutes())} ${ap}`;
};
export const fmtDateTime = (t: number) => `${fmtDate(t)} • ${fmtTime(t)}`;
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export const dayName = (iso: string) => DAYS[new Date(iso + 'T12:00:00').getDay()];
export const prettyIso = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${dayName(iso)} ${Number(d)}/${Number(m)}/${y}`;
};
export const isToday = (t: number) => isoDay(new Date(t)) === isoDay(new Date());

export interface TypeInfo { label: string; single: string; icon: string; emoji: string; color: string; soft: string; template: ServiceTemplate }
const BASE_TYPES: Record<string, TypeInfo> = {
  restaurant: { label: 'المطاعم', single: 'مطعم', icon: 'restaurant', emoji: '🍔', color: C.orange, soft: C.orangeSoft, template: 'cart' },
  supermarket: { label: 'السوبر ماركت', single: 'سوبر ماركت', icon: 'cart', emoji: '🛒', color: C.green, soft: C.greenSoft, template: 'request' },
  pharmacy: { label: 'الصيدليات', single: 'صيدلية', icon: 'medkit', emoji: '💊', color: C.blue, soft: C.blueSoft, template: 'request' },
  clinic: { label: 'حجز العيادات', single: 'عيادة', icon: 'pulse', emoji: '🩺', color: '#8A5CD1', soft: '#EFE6FB', template: 'booking' },
  store: { label: 'متاجر', single: 'متجر', icon: 'storefront', emoji: '🏬', color: '#0E9AA7', soft: '#DDF3F5', template: 'cart' },
  maker: { label: 'صُنّاع أبيس', single: 'صانع', icon: 'color-palette', emoji: '🧵', color: '#D6457F', soft: '#FBE3EC', template: 'maker' },
};
const FALLBACK_TYPE: TypeInfo = { label: 'خدمة', single: 'خدمة', icon: 'storefront', emoji: '🛍️', color: '#0E9AA7', soft: '#DDF3F5', template: 'cart' };
const EXTRA_COLORS: [string, string][] = [['#0E9AA7', '#DDF3F5'], ['#D6457F', '#FBE3EC'], ['#8A5CD1', '#EFE6FB'], ['#2E7D32', '#E3F3E4'], ['#E4572E', '#FDE6DE']];
/** The services (name, icon, template). It is a live object: applyServices() updates it when the owner changes something. Unknown keys read as a basket service. */
export const TYPES = new Proxy(BASE_TYPES, { get: (t, k) => (typeof k === 'string' ? (k in t ? t[k] : FALLBACK_TYPE) : (t as any)[k]) }) as Record<ProviderType, TypeInfo>;
export const TEMPLATE_LABEL: Record<ServiceTemplate, string> = { cart: 'منتجات وسلة', request: 'طلب مكتوب', booking: 'حجز مواعيد', maker: 'منتجات + طلب خاص', lab: 'معمل تحاليل' };
let SERVICE_DEFS: ServiceDef[] = [];
/** Take the owner's service list (from the catalog) and update TYPES. The errand service is kept apart: it has no providers. */
export function applyServices(list?: ServiceDef[]) {
  if (!list || !list.length) return;
  SERVICE_DEFS = list;
  const prev = { ...BASE_TYPES };
  for (const k of Object.keys(BASE_TYPES)) delete BASE_TYPES[k];
  let extra = 0;
  for (const s of list) {
    if (s.template === 'errand') continue;
    const old = prev[s.key];
    const col = old ? [old.color, old.soft] : EXTRA_COLORS[extra++ % EXTRA_COLORS.length];
    BASE_TYPES[s.key] = { label: s.label, single: s.single, icon: old ? old.icon : 'storefront', emoji: s.emoji, color: col[0], soft: col[1], template: s.template as ServiceTemplate };
  }
}
export const serviceDefs = () => SERVICE_DEFS;
/** the errand service ("اطلب إيه؟ نجيبهولك") as the owner arranged it */
export const errandDef = (): ServiceDef => SERVICE_DEFS.find((s) => s.template === 'errand') || { key: 'errand', label: 'اطلب إيه؟ نجيبهولك', single: 'طلب خاص', emoji: '🎁', template: 'errand', order: 999, size: 'large', active: true, showHome: true, canProducts: false, builtin: true };
/** the keys of every provider service, in the owner's order */
export const typeKeys = () => Object.keys(BASE_TYPES) as ProviderType[];
export const tplOf = (type?: string): ServiceTemplate => (type && BASE_TYPES[type] ? BASE_TYPES[type].template : 'cart');
/** appointment-style services: clinics and medical labs share the bookings screens, invoices and commission */
export const isBooking = (type?: string) => { const t = tplOf(type); return t === 'booking' || t === 'lab'; };
export const isLab = (type?: string) => tplOf(type) === 'lab';
export const isRequestOnly = (type?: string) => tplOf(type) === 'request';
export const isMakerTpl = (type?: string) => tplOf(type) === 'maker';
/** may the provider of this service add products */
export const hasProducts = (type?: string) => tplOf(type) !== 'request' && tplOf(type) !== 'lab';
export const acceptsRequests = (type?: string) => { const t = tplOf(type); return t === 'request' || t === 'maker'; };

/** "الخميس 5/11/2026 • 3:30 م" for a maker's ready day (YYYY-MM-DD) and hour (HH:mm). */
export const readyLabel = (date?: string, time?: string) => {
  if (!date) return '';
  let out = prettyIso(date);
  const m = /^(\d{2}):(\d{2})$/.exec(time || '');
  if (m) {
    const h = Number(m[1]);
    out += ` • ${h % 12 || 12}:${m[2]} ${h >= 12 ? 'م' : 'ص'}`;
  }
  return out;
};

const RAW_ORDER_STATUS: Record<OrderStatus, { label: string; color: string; soft: string; icon: string }> = {
  pending: { label: 'تم إرسال الطلب', color: C.goldDeep, soft: C.goldSoft, icon: 'time' },
  accepted: { label: 'قيد التحضير', color: C.blue, soft: C.blueSoft, icon: 'flame' },
  ready: { label: 'جاهز للاستلام', color: '#8A5CD1', soft: '#EFE6FB', icon: 'bag-check' },
  picked_up: { label: 'استلم المندوب الطلب', color: '#8A5CD1', soft: '#EFE6FB', icon: 'bag-check' },
  on_the_way: { label: 'جاري التوصيل', color: C.orange, soft: C.orangeSoft, icon: 'bicycle' },
  arrived: { label: 'وصل المندوب', color: C.green, soft: C.greenSoft, icon: 'location' },
  delivered: { label: 'تم التسليم', color: C.green, soft: C.greenSoft, icon: 'checkmark-circle' },
  rejected: { label: 'مرفوض', color: C.red, soft: C.redSoft, icon: 'close-circle' },
  cancelled: { label: 'ملغي', color: C.red, soft: C.redSoft, icon: 'close-circle' },
  quoted: { label: 'بانتظار موافقتك على الفاتورة', color: C.goldDeep, soft: C.goldSoft, icon: 'receipt' },
  unavailable: { label: 'الأصناف غير متوفرة', color: C.red, soft: C.redSoft, icon: 'alert-circle' },
};
// An unknown status (e.g. from a newer server) must never crash a screen: show it plainly instead.
export const ORDER_STATUS = new Proxy(RAW_ORDER_STATUS, {
  get: (t, k: string) => t[k as keyof typeof t] ?? { label: 'قيد المتابعة', color: C.sub, soft: C.line, icon: 'time' },
}) as typeof RAW_ORDER_STATUS;

export const APPT_STATUS: Record<ApptStatus, { label: string; color: string; soft: string }> = {
  pending: { label: 'بانتظار تأكيد العيادة', color: C.goldDeep, soft: C.goldSoft },
  confirmed: { label: 'تم تأكيد الحجز', color: C.green, soft: C.greenSoft },
  rejected: { label: 'مرفوض', color: C.red, soft: C.redSoft },
  completed: { label: 'تمت الزيارة', color: C.blue, soft: C.blueSoft },
  cancelled: { label: 'ملغي', color: C.red, soft: C.redSoft },
};

export const ACCOUNT_STATUS: Record<string, { label: string; color: string; soft: string }> = {
  active: { label: 'معتمد', color: C.green, soft: C.greenSoft },
  pending: { label: 'قيد المراجعة', color: C.goldDeep, soft: C.goldSoft },
  rejected: { label: 'مرفوض', color: C.red, soft: C.redSoft },
  suspended: { label: 'موقوف', color: C.red, soft: C.redSoft },
};

/** The owner's labels on customer accounts. */
export const FLAGS: Record<string, { label: string; icon: string; color: string; soft: string }> = {
  trusted: { label: 'حساب معتمد', icon: 'shield-checkmark', color: C.green, soft: C.greenSoft },
  watch: { label: 'تحت المراقبة', icon: 'eye', color: C.goldDeep, soft: C.goldSoft },
  fraud: { label: 'حساب احتيالي', icon: 'warning', color: C.red, soft: C.redSoft },
};

export const SPECIALTIES = ['باطنة', 'أطفال', 'أسنان', 'عيون', 'نساء وتوليد', 'عظام', 'جلدية'];
export const SPEC_EMOJI: Record<string, string> = {
  باطنة: '🩺',
  أطفال: '🧒',
  أسنان: '🦷',
  عيون: '👁️',
  'نساء وتوليد': '🤰',
  عظام: '🦴',
  جلدية: '🧴',
};
export const ALL_SLOTS = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00'];

export const normPhone = (p: string) =>
  p
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[^0-9]/g, '');

const SALT = 'abis$2026#salt';
export const hash = (s: string) => {
  const input = SALT + s + SALT;
  let h1 = 5381;
  let h2 = 52711;
  for (let r = 0; r < 600; r++) {
    for (let i = 0; i < input.length; i++) {
      const c = input.charCodeAt(i);
      h1 = Math.imul(h1, 33) ^ c ^ (h2 >>> 13);
      h2 = Math.imul(h2, 31) ^ c ^ (h1 >>> 7);
    }
  }
  return 'h' + (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
};

/** The developer lines at the bottom of the first screen (the owner can change them from the control panel). */
export const DEFAULT_CREDITS = { a: 'DESIGNED & DEVELOPED BY', b: 'ENG. AHMED EL-HEFNAWY', c: 'تصميم وتطوير وبرمجة المهندس أحمد الحفناوي', d: '© 2026 All Rights Reserved' };

/**
 * Orders run by themselves. A supervisor steps in only when the shop refused the order, cancelled it, left it unanswered for this long
 * (restaurants: only refuse / cancel), or he already took it over.
 */
export const STAFF_WAIT_MS = 30 * 1000;
export const needsStaff = (o: { status: string; updatedAt: number; staffHandled?: boolean; cancelledBy?: string; providerType?: string }) =>
  o.status === 'rejected' || !!o.staffHandled || (o.status === 'cancelled' && o.cancelledBy === 'provider')
  || (o.providerType !== 'restaurant' && o.status === 'pending' && Date.now() - o.updatedAt >= STAFF_WAIT_MS);
/** The supervisor's "needs attention" list: refused / cancelled orders stay for 24 hours. */
export const inStaffQueue = (o: { status: string; updatedAt: number; staffHandled?: boolean; cancelledBy?: string; providerType?: string }) =>
  needsStaff(o) && (['rejected', 'cancelled'].includes(o.status) ? Date.now() - o.updatedAt < 24 * 3600 * 1000 : !['delivered', 'unavailable'].includes(o.status));
