import React, { useEffect, useMemo, useState } from 'react';
import { View, ScrollView, FlatList, RefreshControl, Pressable, KeyboardAvoidingView, Platform, Text, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { C, R, shadow } from '../lib/theme';
import {
  T, Icon, Logo, SearchBar, Card, Chip, Btn, Appear, EmojiBubble, Empty, Segmented, Stepper, Header, Field, SectionTitle,
  toast, IconBtn, Pill, openWhats,
} from '../components/ui';
import { ProviderCard, OrderCard, ApptCard } from '../components/Cards';
import { AreaTag } from '../components/Cards';
import { ProviderLogo } from '../components/Brand';
import { ProductPhoto } from '../components/Quote';
import {
  useStore, useMe, placeRequestOrder, labRequest, cartAdd, cartDetails, placeOrder, placeCustomOrder, refresh, slotTaken, bookAppointment, deliveryOpen, feeFor } from '../lib/store';
import { pickImage, canPickImage } from '../lib/pickImage';
import { catIconUrl } from '../lib/api';
import { AdsCarousel } from '../components/Ads';
import { TYPES, money, SPECIALTIES, SPEC_EMOJI, isoDay, dayName, ALL_SLOTS, isBooking, isLab, isMakerTpl, isRequestOnly, typeKeys, serviceDefs, errandDef } from '../lib/format';
import { LabCardActions } from '../components/Lab';
import { ProviderType, Provider } from '../lib/types';

const useRefresh = () => {
  const [r, setR] = useState(false);
  return {
    refreshing: r,
    onRefresh: async () => {
      setR(true);
      await refresh();
      setR(false);
    },
  };
};
export const useRC = () => {
  const { refreshing, onRefresh } = useRefresh();
  return <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.gold} colors={[C.gold]} />;
};

/* ---------------- Home ---------------- */
const rows3 = <X,>(l: X[]): X[][] => { const r: X[][] = []; for (let i = 0; i < l.length; i += 3) r.push(l.slice(i, i + 3)); return r; };

export function HomeScreen({ navigation }: any) {
  const rc = useRC();
  const { db, cart } = useStore();
  const me = useMe()!;
  const [q, setQ] = useState('');
  const insets = useSafeAreaInsets();
  const provs = db.providers.filter((p) => p.status === 'active');
  const active = db.orders.filter((o) => o.customerId === me.id && ['pending', 'quoted', 'accepted', 'ready', 'picked_up', 'on_the_way', 'arrived'].includes(o.status));
  const cartCount = cart.reduce((s, l) => s + l.qty, 0);

  const results = useMemo(() => {
    const s = q.trim();
    if (!s) return [];
    const byName = provs.filter((p) => p.name.includes(s) || p.desc.includes(s) || (p.specialty || '').includes(s));
    const byProduct = db.products
      .filter((x) => x.name.includes(s) || x.category.includes(s))
      .map((x) => provs.find((p) => p.id === x.providerId))
      .filter(Boolean) as Provider[];
    return Array.from(new Set([...byName, ...byProduct]));
  }, [q, db]);

  const cats: ProviderType[] = typeKeys().filter((k) => { const d = serviceDefs().find((x) => x.key === k); return !d || (d.active && d.showHome); });
  // "الأعلى تقييماً": only the places the owner chose from the control panel
  // "بالقرب منك": automatically the places in the customer's own area
  const nearby = me.regionId ? provs.filter((p) => p.regionId === me.regionId && p.open !== undefined).sort((a, b) => Number(b.open) - Number(a.open)) : [];
  const top = provs.filter((p) => p.featured).sort((a, b) => b.rating - a.rating).slice(0, 12);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ backgroundColor: C.dark, paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: 26, borderBottomLeftRadius: 28, borderBottomRightRadius: 28 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1, gap: 2 }}>
            <T size={12} color="#9FB5AC">أهلاً {me.name.split(' ')[0]} 👋</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Icon name="location" size={15} color={C.gold} />
              <T w="bold" size={12.5} color="#fff" numberOfLines={1} style={{ flex: 1 }}>{me.address || 'أبيس'}</T>
            </View>
          </View>
          <Logo width={110} />
        </View>
        <View style={{ marginTop: 12 }}>
          <SearchBar value={q} onChange={setQ} placeholder="ابحث عن مطعم أو منتج أو خدمة..." />
        </View>
      </View>

      {q.trim() ? (
        <FlatList
          data={results}
          keyExtractor={(p) => p.id}
          contentContainerStyle={{ padding: 16, gap: 12 }}
          ListEmptyComponent={<Empty icon="search" title="لا توجد نتائج" text="جرّب كلمات بحث أخرى" />}
          renderItem={({ item, index }) => (
            <Appear i={index}><ProviderCard p={item} onPress={() => navigation.navigate('Provider', { id: item.id })} /></Appear>
          )}
        />
      ) : (
        <ScrollView refreshControl={rc} contentContainerStyle={{ padding: 16, paddingBottom: 30 }} showsVerticalScrollIndicator={false}>
          <View style={{ marginHorizontal: -16, marginTop: -14, marginBottom: 12 }}><AdsCarousel /></View>
          {!!db.settings.announcement && (
            <Appear>
              <View style={{ flexDirection: 'row', gap: 10, backgroundColor: C.goldSoft, borderRadius: 16, padding: 12, alignItems: 'center', marginBottom: 14 }}>
                <Icon name="megaphone" size={20} color={C.goldDeep} />
                <T size={12.5} w="semi" color={C.goldDeep} style={{ flex: 1 }}>{db.settings.announcement}</T>
              </View>
            </Appear>
          )}

          <View style={{ gap: 10 }}>
            {rows3(cats.filter((k) => !isMakerTpl(k))).map((row, ri) => (
              <View key={ri} style={{ flexDirection: 'row', justifyContent: 'center', gap: 10 }}>
            {row.map((k, ci) => { const i = ri * 3 + ci; const sz = serviceDefs().find((x) => x.key === k)?.size || 'small'; return (
              <Appear key={k} i={i} style={{ width: sz === 'large' ? '21%' : sz === 'medium' ? '26%' : '31.3%' }}>
                <Pressable
                  onPress={() => navigation.navigate('Category', { type: k })}
                  style={({ pressed }) => [{ backgroundColor: '#fff', borderRadius: 20, overflow: 'hidden', alignItems: 'center', gap: 4, ...shadow }, (db.settings.catIconV?.[k] || 0) > 0 || isLab(k) ? { paddingBottom: 6 } : { paddingVertical: 14 }, pressed && { transform: [{ scale: 0.96 }] }]}
                >
                  {(db.settings.catIconV?.[k] || 0) > 0
                    ? <Image source={{ uri: catIconUrl(k, db.settings.catIconV![k]) }} style={{ width: '100%', aspectRatio: 1.15 }} resizeMode="cover" />
                    : isLab(k) ? (
                      <LinearGradient colors={['#0E5A33', '#06361F']} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={{ width: '100%', aspectRatio: 1.15, alignItems: 'center', justifyContent: 'center' }}>
                        <Text style={{ fontSize: 64, marginBottom: 18 }}>{TYPES[k].emoji}</Text>
                        <View style={{ position: 'absolute', bottom: 14, left: 8, right: 8, backgroundColor: C.gold, borderRadius: 8, paddingVertical: 4 }}>
                          <T w="black" size={13} color={C.dark} align="center" numberOfLines={1}>المعامل</T>
                        </View>
                      </LinearGradient>
                    ) : (
                      <View style={{ width: 50, height: 50, borderRadius: 25, backgroundColor: C.dark, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: C.gold, overflow: 'hidden' }}>
                        <Icon name={TYPES[k].icon} size={23} color={C.gold} />
                      </View>
                    )}
                  <T w="bold" size={sz === 'large' ? 9.5 : sz === 'medium' ? 10.5 : 11.5} align="center" numberOfLines={2}>{TYPES[k].label}</T>
                </Pressable>
              </Appear>
            ); })}
              </View>
            ))}
          </View>

          {/* makers: one full-width card under the six icons */}
          {cats.filter((k) => isMakerTpl(k)).map((k, i) => (
            <Appear key={k} i={i + 3} style={{ marginTop: 12 }}>
              <Pressable onPress={() => navigation.navigate('Category', { type: k })} style={({ pressed }) => [pressed && { transform: [{ scale: 0.98 }] }]}>
                <LinearGradient colors={[C.dark3, C.dark]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 22, padding: 11, flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 2, borderColor: C.gold, ...shadow }}>
                  <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                    {(db.settings.catIconV?.[k] || 0) > 0
                      ? <Image source={{ uri: catIconUrl(k, db.settings.catIconV![k]) }} style={{ width: 56, height: 56 }} resizeMode="cover" />
                      : <Text style={{ fontSize: 29 }}>{TYPES[k].emoji}</Text>}
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <T w="black" size={18} color="#fff">{TYPES[k].label}</T>
                    <T size={12} color={C.gold}>{serviceDefs().find((x) => x.key === k)?.tagline || 'منتجات يدوية من أهل أبيس.. اطلب والصانع يحدد السعر وموعد التسليم'}</T>
                  </View>
                  <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="arrow-back" size={18} color={C.dark} />
                  </View>
                </LinearGradient>
              </Pressable>
            </Appear>
          ))}

          {active.length > 0 && (
            <Appear style={{ marginTop: 18 }}>
              <SectionTitle title="طلباتك الجارية" />
              {active.slice(0, 2).map((o) => (
                <View key={o.id} style={{ marginBottom: 10 }}>
                  <OrderCard o={o} perspective="customer" onPress={() => navigation.navigate('OrderDetail', { id: o.id })} />
                </View>
              ))}
            </Appear>
          )}

          {errandDef().active && errandDef().showHome && <Appear i={2} style={{ marginTop: 18 }}>
            <Pressable onPress={() => navigation.navigate('CustomOrder')}>
              <LinearGradient colors={['#F8CB4B', '#F2B51D']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 24, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12, ...shadow }}>
                <View style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(255,255,255,0.45)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                  {(db.settings.catIconV?.[errandDef().key] || 0) > 0
                    ? <Image source={{ uri: catIconUrl(errandDef().key, db.settings.catIconV![errandDef().key]) }} style={{ width: 60, height: 60 }} resizeMode="cover" />
                    : <Text style={{ fontSize: 32 }}>{errandDef().emoji}</Text>}
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T w="black" size={18} color={C.dark}>{errandDef().label}</T>
                  <T size={12.5} color={C.dark3}>{errandDef().tagline || 'اكتب أي حاجة محتاجها وهنوصلهالك من أي مكان في أبيس'}</T>
                </View>
                <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.dark, alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="arrow-back" size={18} color={C.gold} />
                </View>
              </LinearGradient>
            </Pressable>
          </Appear>}

          {nearby.length > 0 && <View style={{ marginTop: 18 }}>
            <SectionTitle title="بالقرب منك" />
            <FlatList
              horizontal
              data={nearby}
              keyExtractor={(p) => p.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 12, paddingVertical: 4 }}
              renderItem={({ item }) => (
                <Card onPress={() => navigation.navigate('Provider', { id: item.id })} style={{ width: 150, alignItems: 'center', gap: 6 }}>
                  <ProviderLogo p={item} size={64} />
                  <T w="bold" size={13} align="center" numberOfLines={1}>{item.name}</T>
                  <T size={11.5} color={C.sub} align="center" numberOfLines={1}>{TYPES[item.type].single}</T>
                  <AreaTag p={item} />
                </Card>
              )}
            />
          </View>}

          {top.length > 0 && <View style={{ marginTop: 18 }}>
            <SectionTitle title="الأعلى تقييماً" action="عرض المطاعم" onAction={() => navigation.navigate('Category', { type: 'restaurant' })} />
            <FlatList
              horizontal
              inverted={false}
              data={top}
              keyExtractor={(p) => p.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 12, paddingVertical: 4 }}
              renderItem={({ item }) => (
                <Card onPress={() => navigation.navigate('Provider', { id: item.id })} style={{ width: 150, alignItems: 'center', gap: 6 }}>
                  <ProviderLogo p={item} size={64} />
                  <T w="bold" size={13} align="center" numberOfLines={1}>{item.name}</T>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Icon name="star" size={13} color={C.gold} />
                    <T w="bold" size={12}>{item.rating.toFixed(1)}</T>
                    <T size={11.5} color={C.sub}>• {item.eta} د</T>
                  </View>
                  <AreaTag p={item} />
                </Card>
              )}
            />
          </View>}
        </ScrollView>
      )}

      {cartCount > 0 && !q && (
        <Pressable
          onPress={() => navigation.navigate('Cart')}
          style={{ position: 'absolute', bottom: 14, left: 16, right: 16, backgroundColor: C.dark, borderRadius: 18, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, ...shadow }}
        >
          <View style={{ backgroundColor: C.gold, borderRadius: 12, width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}>
            <T w="black" size={13} color={C.dark} align="center">{cartCount}</T>
          </View>
          <T w="bold" color="#fff" style={{ flex: 1 }}>عرض السلة وإتمام الطلب</T>
          <T w="black" color={C.gold}>{money(cartDetails(db, cart).subtotal)}</T>
        </Pressable>
      )}
    </View>
  );
}

/* ---------------- Category ---------------- */
export function CategoryScreen({ navigation, route }: any) {
  const rc = useRC();
  const type: ProviderType = route.params.type;
  const { db } = useStore();
  const t = TYPES[type];
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'near' | 'rate' | 'fast'>('near');
  const [spec, setSpec] = useState('الكل');

  const list = useMemo(() => {
    let l = db.providers.filter((p) => p.type === type && p.status === 'active');
    if (q.trim()) l = l.filter((p) => p.name.includes(q.trim()) || p.desc.includes(q.trim()) || (p.specialty || '').includes(q.trim()) || db.products.some((x) => x.providerId === p.id && x.name.includes(q.trim())));
    if (isBooking(type) && spec !== 'الكل') l = l.filter((p) => p.specialty === spec || db.products.some((x) => x.providerId === p.id && x.category === spec));
    if (sort === 'rate') l = [...l].sort((a, b) => b.rating - a.rating);
    if (sort === 'fast') l = [...l].sort((a, b) => parseInt(a.eta) - parseInt(b.eta));
    return l;
  }, [db, q, sort, spec, type]);

  const banner = {
    restaurant: 'اطلب أكلك المفضل',
    supermarket: 'كل احتياجاتك في مكان واحد',
    pharmacy: 'صحتك تهمنا.. أقرب صيدلية لبابك',
    clinic: 'رعايتك الصحية أولويتنا',
    store: 'متاجر أبيس كلها في مكان واحد',
    maker: 'منتجات يدوية من صُنّاع أبيس.. اطلب والصانع يحدد السعر وموعد التسليم',
    lab: 'تحاليلك وفحوصاتك.. احجز واستلم نتيجتك من التطبيق',
  }[type];
  const bannerText = serviceDefs().find((x) => x.key === type)?.tagline || banner || 'كل خدمات أبيس في مكان واحد';

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title={t.label} onBack={() => navigation.goBack()} subtitle={`${list.length} ${isLab(type) ? 'معمل' : isBooking(type) ? 'عيادة' : 'مقدم خدمة'} متاح`}>
        <View style={{ marginTop: 12 }}><SearchBar value={q} onChange={setQ} placeholder={isLab(type) ? 'ابحث عن معمل...' : isBooking(type) ? 'ابحث عن دكتور أو تخصص...' : 'ابحث عن مكان أو منتج...'} /></View>
      </Header>
      <FlatList
        data={list}
        keyExtractor={(p) => p.id}
        refreshControl={rc}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 4 }}>
            <LinearGradient colors={[C.dark3, C.dark]} style={{ borderRadius: 22, padding: 18, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ width: 60, height: 60, borderRadius: 30, borderWidth: 2, borderColor: C.gold, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                {(db.settings.catIconV?.[type] || 0) > 0
                  ? <Image source={{ uri: catIconUrl(type, db.settings.catIconV![type]) }} style={{ width: 60, height: 60 }} resizeMode="cover" />
                  : isLab(type) ? <Text style={{ fontSize: 28 }}>{t.emoji}</Text> : <Icon name={t.icon} size={28} color={C.gold} />}
              </View>
              <T w="black" size={18} color="#fff" style={{ flex: 1 }}>{bannerText}</T>
            </LinearGradient>
            {isLab(type) ? null : isBooking(type) ? (
              <FlatList
                horizontal
                data={['الكل', ...Array.from(new Set(db.providers.filter((p) => isBooking(p.type) && p.status === 'active').flatMap((p) => [p.specialty as string, ...db.products.filter((x) => x.providerId === p.id).map((x) => x.category as string)]).filter(Boolean)))]}
                keyExtractor={(x) => x}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8 }}
                renderItem={({ item }) => <Chip label={item === 'الكل' ? item : `${SPEC_EMOJI[item] || '🩺'} ${item}`} active={spec === item} onPress={() => setSpec(item)} />}
              />
            ) : (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Chip label="الأقرب" icon="navigate" active={sort === 'near'} onPress={() => setSort('near')} />
                <Chip label="الأعلى تقييماً" icon="star" active={sort === 'rate'} onPress={() => setSort('rate')} />
                <Chip label="الأسرع" icon="flash" active={sort === 'fast'} onPress={() => setSort('fast')} />
              </View>
            )}
          </View>
        }
        ListEmptyComponent={<Empty icon="search" title="لا توجد نتائج" text="جرّب تغيير البحث أو الفلتر" />}
        renderItem={({ item, index }) => (
          <Appear i={index}><ProviderCard p={item} onPress={() => navigation.navigate('Provider', { id: item.id })} /></Appear>
        )}
      />
    </View>
  );
}

/* ---------------- Provider details ---------------- */
export function ProviderScreen({ navigation, route }: any) {
  const { db, cart } = useStore();
  const meUser = useMe();
  const p = db.providers.find((x) => x.id === route.params.id);
  const [cat, setCat] = useState('الكل');
  const insets = useSafeAreaInsets();
  // a medical lab has no menu: the customer goes straight to the request form
  useEffect(() => { if (p && isLab(p.type)) navigation.replace('LabRequest', { id: p.id }); }, [p?.id]);
  if (!p) return <Empty title="غير موجود" />;
  const t = TYPES[p.type];
  const products = db.products.filter((x) => x.providerId === p.id);
  const cats = ['الكل', ...Array.from(new Set(products.map((x) => x.category)))];
  const shown = products.filter((x) => cat === 'الكل' || x.category === cat);
  const qty = (id: string) => cart.find((l) => l.productId === id)?.qty || 0;
  const cartCount = cart.reduce((s, l) => s + l.qty, 0);
  const det = cartDetails(db, cart);
  const closed = !p.open;
  const noRoute = !deliveryOpen(p);
  const blocked = closed || noRoute;
  const mineArea = !!p.regionId && meUser?.regionId === p.regionId;
  const requestOnly = isRequestOnly(p.type);

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title={p.name} onBack={() => navigation.goBack()} subtitle={t.single}>
        <View style={{ flexDirection: 'row', gap: 14, marginTop: 14, alignItems: 'center' }}>
          <ProviderLogo p={p} size={66} zoomable />
          <View style={{ flex: 1, gap: 4 }}>
            <T size={12.5} color="#C9D8D2" numberOfLines={2}>{p.desc}</T>
            <View style={{ flexDirection: 'row', gap: 12, flexWrap: 'wrap' }}>
              <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}><Icon name="star" size={14} color={C.gold} /><T w="bold" size={12} color="#fff">{p.rating ? p.rating.toFixed(1) : 'جديد'}</T></View>
              {!isBooking(p.type) && <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}><Icon name="time" size={14} color={C.gold} /><T size={12} color="#fff">{p.eta} د</T></View>}
              {!isBooking(p.type) && <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}><Icon name="bicycle" size={14} color={C.gold} /><T size={12} color="#fff">توصيل {feeFor(p)} ج.م</T></View>}
              <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}><Icon name="location" size={14} color={C.gold} /><T size={12} color="#fff">{[p.regionName ? (mineArea ? 'في منطقتك' : `منطقة ${p.regionName}`) : '', p.address].filter(Boolean).join(' — ') || 'أبيس'}</T></View>
            </View>
          </View>
        </View>
      </Header>
      {closed && (
        <View style={{ backgroundColor: C.redSoft, margin: 16, marginBottom: 0, padding: 12, borderRadius: 14, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Icon name="moon" size={18} color={C.red} />
          <T color={C.red} w="bold" size={13}>{isBooking(p.type) ? 'العيادة لا تستقبل حجوزات حالياً' : 'المكان مغلق حالياً ولا يستقبل طلبات'}</T>
        </View>
      )}
      {!closed && noRoute && (
        <View style={{ backgroundColor: C.redSoft, margin: 16, marginBottom: 0, padding: 12, borderRadius: 14, flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <Icon name="location" size={18} color={C.red} />
          <T color={C.red} w="bold" size={13} style={{ flex: 1 }}>التوصيل من منطقة هذا المكان إلى منطقتك غير متاح حالياً</T>
        </View>
      )}
      {!blocked && (isRequestOnly(p.type) || isMakerTpl(p.type)) && (
        <Pressable onPress={() => navigation.navigate('RequestOrder', { id: p.id })} style={{ marginHorizontal: 16, marginTop: 12 }}>
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.goldSoft, borderWidth: 1.5, borderColor: C.gold }}>
            <Icon name="create" size={28} color={C.goldDeep} />
            <View style={{ flex: 1, gap: 2 }}>
              <T w="black" size={15}>{isMakerTpl(p.type) ? 'اطلب من الصانع' : 'هتطلب إيه؟ اكتب طلبك'}</T>
              <T size={12} color={C.sub}>{p.type === 'pharmacy' ? 'اكتب الدواء المطلوب أو ارفع صورة الروشتة، والصيدلية تحدد السعر' : isMakerTpl(p.type) ? 'اوصف اللي عايزه (ومعاه صورة لو تحب)، والصانع يقبل ويحدد السعر ويوم وساعة التسليم' : 'اكتب اللي عايزه والمتجر يقبل الطلب ويحدد السعر'}</T>
            </View>
            <Icon name="chevron-back" size={18} color={C.sub} />
          </Card>
        </Pressable>
      )}
      {requestOnly ? (
        <View style={{ padding: 24, alignItems: 'center', gap: 10 }}>
          <Text style={{ fontSize: 54 }}>{p.type === 'pharmacy' ? '💊' : '🛒'}</Text>
          <T w="black" size={17} align="center">{p.type === 'pharmacy' ? 'اكتب الدواء المطلوب أو ارفع الروشتة' : 'اكتب كل اللي محتاجه'}</T>
          <T size={12.5} color={C.sub} align="center">بدون سلة ولا قوائم: بتكتب طلبك بطريقتك، والمكان يرد عليك بالسعر وتوافق، والمندوب يوصّله لحد بيتك.</T>
        </View>
      ) : null}
      <FlatList
        style={requestOnly ? { display: 'none' } : undefined}
        data={shown}
        keyExtractor={(x) => x.id}
        contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 100 }}
        ListHeaderComponent={
          !isBooking(p.type) ? (
            <FlatList horizontal data={cats} keyExtractor={(x) => x} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 6 }} renderItem={({ item }) => <Chip label={item} active={cat === item} onPress={() => setCat(item)} />} />
          ) : (
            <View style={{ gap: 8 }}>
              <SectionTitle title="الأطباء المتاحون" />
              {cats.length > 2 ? <FlatList horizontal data={cats} keyExtractor={(x) => x} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 6 }} renderItem={({ item }) => <Chip label={item === 'الكل' ? item : `${SPEC_EMOJI[item] || '🩺'} ${item}`} active={cat === item} onPress={() => setCat(item)} />} /> : null}
            </View>
          )
        }
        ListEmptyComponent={<Empty icon={isBooking(p.type) ? 'pulse' : 'pricetag'} title={isBooking(p.type) ? 'لا يوجد أطباء بعد' : 'لا توجد منتجات بعد'} />}
        renderItem={({ item, index }) =>
          item.kind === 'doctor' ? (
            <Appear i={index}>
              <Card style={{ gap: 12 }}>
                <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
                  <EmojiBubble emoji={SPEC_EMOJI[item.category] || '👨‍⚕️'} size={60} bg="#EFE6FB" />
                  <View style={{ flex: 1, gap: 2 }}>
                    <T w="bold" size={15.5}>{item.name}</T>
                    <T size={12.5} color={C.sub}>{item.category} • {item.desc}</T>
                    <T w="black" size={14} color={C.goldDeep}>رسوم الكشف {money(item.price)}</T>
                  </View>
                </View>
                <Btn title={item.available && !closed ? 'احجز موعد' : 'غير متاح للحجز'} icon="calendar" disabled={!item.available || closed} onPress={() => navigation.navigate('Booking', { doctorId: item.id })} />
              </Card>
            </Appear>
          ) : (
            <Appear i={index}>
              <Card style={{ flexDirection: 'row', gap: 12, alignItems: 'center', opacity: item.available ? 1 : 0.5 }}>
                <ProductPhoto p={item} size={56} bg={t.soft} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T w="bold" size={14.5}>{item.name}</T>
                  {!!item.desc && <T size={11.5} color={C.sub} numberOfLines={1}>{item.desc}</T>}
                  <T w="black" size={14} color={C.goldDeep}>{money(item.price)}</T>
                </View>
                {item.available && !blocked ? (
                  <Stepper qty={qty(item.id)} onAdd={() => cartAdd(item.id, 1)} onSub={() => cartAdd(item.id, -1)} />
                ) : (
                  <Pill label={item.available ? (noRoute && !closed ? 'التوصيل غير متاح' : 'مغلق') : 'غير متوفر'} color={C.red} soft={C.redSoft} />
                )}
              </Card>
            </Appear>
          )
        }
      />
      {cartCount > 0 && !isBooking(p.type) && (
        <Pressable
          onPress={() => navigation.navigate('Cart')}
          style={{ position: 'absolute', bottom: insets.bottom + 12, left: 16, right: 16, backgroundColor: C.dark, borderRadius: 18, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, ...shadow }}
        >
          <View style={{ backgroundColor: C.gold, borderRadius: 12, width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}>
            <T w="black" size={13} color={C.dark} align="center">{cartCount}</T>
          </View>
          <T w="bold" color="#fff" style={{ flex: 1 }}>عرض السلة</T>
          <T w="black" color={C.gold}>{money(det.subtotal)}</T>
        </Pressable>
      )}
    </View>
  );
}

/* ---------------- Cart + checkout ---------------- */
export function CartScreen({ navigation }: any) {
  const { db, cart } = useStore();
  const me = useMe()!;
  const det = cartDetails(db, cart);
  const [name, setName] = useState(me.name);
  const [phone, setPhone] = useState(me.phone);
  const [address, setAddress] = useState(me.address);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const qty = (id: string) => cart.find((l) => l.productId === id)?.qty || 0;

  const submit = async () => {
    setBusy(true);
    const r = await placeOrder(me, { name, phone, address, notes });
    setBusy(false);
    if (!r.ok) return toast(r.error, 'err');
    toast('تم إرسال طلبك بنجاح ✅');
    navigation.replace('Invoice', { id: r.invoiceId });
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="السلة وإتمام الطلب" onBack={() => navigation.goBack()} subtitle={det.groups.length > 1 ? `طلبك مقسم على ${det.groups.length} من مقدمي الخدمة` : undefined} />
      {det.groups.length === 0 ? (
        <Empty icon="cart" title="السلة فارغة" text="أضف منتجات من المطاعم أو السوبر ماركت أو الصيدليات" />
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 30 }} keyboardShouldPersistTaps="handled">
            {det.groups.map((g, gi) => (
              <Appear key={g.provider.id} i={gi}>
                <Card style={{ gap: 12 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <ProviderLogo p={g.provider} size={40} />
                    <View style={{ flex: 1 }}>
                      <T w="bold" size={15}>{g.provider.name}</T>
                      <T size={11.5} color={C.sub}>{TYPES[g.provider.type].single}</T>
                    </View>
                  </View>
                  {g.items.map((it) => (
                    <View key={it.productId} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                      <T size={22}>{it.emoji}</T>
                      <View style={{ flex: 1 }}>
                        <T w="semi" size={13.5}>{it.name}</T>
                        <T size={12} color={C.sub}>{money(it.price)}</T>
                      </View>
                      <Stepper qty={qty(it.productId)} onAdd={() => cartAdd(it.productId, 1)} onSub={() => cartAdd(it.productId, -1)} />
                    </View>
                  ))}
                  <View style={{ height: 1, backgroundColor: C.line }} />
                  <View style={{ flexDirection: 'row' }}><T color={C.sub} size={13} style={{ flex: 1 }}>المجموع</T><T w="bold" size={13}>{money(g.subtotal)}</T></View>
                  <View style={{ flexDirection: 'row' }}><T color={C.sub} size={13} style={{ flex: 1 }}>التوصيل</T><T w="bold" size={13}>{money(g.provider.deliveryFee)}</T></View>
                </Card>
              </Appear>
            ))}

            <Card style={{ gap: 12 }}>
              <T w="black" size={16}>بيانات التوصيل</T>
              <Field label="اسم العميل" icon="person" value={name} onChangeText={setName} />
              <Field label="رقم الهاتف" icon="call" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
              <Field label="العنوان بالتفصيل" icon="location" value={address} onChangeText={setAddress} multiline />
              <Field label="ملاحظات (اختياري)" icon="create" value={notes} onChangeText={setNotes} placeholder="مثال: الدور الثالث، الجرس لا يعمل" />
            </Card>

            <Card style={{ gap: 8, backgroundColor: C.dark }}>
              <View style={{ flexDirection: 'row' }}><T color="#C9D8D2" style={{ flex: 1 }}>قيمة الطلبات</T><T w="bold" color="#fff">{money(det.subtotal)}</T></View>
              <View style={{ flexDirection: 'row' }}><T color="#C9D8D2" style={{ flex: 1 }}>رسوم التوصيل</T><T w="bold" color="#fff">{money(det.delivery)}</T></View>
              <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.15)' }} />
              <View style={{ flexDirection: 'row', alignItems: 'center' }}><T w="black" size={17} color={C.gold} style={{ flex: 1 }}>الإجمالي</T><T w="black" size={20} color={C.gold}>{money(det.total)}</T></View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <Icon name="cash" size={16} color={C.gold} />
                <T size={12} color="#C9D8D2">الدفع كاش عند الاستلام</T>
              </View>
            </Card>
            <Btn title="تأكيد وإرسال الطلب" icon="checkmark-circle" loading={busy} onPress={submit} />
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

/* ---------------- Custom order ---------------- */
export function CustomOrderScreen({ navigation }: any) {
  const me = useMe()!;
  const [text, setText] = useState('');
  const [phone, setPhone] = useState(me.phone);
  const [address, setAddress] = useState(me.address);
  const sug = ['علبة شاي وسكر', 'أدوية من صيدلية معينة', 'وجبة من مطعم غير مسجل', 'هدية وورد', 'خبز وفطير'];
  const submit = async () => {
    const r = await placeCustomOrder(me, { text, phone, address });
    if (!r.ok) return toast(r.error, 'err');
    toast('تم إرسال طلبك للمناديب 🛵');
    navigation.replace('OrderDetail', { id: r.orderId });
  };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="اطلب إيه؟ نجيبهولك" onBack={() => navigation.goBack()} subtitle="اكتب طلبك والمندوب يحدد السعر ويجيبه لك" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
          <View style={{ alignItems: 'center' }}><Text style={{ fontSize: 70 }}>🎁</Text></View>
          <Card style={{ gap: 12 }}>
            <Field label="اكتب طلبك" value={text} onChangeText={setText} multiline placeholder="مثال: أريد علبة شاي ٥٠ كيس وكيلو سكر من أقرب سوبر ماركت..." />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {sug.map((s) => <Chip key={s} label={s} onPress={() => setText((t) => (t ? t + '، ' : '') + s)} />)}
            </View>
            <Field label="رقم الهاتف" icon="call" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            <Field label="عنوان التوصيل" icon="location" value={address} onChangeText={setAddress} multiline />
          </Card>
          <Card style={{ backgroundColor: C.goldSoft, gap: 6 }}>
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Icon name="information-circle" size={18} color={C.goldDeep} />
              <T w="bold" size={13} color={C.goldDeep}>كيف يعمل؟</T>
            </View>
            <T size={12.5} color={C.dark3}>أول مندوب يقبل طلبك يحدد لك سعر المشتريات ورسوم التوصيل ويبعتلك فاتورة. إنت توافق عليها أو ترفضها (لو رفضت يرجع الطلب للمناديب)، والدفع كاش عند الاستلام.</T>
          </Card>
          <Btn title="إرسال الطلب" icon="send" onPress={submit} />
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/* ---------------- Booking ---------------- */
export function BookingScreen({ navigation, route }: any) {
  const { db } = useStore();
  const me = useMe()!;
  const doc = db.products.find((x) => x.id === route.params.doctorId);
  const clinic = doc && db.providers.find((p) => p.id === doc.providerId);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return isoDay(d); }), []);
  const [date, setDate] = useState(() => {
    const n = new Date();
    const mins = n.getHours() * 60 + n.getMinutes();
    const first = (route.params && db.products.find((x) => x.id === route.params.doctorId)?.slots) || ALL_SLOTS;
    const todayLeft = first.some((s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m > mins; });
    return todayLeft ? days[0] : days[1];
  });
  const [time, setTime] = useState('');
  const [pname, setPname] = useState(me.name);
  const [phone, setPhone] = useState(me.phone);
  const [notes, setNotes] = useState('');
  if (!doc || !clinic) return <Empty title="غير موجود" />;
  const nowH = new Date();
  const slots = (doc.slots && doc.slots.length ? doc.slots : ALL_SLOTS).filter((s) => {
    if (date !== days[0]) return true;
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m > nowH.getHours() * 60 + nowH.getMinutes();
  });

  const submit = async () => {
    if (!time) return toast('اختر ميعاد الحجز', 'err');
    const r = await bookAppointment(me, { doctor: doc, date, time, patientName: pname, phone, notes });
    if (!r.ok) return toast(r.error, 'err');
    toast('تم إرسال طلب الحجز للعيادة ✅');
    navigation.replace('ApptDetail', { id: r.id });
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="حجز موعد" onBack={() => navigation.goBack()} subtitle={clinic.name} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 30 }} keyboardShouldPersistTaps="handled">
          <Card style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <EmojiBubble emoji={SPEC_EMOJI[doc.category] || '👨‍⚕️'} size={60} bg="#EFE6FB" />
            <View style={{ flex: 1 }}>
              <T w="black" size={16}>{doc.name}</T>
              <T size={12.5} color={C.sub}>{doc.category} • {clinic.name}</T>
              <T w="bold" size={13.5} color={C.goldDeep}>رسوم الكشف {money(doc.price)}</T>
            </View>
          </Card>
          <View>
            <SectionTitle title="اختر اليوم" />
            <FlatList horizontal data={days} keyExtractor={(d) => d} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}
              renderItem={({ item, index }) => {
                const a = item === date;
                return (
                  <Pressable onPress={() => { setDate(item); setTime(''); }} style={{ width: 64, paddingVertical: 12, borderRadius: 16, alignItems: 'center', gap: 2, backgroundColor: a ? C.dark : '#fff', ...shadow, shadowOpacity: 0.05 }}>
                    <T w="semi" size={11} color={a ? C.gold : C.sub} align="center">{index === 0 ? 'اليوم' : dayName(item)}</T>
                    <T w="black" size={20} color={a ? '#fff' : C.text} align="center">{Number(item.split('-')[2])}</T>
                    <T size={10.5} color={a ? '#C9D8D2' : C.sub} align="center">{Number(item.split('-')[1])}/{item.split('-')[0].slice(2)}</T>
                  </Pressable>
                );
              }}
            />
          </View>
          <View>
            <SectionTitle title="اختر الميعاد" />
            {slots.length === 0 ? (
              <T color={C.sub}>لا توجد مواعيد متاحة اليوم، اختر يوماً آخر.</T>
            ) : (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {slots.map((s) => {
                  const taken = slotTaken(db, doc.id, date, s);
                  const a = s === time;
                  return (
                    <Pressable key={s} disabled={taken} onPress={() => setTime(s)} style={{ paddingHorizontal: 16, paddingVertical: 10, borderRadius: 14, backgroundColor: taken ? '#E6EAE3' : a ? C.gold : '#fff', borderWidth: 1.5, borderColor: a ? C.goldDeep : C.line }}>
                      <T w="bold" size={13} color={taken ? '#9AA8A2' : C.dark} style={taken ? { textDecorationLine: 'line-through' } : undefined}>{s}</T>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
          <Card style={{ gap: 12 }}>
            <Field label="اسم المريض" icon="person" value={pname} onChangeText={setPname} />
            <Field label="رقم الهاتف" icon="call" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            <Field label="ملاحظات للدكتور (اختياري)" icon="create" value={notes} onChangeText={setNotes} multiline placeholder="الأعراض أو سبب الزيارة" />
          </Card>
          <Btn title="تأكيد طلب الحجز" icon="checkmark-circle" onPress={submit} />
          <T size={12} color={C.sub} align="center">سيصل طلبك للعيادة وبعد تأكيدها ستصلك فاتورة الحجز</T>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/* ---------------- Orders tab (customer) ---------------- */
export function CustomerOrdersScreen({ navigation }: any) {
  const rc = useRC();
  const { db } = useStore();
  const me = useMe()!;
  const [seg, setSeg] = useState('orders');
  const orders = db.orders.filter((o) => o.customerId === me.id).sort((a, b) => b.createdAt - a.createdAt);
  const appts = db.appointments.filter((a) => a.customerId === me.id).sort((a, b) => b.createdAt - a.createdAt);
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="طلباتي" subtitle="تابع طلباتك وحجوزاتك">
        <View style={{ marginTop: 14 }}>
          <View style={{ backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 18, padding: 3 }}>
            <Segmented value={seg} onChange={setSeg} options={[{ key: 'orders', label: `الطلبات (${orders.length})` }, { key: 'appts', label: `الحجوزات (${appts.length})` }]} />
          </View>
        </View>
      </Header>
      {seg === 'orders' ? (
        <FlatList
          data={orders}
          keyExtractor={(o) => o.id}
          refreshControl={rc}
          contentContainerStyle={{ padding: 16, gap: 12 }}
          ListEmptyComponent={<Empty icon="receipt" title="لا توجد طلبات بعد" text="اطلب من المطاعم أو السوبر ماركت أو الصيدليات وستظهر هنا" />}
          renderItem={({ item, index }) => (
            <Appear i={index}>
              <OrderCard o={item} perspective="customer" onPress={() => navigation.navigate('OrderDetail', { id: item.id })}>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Btn small variant="soft" title="الفاتورة" icon="document-text" style={{ flex: 1 }} onPress={() => navigation.navigate('Invoice', { id: item.invoiceId })} />
                  {item.courierId && !['delivered', 'cancelled', 'rejected'].includes(item.status) && (
                    <Btn small variant="dark" title="شات المندوب" icon="chatbubbles" style={{ flex: 1 }} onPress={() => navigation.navigate('Chat', { orderId: item.id })} />
                  )}
                </View>
              </OrderCard>
            </Appear>
          )}
        />
      ) : (
        <FlatList
          data={appts}
          keyExtractor={(o) => o.id}
          refreshControl={rc}
          contentContainerStyle={{ padding: 16, gap: 12 }}
          ListEmptyComponent={<Empty icon="calendar" title="لا توجد حجوزات" text="احجز موعدك مع أفضل الأطباء من قسم حجز العيادات" />}
          renderItem={({ item, index }) => (
            <Appear i={index}>
              <ApptCard a={item} perspective="customer" onPress={() => navigation.navigate('ApptDetail', { id: item.id })}>
                {item.lab ? <LabCardActions a={item} navigation={navigation} role="customer" /> : null}
                {item.invoiceId && <Btn small variant="soft" title="فاتورة الحجز" icon="document-text" onPress={() => navigation.navigate('Invoice', { id: item.invoiceId })} />}
              </ApptCard>
            </Appear>
          )}
        />
      )}
    </View>
  );
}

/* ---------------- written request to a supermarket / pharmacy ---------------- */
export function RequestOrderScreen({ navigation, route }: any) {
  const { db } = useStore();
  const me = useMe()!;
  const p = db.providers.find((x) => x.id === route.params.id);
  const [text, setText] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [phone, setPhone] = useState(me.phone);
  const [address, setAddress] = useState(me.address);
  const [busy, setBusy] = useState(false);
  if (!p) return <View style={{ flex: 1 }}><Header title="طلب مكتوب" onBack={() => navigation.goBack()} /><Empty title="المتجر غير موجود" /></View>;
  const pharmacy = p.type === 'pharmacy';
  const maker = isMakerTpl(p.type);

  const choose = async () => {
    if (!canPickImage) return toast('رفع الصور متاح حالياً من نسخة الويب', 'info');
    const img = await pickImage();
    if (img) setImage(img);
    else toast('تعذر تحميل الصورة، جرّب صورة أخرى', 'err');
  };
  const submit = async () => {
    setBusy(true);
    const r = await placeRequestOrder(me, { provider: p, text, image, phone, address });
    setBusy(false);
    if (!r.ok) return toast(r.error, 'err');
    toast(maker ? 'تم إرسال طلبك للصانع ✅' : 'تم إرسال طلبك للمتجر ✅');
    navigation.replace('OrderDetail', { id: r.orderId });
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title={pharmacy ? 'اطلب من الصيدلية' : maker ? 'اطلب من الصانع' : 'اطلب من السوبر ماركت'} subtitle={p.name} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
        <Card style={{ gap: 6, backgroundColor: C.goldSoft }}>
          <T w="black" size={14} color={C.goldDeep}>إزاي بيشتغل؟</T>
          <T size={12.5} color={C.dark3}>{maker
            ? '1) اوصف اللي عايزه.  2) الصانع يقبل الطلب أو يعتذر.  3) لو قبل، بيحدد السعر ويوم وساعة ما يكون جاهز للتسليم.  4) توافق على الفاتورة والمندوب يستلمه في الموعد ويوصّله لك. الدفع كاش عند الاستلام.'
            : `1) اكتب طلبك${pharmacy ? ' أو ارفع صورة الروشتة' : ''}.  2) المتجر يقبل الطلب ويحدد السعر.  3) توصلك الفاتورة وتوافق عليها.  4) المندوب يوصّل لحد باب بيتك. الدفع كاش عند الاستلام.`}</T>
        </Card>
        <Field
          label={maker ? 'اوصف طلبك' : 'هتطلب إيه؟'}
          icon="create"
          value={text}
          onChangeText={setText}
          multiline
          placeholder={maker ? 'مثال: تورتة عيد ميلاد ٢ كيلو بالشوكولاتة، أو شنطة كروشيه لونها بيج' : pharmacy ? 'اكتب أسماء الأدوية وكمياتها' : 'اكتب الأصناف اللي عايزها وكمياتها، مثال: 2 كيلو سكر، علبة شاي'}
        />
        {(pharmacy || maker) && (
          <View style={{ gap: 8 }}>
            <T w="semi" size={13} color={C.dark3}>{maker ? 'صورة توضيحية (اختياري)' : 'صورة الروشتة (اختياري)'}</T>
            {image ? <Image source={{ uri: image }} style={{ width: '100%', height: 260, borderRadius: 14, backgroundColor: C.line }} resizeMode="contain" /> : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn variant="soft" icon="camera" title={image ? 'تغيير الصورة' : maker ? 'ارفع صورة' : 'ارفع صورة الروشتة'} style={{ flex: 1 }} onPress={choose} />
              {image ? <Btn variant="danger" icon="trash" title="حذف" style={{ flex: 0.5 }} onPress={() => setImage(null)} /> : null}
            </View>
          </View>
        )}
        <Field label="رقم الهاتف" icon="call" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        <Field label="العنوان التفصيلي" icon="location" value={address} onChangeText={setAddress} multiline />
        <Btn title={maker ? 'إرسال الطلب للصانع' : 'إرسال الطلب للمتجر'} icon="send" loading={busy} onPress={submit} />
      </ScrollView>
    </View>
  );
}


/* ---------------- Medical lab: the customer writes the reason or sends the prescription ---------------- */
export function LabRequestScreen({ navigation, route }: any) {
  const { db } = useStore();
  const me = useMe()!;
  const p = db.providers.find((x) => x.id === route.params.id);
  const [reason, setReason] = useState('');
  const [rx, setRx] = useState<string | null>(null);
  const [patient, setPatient] = useState(me.name);
  const [phone, setPhone] = useState(me.phone);
  const [busy, setBusy] = useState(false);
  if (!p) return <View style={{ flex: 1 }}><Header title="طلب تحليل" onBack={() => navigation.goBack()} /><Empty title="المعمل غير موجود" /></View>;
  const choose = async () => {
    if (!canPickImage) return toast('رفع الصور غير متاح هنا', 'info');
    const img = await pickImage();
    if (img) setRx(img); else toast('تعذر تحميل الصورة، جرّب صورة أخرى', 'err');
  };
  const submit = async () => {
    setBusy(true);
    const r = await labRequest(me, { provider: p, reason, rx, patientName: patient, phone });
    setBusy(false);
    if (!r.ok) return toast(r.error, 'err');
    toast('تم إرسال طلبك للمعمل ✅');
    navigation.replace('ApptDetail', { id: r.id });
  };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="طلب تحليل أو كشف" subtitle={p.name} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}>
        <Card style={{ gap: 6, backgroundColor: C.goldSoft }}>
          <T w="black" size={14} color={C.goldDeep}>إزاي بيشتغل؟</T>
          <T size={12.5} color={C.dark3}>1) اكتب سبب الكشف أو ارفع الروشتة.  2) المعمل يحدد يوم الكشف وساعته والسعر.  3) توافق وتؤكد الحجز وتوصلك فاتورة الحجز.  4) تروح المعمل في الميعاد.  5) بعد الكشف، المعمل يرفع التقرير أو النتيجة في نفس الطلب وتفتحه من عندك.</T>
        </Card>
        <Field label="سبب الكشف" icon="create" value={reason} onChangeText={setReason} multiline placeholder="مثال: تحليل سكر تراكمي وصورة دم كاملة" />
        <View style={{ gap: 8 }}>
          <T w="semi" size={13} color={C.dark3}>صورة الروشتة (اختياري)</T>
          {rx ? <Image source={{ uri: rx }} style={{ width: '100%', height: 260, borderRadius: 14, backgroundColor: C.line }} resizeMode="contain" /> : null}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn variant="soft" icon="camera" title={rx ? 'تغيير الصورة' : 'ارفع صورة الروشتة'} style={{ flex: 1 }} onPress={choose} />
            {rx ? <Btn variant="danger" icon="trash" title="حذف" style={{ flex: 0.5 }} onPress={() => setRx(null)} /> : null}
          </View>
        </View>
        <Field label="اسم المريض" icon="person" value={patient} onChangeText={setPatient} />
        <Field label="رقم الهاتف" icon="call" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        <Btn title="إرسال الطلب للمعمل" icon="send" loading={busy} onPress={submit} />
      </ScrollView>
    </View>
  );
}
