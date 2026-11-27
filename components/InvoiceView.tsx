import React, { forwardRef, useState } from 'react';
import { View, Image } from 'react-native';
import { T } from './ui';
import type { Invoice, InvDesign, InvStamp, InvStampPlace } from '../lib/api';

/* The invoice as a picture. Everything is drawn here once: the same view is shown on screen, shared to WhatsApp and printed. */
export const BUILTIN: Record<string, { c: any; bw: any; label: string }> = {
  circle: { c: require('../assets/stamps/circle-c.png'), bw: require('../assets/stamps/circle-bw.png'), label: 'ختم دائري' },
  rect: { c: require('../assets/stamps/rect-c.png'), bw: require('../assets/stamps/rect-bw.png'), label: 'ختم رسمي مستطيل' },
  logo: { c: require('../assets/stamps/logo-c.png'), bw: require('../assets/stamps/logo-bw.png'), label: 'شعار واسم' },
  gold: { c: require('../assets/stamps/gold-c.png'), bw: require('../assets/stamps/gold-bw.png'), label: 'ختم ذهبي' },
};
const LOGO = require('../assets/brand/logo_dark.png');
const LOGO_BW = require('../assets/brand/logo_bw.png');
/** the invoice number is made by the app: AB + year-month + the running number, e.g. AB-2611-0042 */
export const fmtNo = (n: number, at: number) => { const d = new Date(at); return `AB-${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}-${String(n).padStart(4, '0')}`; };
export const KIND_TITLE: Record<string, string> = { customer: 'فاتورة', provider: 'فاتورة مقدم خدمة', courier: 'فاتورة مندوب', commission: 'فاتورة عمولة' };
// thermal printers: 80 mm paper prints 72 mm = 576 dots, 58 mm paper prints 48 mm = 384 dots (the picture is made at exactly that width)
const widthPx = (w: string) => (w === '58' ? 384 : w === '80' ? 576 : 410);
export const paperMm = (w: string) => (w === '58' ? 48 : 72);
export const paperName = (w: string) => (w === '58' ? 58 : 80);
const n2 = (n: number) => String(Math.round(n * 100) / 100);

export function stampSource(ref: string, bw: boolean, uploaded: InvStamp[]) {
  if (ref.startsWith('b:')) { const b = BUILTIN[ref.slice(2)]; return b ? (bw ? b.bw : b.c) : null; }
  const u = uploaded.find((s) => 'u:' + s.id === ref);
  return u ? { uri: u.image } : null;
}

export const InvoiceView = forwardRef<View, { inv: Pick<Invoice, 'number' | 'kind' | 'partyName' | 'partyPhone' | 'lines' | 'extras' | 'delivery' | 'discount' | 'total' | 'commission' | 'design' | 'stamps' | 'createdAt'> & { voided?: boolean }; stamps: InvStamp[]; theme?: 'color' | 'bw'; paper?: 'wa' | '80' | '58' }>(
  function InvoiceView({ inv, stamps, theme, paper }, ref) {
    const d: InvDesign = { ...inv.design, ...(theme ? { theme } : {}), ...(paper ? { width: paper } : {}) };
    const bw = d.theme === 'bw';
    const W = widthPx(d.width);
    const k = W / 410; // the approved design is drawn at 410 and scales to the paper: 80 mm = 576 dots, 58 mm = 384 dots
    const ink = bw ? '#000' : '#00251C', gold = bw ? '#000' : '#C9921A', band = '#00251C';
    const f = (x: number) => x * k;
    const [h, setH] = useState(0);
    const date = new Date(inv.createdAt);
    const day = `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
    const time = date.toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' });
    const subtotal = inv.lines.reduce((s, l) => s + l.qty * l.price, 0);
    const c = inv.commission;
    const Dash = () => <View style={{ height: 0, borderTopWidth: f(2.5), borderTopColor: gold, borderStyle: 'dashed', marginVertical: f(10) }} />;
    const R2 = ({ a, b }: { a: string; b: string }) => (
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: f(2) }}>
        <T w="bold" size={f(15)} color={ink}>{a}</T><T w="bold" size={f(15)} color={ink}>{b}</T>
      </View>
    );
    const cols = { q: '14%', p: '19%', t: '21%' } as const;
    const Cell = ({ w, children, head, right }: { w?: string; children: any; head?: boolean; right?: boolean }) => (
      <View style={{ width: w as any, flex: w ? undefined : 1 }}><T w={head ? 'black' : 'bold'} size={f(head ? 13 : 14)} color={ink} align={right ? 'right' : 'left'}>{children}</T></View>
    );
    const rows = [...inv.lines.map((l) => [l.name, l.qty, l.price, l.qty * l.price]), ...(inv.kind === 'customer' && inv.delivery > 0 ? [['خدمة التوصيل', 1, inv.delivery, inv.delivery]] : [])];
    const sep = (i: number) => ({ borderBottomWidth: 1, borderBottomColor: ink, borderStyle: 'dotted' as const, paddingVertical: f(5), paddingHorizontal: f(2), flexDirection: 'row' as const, opacity: 1 });
    return (
      <View ref={ref} collapsable={false} onLayout={(e) => setH(e.nativeEvent.layout.height)} style={{ width: W, backgroundColor: '#fff', paddingHorizontal: f(24), paddingBottom: f(24), overflow: 'hidden' }}>
        {d.showLogo ? (
          <View style={{ alignItems: 'center', marginHorizontal: f(-24), paddingHorizontal: f(24), paddingTop: f(16), paddingBottom: f(12), marginBottom: f(12), backgroundColor: bw ? '#fff' : band, borderBottomWidth: bw ? 0 : f(5), borderBottomColor: '#F2B51D' }}>
            <Image source={bw ? LOGO_BW : LOGO} style={{ width: f(210), height: f(98) }} resizeMode="contain" />
            {!!d.tagline && <T w="black" size={f(15)} color={bw ? '#000' : '#F2B51D'} align="center">{d.tagline}</T>}
          </View>
        ) : <View style={{ height: f(22) }} />}
        {d.showSupport && (!!d.supportPhone || !!d.website) && (
          <View style={{ alignItems: 'center' }}>
            {!!d.supportPhone && <T w="bold" size={f(12.5)} color={ink} align="center">واتساب الدعم: {d.supportPhone}</T>}
            {!!d.website && <T w="bold" size={f(12.5)} color={ink} align="center">{d.website}</T>}
          </View>
        )}
        <Dash />
        <T w="black" size={f(21)} color={ink} align="center">{KIND_TITLE[inv.kind]}</T>
        <Dash />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <View>
            <T w="bold" size={f(13.5)} color={ink}>رقم الفاتورة: {fmtNo(inv.number, inv.createdAt)}</T>
            {d.showParty && <T w="bold" size={f(13.5)} color={ink}>{inv.kind === 'customer' ? 'العميل' : inv.kind === 'commission' ? 'المطلوب من' : 'الاسم'}: {inv.partyName}</T>}
            {d.showParty && !!inv.partyPhone && <T w="bold" size={f(13.5)} color={ink}>الموبايل: {inv.partyPhone}</T>}
          </View>
          <View>
            <T w="bold" size={f(13.5)} color={ink} align="left">{day}</T>
            <T w="bold" size={f(13.5)} color={ink} align="left">{time}</T>
          </View>
        </View>
        <View style={{ height: 0, borderTopWidth: f(4), borderTopColor: gold, borderStyle: 'solid', marginVertical: f(9), borderBottomWidth: f(1), borderBottomColor: gold }} />
        {inv.kind === 'commission' && c ? (
          <View>
            <R2 a="الفترة" b={`${c.from} ← ${c.to}`} />
            {c.orders > 0 && <R2 a="عدد الطلبات" b={String(c.orders)} />}
            {c.base > 0 && <R2 a="إجمالي المبيعات" b={n2(c.base)} />}
            {c.percent != null && <R2 a="نسبة العمولة" b={`${c.percent}%`} />}
            <R2 a="العمولة المستحقة" b={n2(c.commission)} />
            {c.settled > 0 && <R2 a="مدفوع سابقاً" b={`- ${n2(c.settled)}`} />}
          </View>
        ) : (
          <View>
            <View style={{ flexDirection: 'row', backgroundColor: bw ? '#fff' : '#F6F1E3', borderBottomWidth: f(2.5), borderBottomColor: ink, paddingVertical: f(4), paddingHorizontal: f(2) }}>
              <Cell head right>الصنف</Cell><Cell head w={cols.q}>كمية</Cell><Cell head w={cols.p}>سعر</Cell><Cell head w={cols.t}>إجمالي</Cell>
            </View>
            {rows.map((r, i) => (
              <View key={i} style={sep(i)}>
                <Cell right>{r[0] as string}</Cell><Cell w={cols.q}>{n2(r[1] as number)}</Cell><Cell w={cols.p}>{n2(r[2] as number)}</Cell><Cell w={cols.t}>{n2(r[3] as number)}</Cell>
              </View>
            ))}
            <Dash />
            <R2 a="إجمالي الأصناف" b={n2(subtotal)} />
            {inv.kind === 'customer' && <R2 a="خدمة التوصيل" b={n2(inv.delivery)} />}
            <R2 a="الخصم" b={n2(inv.discount)} />
          </View>
        )}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: ink, paddingVertical: f(8), paddingHorizontal: f(12), marginVertical: f(8) }}>
          <T w="black" size={f(22)} color={bw ? '#fff' : '#F2B51D'}>{inv.kind === 'commission' ? 'المطلوب سداده' : 'الإجمالي'}</T>
          <T w="black" size={f(22)} color={bw ? '#fff' : '#F2B51D'}>{n2(inv.total)} ج.م</T>
        </View>
        {d.showPayment && !!d.payment && inv.kind === 'customer' && <T w="bold" size={f(13)} color={ink} align="center">الدفع: {d.payment}</T>}
        {[...d.fixed, ...inv.extras].length > 0 && (<><Dash />{[...d.fixed, ...inv.extras].map((x, i) => <R2 key={i} a={x.label} b={x.value} />)}</>)}
        {d.showThanks && !!d.thanks && (<><Dash /><T w="black" size={f(16)} color={ink} align="center">{d.thanks}</T></>)}
        {inv.stamps.length > 0 && <View style={{ height: f(120) }} />}
        <T size={f(11)} color={gold} align="center" style={{ marginTop: f(10) }}>✂ - - - - - - - - - - - - - - - - - -</T>
        {/* stamps: placed anywhere on the page (centre position and width as fractions of the page) */}
        {h > 0 && inv.stamps.map((s: InvStampPlace, i) => {
          const src = stampSource(s.ref, bw, stamps);
          if (!src) return null;
          const sz = s.size * W;
          return <Image key={i} source={src} resizeMode="contain" style={{ position: 'absolute', width: sz, height: sz, left: s.x * W - sz / 2, top: s.y * h - sz / 2 }} />;
        })}
      </View>
    );
  });
