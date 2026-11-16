import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, Pressable, Text, Image } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon, Card, Btn, Empty, Header, Field, Chip, toast, confirmDialog } from '../components/ui';
import { pickImage, canPickImage } from '../lib/pickImage';
import {
  MarketProduct, marketImageUrl, apiAdminMarketList, apiAdminMarketAdd, apiAdminMarketImportDefaults, apiAdminMarketSetOfferText, apiAdminMarketEdit, apiAdminMarketDelete, apiAdminMarketImage, apiAdminMarketFee, apiAdminMarketSetFee,
  RideType, rideImageUrl, apiAdminRideTypes, apiAdminRideTypeSave, apiAdminRideTypeDelete, apiAdminRideTypeImage, apiAdminRideTypeCommission,
  SvcKey, SvcCoverKind, apiAdminSvcImage, apiAdminSvcSub, apiAdminSvcMeta, apiSvcMeta, svcImageUrl,
  Broadcast, BroadcastAud, apiAdminBroadcasts, apiAdminBroadcastSend, apiAdminBroadcastDelete,
  AdminCaptain, apiAdminCaptains, apiAdminCaptainSet, apiAdminCaptainBalance, captainPhotoUrl, apiAdminRideSettings, apiAdminRideSettingsSave, apiAdminRides, apiAdminRideAssign, apiAdminRideCancel, apiAdminRideComplete, apiAdminCaptainAdd,
} from '../lib/api';

const askConfirm = (title: string, message: string, onConfirm: () => void) => confirmDialog({ title, message, confirmText: 'تأكيد', onConfirm });
const errText = (e: any) => String(e?.message || 'حدث خطأ، حاول مرة أخرى');
const PHOTO_AR = { car: 'العربية', license: 'رخصة المركبة', driver: 'رخصة القيادة', selfie: 'شخصية' };
const num = (v: string) => Number(String(v).replace(/[^\d.\-]/g, ''));

/* ---------------- market products ---------------- */
/** Owner: a discount on one product (percent, optional hours until it ends, optional button text of its own). */
function DiscountEditor({ p, onSave }: { p: MarketProduct; onSave: (b: { discountPct: number | null; offerUntil: string | null; offerText: string }) => void }) {
  const [pct, setPct] = useState(p.discountPct ? String(p.discountPct) : '');
  const [hours, setHours] = useState('');
  const [txt, setTxt] = useState(p.offerText || '');
  if (p.price == null) return <T size={11.5} color={C.sub}>الخصم للمنتجات اللي ليها سعر. حط سعر للمنتج الأول.</T>;
  const n = num(pct), after = n > 0 ? Math.round(p.price * (100 - n)) / 100 : null;
  const until = p.offerUntil ? new Date(p.offerUntil) : null;
  return (
    <View style={{ gap: 6, backgroundColor: '#FFF6F5', borderRadius: 12, padding: 8 }}>
      <T w="black" size={12.5} color="#C4251F">🔥 خصم على المنتج {p.onOffer ? '(شغال)' : ''}</T>
      <Field label="نسبة الخصم % (من 1 إلى 90 — فاضي = بدون خصم)" value={pct} onChangeText={setPct} keyboardType="number-pad" />
      {after != null && <T size={12.5} w="bold" color="#C4251F">السعر بعد الخصم: {after} ج (بدل {p.price} ج)</T>}
      <Field label="ينتهي بعد كام ساعة؟ (فاضي = مفتوح لحد ما توقفه)" value={hours} onChangeText={setHours} keyboardType="number-pad" />
      {!!until && !hours && <T size={11.5} color={C.sub}>ينتهي: {until.toLocaleString('ar-EG')}</T>}
      <Field label="جملة الزر لهذا المنتج (اختياري)" value={txt} onChangeText={setTxt} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title="حفظ العرض" small style={{ flex: 1 }} onPress={() => {
          if (pct.trim() !== '' && (n < 1 || n > 90)) return toast('نسبة الخصم من 1 إلى 90', 'err');
          const h = num(hours);
          onSave({ discountPct: pct.trim() === '' ? null : n, offerUntil: hours.trim() === '' ? (p.offerUntil || null) : h > 0 ? new Date(Date.now() + h * 3600000).toISOString() : null, offerText: txt.trim() });
        }} />
        {!!p.discountPct && <Btn title="إيقاف العرض" small variant="soft" style={{ flex: 1 }} onPress={() => onSave({ discountPct: null, offerUntil: null, offerText: '' })} />}
      </View>
    </View>
  );
}

/** Owner: the button sentence shown on every discounted product (a product can have its own). */
function OfferTextCard() {
  const [t, setT] = useState('');
  useEffect(() => { apiAdminMarketFee().then((r) => setT(r.offerText || 'وفّر واطلب')).catch(() => {}); }, []);
  return (
    <Card style={{ gap: 8 }}>
      <T w="black">جملة زر العروض (لكل التطبيق)</T>
      <Field label="مثال: وفّر واطلب • الحق العرض • خصم النهارده" value={t} onChangeText={setT} />
      <Btn title="حفظ الجملة" small variant="soft" onPress={async () => { try { await apiAdminMarketSetOfferText(t); toast('تم الحفظ'); } catch (e) { toast(errText(e), 'err'); } }} />
    </Card>
  );
}

export function AdminMarketScreen({ navigation }: any) {
  const [list, setList] = useState<MarketProduct[] | null>(null);
  const [name, setName] = useState(''); const [price, setPrice] = useState(''); const [cat, setCat] = useState(''); const [emoji, setEmoji] = useState('');
  const load = useCallback(async () => { try { setList((await apiAdminMarketList()).products); } catch (e) { toast(errText(e), 'err'); setList([]); } }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<any>, ok?: string) => { try { await fn(); if (ok) toast(ok); await load(); } catch (e) { toast(errText(e), 'err'); } };
  const add = () => run(async () => { await apiAdminMarketAdd({ name, price: price.trim() === '' ? null : num(price), category: cat, emoji: emoji || '🛒' }); setName(''); setPrice(''); }, 'تمت الإضافة');
  const pic = (id: number) => run(async () => { const img = await pickImage(); if (img) await apiAdminMarketImage(id, img); }, 'تم رفع الصورة');
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="منتجات طلبات ماركت" subtitle="إنت اللي بتضيف المنتجات وبتحدد أسعارها" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <SvcLookCard svc="market" title="طلبات ماركت في الرئيسية" withName />
        <OfferTextCard />
        <Card style={{ gap: 4 }}>
          <T w="black">التوصيل</T>
          <T size={12.5} color={C.sub}>مفيش سعر توصيل ثابت: المندوب بيحدد سعر التوصيل وسعر أي منتج من غير سعر، والعميل بيوافق على الفاتورة.</T>
        </Card>
        <Btn title="إضافة المنتجات الجاهزة (بدون أسعار)" icon="cart" variant="soft" onPress={() => askConfirm('المنتجات الجاهزة', 'هيتضاف حوالي 78 منتج بدون أسعار (المندوب يسعّرها). المنتجات اللي بنفس الاسم مش هتتكرر.', async () => { try { const x = await apiAdminMarketImportDefaults(); toast(x.added ? `تمت إضافة ${x.added} منتج` : 'كلها مضافة بالفعل'); load(); } catch (e) { toast(errText(e), 'err'); } })} />
        <Card style={{ gap: 8 }}>
          <T w="black">إضافة منتج</T>
          <Field label="الاسم" value={name} onChangeText={setName} />
          <Field label="السعر (ج) — سيبه فاضي لو المندوب هو اللي يسعّره" value={price} onChangeText={setPrice} keyboardType="number-pad" />
          <Field label="القسم (مثال: ألبان)" value={cat} onChangeText={setCat} />
          <Field label="إيموجي (اختياري)" value={emoji} onChangeText={setEmoji} />
          <Btn title="أضف" icon="add-circle" onPress={add} />
        </Card>
        {list === null ? <Empty title="جاري التحميل..." /> : list.length === 0 ? <Empty title="لا توجد منتجات بعد" /> : list.map((p) => (
          <Card key={p.id} style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 52, height: 52, borderRadius: 12, backgroundColor: '#EEF3EE', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                {p.image ? <Image source={{ uri: marketImageUrl(p) }} style={{ width: 52, height: 52 }} /> : <Text style={{ fontSize: 26 }}>{p.emoji}</Text>}
              </View>
              <View style={{ flex: 1 }}><T w="black">{p.name}</T><T size={12} color={C.sub}>{p.category || 'بدون قسم'} • {p.price == null ? 'بدون سعر (المندوب يسعّره)' : `${p.price} ج`}</T></View>
              <Chip label={p.available ? 'متاح' : 'موقوف'} active={p.available} onPress={() => run(() => apiAdminMarketEdit(p.id, { available: !p.available }))} />
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn title="صورة" small variant="soft" style={{ flex: 1 }} onPress={() => pic(p.id)} />
              <Btn title="سعر +5" small variant="soft" style={{ flex: 1 }} onPress={() => run(() => apiAdminMarketEdit(p.id, { price: (p.price ?? 0) + 5 }))} />
              <Btn title="سعر -5" small variant="soft" style={{ flex: 1 }} onPress={() => run(() => apiAdminMarketEdit(p.id, { price: Math.max(0, (p.price ?? 0) - 5) }))} />
              <Btn title={p.price == null ? 'له سعر' : 'بدون سعر'} small variant="soft" style={{ flex: 1 }} onPress={() => run(() => apiAdminMarketEdit(p.id, { price: p.price == null ? 10 : null }))} />
              <Btn title="حذف" small variant="soft" style={{ flex: 1 }} onPress={() => run(() => apiAdminMarketDelete(p.id), 'تم الحذف')} />
            </View>
            <DiscountEditor key={`${p.id}-${p.discountPct}-${p.offerUntil}`} p={p} onSave={(b) => run(() => apiAdminMarketEdit(p.id, b), 'تم حفظ العرض')} />
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}

/* ---------------- rides: types / captains / settings / rides ---------------- */
type Tab = 'types' | 'captains' | 'settings' | 'rides';
export function AdminRidesScreen({ navigation }: any) {
  const [tab, setTab] = useState<Tab>('captains');
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="التوصيلة" subtitle="الأنواع والأسعار، الكباتن، العمولة، الرحلات" onBack={() => navigation.goBack()} />
      <View style={{ flexDirection: 'row', gap: 8, padding: 12, flexWrap: 'wrap' }}>
        {([['captains', 'الكباتن'], ['types', 'الأنواع والأسعار'], ['settings', 'العمولة والتحكم'], ['rides', 'الرحلات']] as [Tab, string][]).map(([k, l]) => <Chip key={k} label={l} active={tab === k} onPress={() => setTab(k)} />)}
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, paddingTop: 4, gap: 12, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        {tab === 'types' && <><SvcLookCard svc="rides" title="توصيلة في الرئيسية" withName /><TypesTab /></>}
        {tab === 'captains' && <CaptainsTab />}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'rides' && <RidesTab />}
      </ScrollView>
    </View>
  );
}

function TypesTab() {
  const [list, setList] = useState<RideType[] | null>(null);
  const [f, setF] = useState({ name: '', base: '10', perKm: '9', min: '30', adj: '30' });
  const load = useCallback(async () => { try { setList((await apiAdminRideTypes()).types); } catch (e) { toast(errText(e), 'err'); setList([]); } }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<any>, ok?: string) => { try { await fn(); if (ok) toast(ok); await load(); } catch (e) { toast(errText(e), 'err'); } };
  return (
    <>
      <Card style={{ gap: 8 }}>
        <T w="black">إضافة نوع مركبة</T>
        <Field label="الاسم" value={f.name} onChangeText={(v) => setF({ ...f, name: v })} />
        <Field label="سعر الفتح (ج)" value={f.base} onChangeText={(v) => setF({ ...f, base: v })} keyboardType="number-pad" />
        <Field label="سعر الكيلو (ج)" value={f.perKm} onChangeText={(v) => setF({ ...f, perKm: v })} keyboardType="number-pad" />
        <Field label="الحد الأدنى للرحلة (ج)" value={f.min} onChangeText={(v) => setF({ ...f, min: v })} keyboardType="number-pad" />
        <Field label="نسبة تعديل السعر المسموحة %" value={f.adj} onChangeText={(v) => setF({ ...f, adj: v })} keyboardType="number-pad" />
        <Btn title="أضف" icon="add-circle" onPress={() => run(() => apiAdminRideTypeSave(null, { name: f.name, base_fee: num(f.base), per_km: num(f.perKm), min_fee: num(f.min), adj_pct: num(f.adj) }), 'تمت الإضافة')} />
      </Card>
      {list === null ? <Empty title="جاري التحميل..." /> : list.map((t) => (
        <Card key={t.id} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 70, height: 48, alignItems: 'center', justifyContent: 'center' }}>{t.image ? <Image source={{ uri: rideImageUrl(t) }} style={{ width: 70, height: 48 }} resizeMode="contain" /> : <Text style={{ fontSize: 28 }}>🚕</Text>}</View>
            <View style={{ flex: 1 }}><T w="black">{t.name}</T><T size={12} color={C.sub}>فتح {t.baseFee} + {t.perKm}/كم • أدنى {t.minFee} • ±{t.adjPct}%</T></View>
            <Chip label={t.active ? 'شغال' : 'موقوف'} active={t.active} onPress={() => run(() => apiAdminRideTypeSave(t.id, { active: !t.active }))} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn title="صورة" small variant="soft" style={{ flex: 1 }} onPress={() => run(async () => { const img = await pickImage(1100, true); if (img) await apiAdminRideTypeImage(t.id, img); }, 'تم رفع الصورة')} />
            <Btn title="الكيلو +1" small variant="soft" style={{ flex: 1 }} onPress={() => run(() => apiAdminRideTypeSave(t.id, { per_km: t.perKm + 1 }))} />
            <Btn title="الكيلو -1" small variant="soft" style={{ flex: 1 }} onPress={() => run(() => apiAdminRideTypeSave(t.id, { per_km: Math.max(0, t.perKm - 1) }))} />
            <Btn title="حذف" small variant="soft" style={{ flex: 1 }} onPress={() => run(() => apiAdminRideTypeDelete(t.id), 'تم الحذف')} />
          </View>
          <CommissionRow type={t} />
        </Card>
      ))}
    </>
  );
}
function CommissionRow({ type }: { type: RideType }) {
  const [v, setV] = useState('');
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
      <View style={{ flex: 1 }}><Field label="عمولة هذا النوع % (فاضي = العمولة العامة)" value={v} onChangeText={setV} keyboardType="number-pad" /></View>
      <Btn title="حفظ" small variant="soft" onPress={async () => { try { await apiAdminRideTypeCommission(type.id, v.trim() === '' ? null : num(v)); toast('تم الحفظ'); } catch (e) { toast(errText(e), 'err'); } }} />
    </View>
  );
}

/** Owner: opens a captain account by hand (already approved, no photos needed). */
function AddCaptainCard({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [types, setTypes] = useState<RideType[]>([]);
  const [f, setF] = useState({ name: '', phone: '', password: '', model: '', color: '', plate: '' });
  const [typeId, setTypeId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open && !types.length) apiAdminRideTypes().then((r) => { setTypes(r.types); if (r.types[0]) setTypeId(r.types[0].id); }).catch(() => {}); }, [open, types.length]);
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    if (!typeId) return toast('اختر نوع المركبة', 'err');
    setBusy(true);
    try { await apiAdminCaptainAdd({ ...f, typeId }); toast('تم إضافة الكابتن'); setF({ name: '', phone: '', password: '', model: '', color: '', plate: '' }); setOpen(false); onDone(); }
    catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
  };
  if (!open) return <Btn title="إضافة حساب كابتن" icon="person-add" variant="soft" onPress={() => setOpen(true)} />;
  return (
    <Card style={{ gap: 8 }}>
      <T w="black">إضافة حساب كابتن</T>
      <Field label="الاسم بالكامل" value={f.name} onChangeText={set('name')} />
      <Field label="رقم الهاتف (01xxxxxxxxx)" value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
      <Field label="كلمة المرور (8 أحرف على الأقل)" value={f.password} onChangeText={set('password')} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {types.map((t) => <Chip key={t.id} label={t.name} active={typeId === t.id} onPress={() => setTypeId(t.id)} />)}
      </ScrollView>
      <Field label="موديل المركبة" value={f.model} onChangeText={set('model')} />
      <Field label="اللون" value={f.color} onChangeText={set('color')} />
      <Field label="رقم اللوحة" value={f.plate} onChangeText={set('plate')} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn title="حفظ" icon="checkmark" style={{ flex: 1 }} onPress={save} loading={busy} />
        <Btn title="إلغاء" variant="soft" style={{ flex: 1 }} onPress={() => setOpen(false)} />
      </View>
    </Card>
  );
}

function CaptainsTab() {
  const [list, setList] = useState<AdminCaptain[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [note, setNote] = useState(''); const [amt, setAmt] = useState(''); const [pct, setPct] = useState('');
  const load = useCallback(async () => { try { setList((await apiAdminCaptains()).captains); } catch (e) { toast(errText(e), 'err'); setList([]); } }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<any>, ok?: string) => { try { await fn(); if (ok) toast(ok); await load(); } catch (e) { toast(errText(e), 'err'); } };
  const ST: Record<string, string> = { pending: 'تحت المراجعة', approved: 'مفعّل', rejected: 'مرفوض', suspended: 'موقوف', needs_photo: 'يحتاج صورة أوضح' };
  if (list === null) return <Empty title="جاري التحميل..." />;
  if (!list.length) return <><AddCaptainCard onDone={load} /><Empty title="لا يوجد كباتن بعد" /></>;
  return (
    <>
      <AddCaptainCard onDone={load} />
      {list.map((c) => (
        <Card key={c.id} style={{ gap: 8 }}>
          <Pressable onPress={() => setOpen(open === c.id ? null : c.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}><T w="black">{c.name} • {c.phone}</T><T size={12} color={C.sub}>{c.typeName || '—'} • {c.model} • {c.color} • {c.plate}</T></View>
            <T size={12} w="bold" color={c.status === 'approved' ? C.green : c.status === 'pending' ? C.goldDeep : C.red}>{ST[c.status]}</T>
          </Pressable>
          {open === c.id && (
            <>
              <T size={12.5}>الرصيد: {c.balance} ج • عمولته: {c.commissionPct == null ? 'العامة' : c.commissionPct + '%'} • الاستقبال: {c.autoReceive ? 'تلقائي' : 'يدوي'}</T>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                {c.photos.map((k) => <View key={k} style={{ alignItems: 'center', gap: 2 }}><Image source={{ uri: captainPhotoUrl(c.id, k) }} style={{ width: 120, height: 90, borderRadius: 10, backgroundColor: C.line }} resizeMode="cover" /><T size={11} color={C.sub}>{(PHOTO_AR as Record<string, string>)[k] || k}</T></View>)}
              </ScrollView>
              <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                <Btn title="قبول" small style={{ flex: 1 }} onPress={() => run(() => apiAdminCaptainSet(c.id, { status: 'approved' }), 'تم القبول')} />
                <Btn title="رفض" small variant="soft" style={{ flex: 1 }} onPress={() => run(() => apiAdminCaptainSet(c.id, { status: 'rejected' }), 'تم الرفض')} />
                <Btn title="إيقاف" small variant="soft" style={{ flex: 1 }} onPress={() => run(() => apiAdminCaptainSet(c.id, { status: 'suspended' }), 'تم الإيقاف')} />
              </View>
              <Field label="سبب طلب صورة أوضح" value={note} onChangeText={setNote} />
              <Btn title="اطلب صورة أوضح" small variant="soft" onPress={() => run(() => apiAdminCaptainSet(c.id, { status: 'needs_photo', note }), 'تم الإرسال للكابتن')} />
              <Field label="شحن الرصيد (سالب للخصم)" value={amt} onChangeText={setAmt} keyboardType="numbers-and-punctuation" />
              <Btn title="نفّذ" small variant="soft" onPress={() => run(() => apiAdminCaptainBalance(c.id, num(amt), 'من الإدارة'), 'تم تعديل الرصيد')} />
              <Field label="عمولة هذا الكابتن % (فاضي = العامة)" value={pct} onChangeText={setPct} keyboardType="number-pad" />
              <Btn title="حفظ العمولة" small variant="soft" onPress={() => run(() => apiAdminCaptainSet(c.id, { commissionPct: pct.trim() === '' ? null : num(pct) }), 'تم الحفظ')} />
              <Btn title={c.autoReceive ? 'خليه يستقبل يدوي' : 'خليه يستقبل تلقائي'} small variant="soft" onPress={() => run(() => apiAdminCaptainSet(c.id, { autoReceive: !c.autoReceive }))} />
            </>
          )}
        </Card>
      ))}
    </>
  );
}

function SettingsTab() {
  const [s, setS] = useState<any>(null);
  const load = useCallback(async () => { try { setS(await apiAdminRideSettings()); } catch (e) { toast(errText(e), 'err'); } }, []);
  useEffect(() => { load(); }, [load]);
  if (!s) return <Empty title="جاري التحميل..." />;
  const set = (k: string, v: string) => setS({ ...s, [k]: v });
  const save = async () => {
    try { await apiAdminRideSettingsSave({ commissionPct: num(String(s.commissionPct)), commissionMin: num(String(s.commissionMin)), minBalance: num(String(s.minBalance)), offerSecs: num(String(s.offerSecs)), radiusKm: num(String(s.radiusKm)), autoDispatch: !!s.autoDispatch, pricing: s.pricing === 'bidding' ? 'bidding' : 'fixed' }); toast('تم الحفظ'); }
    catch (e) { toast(errText(e), 'err'); }
  };
  return (
    <Card style={{ gap: 8 }}>
      <T w="black" size={14}>طريقة التسعير</T>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Chip label="سعر ثابت (النظام يقترح والعميل يعدّل)" active={s.pricing !== 'bidding'} onPress={() => setS({ ...s, pricing: 'fixed' })} />
        <Chip label="مزايدة (الكباتن يحددوا السعر)" active={s.pricing === 'bidding'} onPress={() => setS({ ...s, pricing: 'bidding' })} />
      </View>
      <Field label="العمولة العامة %" value={String(s.commissionPct)} onChangeText={(v) => set('commissionPct', v)} keyboardType="number-pad" />
      <Field label="أقل عمولة (ج)" value={String(s.commissionMin)} onChangeText={(v) => set('commissionMin', v)} keyboardType="number-pad" />
      <Field label="حد الإيقاف التلقائي للرصيد (سالب، مثال -50)" value={String(s.minBalance)} onChangeText={(v) => set('minBalance', v)} keyboardType="numbers-and-punctuation" />
      <Field label="مدة عرض الطلب على الكابتن (ثانية)" value={String(s.offerSecs)} onChangeText={(v) => set('offerSecs', v)} keyboardType="number-pad" />
      <Field label="نطاق الكباتن حوالين نقطة التحميل (كم)" value={String(s.radiusKm)} onChangeText={(v) => set('radiusKm', v)} keyboardType="number-pad" />
      <Chip label={s.autoDispatch ? 'التوزيع التلقائي: شغال' : 'التوزيع التلقائي: مقفول'} active={!!s.autoDispatch} onPress={() => setS({ ...s, autoDispatch: !s.autoDispatch })} />
      <Btn title="حفظ" icon="save" onPress={save} />
    </Card>
  );
}

function RidesTab() {
  const [list, setList] = useState<any[] | null>(null);
  const [driver, setDriver] = useState<Record<number, string>>({});
  const load = useCallback(async () => { try { setList((await apiAdminRides()).rides); } catch (e) { toast(errText(e), 'err'); setList([]); } }, []);
  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, [load]);
  if (list === null) return <Empty title="جاري التحميل..." />;
  if (!list.length) return <Empty title="لا توجد رحلات" />;
  return (
    <>
      {list.map((r) => (
        <Card key={r.id} style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T w="black">رحلة #{r.id} • {r.customer}</T><T size={12} color={C.sub}>{r.status}</T></View>
          <T size={12.5} color={C.sub}>{r.km} كم • {r.finalPrice ?? r.offered} ج • الكابتن: {r.driver || '—'}</T>
          {['searching', 'assigned', 'arrived', 'started'].includes(r.status) && (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn title="إلغاء الرحلة" small variant="soft" style={{ flex: 1 }} onPress={() => askConfirm('إلغاء الرحلة', `إلغاء رحلة #${r.id}؟`, async () => { try { await apiAdminRideCancel(r.id); toast('تم الإلغاء'); load(); } catch (e) { toast(errText(e), 'err'); } })} />
              {!!r.driver && r.status !== 'searching' && <Btn title="تأكيد الإنهاء" small style={{ flex: 1 }} onPress={() => askConfirm('تأكيد الإنهاء', `تأكيد إنهاء رحلة #${r.id}؟ هتتخصم عمولة الكابتن.`, async () => { try { const x = await apiAdminRideComplete(r.id); toast(`تم التأكيد — العمولة ${x.commission} ج`); load(); } catch (e) { toast(errText(e), 'err'); } })} />}
            </View>
          )}
          {['searching', 'assigned'].includes(r.status) && (
            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
              <View style={{ flex: 1 }}><Field label="رقم الكابتن (من تبويب الكباتن)" value={driver[r.id] || ''} onChangeText={(v) => setDriver({ ...driver, [r.id]: v })} keyboardType="number-pad" /></View>
              <Btn title="حوّل" small variant="soft" onPress={async () => { try { await apiAdminRideAssign(r.id, num(driver[r.id] || '0')); toast('تم التحويل'); load(); } catch (e) { toast(errText(e), 'err'); } }} />
            </View>
          )}
        </Card>
      ))}
    </>
  );
}

/** Owner: icon picture, cover picture and the description line of a new service on the home. */
export function SvcLookCard({ svc, title, withName }: { svc: SvcKey; title: string; withName?: boolean }) {
  const [m, setM] = useState<{ sub: string; title: string; sort: number; icon: number; cover: number; cover2: number; cover3: number } | null>(null);
  const [sub, setSub] = useState(''); const [name, setName] = useState(''); const [sort, setSort] = useState('');
  const load = useCallback(async () => { try { const r = (await apiSvcMeta())[svc]; setM(r); setSub(r.sub); setName(r.title || ''); setSort(r.sort ? String(r.sort) : ''); } catch { /* keep */ } }, [svc]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast(ok); await load(); } catch (e) { toast(errText(e), 'err'); } };
  const pic = (kind: 'icon' | SvcCoverKind) => run(async () => { const img = await pickImage(kind === 'icon' ? 700 : 1600, kind === 'icon'); if (img) await apiAdminSvcImage(svc, kind, img); }, 'تم رفع الصورة');
  const COVERS: { k: SvcCoverKind; l: string }[] = [{ k: 'cover', l: 'صورة الغلاف 1' }, { k: 'cover2', l: 'صورة الغلاف 2' }, { k: 'cover3', l: 'صورة الغلاف 3' }];
  return (
    <Card style={{ gap: 8 }}>
      <T w="black">شكل «{title}»</T>
      {!!withName && <Field label="الاسم على الرئيسية (فاضي = الاسم الأصلي)" value={name} onChangeText={setName} />}
      {!!withName && <Field label="الترتيب في الرئيسية (رقم أصغر = أعلى، فاضي = الافتراضي)" value={sort} onChangeText={setSort} keyboardType="number-pad" />}
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#FFF3D2', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          {m?.icon ? <Image source={{ uri: svcImageUrl(svc, 'icon', m.icon) }} style={{ width: 64, height: 64 }} resizeMode="cover" /> : <T size={12} color={C.sub}>بدون</T>}
        </View>
        <Btn title="صورة الأيقونة" small variant="soft" style={{ flex: 1 }} onPress={() => pic('icon')} />
        {!!m?.icon && <Btn title="حذف" small variant="soft" onPress={() => run(() => apiAdminSvcImage(svc, 'icon', null), 'تم الحذف')} />}
      </View>
      <T size={11.5} color={C.sub}>الغلاف: صورة أو أكتر (لحد 3). لو رفعت أكتر من صورة بتتحرك لوحدها في البانر.</T>
      {COVERS.map((c) => (
        <View key={c.k} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
          <View style={{ width: 64, height: 40, borderRadius: 8, backgroundColor: C.line, overflow: 'hidden' }}>
            {m?.[c.k] ? <Image source={{ uri: svcImageUrl(svc, c.k, m[c.k]) }} style={{ width: 64, height: 40 }} resizeMode="cover" /> : null}
          </View>
          <Btn title={c.l} small variant="soft" style={{ flex: 1 }} onPress={() => pic(c.k)} />
          {!!m?.[c.k] && <Btn title="حذف" small variant="soft" onPress={() => run(() => apiAdminSvcImage(svc, c.k, null), 'تم الحذف')} />}
        </View>
      ))}
      <Field label="الوصف تحت الاسم" value={sub} onChangeText={setSub} />
      <Btn title="حفظ" small variant="soft" onPress={() => {
        const n = sort.trim() === '' ? 0 : Number(sort);
        if (!Number.isFinite(n) || n < 0 || n > 999) return toast('الترتيب رقم من 0 إلى 999', 'err');
        run(() => apiAdminSvcMeta(svc, { sub, ...(withName ? { title: name, sort: n } : {}) }), 'تم الحفظ');
      }} />
    </Card>
  );
}

/* ---------------- owner broadcasts ---------------- */
const AUDS: { k: BroadcastAud; label: string }[] = [{ k: 'all', label: 'الكل' }, { k: 'customer', label: 'العملاء' }, { k: 'courier', label: 'المناديب' }, { k: 'captain', label: 'الكباتن' }, { k: 'provider', label: 'المحلات' }];
export function AdminBroadcastScreen({ navigation }: any) {
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [aud, setAud] = useState<BroadcastAud>('all');
  const [list, setList] = useState<Broadcast[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({}); const [pushUsers, setPushUsers] = useState(0); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { const r = await apiAdminBroadcasts(); setList(r.broadcasts); setCounts(r.counts); setPushUsers(r.pushUsers); } catch (e) { toast(errText(e), 'err'); setList([]); } }, []);
  useEffect(() => { load(); }, [load]);
  const n = counts[aud] ?? 0;
  const send = () => {
    if (!title.trim()) { toast('اكتب عنوان الإشعار', 'err'); return; }
    askConfirm('إرسال الإشعار', `هيوصل لـ ${n} مستخدم (${AUDS.find((a) => a.k === aud)?.label}). متأكد؟`, async () => {
      setBusy(true);
      try { const r = await apiAdminBroadcastSend({ title, body, audience: aud }); setList(r.broadcasts); setTitle(''); setBody(''); toast('تم الإرسال'); }
      catch (e) { toast(errText(e), 'err'); } finally { setBusy(false); }
    });
  };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="إرسال إشعار" subtitle="يوصل على الموبايل ويظهر جوه التطبيق عند الكل" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: 8 }}>
          <Field label="العنوان (مثال: 🎉 عرض اليوم)" value={title} onChangeText={setTitle} />
          <Field label="الرسالة" value={body} onChangeText={setBody} multiline />
          <T w="bold" size={13}>يوصل لـ</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {AUDS.map((a) => <Chip key={a.k} label={`${a.label} (${counts[a.k] ?? 0})`} active={aud === a.k} onPress={() => setAud(a.k)} />)}
          </View>
          <Btn title={`إرسال لـ ${n} مستخدم`} icon="send" loading={busy} onPress={send} />
          <T size={11.5} color={C.sub}>{pushUsers} مستخدم مفعّلين إشعارات الموبايل. الباقي هتظهرله الرسالة جوه التطبيق أول ما يفتحه.</T>
        </Card>
        <T w="black">آخر الإشعارات</T>
        {list === null ? <T color={C.sub}>جاري التحميل...</T> : list.length === 0 ? <Empty title="لسه مفيش إشعارات" /> : list.map((b) => (
          <Card key={b.id} style={{ gap: 4 }}>
            <T w="black">{b.title}</T>
            {!!b.body && <T size={13} color={C.sub}>{b.body}</T>}
            <T size={11.5} color={C.sub}>{b.audienceAr} • {b.sentTo} مستخدم • {new Date(b.createdAt).toLocaleString('ar-EG')}</T>
            <Btn title="حذف الرسالة من التطبيق" small variant="soft" onPress={() => askConfirm('حذف', 'هتختفي الرسالة لمن لم يشاهدها بعد (اللي وصله إشعار الموبايل مش بيتسحب).', async () => { try { setList((await apiAdminBroadcastDelete(b.id)).broadcasts); } catch (e) { toast(errText(e), 'err'); } })} />
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}
