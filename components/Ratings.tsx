import React, { useEffect, useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Header, Empty, Icon, Sheet, toast } from './ui';
import { useStore, useMe } from '../lib/store';
import { apiMyRating, apiRateOrder, apiShopRatings, apiStaffRatings, apiHideRating, MyRating, ShopRatings, StaffRating } from '../lib/api';
import type { Order } from '../lib/types';

const WORDS = ['', 'سيئ', 'مقبول', 'جيد', 'جيد جداً', 'ممتاز'];
const ago = (t: number) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 60 ? 'منذ قليل' : m < 1440 ? `منذ ${Math.round(m / 60)} ساعة` : `منذ ${Math.round(m / 1440)} يوم`; };

/** Five stars; tap one to choose (when onChange is given), otherwise just shows the number. */
export function Stars({ value, onChange, size = 30 }: { value: number; onChange?: (n: number) => void; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center' }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Pressable key={n} disabled={!onChange} onPress={() => onChange?.(n)} hitSlop={6}>
          <Icon name={n <= value ? 'star' : 'star-outline'} size={size} color={n <= value ? C.gold : C.line} />
        </Pressable>
      ))}
    </View>
  );
}

/** Customer: after delivery, rate the shop (and the courier). One rating per order, editable for 24 hours. */
export function RateOrderCard({ o }: { o: Order }) {
  const me = useMe();
  const [mine, setMine] = useState<MyRating | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [shop, setShop] = useState(0);
  const [courier, setCourier] = useState(0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const on = me?.role === 'customer' && o.customerId === me.id && o.status === 'delivered';
  useEffect(() => { if (on) apiMyRating(o.id).then((r) => setMine(r.rating)).catch(() => setMine(null)); }, [o.id, on]);
  if (!on || mine === undefined) return null;

  const start = () => { setShop(mine?.providerStars || 0); setCourier(mine?.courierStars || 0); setText(mine?.comment || ''); setEditing(true); };
  const send = async () => {
    if (!shop) { toast('اختر عدد النجوم للمتجر', 'err'); return; }
    setBusy(true);
    try {
      const r = await apiRateOrder(o.id, { providerStars: shop, ...(o.courierId && courier ? { courierStars: courier } : {}), comment: text.trim() });
      setMine(r.rating); setEditing(false); toast('شكراً لتقييمك');
    } catch (e: any) { toast(e?.message || 'تعذر إرسال التقييم', 'err'); }
    finally { setBusy(false); }
  };

  if (mine && !editing) {
    return (
      <Card style={{ gap: 8, alignItems: 'center' }}>
        <T w="black" size={15}>شكراً لتقييمك</T>
        <Stars value={mine.providerStars || 0} size={24} />
        {!!mine.comment && <T size={12.5} color={C.sub} align="center">{mine.comment}</T>}
        {mine.canEdit && <Pressable onPress={start}><T w="bold" size={12.5} color={C.goldDeep}>تعديل التقييم</T></Pressable>}
      </Card>
    );
  }
  return (
    <Card style={{ gap: 12 }}>
      <T w="black" size={16} align="center">قيّم طلبك</T>
      <View style={{ gap: 4 }}>
        <T w="bold" size={13} align="center">{o.providerName}</T>
        <Stars value={shop} onChange={setShop} />
        {!!shop && <T size={12} color={C.sub} align="center">{WORDS[shop]}</T>}
      </View>
      {!!o.courierId && (
        <View style={{ gap: 4 }}>
          <T w="bold" size={13} align="center">المندوب {o.courierName}</T>
          <Stars value={courier} onChange={setCourier} size={26} />
        </View>
      )}
      <View style={{ backgroundColor: '#F3F4EE', borderRadius: 14, paddingHorizontal: 12 }}>
        <RateInput value={text} onChange={setText} />
      </View>
      <Btn title="إرسال التقييم" onPress={send} loading={busy} full />
    </Card>
  );
}

// a plain multiline box (kept here so the card does not depend on the form Field style)
function RateInput({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  const { TextInput } = require('react-native');
  return <TextInput value={value} onChangeText={onChange} placeholder="اكتب تعليق (اختياري)" placeholderTextColor={C.sub} multiline maxLength={500} style={{ minHeight: 60, textAlign: 'right', writingDirection: 'rtl', fontSize: 14, paddingVertical: 10, color: C.text }} />;
}

/** The star line in a shop's header: opens the shop's average, distribution and latest comments. */
export function ShopRatingsSheet({ providerId, name, visible, onClose }: { providerId: string; name: string; visible: boolean; onClose: () => void }) {
  const [d, setD] = useState<ShopRatings | null>(null);
  useEffect(() => { if (visible) { setD(null); apiShopRatings(providerId).then(setD).catch(() => setD({ count: 0, avg: 0, dist: {}, comments: [] })); } }, [visible, providerId]);
  return (
    <Sheet visible={visible} onClose={onClose} title={`تقييمات ${name}`}>
      {!d ? <T color={C.sub} align="center">جاري التحميل...</T> : d.count === 0 ? (
        <T color={C.sub} align="center">لا توجد تقييمات بعد. كن أول من يقيّم.</T>
      ) : (
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            <T w="black" size={36}>{d.avg.toFixed(1)}</T>
            <View style={{ flex: 1, gap: 3 }}>
              <Stars value={Math.round(d.avg)} size={18} />
              <T size={12} color={C.sub} align="center">من {d.count} تقييم</T>
            </View>
          </View>
          {[5, 4, 3, 2, 1].map((n) => (
            <View key={n} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <T size={12} w="bold" style={{ width: 14 }}>{n}</T>
              <View style={{ flex: 1, height: 7, borderRadius: 4, backgroundColor: C.line, overflow: 'hidden' }}>
                <View style={{ width: `${Math.round(((d.dist[String(n)] || 0) / d.count) * 100)}%`, height: '100%', backgroundColor: C.gold }} />
              </View>
            </View>
          ))}
          {d.comments.length > 0 && <T w="black" size={14}>آخر التعليقات</T>}
          {d.comments.map((c, i) => (
            <View key={i} style={{ borderTopWidth: 1, borderTopColor: C.line, paddingTop: 8, gap: 2 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <T w="bold" size={12.5}>{c.who} · {'★'.repeat(c.stars)}</T>
                <T size={11} color={C.sub}>{ago(c.at)}</T>
              </View>
              <T size={13}>{c.comment}</T>
            </View>
          ))}
        </View>
      )}
    </Sheet>
  );
}

/** Owner / supervisor: latest ratings, the couriers' averages, and (owner only) hide an abusive comment. */
export function AdminRatingsScreen({ navigation }: any) {
  const { db } = useStore();
  const me = useMe();
  const [d, setD] = useState<{ ratings: StaffRating[]; couriers: Record<string, { avg: number; count: number }> } | null>(null);
  const load = () => apiStaffRatings().then(setD).catch((e) => { setD({ ratings: [], couriers: {} }); toast(e?.message || 'تعذر التحميل', 'err'); });
  useEffect(() => { load(); }, []);
  const hide = async (r: StaffRating) => {
    try { await apiHideRating(r.id, !r.hidden); toast(r.hidden ? 'تم إظهار التعليق' : 'تم إخفاء التعليق'); load(); }
    catch (e: any) { toast(e?.message || 'تعذر التنفيذ', 'err'); }
  };
  const couriers = db.users.filter((u) => u.role === 'courier' && d?.couriers[u.id]);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="التقييمات" subtitle="تقييمات العملاء للمتاجر والمناديب" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
        {!d ? <T color={C.sub} align="center">جاري التحميل...</T> : (
          <>
            {couriers.length > 0 && (
              <Card style={{ gap: 8 }}>
                <T w="black" size={15}>متوسط تقييم المناديب</T>
                {couriers.map((u) => (
                  <View key={u.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <T w="bold" style={{ flex: 1 }}>{u.name}</T>
                    <Icon name="star" size={15} color={C.gold} />
                    <T w="bold">{d.couriers[u.id].avg.toFixed(1)}</T>
                    <T size={11.5} color={C.sub}>({d.couriers[u.id].count})</T>
                  </View>
                ))}
              </Card>
            )}
            {d.ratings.length === 0 && <Empty icon="star" title="لا توجد تقييمات بعد" />}
            {d.ratings.map((r) => (
              <Card key={r.id} style={{ gap: 6, opacity: r.hidden ? 0.55 : 1 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <T w="bold" size={13.5}>{r.providerName} · طلب ‎#{r.orderNumber}</T>
                  <T size={11} color={C.sub}>{ago(r.createdAt)}</T>
                </View>
                <T size={12.5}>المتجر: {'★'.repeat(r.providerStars || 0)}{r.courierStars ? `   المندوب ${r.courierName}: ${'★'.repeat(r.courierStars)}` : ''}</T>
                {!!r.comment && <T size={13}>"{r.comment}" — {r.customerName.split(' ')[0]}</T>}
                {me?.role === 'admin' && !!r.comment && (
                  <Pressable onPress={() => hide(r)}><T w="bold" size={12.5} color={r.hidden ? C.green : C.red}>{r.hidden ? 'إظهار التعليق' : 'إخفاء التعليق'}</T></Pressable>
                )}
              </Card>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}
