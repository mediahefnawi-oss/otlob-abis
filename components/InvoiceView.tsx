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
const LOGO = require('../assets/brand/logo.png');
const LOGO_BW = require('../assets/brand/logo_bw.png');
export const KIND_TITLE: Record<string, string> = { customer: 'فاتورة', provider: 'فاتورة مقدم خدمة', courier: 'فاتورة مندوب', commission: 'فاتورة عمولة' };
const widthPx = (w: string) => (w === '58' ? 264 : w === '80' ? 384 : 400);
export const paperMm = (w: string) => (w === '58' ? 58 : 80);
const n2 = (n: number) => String(Math.round(n * 100) / 100);

export function stampSource(ref: string, bw: boolean, uploaded: InvStamp[]) {
  if (ref.startsWith('b:')) { const b = BUILTIN[ref.slice(2)]; return b ? (bw ? b.bw : b.c) : null; }
  const u = uploaded.find((s) => 'u:' + s.id === ref);
  return u ? { uri: u.image } : null;
}

export const InvoiceView = forwardRef<View, { inv: Pick<Invoice, 'number' | 'kind' | 'partyName' | 'partyPhone' | 'lines' | 'extras' | 'delivery' | 'discount' | 'total' | 'commission' | 'design' | 'stamps' | 'createdAt'> & { voided?: boolean }; stamps: InvStamp[] }>(
  function InvoiceView({ inv, stamps }, ref) {
    const d: InvDesign = inv.design;
    const bw = d.theme === 'bw';
    const W = widthPx(d.width);
    const small = d.width === '58';
    const ink = bw ? '#000' : '#00211A', sub = bw ? '#000' : '#5B6B65', accent = bw ? '#000' : '#C98F0A', line = bw ? '#000' : '#D9DED9';
    const fs = (x: number) => (small ? x - 1.5 : x);
    const [h, setH] = useState(0);
    const date = new Date(inv.createdAt);
    const when = `${date.toLocaleDateString('ar-EG')} • ${date.toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' })}`;
    const subtotal = inv.lines.reduce((s, l) => s + l.qty * l.price, 0);
    const Row = ({ a, b, bold, big }: { a: string; b: string; bold?: boolean; big?: boolean }) => (
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 2 }}>
        <T w={bold ? 'black' : 'regular'} size={fs(big ? 17 : 13)} color={ink}>{a}</T>
        <T w={bold ? 'black' : 'bold'} size={fs(big ? 17 : 13)} color={ink}>{b}</T>
      </View>
    );
    const Rule = () => <View style={{ height: 0, borderTopWidth: 1.5, borderTopColor: line, borderStyle: bw ? 'dashed' : 'solid', marginVertical: 8 }} />;
    const c = inv.commission;
    return (
      <View ref={ref} collapsable={false} onLayout={(e) => setH(e.nativeEvent.layout.height)} style={{ width: W, backgroundColor: '#fff', paddingHorizontal: small ? 12 : 18, paddingVertical: 16 }}>
        {d.showLogo && (
          <View style={{ alignItems: 'center', gap: 2 }}>
            <Image source={bw ? LOGO_BW : LOGO} style={{ width: small ? 120 : 150, height: small ? 56 : 70 }} resizeMode="contain" />
            {!!d.tagline && <T w="bold" size={fs(11.5)} color={sub} align="center">{d.tagline}</T>}
          </View>
        )}
        <Rule />
        <View style={{ alignItems: 'center', gap: 2 }}>
          <T w="black" size={fs(18)} color={ink} align="center">{KIND_TITLE[inv.kind]}{inv.voided ? ' (ملغاة)' : ''}</T>
          <T w="bold" size={fs(13)} color={accent}>رقم {inv.number}</T>
          <T size={fs(11.5)} color={sub}>{when}</T>
        </View>
        {d.showParty && (
          <>
            <Rule />
            <Row a={inv.kind === 'commission' ? 'المطلوب من' : 'السيد'} b={inv.partyName} bold />
            {!!inv.partyPhone && <Row a="الموبايل" b={inv.partyPhone} />}
          </>
        )}
        <Rule />
        {inv.kind === 'commission' && c ? (
          <View>
            <Row a="الفترة" b={`${c.from} ← ${c.to}`} />
            {c.orders > 0 && <Row a="عدد الطلبات" b={String(c.orders)} />}
            {c.base > 0 && <Row a="إجمالي المبيعات" b={`${n2(c.base)} ج.م`} />}
            {c.percent != null && <Row a="نسبة العمولة" b={`${c.percent}%`} />}
            <Row a="العمولة المستحقة" b={`${n2(c.commission)} ج.م`} />
            {c.settled > 0 && <Row a="مدفوع سابقاً" b={`- ${n2(c.settled)} ج.م`} />}
          </View>
        ) : (
          <View>
            <View style={{ flexDirection: 'row', paddingBottom: 4 }}>
              <T w="black" size={fs(12)} color={ink} style={{ flex: 1 }}>الصنف</T>
              <T w="black" size={fs(12)} color={ink} style={{ width: 34 }} align="center">كمية</T>
              <T w="black" size={fs(12)} color={ink} style={{ width: small ? 52 : 64 }} align="left">السعر</T>
            </View>
            {inv.lines.map((l, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 2 }}>
                <T size={fs(13)} color={ink} style={{ flex: 1 }}>{l.name}</T>
                <T size={fs(13)} color={ink} style={{ width: 34 }} align="center">{n2(l.qty)}</T>
                <T w="bold" size={fs(13)} color={ink} style={{ width: small ? 52 : 64 }} align="left">{n2(l.qty * l.price)}</T>
              </View>
            ))}
            <Rule />
            <Row a="المجموع" b={`${n2(subtotal)} ج.م`} />
            {inv.delivery > 0 && <Row a="خدمة التوصيل" b={`${n2(inv.delivery)} ج.م`} />}
            {inv.discount > 0 && <Row a="الخصم" b={`- ${n2(inv.discount)} ج.م`} />}
          </View>
        )}
        <Rule />
        <Row a={inv.kind === 'commission' ? 'المطلوب سداده' : 'الإجمالي'} b={`${n2(inv.total)} ج.م`} bold big />
        {d.showPayment && !!d.payment && inv.kind === 'customer' && <Row a="طريقة الدفع" b={d.payment} />}
        {(inv.extras.length > 0 || d.fixed.length > 0) && <Rule />}
        {[...d.fixed, ...inv.extras].map((x, i) => <Row key={i} a={x.label} b={x.value} />)}
        {(d.showThanks || d.showSupport) && <Rule />}
        {d.showThanks && !!d.thanks && <T w="bold" size={fs(13)} color={ink} align="center">{d.thanks}</T>}
        {d.showSupport && (!!d.supportPhone || !!d.website) && (
          <T size={fs(11.5)} color={sub} align="center">{[d.supportPhone && `الدعم: ${d.supportPhone}`, d.website].filter(Boolean).join('  •  ')}</T>
        )}
        {inv.stamps.length > 0 && <View style={{ height: Math.round(W * 0.2) }} />}
        {/* stamps: placed by the owner anywhere on the page (centre position and width as fractions of the page) */}
        {h > 0 && inv.stamps.map((s: InvStampPlace, i) => {
          const src = stampSource(s.ref, bw, stamps);
          if (!src) return null;
          const sz = s.size * W;
          return <Image key={i} source={src} resizeMode="contain" style={{ position: 'absolute', width: sz, height: sz, left: s.x * W - sz / 2, top: s.y * h - sz / 2 }} />;
        })}
      </View>
    );
  });
