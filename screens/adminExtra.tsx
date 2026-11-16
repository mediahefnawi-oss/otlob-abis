import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, Pressable, Text, Image } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon, Card, Btn, Empty, Header, Field, Chip, toast } from '../components/ui';
import { pickImage, canPickImage } from '../lib/pickImage';
import {
  MarketProduct, marketImageUrl, apiAdminMarketList, apiAdminMarketAdd, apiAdminMarketEdit, apiAdminMarketDelete, apiAdminMarketImage, apiAdminMarketFee, apiAdminMarketSetFee,
  RideType, rideImageUrl, apiAdminRideTypes, apiAdminRideTypeSave, apiAdminRideTypeDelete, apiAdminRideTypeImage, apiAdminRideTypeCommission,
  SvcKey, apiAdminSvcImage, apiAdminSvcSub, apiSvcMeta, svcImageUrl,
  AdminCaptain, apiAdminCaptains, apiAdminCaptainSet, apiAdminCaptainBalance, captainPhotoUrl, apiAdminRideSettings, apiAdminRideSettingsSave, apiAdminRides, apiAdminRideAssign,
} from '../lib/api';

const errText = (e: any) => String(e?.message || 'حدث خطأ، حاول مرة أخرى');
const PHOTO_AR = { car: 'العربية', license: 'رخصة المركبة', driver: 'رخصة القيادة', selfie: 'شخصية' };
const num = (v: string) => Number(String(v).replace(/[^\d.\-]/g, ''));

/* ---------------- market products ---------------- */
export function AdminMarketScreen({ navigation }: any) {
  const [list, setList] = useState<MarketProduct[] | null>(null);
  const [fee, setFee] = useState('');
  const [name, setName] = useState(''); const [price, setPrice] = useState(''); const [cat, setCat] = useState(''); const [emoji, setEmoji] = useState('');
  const load = useCallback(async () => { try { setList((await apiAdminMarketList()).products); setFee(String((await apiAdminMarketFee()).fee)); } catch (e) { toast(errText(e), 'err'); setList([]); } }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<any>, ok?: string) => { try { await fn(); if (ok) toast(ok); await load(); } catch (e) { toast(errText(e), 'err'); } };
  const add = () => run(async () => { await apiAdminMarketAdd({ name, price: num(price), category: cat, emoji: emoji || '🛒' }); setName(''); setPrice(''); }, 'تمت الإضافة');
  const pic = (id: number) => run(async () => { const img = await pickImage(); if (img) await apiAdminMarketImage(id, img); }, 'تم رفع الصورة');
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="منتجات طلبات ماركت" subtitle="إنت اللي بتضيف المنتجات وبتحدد أسعارها" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <SvcLookCard svc="market" title="طلبات ماركت" />
        <Card style={{ gap: 8 }}>
          <T w="black">رسوم التوصيل (ج)</T>
          <Field value={fee} onChangeText={setFee} keyboardType="number-pad" />
          <Btn title="حفظ الرسوم" small variant="soft" onPress={() => run(() => apiAdminMarketSetFee(num(fee)), 'تم حفظ الرسوم')} />
        </Card>
        <Card style={{ gap: 8 }}>
          <T w="black">إضافة منتج</T>
          <Field label="الاسم" value={name} onChangeText={setName} />
          <Field label="السعر (ج)" value={price} onChangeText={setPrice} keyboardType="number-pad" />
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
              <View style={{ flex: 1 }}><T w="black">{p.name}</T><T size={12} color={C.sub}>{p.category || 'بدون قسم'} • {p.price} ج</T></View>
              <Chip label={p.available ? 'متاح' : 'موقوف'} active={p.available} onPress={() => run(() => apiAdminMarketEdit(p.id, { available: !p.available }))} />
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Btn title="صورة" small variant="soft" style={{ flex: 1 }} onPress={() => pic(p.id)} />
              <Btn title="سعر +5" small variant="soft" style={{ flex: 1 }} onPress={() => run(() => apiAdminMarketEdit(p.id, { price: p.price + 5 }))} />
              <Btn title="سعر -5" small variant="soft" style={{ flex: 1 }} onPress={() => run(() => apiAdminMarketEdit(p.id, { price: Math.max(0, p.price - 5) }))} />
              <Btn title="حذف" small variant="soft" style={{ flex: 1 }} onPress={() => run(() => apiAdminMarketDelete(p.id), 'تم الحذف')} />
            </View>
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
        {tab === 'types' && <><SvcLookCard svc="rides" title="توصيلة" /><TypesTab /></>}
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

function CaptainsTab() {
  const [list, setList] = useState<AdminCaptain[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [note, setNote] = useState(''); const [amt, setAmt] = useState(''); const [pct, setPct] = useState('');
  const load = useCallback(async () => { try { setList((await apiAdminCaptains()).captains); } catch (e) { toast(errText(e), 'err'); setList([]); } }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<any>, ok?: string) => { try { await fn(); if (ok) toast(ok); await load(); } catch (e) { toast(errText(e), 'err'); } };
  const ST: Record<string, string> = { pending: 'تحت المراجعة', approved: 'مفعّل', rejected: 'مرفوض', suspended: 'موقوف', needs_photo: 'يحتاج صورة أوضح' };
  if (list === null) return <Empty title="جاري التحميل..." />;
  if (!list.length) return <Empty title="لا يوجد كباتن بعد" />;
  return (
    <>
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
    try { await apiAdminRideSettingsSave({ commissionPct: num(String(s.commissionPct)), commissionMin: num(String(s.commissionMin)), minBalance: num(String(s.minBalance)), offerSecs: num(String(s.offerSecs)), radiusKm: num(String(s.radiusKm)), autoDispatch: !!s.autoDispatch }); toast('تم الحفظ'); }
    catch (e) { toast(errText(e), 'err'); }
  };
  return (
    <Card style={{ gap: 8 }}>
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
function SvcLookCard({ svc, title }: { svc: SvcKey; title: string }) {
  const [m, setM] = useState<{ sub: string; icon: number; cover: number } | null>(null);
  const [sub, setSub] = useState('');
  const load = useCallback(async () => { try { const r = (await apiSvcMeta())[svc]; setM(r); setSub(r.sub); } catch { /* keep */ } }, [svc]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<any>, ok: string) => { try { await fn(); toast(ok); await load(); } catch (e) { toast(errText(e), 'err'); } };
  const pic = (kind: 'icon' | 'cover') => run(async () => { const img = await pickImage(kind === 'cover' ? 1600 : 700, kind === 'icon'); if (img) await apiAdminSvcImage(svc, kind, img); }, 'تم رفع الصورة');
  return (
    <Card style={{ gap: 8 }}>
      <T w="black">شكل «{title}» في الرئيسية</T>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: '#FFF3D2', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          {m?.icon ? <Image source={{ uri: svcImageUrl(svc, 'icon', m.icon) }} style={{ width: 64, height: 64 }} resizeMode="cover" /> : <T size={12} color={C.sub}>بدون</T>}
        </View>
        <Btn title="صورة الأيقونة" small variant="soft" style={{ flex: 1 }} onPress={() => pic('icon')} />
        {!!m?.icon && <Btn title="حذف" small variant="soft" onPress={() => run(() => apiAdminSvcImage(svc, 'icon', null), 'تم الحذف')} />}
      </View>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <View style={{ width: 64, height: 40, borderRadius: 8, backgroundColor: C.line, overflow: 'hidden' }}>
          {m?.cover ? <Image source={{ uri: svcImageUrl(svc, 'cover', m.cover) }} style={{ width: 64, height: 40 }} resizeMode="cover" /> : null}
        </View>
        <Btn title="صورة الكفر" small variant="soft" style={{ flex: 1 }} onPress={() => pic('cover')} />
        {!!m?.cover && <Btn title="حذف" small variant="soft" onPress={() => run(() => apiAdminSvcImage(svc, 'cover', null), 'تم الحذف')} />}
      </View>
      <Field label="الوصف تحت الاسم" value={sub} onChangeText={setSub} />
      <Btn title="حفظ الوصف" small variant="soft" onPress={() => run(() => apiAdminSvcSub(svc, sub), 'تم حفظ الوصف')} />
    </Card>
  );
}
