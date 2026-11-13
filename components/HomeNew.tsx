import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, ScrollView, Pressable, Text, Image, TextInput } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, shadow } from '../lib/theme';
import { T, Icon, Logo, Card, Chip, Btn, Appear, Empty, Field, Sheet, SectionTitle, toast } from './ui';
import { ProviderCard, OrderCard } from './Cards';
import { ProviderLogo } from './Brand';
import { AreaTag } from './Cards';
import { AdsCarousel } from './Ads';
import { FavoritesRow } from './Favorites';
import { TodayOffers, ShopOfferTag } from './Offers';
import { RegionClosedBanner, RegionPicker } from './Regions';
import { useStore, useMe, cartAdd, cartClear, setCartDest, updateProfile } from '../lib/store';
import { storage } from '../lib/storage';
import { getPosition } from '../lib/location';
import { apiAddresses, apiAddressAdd, apiAddressDelete, catIconUrl, SavedAddress } from '../lib/api';
import { TYPES, typeKeys, serviceDefs, errandDef } from '../lib/format';
import { Provider, ProviderType } from '../lib/types';

const RECENT_KEY = 'abis_recent_q';
type ChipKey = 'all' | 'near' | 'top' | 'open' | 'free';
const CHIPS: { key: ChipKey; label: string }[] = [
  { key: 'all', label: 'الكل' }, { key: 'near', label: 'الأقرب' }, { key: 'top', label: 'الأعلى تقييماً' }, { key: 'open', label: 'مفتوح دلوقتي' }, { key: 'free', label: 'توصيل مجاني' },
];

/** The new customer home (switch "homeNew"): address in the header, search, quick filters, picture tiles 4 per row. The old home stays in customer.tsx. */
export function HomeNew({ navigation, rc }: { navigation: any; rc: React.ReactElement }) {
  const { db, cart } = useStore();
  const me = useMe()!;
  const f = db.settings.features || {};
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const [chip, setChip] = useState<ChipKey>('all');
  const [addrOpen, setAddrOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [gridW, setGridW] = useState(0);
  const tw = gridW > 0 ? Math.floor(gridW * 0.313) : 110;
  const cartCount = cart.reduce((s, l) => s + l.qty, 0);

  useEffect(() => { if (f.searchSuggest) storage.getItem(RECENT_KEY).then((v) => { try { setRecent(JSON.parse(v || '[]')); } catch { /* ignore */ } }).catch(() => {}); }, [f.searchSuggest]);
  const remember = (s: string) => {
    const t = s.trim(); if (!f.searchSuggest || t.length < 2) return;
    const next = [t, ...recent.filter((x) => x !== t)].slice(0, 6);
    setRecent(next); storage.setItem(RECENT_KEY, JSON.stringify(next)).catch(() => {});
  };

  const provs = db.providers.filter((p) => p.status === 'active');
  const active = db.orders.filter((o) => o.customerId === me.id && ['pending', 'quoted', 'accepted', 'ready', 'picked_up', 'on_the_way', 'arrived'].includes(o.status));
  const cats: ProviderType[] = typeKeys().filter((k) => { const d = serviceDefs().find((x) => x.key === k); return !d || (d.active && d.showHome); });
  const nearby = me.regionId ? provs.filter((p) => p.regionId === me.regionId).sort((a, b) => Number(b.open) - Number(a.open)) : [];
  const top = provs.filter((p) => p.featured).sort((a, b) => b.rating - a.rating).slice(0, 12);

  // the last delivered order that can be repeated (all its products still exist and are available)
  const last = useMemo(() => {
    if (!f.reorder) return null;
    const o = db.orders.filter((x) => x.customerId === me.id && x.status === 'delivered' && x.providerType !== 'custom' && x.items?.length).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!o) return null;
    const ok = o.items.every((it) => db.products.some((p) => p.id === it.productId && p.available));
    return ok ? o : null;
  }, [db.orders, db.products, f.reorder, me.id]);
  const repeat = () => {
    if (!last) return;
    cartClear();
    last.items.forEach((it) => cartAdd(it.productId, it.qty));
    toast('تمت إضافة الطلب للسلة');
    navigation.navigate('Cart');
  };

  const results = useMemo(() => {
    const s = q.trim(); if (!s) return [];
    const byName = provs.filter((p) => p.name.includes(s) || p.desc.includes(s) || (p.specialty || '').includes(s));
    const byProduct = db.products.filter((x) => x.name.includes(s) || x.category.includes(s)).map((x) => provs.find((p) => p.id === x.providerId)).filter(Boolean) as Provider[];
    return Array.from(new Set([...byName, ...byProduct]));
  }, [q, db]);
  const suggestions = useMemo(() => {
    const s = q.trim(); if (!f.searchSuggest || s.length < 1) return [];
    const a = provs.filter((p) => p.name.includes(s)).slice(0, 3).map((p) => ({ key: 'p' + p.id, label: p.name, tag: 'متجر', go: () => navigation.navigate('Provider', { id: p.id }) }));
    const b = db.products.filter((x) => x.available && x.name.includes(s)).slice(0, 4).map((x) => {
      const pv = provs.find((p) => p.id === x.providerId);
      return pv ? { key: 'x' + x.id, label: x.name, tag: pv.name, go: () => navigation.navigate('Provider', { id: pv.id }) } : null;
    }).filter(Boolean) as { key: string; label: string; tag: string; go: () => void }[];
    return [...a, ...b].slice(0, 6);
  }, [q, db, f.searchSuggest]);

  const chipList = useMemo(() => {
    if (chip === 'near') return nearby;
    if (chip === 'top') return [...provs].sort((a, b) => b.rating - a.rating).slice(0, 20);
    if (chip === 'open') return provs.filter((p) => p.open);
    if (chip === 'free') return provs.filter((p) => p.deliveryFee === 0);
    return [];
  }, [chip, db.providers, me.regionId]);

  const searching = !!q.trim();
  const filtering = !searching && f.homeChips && chip !== 'all';

  const tile = (k: ProviderType, i: number) => {
    const img = (db.settings.catIconV?.[k] || 0) > 0;
    return (
      <Appear key={k} i={i} style={{ width: '23.4%' }}>
        <Pressable onPress={() => navigation.navigate('Category', { type: k })} style={({ pressed }) => [{ backgroundColor: '#fff', borderRadius: 16, overflow: 'hidden', ...shadow }, pressed && { transform: [{ scale: 0.96 }] }]}>
          {img
            ? <Image source={{ uri: catIconUrl(k, db.settings.catIconV![k]) }} style={{ width: '100%', aspectRatio: 1.2 }} resizeMode="cover" />
            : (
              <LinearGradient colors={['#0E5A33', '#06361F']} style={{ width: '100%', aspectRatio: 1.2, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={TYPES[k].icon} size={30} color={C.gold} />
              </LinearGradient>
            )}
          <View style={{ paddingVertical: 6, paddingHorizontal: 2 }}>
            <T w="bold" size={10.5} align="center" numberOfLines={2}>{TYPES[k].label}</T>
          </View>
        </Pressable>
      </Appear>
    );
  };
  const gridCats = cats; // the makers (صُنّاع أبيس) sit in the tiles like every other service
  const rows: ProviderType[][] = [];
  for (let i = 0; i < gridCats.length; i += 4) rows.push(gridCats.slice(i, i + 4));

  return (
    <View style={{ flex: 1, backgroundColor: '#fff' }}>
      <View style={{ backgroundColor: C.dark, paddingTop: insets.top + 8, paddingHorizontal: 16, paddingBottom: 20, borderBottomLeftRadius: 26, borderBottomRightRadius: 26 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Pressable onPress={() => setAddrOpen(true)} style={{ flex: 1, gap: 1 }} hitSlop={6}>
            <T size={11} color="#9FB5AC">التوصيل إلى</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <Icon name="location" size={15} color={C.gold} />
              <T w="bold" size={13} color="#fff" numberOfLines={1} style={{ flexShrink: 1 }}>{me.address || 'اضغط لتحديد عنوانك'}</T>
              <Icon name="chevron-down" size={15} color={C.gold} />
            </View>
          </Pressable>
          <Logo width={92} />
        </View>
        <View style={{ marginTop: 12, backgroundColor: '#fff', borderRadius: 26, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="search" size={19} color={C.sub} />
          <TextInput
            value={q} onChangeText={setQ} placeholder="ابحث عن مطعم أو منتج أو خدمة..." placeholderTextColor="#8A948F"
            maxFontSizeMultiplier={1.1} onSubmitEditing={() => remember(q)} returnKeyType="search"
            style={{ flex: 1, paddingVertical: 11, fontSize: 14, textAlign: 'right', color: C.text }}
          />
          {!!q && <Pressable onPress={() => setQ('')} hitSlop={8}><Icon name="close-circle" size={18} color={C.sub} /></Pressable>}
        </View>
        {!!db.settings.announcement && !searching && (
          <T w="bold" size={12} color={C.gold} align="center" numberOfLines={2} style={{ marginTop: 10 }}>{db.settings.announcement}</T>
        )}
      </View>

      <ScrollView refreshControl={rc} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 30 }} showsVerticalScrollIndicator={false}>
        {searching ? (
          <View style={{ padding: 16, gap: 12 }}>
            {suggestions.length > 0 && (
              <View style={{ backgroundColor: '#fff', borderRadius: 16, ...shadow, overflow: 'hidden' }}>
                {suggestions.map((s) => (
                  <Pressable key={s.key} onPress={() => { remember(q); s.go(); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 9, padding: 12, borderBottomWidth: 1, borderBottomColor: C.line }}>
                    <Icon name="search" size={15} color={C.sub} />
                    <T w="bold" size={13} style={{ flex: 1 }} numberOfLines={1}>{s.label}</T>
                    <T size={11} color={C.sub} numberOfLines={1}>{s.tag}</T>
                  </Pressable>
                ))}
              </View>
            )}
            {results.length === 0 ? <Empty icon="search" title="لا توجد نتائج" text="جرّب كلمات بحث أخرى" /> : results.map((p, i) => (
              <Appear key={p.id} i={i}><ProviderCard p={p} onPress={() => { remember(q); navigation.navigate('Provider', { id: p.id }); }} /></Appear>
            ))}
          </View>
        ) : (
          <View style={{ padding: 16, paddingTop: 12 }}>
            {!!f.searchSuggest && recent.length > 0 && (
              <View style={{ marginBottom: 10 }}>
                <T size={11.5} w="bold" color={C.sub} style={{ marginBottom: 6 }}>آخر ما بحثت عنه</T>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {recent.map((r) => <Chip key={r} label={`↺ ${r}`} onPress={() => setQ(r)} />)}
                </ScrollView>
              </View>
            )}
            {!!f.homeChips && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 10 }}>
                {CHIPS.map((c) => <Chip key={c.key} label={c.label} active={chip === c.key} onPress={() => setChip(c.key)} />)}
              </ScrollView>
            )}

            {filtering ? (
              <View style={{ gap: 12 }}>
                {chipList.length === 0 ? <Empty icon="storefront" title="مفيش نتائج" text="جرّب تصنيف تاني" /> : chipList.map((p, i) => (
                  <Appear key={p.id} i={i}><ProviderCard p={p} onPress={() => navigation.navigate('Provider', { id: p.id })} /></Appear>
                ))}
              </View>
            ) : (
              <>
                <View style={{ gap: 10 }} onLayout={(e) => setGridW(e.nativeEvent.layout.width)}>
                  {rows.map((row, ri) => (
                    <View key={ri} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      {row.map((k, ci) => tile(k, ri * 4 + ci))}
                      {Array.from({ length: 4 - row.length }).map((_, n) => <View key={'sp' + n} style={{ width: '23.4%' }} />)}
                    </View>
                  ))}
                </View>

                {!!last && (
                  <Appear style={{ marginTop: 12 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1.5, borderColor: '#E3DEC9', backgroundColor: '#FBF8EE', borderRadius: 16, padding: 10 }}>
                      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.dark, alignItems: 'center', justifyContent: 'center' }}><Icon name="refresh" size={19} color={C.gold} /></View>
                      <View style={{ flex: 1 }}>
                        <T w="black" size={13}>اطلب تاني</T>
                        <T size={11} color={C.sub} numberOfLines={1}>آخر طلب من «{last.providerName}» • {last.items.length} {last.items.length > 10 ? 'صنف' : 'أصناف'}</T>
                      </View>
                      <Pressable onPress={repeat} style={{ backgroundColor: C.gold, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8 }}><T w="black" size={12} color={C.dark}>كرّر الطلب</T></Pressable>
                    </View>
                  </Appear>
                )}

                <View style={{ marginHorizontal: -16, marginTop: 12 }}><AdsCarousel /></View>
                <RegionClosedBanner regionId={me.regionId} />
                <TodayOffers onOpen={(id) => navigation.navigate('Provider', { id })} />
                <FavoritesRow />

                {active.length > 0 && (
                  <Appear style={{ marginTop: 12 }}>
                    <SectionTitle title="طلباتك الجارية" />
                    {active.slice(0, 2).map((o) => <View key={o.id} style={{ marginBottom: 10 }}><OrderCard o={o} perspective="customer" onPress={() => navigation.navigate('OrderDetail', { id: o.id })} /></View>)}
                  </Appear>
                )}

                {errandDef().active && errandDef().showHome && (
                  <Appear i={2} style={{ marginTop: 12 }}>
                    <Pressable onPress={() => navigation.navigate('CustomOrder')}>
                      <LinearGradient colors={['#F8CB4B', '#F2B51D']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 20, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 12, ...shadow }}>
                        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(255,255,255,0.45)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                          {(db.settings.catIconV?.[errandDef().key] || 0) > 0 ? <Image source={{ uri: catIconUrl(errandDef().key, db.settings.catIconV![errandDef().key]) }} style={{ width: 48, height: 48 }} resizeMode="cover" /> : <Text style={{ fontSize: 26 }}>{errandDef().emoji}</Text>}
                        </View>
                        <View style={{ flex: 1 }}>
                          <T w="black" size={16} color={C.dark}>{errandDef().label}</T>
                          <T size={11.5} color={C.dark3}>{errandDef().tagline || 'اكتب أي حاجة محتاجها وهنوصلهالك'}</T>
                        </View>
                        <Icon name="arrow-back" size={18} color={C.dark} />
                      </LinearGradient>
                    </Pressable>
                  </Appear>
                )}

                {nearby.length > 0 && (
                  <View style={{ marginTop: 14 }}>
                    <SectionTitle title="بالقرب منك" />
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingVertical: 4 }}>
                      {nearby.map((item) => (
                        <Card key={item.id} onPress={() => navigation.navigate('Provider', { id: item.id })} style={{ width: tw, paddingHorizontal: 9, paddingTop: 10, paddingBottom: 8, alignItems: 'center', gap: 4 }}>
                          <ProviderLogo p={item} size={tw - 18} />
                          <T w="bold" size={11.5} align="center" numberOfLines={2}>{item.name}</T>
                          <AreaTag p={item} />
                          <ShopOfferTag providerId={item.id} compact />
                        </Card>
                      ))}
                    </ScrollView>
                  </View>
                )}
                {top.length > 0 && (
                  <View style={{ marginTop: 14 }}>
                    <SectionTitle title="الأعلى تقييماً" />
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12, paddingVertical: 4 }}>
                      {top.map((item) => (
                        <Card key={item.id} onPress={() => navigation.navigate('Provider', { id: item.id })} style={{ width: tw, paddingHorizontal: 9, paddingTop: 10, paddingBottom: 8, alignItems: 'center', gap: 4 }}>
                          <ProviderLogo p={item} size={tw - 18} />
                          <T w="bold" size={11.5} align="center" numberOfLines={2}>{item.name}</T>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}><Icon name="star" size={13} color={C.gold} /><T w="bold" size={12}>{item.rating.toFixed(1)}</T><T size={11.5} color={C.sub}>• {item.eta} د</T></View>
                          <AreaTag p={item} />
                          <ShopOfferTag providerId={item.id} compact />
                        </Card>
                      ))}
                    </ScrollView>
                  </View>
                )}
              </>
            )}
          </View>
        )}
      </ScrollView>

      {cartCount > 0 && !searching && (
        <Pressable onPress={() => navigation.navigate('Cart')} style={{ position: 'absolute', bottom: 14, left: 16, right: 16, backgroundColor: C.dark, borderRadius: 18, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, ...shadow }}>
          <View style={{ backgroundColor: C.gold, borderRadius: 12, width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}><T w="black" size={13} color={C.dark} align="center">{cartCount}</T></View>
          <T w="bold" size={14} color="#fff" style={{ flex: 1 }}>عرض السلة</T>
          <Icon name="cart" size={20} color={C.gold} />
        </Pressable>
      )}

      <AddressSheet visible={addrOpen} onClose={() => setAddrOpen(false)} />
    </View>
  );
}

/** "عنوان التوصيل": my location button, saved addresses (when that switch is on), and the address typed by hand. The chosen one is saved on the account. */
function AddressSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { db } = useStore();
  const me = useMe()!;
  const savedOn = !!db.settings.features?.addresses;
  const [text, setText] = useState(me.address || '');
  const [regionId, setRegionId] = useState<string>(me.regionId || '');
  const [list, setList] = useState<SavedAddress[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { apiAddresses().then((r) => setList(r.enabled ? r.addresses : [])).catch(() => {}); }, []);
  useEffect(() => { if (visible) { setText(me.address || ''); setRegionId(me.regionId || ''); if (savedOn) load(); } }, [visible, savedOn, load, me.address, me.regionId]);

  const gps = async () => {
    setBusy(true);
    try { const p = await getPosition(); setCartDest({ pin: { lat: p.lat, lng: p.lng } }); toast('تم تحديد موقعك على الخريطة ✅ اكتب تفاصيل العنوان (الشارع، العمارة، الدور)'); }
    catch (e: any) { toast(e?.message || 'تعذر تحديد الموقع', 'err'); }
    setBusy(false);
  };
  const confirm = async () => {
    const a = text.trim();
    if (a.length < 6) return toast('اكتب العنوان بالتفصيل', 'err');
    setBusy(true);
    const r = await updateProfile({ address: a, ...(regionId && regionId !== me.regionId ? { regionId } : {}) });
    if (r.ok && savedOn && label.trim().length >= 2 && !list.some((x) => x.address === a) && list.length < 5) { try { await apiAddressAdd(label.trim(), a); } catch { /* the address is still saved on the account */ } }
    setBusy(false);
    if (!r.ok) return toast(r.error || 'تعذر الحفظ', 'err');
    toast('تم حفظ العنوان ✅'); setLabel(''); onClose();
  };
  const del = (a: SavedAddress) => { apiAddressDelete(a.id).then(load).catch((e) => toast(e?.message || 'تعذر الحذف', 'err')); };
  return (
    <Sheet visible={visible} onClose={onClose} title="عنوان التوصيل">
      <Pressable onPress={gps} disabled={busy} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.greenSoft, borderRadius: 14, padding: 12 }}>
        <Icon name="navigate" size={20} color={C.green} /><T w="bold" size={13} color={C.green}>استخدم موقعي الحالي</T>
      </Pressable>
      {savedOn && list.length > 0 && (
        <View style={{ gap: 8 }}>
          {list.map((a) => (
            <Pressable key={a.id} onPress={() => setText(a.address)} onLongPress={() => del(a)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1.5, borderColor: text.trim() === a.address ? C.gold : C.line, backgroundColor: text.trim() === a.address ? C.goldSoft : '#fff', borderRadius: 14, padding: 10 }}>
              <Icon name="location" size={18} color={text.trim() === a.address ? C.goldDeep : C.sub} />
              <View style={{ flex: 1 }}><T w="bold" size={12.5}>{a.label}</T><T size={11} color={C.sub} numberOfLines={2}>{a.address}</T></View>
            </Pressable>
          ))}
          <T size={10.5} color={C.sub}>اضغط على عنوان لاستخدامه، واضغط مطولًا لحذفه.</T>
        </View>
      )}
      <RegionPicker value={regionId} onChange={setRegionId} label="المنطقة" />
      <Field label="العنوان بالتفصيل (شارع / عمارة / دور / علامة مميزة)" icon="location" value={text} onChangeText={setText} multiline />
      {savedOn && text.trim().length >= 6 && !list.some((x) => x.address === text.trim()) && list.length < 5 && (
        <Field label="احفظه باسم (اختياري): البيت، الشغل..." icon="bookmark" value={label} onChangeText={setLabel} />
      )}
      <Btn title="تأكيد العنوان" icon="checkmark" loading={busy} onPress={confirm} />
      <T size={11} color={C.sub} align="center">يتحفظ على حسابك ويظهر تلقائياً في كل طلب</T>
    </Sheet>
  );
}
