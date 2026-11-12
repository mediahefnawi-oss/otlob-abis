import React, { useEffect, useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { C, OFFER_COLORS } from '../lib/theme';
import { T, Card, Btn, Header, Empty, Field, Icon, toast, confirmDialog } from './ui';
import { useStore } from '../lib/store';
import { apiOffers, apiOfferCreate, apiOfferActive, apiOfferDelete, AdminOffer } from '../lib/api';
import type { Product } from '../lib/types';

const left = (t: number) => { const m = Math.max(0, Math.round((t - Date.now()) / 60000)); return m >= 1440 ? `${Math.round(m / 1440)} يوم` : m >= 60 ? `${Math.round(m / 60)} ساعة` : `${m} دقيقة`; };

/** The discount tag on a product: "خصم 20%" in the colour the owner chose, with the time left when the offer ends. */
export function OfferBadge({ p }: { p: Pick<Product, 'offer'> }) {
  if (!p.offer) return null;
  const c = OFFER_COLORS[p.offer.color] || OFFER_COLORS.red;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <View style={{ backgroundColor: c.bg, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 2 }}><T w="black" size={11} color={c.fg}>{p.offer.title} • خصم {p.offer.percent}%</T></View>
      {!!p.offer.endsAt && p.offer.endsAt > Date.now() && <T size={10.5} color={C.sub}>⏱ ينتهي بعد {left(p.offer.endsAt)}</T>}
    </View>
  );
}

/** The best offer running at a shop, read from its products (the server already attaches it). Only while the switch is on. */
function useShopOffers(switchKey: 'offerBadge' | 'todayOffers') {
  const { db } = useStore();
  const on = !!db.settings.features?.[switchKey];
  const now = Date.now();
  return React.useMemo(() => {
    const m = new Map<string, NonNullable<Product['offer']>>();
    if (!on) return m;
    for (const x of db.products) {
      if (!x.offer || (x.offer.endsAt && x.offer.endsAt <= now)) continue;
      const cur = m.get(x.providerId);
      if (!cur || x.offer.percent > cur.percent) m.set(x.providerId, x.offer);
    }
    return m;
  }, [db.products, on]);
}

/** Small "خصم 20%" tag on a shop card (switch «offerBadge»). */
export function ShopOfferTag({ providerId }: { providerId: string }) {
  const o = useShopOffers('offerBadge').get(providerId);
  if (!o) return null;
  const c = OFFER_COLORS[o.color] || OFFER_COLORS.red;
  return (
    <View style={{ alignSelf: 'flex-start', backgroundColor: c.bg, borderRadius: 9, paddingHorizontal: 8, paddingVertical: 2 }}>
      <T w="black" size={11} color={c.fg}>🏷️ خصم {o.percent}%{o.endsAt ? ` • ينتهي بعد ${left(o.endsAt)}` : ''}</T>
    </View>
  );
}

/** "عروض اليوم" strip at the top of the customer home (switch «todayOffers»): one tile per shop that has a running offer. */
export function TodayOffers({ onOpen }: { onOpen: (providerId: string) => void }) {
  const { db } = useStore();
  const offers = useShopOffers('todayOffers');
  const list = db.providers
    .filter((p) => p.status === 'active' && offers.has(p.id))
    .map((p) => ({ p, o: offers.get(p.id)! }))
    .sort((a, b) => b.o.percent - a.o.percent)
    .slice(0, 12);
  if (!list.length) return null;
  return (
    <View style={{ marginBottom: 14, gap: 8 }}>
      <T w="black" size={15}>🔥 عروض اليوم</T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
        {list.map(({ p, o }) => {
          const c = OFFER_COLORS[o.color] || OFFER_COLORS.red;
          return (
            <Pressable key={p.id} onPress={() => onOpen(p.id)} style={({ pressed }) => [{ width: 150, backgroundColor: c.bg, borderRadius: 18, padding: 12, gap: 4 }, pressed && { opacity: 0.85 }]}>
              <T w="black" size={22} color={c.fg}>{o.percent}%</T>
              <T w="bold" size={13} color={c.fg} numberOfLines={1}>{p.name}</T>
              <T size={11} color={c.fg} numberOfLines={1}>{o.title}</T>
              {!!o.endsAt && <T size={10.5} color={c.fg}>⏱ ينتهي بعد {left(o.endsAt)}</T>}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** Owner only: create, switch off and delete offers. */
export function AdminOffersScreen({ navigation }: any) {
  const { db } = useStore();
  const [list, setList] = useState<AdminOffer[] | null>(null);
  const [title, setTitle] = useState('');
  const [percent, setPercent] = useState('');
  const [hours, setHours] = useState('');
  const [color, setColor] = useState('red');
  const [shop, setShop] = useState('');
  const [busy, setBusy] = useState(false);
  const shops = db.providers.filter((p) => p.status === 'active' && p.type !== 'clinic' && p.type !== 'lab').slice(0, 60);
  useEffect(() => { apiOffers().then((r) => setList(r.offers)).catch((e) => { setList([]); toast(e?.message || 'تعذر التحميل', 'err'); }); }, []);

  const run = async (f: () => Promise<{ offers: AdminOffer[] }>, okMsg?: string) => {
    setBusy(true);
    try { const r = await f(); setList(r.offers); if (okMsg) toast(okMsg); return true; }
    catch (e: any) { toast(e?.message || 'تعذر التنفيذ', 'err'); return false; }
    finally { setBusy(false); }
  };
  const add = async () => {
    const ok = await run(() => apiOfferCreate({ title: title.trim(), percent: Number(percent), color, providerId: shop || undefined, hours: hours ? Number(hours) : undefined }), 'تم إنشاء العرض 🎉');
    if (ok) { setTitle(''); setPercent(''); setHours(''); setShop(''); }
  };
  const del = (o: AdminOffer) => confirmDialog({ title: 'حذف العرض؟', message: `«${o.title}» سيختفي من التطبيق`, danger: true, confirmText: 'حذف', onConfirm: () => { run(() => apiOfferDelete(o.id), 'تم الحذف'); } });
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="العروض والخصومات" subtitle="المالك فقط يضيف العروض" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: 12 }}>
          <T w="black" size={15}>عرض جديد</T>
          <Field label="اسم العرض (مثال: عرض اليوم)" value={title} onChangeText={setTitle} icon="pricetag" />
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label="نسبة الخصم %" value={percent} onChangeText={setPercent} keyboardType="number-pad" icon="trending-down" /></View>
            <View style={{ flex: 1 }}><Field label="المدة بالساعات (اختياري)" value={hours} onChangeText={setHours} keyboardType="number-pad" icon="time" /></View>
          </View>
          <T size={12} color={C.sub}>لون الشارة</T>
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            {Object.entries(OFFER_COLORS).map(([id, c]) => (
              <Pressable key={id} onPress={() => setColor(id)} style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 12, backgroundColor: c.bg, borderWidth: 3, borderColor: color === id ? C.dark : 'transparent' }}>
                <T w="bold" size={12} color={c.fg}>{c.name}</T>
              </Pressable>
            ))}
          </View>
          <T size={12} color={C.sub}>على أي متجر؟</T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {[{ id: '', name: 'كل المتاجر' }, ...shops.map((p) => ({ id: p.id, name: p.name }))].map((s) => (
              <Pressable key={s.id || 'all'} onPress={() => setShop(s.id)} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14, backgroundColor: shop === s.id ? C.dark : '#fff', borderWidth: 1, borderColor: C.line }}>
                <T w="semi" size={12.5} color={shop === s.id ? '#fff' : C.text}>{s.name}</T>
              </Pressable>
            ))}
          </ScrollView>
          <Btn title="إنشاء العرض" icon="add-circle" onPress={add} loading={busy} disabled={!title.trim() || !Number(percent)} />
        </Card>

        {list && !list.length && <Empty icon="pricetags" title="لا توجد عروض" text="أنشئ أول عرض ويظهر عند العملاء فوراً" />}
        {(list || []).map((o) => {
          const c = OFFER_COLORS[o.color] || OFFER_COLORS.red;
          const over = !!o.endsAt && o.endsAt <= Date.now();
          return (
            <Card key={o.id} style={{ gap: 8, opacity: o.active && !over ? 1 : 0.55 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ backgroundColor: c.bg, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 }}><T w="black" size={13} color={c.fg}>-{o.percent}%</T></View>
                <View style={{ flex: 1 }}>
                  <T w="bold" size={14}>{o.title}</T>
                  <T size={11.5} color={C.sub}>{o.providerName || 'كل المتاجر'} • {over ? 'انتهى' : o.endsAt ? `ينتهي بعد ${left(o.endsAt)}` : 'بدون مدة'}</T>
                </View>
                <Pressable onPress={() => del(o)} hitSlop={10}><Icon name="trash" size={19} color={C.red} /></Pressable>
              </View>
              {!over && <Btn title={o.active ? 'إيقاف العرض' : 'تشغيل العرض'} variant="soft" small onPress={() => run(() => apiOfferActive(o.id, !o.active))} />}
            </Card>
          );
        })}
      </ScrollView>
    </View>
  );
}
