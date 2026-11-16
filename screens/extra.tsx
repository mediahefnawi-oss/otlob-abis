import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, ScrollView, Pressable, Text, Linking, Platform, Image, KeyboardAvoidingView, useWindowDimensions } from 'react-native';
import { C, shadow } from '../lib/theme';
import { T, Icon, Card, Btn, Empty, Header, Field, Chip, Stepper, toast } from '../components/ui';
import { DeliveryPin } from '../components/Location';
import { AddressPicker } from '../components/AddressBook';
import { useStore, useMe, placeMarketOrder, placeGroupOrder } from '../lib/store';
import { isMakerTpl } from '../lib/format';
import {
  apiGroupOpen, apiGroupGet, apiGroupSet, apiGroupRemove, apiGroupDone, apiGroupCancel, GroupCart,
  apiMarketProducts, MarketProduct, marketImageUrl, SvcKey, SvcMeta, apiSvcMeta, svcImageUrl,
} from '../lib/api';

const SITE = 'https://otlobabis.com';
/** the four services that have the group order: restaurants, supermarkets, makers (Sunaat Abis) and stores */
export const groupEligible = (type?: string) => type === 'restaurant' || type === 'supermarket' || type === 'store' || isMakerTpl(type);
const errText = (e: any) => String(e?.message || 'حدث خطأ، حاول مرة أخرى');

/* ---------------- group order ---------------- */

/** The strip on a shop page: opens (or reuses) the owner's shared cart for this shop. */
export function GroupOrderButton({ navigation, providerId }: { navigation: any; providerId: string }) {
  const { db } = useStore();
  const [busy, setBusy] = useState(false);
  const prov = db.providers.find((x) => String(x.id) === String(providerId));
  if (!db.settings.features?.groupOrder || !prov || !groupEligible(prov.type)) return null;
  const go = async () => {
    if (busy) return;
    setBusy(true);
    try { const r = await apiGroupOpen(providerId); navigation.navigate('GroupCart', { code: r.code }); }
    catch (e) { toast(errText(e), 'err'); }
    finally { setBusy(false); }
  };
  return (
    <View style={{ marginHorizontal: 16, marginTop: 12 }}>
    <Pressable onPress={go}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.green, borderRadius: 20, padding: 12, ...shadow }}>
        <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 24 }}>👥</Text></View>
        <View style={{ flex: 1, gap: 1 }}>
          <T w="black" size={15} color="#fff">{busy ? 'جاري الفتح...' : 'طلب جماعي'}</T>
          <T size={12} color="#DDEEE4">ادعو صحابك على واتساب وكل واحد يضيف من حسابه</T>
        </View>
        <Icon name="chevron-back" size={18} color={C.gold} />
      </View>
    </Pressable>
    <GroupJoinCard navigation={navigation} />
    </View>
  );
}

/** Home: join a group cart with a code (the link opens it directly on the web; this covers the app). */
export function GroupJoinCard({ navigation }: { navigation: any }) {
  const { db } = useStore();
  const [code, setCode] = useState('');
  const [open, setOpen] = useState(false);
  if (!db.settings.features?.groupOrder) return null;
  if (!open) return <Pressable onPress={() => setOpen(true)} style={{ marginTop: 10, alignSelf: 'center' }}><T size={12.5} color={C.green} w="bold">عندك كود طلب جماعي؟ ادخله هنا</T></Pressable>;
  return (
    <Card style={{ marginTop: 10, gap: 8 }}>
      <Field label="كود الطلب الجماعي" value={code} onChangeText={setCode} autoCapitalize="none" placeholder="مثال: aB3dE9xK" />
      <Btn title="انضم للسلة" icon="people" onPress={() => { const c = code.trim().replace(/^.*[?&]group=/, '').replace(/[^A-Za-z0-9]/g, ''); if (c.length < 4) return toast('اكتب الكود صح', 'err'); navigation.navigate('GroupCart', { code: c }); }} />
    </Card>
  );
}

/** Web: a link like otlobabis.com/?group=CODE opens the shared cart as soon as the customer is in. */
export function useGroupLink(navigation: any) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || Platform.OS !== 'web' || typeof window === 'undefined') return;
    try {
      const m = /[?&]group=([A-Za-z0-9]{4,20})/.exec(window.location.search);
      if (!m) return;
      done.current = true;
      window.history.replaceState({}, '', window.location.pathname);
      navigation.navigate('GroupCart', { code: m[1] });
    } catch { /* ignore */ }
  }, [navigation]);
}

export function GroupCartScreen({ navigation, route }: any) {
  const code: string = route.params.code;
  const me = useMe()!;
  const { db } = useStore();
  const [cart, setCart] = useState<GroupCart | null>(null);
  const [err, setErr] = useState('');
  const [phone, setPhone] = useState(me.phone);
  const [address, setAddress] = useState(me.address);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    try { const r = await apiGroupGet(code); setCart(r.cart); setErr(''); }
    catch (e) { setErr(errText(e)); }
  }, [code]);
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
  const products = useMemo(() => (cart ? db.products.filter((x) => String(x.providerId) === String(cart.providerId) && x.available !== false) : []), [db.products, cart?.providerId]);
  const mine = cart?.members.find((m) => m.userId === Number(me.id));
  const qtyOf = (pid: string) => mine?.items.find((i) => String(i.productId) === String(pid))?.qty || 0;
  const act = async (fn: () => Promise<{ cart: GroupCart }>) => { try { const r = await fn(); setCart(r.cart); } catch (e) { toast(errText(e), 'err'); } };
  if (err && !cart) return (<View style={{ flex: 1, backgroundColor: C.bg }}><Header title="طلب جماعي" onBack={() => navigation.goBack()} /><Empty title={err} /></View>);
  if (!cart) return (<View style={{ flex: 1, backgroundColor: C.bg }}><Header title="طلب جماعي" onBack={() => navigation.goBack()} /><Empty title="جاري التحميل..." /></View>);
  const open = cart.status === 'open';
  const link = `${SITE}/?group=${cart.code}`;
  const share = () => {
    const msg = `انضم لطلبنا الجماعي من ${cart.providerName} على أطلب أبيس 🛒\nأضف اللي تحبه من حسابك:\n${link}\nالكود: ${cart.code}`;
    Linking.openURL(`https://wa.me/?text=${encodeURIComponent(msg)}`).catch(() => toast('تعذر فتح واتساب', 'err'));
  };
  const confirm = async () => {
    if (!cart.lines || !cart.lines.length) return toast('السلة فارغة', 'err');
    setBusy(true);
    const r = await placeGroupOrder(me, { lines: cart.lines, name: me.name, phone, address, notes });
    if (!r.ok) { setBusy(false); return toast(r.error, 'err'); }
    try { await apiGroupDone(code); } catch { /* the order is already placed; the cart expires by itself */ }
    setBusy(false);
    toast('تم إرسال الطلب الجماعي ✅');
    navigation.replace('Invoice', { id: r.invoiceId });
  };
  const cancel = async () => { try { await apiGroupCancel(code); navigation.goBack(); } catch (e) { toast(errText(e), 'err'); } };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title={`طلب جماعي — ${cart.providerName}`} subtitle={open ? (cart.isOwner ? 'إنت صاحب الطلب: بتأكد وبتدفع' : 'ضيف اللي تحبه، وصاحب الطلب هو اللي بيدفع') : cart.status === 'ordered' ? 'الطلب اتأكد' : 'السلة انتهت أو اتلغت'} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        {open && cart.isOwner && <Btn title="ابعت اللينك على واتساب" icon="logo-whatsapp" onPress={share} />}
        {cart.members.length === 0 && <Card><T color={C.sub} align="center">لسه مفيش حد ضاف حاجة</T></Card>}
        {cart.members.map((m) => (
          <Card key={m.userId} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: C.line, paddingBottom: 6 }}>
              <T w="black" size={15}>{m.name}{m.isOwner ? ' (صاحب الطلب)' : ''}</T>
              <T w="black" size={14} color={C.green}>{m.subtotal} ج</T>
            </View>
            {m.items.map((i) => (
              <View key={i.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                {open && i.canRemove && <Pressable onPress={() => act(() => apiGroupRemove(code, i.id))} hitSlop={8}><Icon name="close-circle" size={20} color={C.red} /></Pressable>}
                <T style={{ flex: 1 }} size={13.5}>{i.qty} × {i.name}</T>
                <T size={13.5} color={C.sub}>{i.line} ج</T>
              </View>
            ))}
          </Card>
        ))}
        <Card style={{ backgroundColor: C.dark, flexDirection: 'row', justifyContent: 'space-between' }}>
          <T w="black" size={16} color="#fff">الإجمالي ({cart.members.length} أشخاص)</T>
          <T w="black" size={16} color={C.gold}>{cart.total} ج</T>
        </Card>
        {open && (
          <>
            <Btn title={adding ? 'إخفاء المنتجات' : 'أضف أصنافك'} icon="add-circle" variant="soft" onPress={() => setAdding((v) => !v)} />
            {adding && products.map((p) => (
              <Card key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ flex: 1 }}><T w="bold" size={14}>{p.name}</T><T size={12} color={C.green}>{p.price} ج</T></View>
                <Stepper qty={qtyOf(p.id)} onAdd={() => act(() => apiGroupSet(code, p.id, qtyOf(p.id) + 1))} onSub={() => act(() => apiGroupSet(code, p.id, qtyOf(p.id) - 1))} />
              </Card>
            ))}
          </>
        )}
        {open && cart.isOwner && (
          <Card style={{ gap: 10 }}>
            <T w="black" size={15}>بيانات التوصيل (على عنوانك)</T>
            <Field label="رقم الهاتف" icon="call" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            <AddressPicker address={address} onPick={setAddress} />
            <Field label="عنوان التوصيل" icon="location" value={address} onChangeText={setAddress} multiline />
            <DeliveryPin />
            <Field label="ملاحظات" value={notes} onChangeText={setNotes} />
            <Btn title="أكّد الطلب وادفع" icon="checkmark-circle" onPress={confirm} loading={busy} />
            <Btn title="إلغاء السلة" variant="soft" onPress={cancel} />
          </Card>
        )}
        {open && !cart.isOwner && <T size={12} color={C.sub} align="center">صاحب الطلب هو اللي هيأكد ويدفع، والطلب هيوصل له.</T>}
      </ScrollView>
    </View>
  );
}

/* ---------------- market ---------------- */
export function MarketScreen({ navigation }: any) {
  const me = useMe()!;
  const { width } = useWindowDimensions();
  const [items, setItems] = useState<MarketProduct[]>([]);
  const [state, setState] = useState<'load' | 'ok' | 'err'>('load');
  const [cat, setCat] = useState('الكل');
  const [qty, setQty] = useState<{ [id: number]: number }>({});
  const [phone, setPhone] = useState(me.phone);
  const [address, setAddress] = useState(me.address);
  const [busy, setBusy] = useState(false);
  const [checkout, setCheckout] = useState(false);
  useEffect(() => { apiMarketProducts().then((r) => { setItems(r.products); setState('ok'); }).catch(() => setState('err')); }, []);
  const cats: string[] = ['الكل', ...(Array.from(new Set(items.map((x) => x.category).filter(Boolean))) as string[])];
  const shown = items.filter((x) => cat === 'الكل' || x.category === cat);
  const lines: { productId: string; qty: number }[] = Object.keys(qty).map((id) => ({ productId: id, qty: Number(qty[Number(id)]) })).filter((l) => l.qty > 0);
  const priced = (l: { productId: string; qty: number }) => items.find((x) => String(x.id) === l.productId)?.price;
  const subtotal = lines.reduce((s, l) => s + (priced(l) || 0) * l.qty, 0);
  const unpriced = lines.filter((l) => priced(l) == null).length;
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const set = (id: number, d: number) => setQty((q) => ({ ...q, [id]: Math.max(0, Math.min(50, (q[id] || 0) + d)) }));
  const tile = Math.floor((width - 16 * 2 - 8 * 2) / 3);
  const send = async () => {
    setBusy(true);
    const r = await placeMarketOrder(me, { lines, phone, address });
    setBusy(false);
    if (!r.ok) return toast(r.error, 'err');
    toast('تم إرسال طلبك للمناديب 🛵');
    navigation.replace('OrderDetail', { id: r.orderId });
  };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="طلبات ماركت" subtitle="اختار منتجاتك والمندوب يجيبها لحد بابك" onBack={() => (checkout ? setCheckout(false) : navigation.goBack())} />
      {state === 'load' ? <Empty title="جاري التحميل..." /> : state === 'err' ? <Empty title="الخدمة غير متاحة الآن" /> : checkout ? (
        <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
            <Card style={{ gap: 10 }}>
              <T w="black" size={15}>طلبك</T>
              {lines.map((l) => { const p = items.find((x) => String(x.id) === l.productId); return p ? (
                <View key={l.productId} style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T>{p.name} × {l.qty}</T><T w="bold" color={p.price == null ? C.goldDeep : C.text}>{p.price == null ? 'المندوب يسعّره' : `${p.price * l.qty} ج`}</T></View>
              ) : null; })}
              <View style={{ height: 1, backgroundColor: C.line }} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T>منتجات بسعر ثابت</T><T w="bold">{subtotal} ج</T></View>
              {unpriced > 0 && <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T>منتجات المندوب هيسعّرها</T><T w="bold">؟</T></View>}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T>التوصيل</T><T w="bold">المندوب يحدده</T></View>
              <T size={12} color={C.goldDeep} w="semi">هتشوف الفاتورة النهائية من المندوب وتوافق عليها قبل ما الطلب يتجهز.</T>
            </Card>
            <Card style={{ gap: 10 }}>
              <Field label="رقم الهاتف" icon="call" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
              <AddressPicker address={address} onPick={setAddress} />
              <Field label="عنوان التوصيل" icon="location" value={address} onChangeText={setAddress} multiline />
              <DeliveryPin />
              <Btn title="ابعت الطلب للمناديب" icon="bicycle" onPress={send} loading={busy} />
              <T size={12} color={C.sub} align="center">الدفع كاش للمندوب عند الاستلام</T>
            </Card>
          </ScrollView>
        </KeyboardAvoidingView>
      ) : (
        <>
          <ScrollView contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 100 }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {cats.map((c) => <Chip key={c} label={c} active={cat === c} onPress={() => setCat(c)} />)}
            </ScrollView>
            {shown.length === 0 && <Empty title="لا توجد منتجات" />}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {shown.map((p) => { const q = qty[p.id] || 0; return (
                <View key={p.id} style={[{ width: tile, backgroundColor: '#fff', borderRadius: 16, padding: 6, gap: 3, borderWidth: q > 0 ? 1.5 : 0, borderColor: C.green }, shadow]}>
                  <View style={{ width: '100%', aspectRatio: 1.15, borderRadius: 12, backgroundColor: '#F1F5F1', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                    {p.image ? <Image source={{ uri: marketImageUrl(p) }} style={{ width: '100%', height: '100%' }} resizeMode="cover" /> : <Text style={{ fontSize: 34 }}>{p.emoji}</Text>}
                    {p.price == null && <View style={{ position: 'absolute', top: 4, right: 4, backgroundColor: C.goldSoft, borderRadius: 7, paddingHorizontal: 5 }}><T size={9} w="bold" color={C.goldDeep}>بدون سعر</T></View>}
                  </View>
                  <T w="bold" size={12} numberOfLines={2} style={{ minHeight: 30 }}>{p.name}</T>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <T size={12} w="black" color={p.price == null ? C.goldDeep : C.green} numberOfLines={1} style={{ flex: 1 }}>{p.price == null ? 'سعر المندوب' : `${p.price} ج`}</T>
                    {q === 0 && <Pressable onPress={() => set(p.id, 1)} hitSlop={6} style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' }}><Icon name="add" size={18} color="#fff" /></Pressable>}
                  </View>
                  {q > 0 && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#E6F3EA', borderRadius: 10, paddingHorizontal: 4, height: 28 }}>
                      <Pressable onPress={() => set(p.id, 1)} hitSlop={6}><Icon name="add-circle" size={22} color={C.green} /></Pressable>
                      <T w="black" size={13}>{q}</T>
                      <Pressable onPress={() => set(p.id, -1)} hitSlop={6}><Icon name={q === 1 ? 'trash-outline' : 'remove-circle'} size={22} color={q === 1 ? C.red : C.green} /></Pressable>
                    </View>
                  )}
                </View>
              ); })}
            </View>
          </ScrollView>
          {count > 0 && (
            <View style={{ position: 'absolute', left: 16, right: 16, bottom: 16 }}>
              <Pressable onPress={() => setCheckout(true)} style={[{ backgroundColor: C.green, borderRadius: 16, paddingVertical: 13, paddingHorizontal: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, shadow]}>
                <T w="black" color="#fff">🛒 {count} منتجات</T>
                <T w="black" color="#fff">{subtotal} ج{unpriced > 0 ? ' + المندوب يكمّل' : ''}  ›</T>
              </Pressable>
            </View>
          )}
        </>
      )}
    </View>
  );
}


/** The owner's look of a new service (icon, cover, description); empty until the server answers. */
export function useSvcMeta(): Partial<SvcMeta> {
  const [m, setM] = useState<Partial<SvcMeta>>({});
  useEffect(() => { let live = true; apiSvcMeta().then((r) => { if (live) setM(r); }).catch(() => {}); return () => { live = false; }; }, []);
  return m;
}
/** The cover picture at the top of a service screen (nothing when the owner has not set one). */
export function useSvcCover(svc: SvcKey): string | undefined {
  const v = useSvcMeta()[svc]?.cover || 0;
  return v ? svcImageUrl(svc, 'cover', v) : undefined;
}
