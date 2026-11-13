import { feeFor, deliveryOpen, useStore, useMe } from '../lib/store';
import { ProviderLogo } from './Brand';
import { CourierAvatar } from './CourierPhoto';
import { schedLabel } from './Schedule';
import React from 'react';
import { View } from 'react-native';
import { Provider, Order, Appointment, Invoice } from '../lib/types';
import { C } from '../lib/theme';
import { TYPES, money, fmtDateTime, prettyIso, SPEC_EMOJI, readyLabel, isBooking } from '../lib/format';
import { Card, T, Icon, EmojiBubble, OrderPill, ApptPill, Pill, FlagPill } from './ui';
import { RatingLine, useRatingStars } from './Stars';
import { LabPill, fmt12 } from './Lab';
import { ShopOfferTag } from './Offers';

/** "في منطقتك" when the place is in the customer's own area, otherwise "منطقة X". */
export function AreaTag({ p }: { p: Pick<Provider, 'regionId' | 'regionName'> }) {
  const { db, userId } = useStore();
  const mine = !!p.regionId && db.users.find((u) => u.id === userId)?.regionId === p.regionId;
  if (!p.regionName) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Icon name="map" size={12} color={mine ? C.green : C.goldDeep} />
      <T w="bold" size={11.5} color={mine ? C.green : C.goldDeep}>{mine ? 'في منطقتك' : `منطقة ${p.regionName}`}</T>
    </View>
  );
}

export function ProviderCard({ p, onPress }: { p: Provider; onPress: () => void }) {
  const t = TYPES[p.type];
  const closed = !p.open;
  const isOwner = useMe()?.role === 'admin'; // the pin mark is for the owner only: customers just see the order
  const starsOn = useRatingStars();
  return (
    <Card onPress={onPress} style={{ flexDirection: 'row', gap: 12, alignItems: 'center', opacity: closed ? 0.75 : 1 }}>
      <ProviderLogo p={p} size={62} />
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <T w="bold" size={15.5} numberOfLines={1} style={{ flexShrink: 1 }}>{p.name}</T>
          {isOwner && p.pinRank != null && <T size={11}>📌</T>}
        </View>
        <T size={12} color={C.sub} numberOfLines={1}>{p.desc}</T>
        {!!p.regionName && <AreaTag p={p} />}
        <ShopOfferTag providerId={p.id} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 2 }}>
          {starsOn ? <RatingLine p={p} /> : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Icon name="star" size={13} color={C.gold} />
            <T w="bold" size={12}>{p.rating ? p.rating.toFixed(1) : 'جديد'}</T>
          </View>
          )}
          {isBooking(p.type) ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <Icon name="pulse" size={13} color={t.color} />
              <T size={12} color={C.sub}>{p.specialty}</T>
            </View>
          ) : (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <Icon name="time-outline" size={13} color={C.sub} />
                <T size={12} color={C.sub}>{p.eta} د</T>
              </View>
              {deliveryOpen(p) ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <Icon name="bicycle" size={14} color={C.sub} />
                  <T size={12} color={C.sub}>{feeFor(p)} ج.م</T>
                </View>
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                  <Icon name="close-circle" size={14} color={C.red} />
                  <T w="bold" size={11.5} color={C.red}>التوصيل غير متاح لمنطقتك</T>
                </View>
              )}
            </>
          )}
        </View>
      </View>
      {closed ? <Pill label="مغلق" color={C.red} soft={C.redSoft} /> : <Icon name="chevron-back" size={18} color={C.sub} />}
    </Card>
  );
}

export function OrderCard({ o, onPress, perspective, children }: { o: Order; onPress: () => void; perspective: 'customer' | 'provider' | 'courier' | 'admin'; children?: React.ReactNode }) {
  const t = o.providerType === 'custom' ? null : TYPES[o.providerType];
  const { db } = useStore();
  const prov = o.providerId ? db.providers.find((x) => x.id === o.providerId) : undefined;
  return (
    <Card onPress={onPress} style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {prov && perspective !== 'provider' && perspective !== 'courier' ? <ProviderLogo p={prov} size={44} /> : <EmojiBubble emoji={o.providerType === 'custom' ? '🎁' : t!.emoji} size={44} bg={t ? t.soft : C.goldSoft} />}
        <View style={{ flex: 1 }}>
          <T w="bold" size={14.5} numberOfLines={1}>
            {perspective === 'provider' || perspective === 'courier' ? o.customerName : o.providerName}
          </T>
          <T size={11.5} color={C.sub}>طلب ‎#{o.number} • {fmtDateTime(o.createdAt)}</T>
        </View>
        <OrderPill s={o.status} />
      </View>
      {!!o.scheduledFor && !['delivered', 'cancelled', 'rejected'].includes(o.status) && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.goldSoft, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 }}>
          <Icon name="alarm" size={15} color={C.goldDeep} />
          <T w="bold" size={12.5} color={C.goldDeep}>طلب مجدول: {schedLabel(o.scheduledFor)}</T>
        </View>
      )}
      {!!o.hasVoice && <T w="bold" size={12.5} color={C.green}>🎤 فيه رسالة صوتية ({o.voiceSecs || 0} ثانية)</T>}
      {!!o.pool && o.pool.size > 1 && !['delivered', 'cancelled', 'rejected'].includes(o.status) && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.greenSoft, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 }}>
          <T size={14}>🤝</T>
          <T w="bold" size={12.5} color={C.green}>توصيلة مشتركة ({o.pool.size} طلبات) — رسوم التوصيل {o.pool.share} ج.م بدل {o.pool.fullFee}</T>
        </View>
      )}
      <T size={12.5} color={C.sub} numberOfLines={2}>
        {o.customText ? `🎁 ${o.customText}` : o.request ? `📝 ${o.request.text || 'طلب بصورة الروشتة'}${o.request.hasImage ? ' 📷' : ''}` : o.items.map((i) => `${i.qty}× ${i.name}`).join('، ')}
      </T>
      {!!o.readyDate && o.status !== 'rejected' && o.status !== 'unavailable' && o.status !== 'cancelled' && (
        <View style={{ flexDirection: 'row' }}><Pill label={`جاهز للتسليم: ${readyLabel(o.readyDate, o.readyTime)}`} color={TYPES.maker.color} soft={TYPES.maker.soft} icon="calendar" /></View>
      )}
      {perspective !== 'customer' && !!o.customerFlag && <View style={{ flexDirection: 'row' }}><FlagPill flag={o.customerFlag} /></View>}
      {o.regionName && perspective !== 'customer' && (
        <View style={{ flexDirection: 'row' }}><Pill label={`المنطقة: ${o.regionName}`} color={C.goldDeep} soft={C.goldSoft} icon="map" /></View>
      )}
      {(perspective === 'courier' || perspective === 'admin') && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="location" size={14} color={C.goldDeep} />
          <T size={12} style={{ flex: 1 }} numberOfLines={3}>
            {perspective === 'admin' ? `${o.providerName} ← ${o.customerName}` : `من ${o.providerRegionName ? `منطقة ${o.providerRegionName} (${o.providerName})` : o.providerName} إلى ${o.regionName ? `منطقة ${o.regionName} — ` : ''}${o.address}`}
          </T>
        </View>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <T w="black" size={15} style={{ flex: 1 }}>{money(perspective === 'courier' ? o.deliveryFee : o.total)}</T>
        {perspective === 'courier' && <T size={11.5} color={C.sub}>عمولة التوصيل</T>}
        {perspective !== 'courier' && o.courierName && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <CourierAvatar courierId={o.courierId} size={24} />
            <Icon name="bicycle" size={14} color={C.sub} />
            <T size={11.5} color={C.sub}>{o.courierName}</T>
          </View>
        )}
      </View>
      {children}
    </Card>
  );
}

export function ApptCard({ a, onPress, perspective, children }: { a: Appointment; onPress: () => void; perspective: 'customer' | 'provider' | 'admin'; children?: React.ReactNode }) {
  return (
    <Card onPress={onPress} style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <EmojiBubble emoji={a.lab ? '🧪' : SPEC_EMOJI[a.specialty] || '🩺'} size={44} bg="#EFE6FB" />
        <View style={{ flex: 1 }}>
          <T w="bold" size={14.5} numberOfLines={1}>{perspective === 'provider' ? a.patientName : a.doctorName}</T>
          <T size={11.5} color={C.sub} numberOfLines={1}>
            {perspective === 'customer' ? a.clinicName : perspective === 'admin' ? `${a.clinicName} • ${a.patientName}` : a.doctorName} • حجز ‎#{a.number}
          </T>
        </View>
        {a.lab ? <LabPill stage={a.lab.stage} /> : <ApptPill s={a.status} />}
      </View>
      {perspective !== 'customer' && !!a.customerFlag && <View style={{ flexDirection: 'row' }}><FlagPill flag={a.customerFlag} /></View>}
      {a.clinicSet && a.clinicSet.stage === 'awaiting' ? (
        <T size={12.5} color={C.sub}>{perspective === 'provider' ? 'العميل بيطلب كشف، حدد له اليوم والساعة' : 'بانتظار العيادة تحدد لك اليوم والساعة'}</T>
      ) : a.lab && a.lab.stage === 'new' ? (
        <T size={12.5} color={C.sub} numberOfLines={2}>{a.lab.reason || 'طلب بروشتة مرفقة'}</T>
      ) : (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name="calendar" size={14} color={C.goldDeep} />
          <T size={12.5}>{prettyIso(a.date)}</T>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name="time" size={14} color={C.goldDeep} />
          <T size={12.5}>{a.lab ? fmt12(a.time) : a.time}</T>
        </View>
        <T w="black" size={14} style={{ flex: 1 }} align="left">{money(a.fee)}</T>
      </View>
      )}
      {children}
    </Card>
  );
}

export const invoiceTotalLabel = (i: Invoice) => (i.kind === 'booking' ? 'رسوم الكشف' : 'الإجمالي');
