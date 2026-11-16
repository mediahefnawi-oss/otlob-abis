import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, ScrollView, Pressable, Text, Image, Linking } from 'react-native';
import { C, shadow } from '../lib/theme';
import { T, Icon, Card, Btn, Empty, Header, Field, toast } from '../components/ui';
import MapView from '../components/MapView';
import { getPosition } from '../lib/location';
import { reverseAddress, searchPlace } from '../lib/revgeo';
import { pickImage, canPickImage } from '../lib/pickImage';
import { useStore } from '../lib/store';
import { alertNewOrder } from '../lib/alerts';
import {
  RideType, RidePoint, Ride, RideOffer, rideImageUrl, apiRideTypes, apiRideEstimate, apiRideCreate, apiRideCurrent, apiRideAcceptOffer, apiRideCancel,
  CaptainMe, CaptainReq, apiCaptainMe, apiCaptainProfile, apiCaptainPhoto, apiCaptainRequests, apiCaptainOffer, apiCaptainStatus, apiCaptainCurrent, CaptainRide,
} from '../lib/api';

const errText = (e: any) => String(e?.message || 'حدث خطأ، حاول مرة أخرى');
const STATUS_AR: Record<string, string> = { searching: 'بندوّر لك على كابتن...', assigned: 'الكابتن في الطريق إليك', arrived: 'الكابتن وصل', started: 'الرحلة شغالة', completed: 'وصلت بالسلامة ✅', cancelled: 'الرحلة اتلغت', expired: 'انتهت المهلة' };

function TypeTile({ t, active, onPress }: { t: RideType; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ width: 118, backgroundColor: '#fff', borderRadius: 18, padding: 8, alignItems: 'center', gap: 4, borderWidth: 2, borderColor: active ? C.green : 'transparent', ...shadow }}>
      <View style={{ width: 100, height: 64, alignItems: 'center', justifyContent: 'center' }}>
        {t.image ? <Image source={{ uri: rideImageUrl(t) }} style={{ width: 100, height: 64 }} resizeMode="contain" /> : <Text style={{ fontSize: 36 }}>🚕</Text>}
      </View>
      <T w="black" size={13} align="center" numberOfLines={1}>{t.name}</T>
    </Pressable>
  );
}

const routePts = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, r?: [number, number][] | null): [number, number][] => (r && r.length > 1 ? r : [[a.lat, a.lng], [b.lat, b.lng]]);

/** The customer: choose a vehicle, point on the map, set a price near the suggested one, wait for offers. */
export function RideHomeScreen({ navigation }: any) {
  const { db } = useStore();
  const [types, setTypes] = useState<RideType[] | null>(null);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [from, setFrom] = useState<RidePoint | null>(null);
  const [to, setTo] = useState<RidePoint | null>(null);
  const [est, setEst] = useState<{ km: number; minutes: number; price: number; lo: number; hi: number; route?: [number, number][] | null } | null>(null);
  const [target, setTarget] = useState<'from' | 'to'>('from');
  const [note, setNote] = useState('');
  const [fromDetails, setFromDetails] = useState('');
  const [locating, setLocating] = useState(false);
  const [searching, setSearching] = useState(false);
  const [price, setPrice] = useState(0);
  const [busy, setBusy] = useState(false);
  const [cur, setCur] = useState<{ ride: Ride | null; offers: RideOffer[] } | null>(null);
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');

  const loadCur = useCallback(async () => { try { setCur(await apiRideCurrent()); } catch { /* keep the last state */ } }, []);
  useEffect(() => { apiRideTypes().then((r) => { setTypes(r.types); if (r.types[0]) setTypeId(r.types[0].id); }).catch(() => setTypes([])); loadCur(); }, [loadCur]);
  useEffect(() => { const t = setInterval(loadCur, 4000); return () => clearInterval(t); }, [loadCur]);
  /** Sets a pin and writes its address in the field by itself (the field stays editable; no address = it stays as typed). */
  const setPin = async (which: 'from' | 'to', p: { lat: number; lng: number }) => {
    if (which === 'from') { setFrom(p); setFromText(''); setTarget('to'); } else { setTo(p); setToText(''); }
    const a = await reverseAddress(p.lat, p.lng);
    if (a) (which === 'from' ? setFromText : setToText)((cur) => cur || a);
  };
  const locate = async () => {
    setLocating(true);
    try { const p = await getPosition(); await setPin('from', { lat: p.lat, lng: p.lng }); }
    catch (e) { toast(errText(e), 'err'); }
    finally { setLocating(false); }
  };
  const findDest = async () => {
    if (!toText.trim()) return;
    setSearching(true);
    try {
      const r = await searchPlace(toText, from);
      if (r) { setTo({ lat: r.lat, lng: r.lng }); setTarget('to'); } else toast('ما لقيناش المكان بالاسم، حط الدبوس على الخريطة', 'err');
    } finally { setSearching(false); }
  };
  useEffect(() => {
    setEst(null);
    if (!from || !to || !typeId) return;
    let live = true;
    apiRideEstimate(from, to, typeId).then((r) => { if (live) { setEst(r); setPrice(r.price); } }).catch((e) => { if (live) toast(errText(e), 'err'); });
    return () => { live = false; };
  }, [from?.lat, from?.lng, to?.lat, to?.lng, typeId]);

  if (!db.settings.features?.rides) return <View style={{ flex: 1, backgroundColor: C.bg }}><Header title="توصيلة" onBack={() => navigation.goBack()} /><Empty title="الخدمة غير متاحة الآن" /></View>;
  const ride = cur?.ride;
  const live = ride && ['searching', 'assigned', 'arrived', 'started'].includes(ride.status);

  const request = async () => {
    if (!from || !to || !typeId || !est) return;
    setBusy(true);
    try { await apiRideCreate({ ...from, text: [fromText, fromDetails.trim()].filter(Boolean).join(' — ').slice(0, 200) }, { ...to, text: [toText, note.trim()].filter(Boolean).join(' — ').slice(0, 200) }, typeId, price); await loadCur(); toast('تم إرسال طلبك للكباتن 🚕'); }
    catch (e) { toast(errText(e), 'err'); }
    finally { setBusy(false); }
  };
  const cancel = async () => { if (!ride) return; try { await apiRideCancel(ride.id); await loadCur(); } catch (e) { toast(errText(e), 'err'); } };
  const take = async (o: RideOffer) => { if (!ride) return; try { await apiRideAcceptOffer(ride.id, o.id); await loadCur(); } catch (e) { toast(errText(e), 'err'); } };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="توصيلة" subtitle={ride?.bidding || est?.bidding ? 'حدد وجهتك والكباتن يحددوا السعر' : 'حدد وجهتك واختار السعر اللي يناسبك'} onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        {live && ride ? (
          <>
            <Card style={{ gap: 6 }}>
              <T w="black" size={17}>{STATUS_AR[ride.status] || ride.status}</T>
              <T size={13} color={C.sub}>{ride.km} كم تقريباً • {ride.minutes} دقيقة</T>
              <T w="black" size={18} color={C.green}>{ride.finalPrice != null ? `${ride.finalPrice} ج` : ride.bidding ? 'السعر حسب عروض الكباتن' : `${ride.offered} ج`}</T>
            </Card>
            {ride.status === 'searching' && (cur?.offers || []).length === 0 && <Card><T color={C.sub} align="center">مستنيين عروض الكباتن... هتظهر هنا</T></Card>}
            {ride.status === 'searching' && (cur?.offers || []).map((o) => (
              <Card key={o.id} style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T w="black" size={15}>{o.driver.name}</T><T w="black" size={16} color={C.green}>{o.price} ج</T></View>
                <T size={12.5} color={C.sub}>{o.driver.model} • {o.driver.color} • {o.driver.plate}</T>
                <Btn title="اقبل العرض" icon="checkmark-circle" small onPress={() => take(o)} />
              </Card>
            ))}
            {(ride.status === 'searching' || ride.status === 'assigned' || ride.status === 'arrived') && <Btn title="إلغاء الرحلة" variant="soft" onPress={cancel} />}
          </>
        ) : (
          <>
            {ride && ride.status === 'completed' && <Card><T w="black" align="center">{STATUS_AR.completed}</T></Card>}
            <T w="black" size={15}>اختار المركبة</T>
            {types === null ? <T color={C.sub}>جاري التحميل...</T> : types.length === 0 ? <Empty title="لا توجد أنواع متاحة" /> : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
                {types.map((t) => <TypeTile key={t.id} t={t} active={typeId === t.id} onPress={() => setTypeId(t.id)} />)}
              </ScrollView>
            )}
            <T w="black" size={15}>من فين لفين؟</T>
            <Pressable onPress={() => setTarget('from')} style={{ borderWidth: 1.5, borderColor: target === 'from' ? C.green : C.line, borderRadius: 14, backgroundColor: '#fff', padding: 10, gap: 6 }}>
              <T size={11.5} color={C.sub}>مكان التحميل</T>
              <Field label="" value={fromText} onChangeText={setFromText} placeholder={from ? 'اكتب العنوان لو مش ظاهر' : 'دوس «حدد موقعي» أو اختار من الخريطة'} />
              <Field label="" value={fromDetails} onChangeText={setFromDetails} placeholder="تفاصيل مكانك (عمارة، دور، علامة مميزة، رقم شقة)" />
              <Btn title={from ? 'حدّد موقعي من جديد' : 'حدد موقعي'} icon="locate" small variant="soft" onPress={locate} loading={locating} />
            </Pressable>
            <Pressable onPress={() => setTarget('to')} style={{ borderWidth: 1.5, borderColor: target === 'to' ? C.green : C.line, borderRadius: 14, backgroundColor: '#fff', padding: 10, gap: 6 }}>
              <T size={11.5} color={C.sub}>مكان الوصول — اكتب الاسم ودوس «ابحث»، أو حط الدبوس على الخريطة</T>
              <Field label="" value={toText} onChangeText={setToText} placeholder="مثال: ميدان المحطة" />
              <Btn title="ابحث عن المكان" icon="search" small variant="soft" onPress={findDest} loading={searching} />
            </Pressable>
            <MapView
              markers={[...(from ? [{ lat: from.lat, lng: from.lng, kind: 'me' as const }] : []), ...(to ? [{ lat: to.lat, lng: to.lng, kind: 'dest' as const }] : [])]}
              lines={from && to ? [{ kind: 'base', pts: routePts(from, to, est?.route) }, { kind: 'done', pts: routePts(from, to, est?.route) }] : undefined}
              fitKey={from && to ? `${from.lat},${from.lng}|${to.lat},${to.lng}` : undefined}
              height={260} pickable focus={from && to ? null : (to || from)}
              onPick={(p) => { setPin(target, p); }}
            />
            <T size={12} color={C.sub}>{target === 'from' ? 'دوس على الخريطة عشان تحدد مكان التحميل' : 'دوس على الخريطة عشان تحدد مكان الوصول'}</T>
            <Field label="ملاحظة للكابتن (اختياري) — مثال: عمارة 5 جنب الصيدلية" value={note} onChangeText={setNote} />
            {est && est.bidding && (
              <Card style={{ gap: 8 }}>
                <T size={13} color={C.sub}>{est.km} كم • حوالي {est.minutes} دقيقة</T>
                <T w="black" size={14} align="center">الكباتن هيحددوا السعر، وإنت تختار أنسب عرض</T>
                <Btn title="ابعت الطلب للكباتن" icon="car" onPress={request} loading={busy} />
              </Card>
            )}
            {est && !est.bidding && (
              <Card style={{ gap: 8 }}>
                <T size={13} color={C.sub}>{est.km} كم • حوالي {est.minutes} دقيقة</T>
                <T w="black" size={14}>السعر المقترح {est.price} ج — اختار سعرك</T>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
                  <Pressable onPress={() => setPrice((v) => Math.max(est.lo, v - 5))} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.greenSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="remove" size={22} color={C.green} /></Pressable>
                  <T w="black" size={26} color={C.green}>{price} ج</T>
                  <Pressable onPress={() => setPrice((v) => Math.min(est.hi, v + 5))} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.greenSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="add" size={22} color={C.green} /></Pressable>
                </View>
                <T size={12} color={C.sub} align="center">من {est.lo} إلى {est.hi} ج</T>
                <Btn title="اطلب توصيلة" icon="car" onPress={request} loading={busy} />
              </Card>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/** Bidding mode: the captain types his own price for the trip (reference = the system's suggestion). */
function BidBox({ r, value, onChange, onSend, dark }: { r: CaptainReq; value?: number; onChange: (v: number) => void; onSend: (v: number) => void; dark?: boolean }) {
  const v = value ?? 0;
  return (
    <View style={{ gap: 6 }}>
      <Field label="" value={value ? String(value) : ''} onChangeText={(t) => onChange(Number(t.replace(/\D/g, '')) || 0)} keyboardType="number-pad" placeholder={`اكتب سعرك (المرجع حوالي ${r.suggested} ج)`} />
      <Btn title={v ? `ابعت سعرك ${v} ج` : 'اكتب سعرك'} icon="send" small={!dark} onPress={() => (v ? onSend(v) : toast('اكتب سعرك للمشوار', 'err'))} />
      {r.myOffer != null && <T size={12} color={dark ? '#DDEEE4' : C.goldDeep}>عرضك الحالي: {r.myOffer} ج</T>}
    </View>
  );
}

/** The captain: registration (vehicle + four photos) and the incoming requests. */
export function CaptainScreen({ navigation }: any) {
  const [me, setMe] = useState<CaptainMe | null | undefined>(undefined);
  const [types, setTypes] = useState<RideType[]>([]);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [model, setModel] = useState('');
  const [color, setColor] = useState('');
  const [plate, setPlate] = useState('');
  const [reqs, setReqs] = useState<CaptainReq[]>([]);
  const [counter, setCounter] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [offerSecs, setOfferSecs] = useState(25);
  const [curRide, setCurRide] = useState<CaptainRide | null>(null);
  const pullCur = useCallback(() => apiCaptainCurrent().then((r) => setCurRide(r.ride)).catch(() => {}), []);
  const [now, setNow] = useState(Date.now());
  const seen = useRef<Record<number, number>>({});   // when each request first reached this captain
  const skipped = useRef<Record<number, true>>({});
  const load = useCallback(async () => { try { setMe((await apiCaptainMe()).profile); } catch { setMe(null); } }, []);
  useEffect(() => { load(); apiRideTypes().then((r) => setTypes(r.types)).catch(() => {}); }, [load]);
  const approved = me?.status === 'approved';
  useEffect(() => {
    if (!approved) return;
    const pull = () => apiCaptainRequests().then((r) => {
      setReqs(r.requests); setOfferSecs(r.offerSecs || 25);
      const fresh = r.requests.filter((x) => !seen.current[x.id] && x.myOffer == null);
      fresh.forEach((x) => { seen.current[x.id] = Date.now(); });
      if (fresh.length) alertNewOrder('🚕 طلب رحلة جديد', `${fresh[0].km} كم — ${fresh[0].offered} ج`); // the loud sound
    }).catch(() => {});
    pull(); pullCur();
    const t = setInterval(() => { pull(); pullCur(); }, 4000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(t); clearInterval(tick); };
  }, [approved, pullCur]);
  const saveProfile = async () => {
    if (!typeId) return toast('اختر نوع المركبة', 'err');
    setBusy(true);
    try { await apiCaptainProfile({ typeId, model, color, plate }); await load(); toast('تم حفظ البيانات، ارفع الصور المطلوبة'); }
    catch (e) { toast(errText(e), 'err'); }
    finally { setBusy(false); }
  };
  const photo = async (kind: 'car' | 'license' | 'driver' | 'selfie') => {
    try { const img = await pickImage(); if (!img) return; await apiCaptainPhoto(kind, img); await load(); toast('تم رفع الصورة'); }
    catch (e) { toast(errText(e), 'err'); }
  };
  const offer = async (r: CaptainReq, price?: number) => { try { const x = await apiCaptainOffer(r.id, price); toast(x.accepted ? 'تم قبول الرحلة ✅' : 'تم إرسال عرضك'); pullCur(); } catch (e) { toast(errText(e), 'err'); } };
  const step = async (id: number, s: 'arrived' | 'started' | 'completed') => { try { const x = await apiCaptainStatus(id, s); if (s === 'completed') toast(`تمت الرحلة — العمولة ${x.commission} ج`); await load(); await pullCur(); } catch (e) { toast(errText(e), 'err'); } };

  const left = (r: CaptainReq) => Math.max(0, offerSecs - Math.floor((now - (seen.current[r.id] || now)) / 1000));
  const hot = reqs.find((r) => r.myOffer == null && !skipped.current[r.id] && left(r) > 0) || null;
  const KINDS: { k: 'car' | 'license' | 'driver' | 'selfie'; label: string }[] = [{ k: 'car', label: 'صورة العربية' }, { k: 'license', label: 'رخصة المركبة' }, { k: 'driver', label: 'رخصة القيادة' }, { k: 'selfie', label: 'صورتك الشخصية' }];
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="كابتن توصيلة" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        {me === undefined && <Empty title="جاري التحميل..." />}
        {(me === null || (me && me.status !== 'approved')) && (
          <Card style={{ gap: 10 }}>
            {me && <T w="black" size={15} color={me.status === 'rejected' || me.status === 'suspended' ? C.red : C.goldDeep}>{me.status === 'pending' ? 'طلبك تحت المراجعة' : me.status === 'needs_photo' ? `مطلوب صورة أوضح: ${me.note}` : me.status === 'rejected' ? 'تم رفض الطلب' : 'الحساب موقوف'}</T>}
            <T w="black" size={15}>بيانات المركبة</T>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
              {types.map((t) => <TypeTile key={t.id} t={t} active={(typeId ?? me?.typeId) === t.id} onPress={() => setTypeId(t.id)} />)}
            </ScrollView>
            <Field label="موديل العربية" value={model || me?.model || ''} onChangeText={setModel} />
            <Field label="اللون" value={color || me?.color || ''} onChangeText={setColor} />
            <Field label="رقم اللوحة" value={plate || me?.plate || ''} onChangeText={setPlate} />
            <Btn title="حفظ البيانات" icon="save" onPress={saveProfile} loading={busy} />
            {me && KINDS.map((x) => (
              <Pressable key={x.k} onPress={() => photo(x.k)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: 14, borderWidth: 1.5, borderColor: me.photos.includes(x.k) ? C.green : C.line }}>
                <Icon name={me.photos.includes(x.k) ? 'checkmark-circle' : 'camera'} size={22} color={me.photos.includes(x.k) ? C.green : C.sub} />
                <T style={{ flex: 1 }} w="bold">{x.label}</T><T size={12} color={C.sub}>{me.photos.includes(x.k) ? 'تم الرفع' : 'ارفع'}</T>
              </Pressable>
            ))}
          </Card>
        )}
        {approved && me && (
          <>
            <Card style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T w="black">رصيدك</T><T w="black" color={me.balance < 0 ? C.red : C.green}>{me.balance} ج</T></Card>
            {!me.canReceive && <Card><T color={C.red} w="bold">رصيدك غير كافٍ لاستقبال الرحلات. اشحن رصيدك من الإدارة.</T></Card>}
            {me.canReceive && hot && (
              <View style={{ borderRadius: 22, backgroundColor: C.dark, padding: 16, gap: 10, borderWidth: 3, borderColor: C.gold }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <T w="black" size={16} color={C.gold}>🚕 طلب رحلة جديد</T>
                  <T w="black" size={20} color={left(hot) <= 8 ? '#FF8A80' : '#fff'}>{left(hot)} ث</T>
                </View>
                <View style={{ height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.2)', overflow: 'hidden' }}><View style={{ height: 6, width: `${Math.round((left(hot) / offerSecs) * 100)}%`, backgroundColor: C.gold }} /></View>
                <T w="black" size={26} color="#fff" align="center">{hot.bidding ? 'حدد سعرك للمشوار' : `${hot.offered} ج`}</T>
                <T size={13} color="#DDEEE4" align="center">{hot.km} كم{hot.pickupKm != null ? ` • بعيد عنك ${hot.pickupKm} كم` : ''}</T>
                <MapView markers={[{ lat: hot.from.lat, lng: hot.from.lng, kind: 'me', label: 'العميل' }, { lat: hot.to.lat, lng: hot.to.lng, kind: 'dest', label: 'الوصول' }]} fitKey={hot.id} height={150} />
                {!!hot.from.text && <T size={12.5} color="#DDEEE4">من: {hot.from.text}</T>}{!!hot.to.text && <T size={12.5} color="#DDEEE4">إلى: {hot.to.text}</T>}
                {hot.bidding
                  ? <BidBox r={hot} value={counter[hot.id]} onChange={(v) => setCounter((c) => ({ ...c, [hot.id]: v }))} onSend={(v) => offer(hot, v)} dark />
                  : <Btn title={`اقبل بـ ${hot.offered} ج`} icon="checkmark-circle" onPress={() => offer(hot)} />}
                <Btn title="تخطّي" variant="soft" small onPress={() => { skipped.current[hot.id] = true; setNow(Date.now()); }} />
              </View>
            )}
            {me.canReceive && reqs.length === 0 && <Card><T color={C.sub} align="center">مفيش طلبات دلوقتي... هتظهر هنا أول ما تيجي</T></Card>}
            {me.canReceive && reqs.map((r) => (
              <Card key={r.id} style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T w="black" size={16}>{r.bidding ? 'حدد سعرك' : `${r.offered} ج`}</T><T size={12.5} color={C.sub}>{r.km} كم{r.pickupKm != null ? ` • بعيد عنك ${r.pickupKm} كم` : ''}</T></View>
                {!!r.from.text && <T size={12.5}>من: {r.from.text}</T>}{!!r.to.text && <T size={12.5}>إلى: {r.to.text}</T>}
                {r.bidding && <BidBox r={r} value={counter[r.id]} onChange={(v) => setCounter((c) => ({ ...c, [r.id]: v }))} onSend={(v) => offer(r, v)} />}
                {!r.bidding && <Btn title={`اقبل بـ ${r.offered} ج`} icon="checkmark-circle" small onPress={() => offer(r)} />}
                {!r.bidding && <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  <Pressable onPress={() => setCounter((c) => ({ ...c, [r.id]: (c[r.id] ?? r.offered) - 5 }))}><Icon name="remove-circle" size={30} color={C.green} /></Pressable>
                  <T w="black" size={16}>{counter[r.id] ?? r.offered} ج</T>
                  <Pressable onPress={() => setCounter((c) => ({ ...c, [r.id]: (c[r.id] ?? r.offered) + 5 }))}><Icon name="add-circle" size={30} color={C.green} /></Pressable>
                  <Btn title="اعرض السعر ده" variant="soft" small style={{ flex: 1 }} onPress={() => offer(r, counter[r.id] ?? r.offered)} />
                </View>}
                {!r.bidding && r.myOffer != null && <T size={12} color={C.goldDeep}>عرضك الحالي: {r.myOffer} ج</T>}
              </Card>
            ))}
            {curRide && (
              <Card style={{ gap: 8, borderWidth: 2, borderColor: C.green }}>
                <T w="black" size={16}>🚕 رحلتك الحالية — {({ assigned: 'روح للعميل', arrived: 'وصلت للعميل', started: 'الرحلة شغالة' } as Record<string, string>)[curRide.status] || curRide.status}</T>
                <MapView
                  markers={[{ lat: curRide.from.lat, lng: curRide.from.lng, kind: 'me', label: 'العميل' }, { lat: curRide.to.lat, lng: curRide.to.lng, kind: 'dest', label: 'الوصول' }]}
                  fitKey={curRide.id} height={220} />
                <T w="bold" size={13.5}>مكان العميل: {curRide.from.text || 'حسب الدبوس على الخريطة'}</T>
                {!!curRide.to.text && <T size={13} color={C.sub}>إلى: {curRide.to.text}</T>}
                <T w="black" size={18} color={C.green}>{curRide.finalPrice ?? curRide.offered} ج • {curRide.km} كم</T>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Btn title="اتصل بالعميل" icon="call" small variant="soft" style={{ flex: 1 }} onPress={() => Linking.openURL(`tel:${curRide.customer.phone}`)} />
                  <Btn title="افتح في الخرائط" icon="navigate" small variant="soft" style={{ flex: 1 }} onPress={() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${curRide.status === 'started' ? curRide.to.lat + ',' + curRide.to.lng : curRide.from.lat + ',' + curRide.from.lng}`)} />
                </View>
                {curRide.status === 'assigned' && <Btn title="وصلت للعميل" icon="location" onPress={() => step(curRide.id, 'arrived')} />}
                {curRide.status === 'arrived' && <Btn title="بدأنا الرحلة" icon="play" onPress={() => step(curRide.id, 'started')} />}
                {curRide.status === 'started' && <Btn title="خلصنا الرحلة" icon="checkmark-circle" onPress={() => step(curRide.id, 'completed')} />}
              </Card>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
