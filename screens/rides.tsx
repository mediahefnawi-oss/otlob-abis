import { SvcCover } from './extra';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, Text, Image, Linking, useWindowDimensions } from 'react-native';
import { ScrollView } from '../components/KScroll';
import { C, shadow } from '../lib/theme';
import { T, Icon, Card, Btn, Empty, Header, Field, Chip, Sheet, toast } from '../components/ui';
import MapView from '../components/MapView';
import type { MapLine } from '../lib/mapHtml';
import { getPosition } from '../lib/location';
import { reverseAddress, searchPlace } from '../lib/revgeo';
import { pickImage, canPickImage } from '../lib/pickImage';
import { useStore, useMe } from '../lib/store';
import { alertNewOrder } from '../lib/alerts';
import {
  RideType, RidePoint, Ride, RideOffer, RideEstimate, rideImageUrl, apiRideTypes, apiRideEstimate, apiRideCreate, apiRideCreateByRegion, apiRideCurrent, apiRideAcceptOffer, apiRideCancel,
  RideDriver, RideLive, apiRideLive, apiCourierPing, CaptainMe, CaptainReq, apiCaptainMe, apiCaptainProfile, apiCaptainPhoto, apiCaptainRequests, apiCaptainOffer, apiCaptainStatus, apiCaptainCurrent, CaptainRide,
} from '../lib/api';

const errText = (e: any) => String(e?.message || 'حدث خطأ، حاول مرة أخرى');
const STATUS_AR: Record<string, string> = { searching: 'بندوّر لك على كابتن...', assigned: 'الكابتن في الطريق إليك', arrived: 'الكابتن وصل', started: 'الرحلة شغالة', completed: 'وصلت بالسلامة ✅', cancelled: 'الرحلة اتلغت', expired: 'انتهت المهلة' };


/** The trip on a map, for the customer and for the captain: the captain's position, the way to the customer (green), the way of the trip (dotted gold),
 *  and what is left to the destination once the trip has started. It refreshes by itself every few seconds. */
function RideLiveMap({ ride, who, height }: { ride: { id: number; status: string; from: RidePoint; to: RidePoint }; who: 'customer' | 'captain'; height: number }) {
  const [live, setLive] = useState<RideLive | null>(null);
  useEffect(() => {
    let dead = false;
    const tick = async () => { try { const r = await apiRideLive(ride.id); if (!dead) setLive(r); } catch { /* keep the last picture */ } };
    tick();
    const t = setInterval(tick, 5000);
    return () => { dead = true; clearInterval(t); };
  }, [ride.id, ride.status]);
  const me = who === 'customer';
  const markers = [
    { lat: ride.from.lat, lng: ride.from.lng, kind: 'me' as const, label: me ? 'أنت' : 'العميل' },
    { lat: ride.to.lat, lng: ride.to.lng, kind: 'dest' as const, label: 'الوصول' },
    ...(live?.driver ? [{ lat: live.driver.lat, lng: live.driver.lng, kind: 'courier' as const, label: me ? 'الكابتن' : 'أنت' }] : []),
  ];
  const lines: MapLine[] = [];
  if (live?.pickup) lines.push({ kind: 'base', pts: live.pickup.route }, { kind: 'done', pts: live.pickup.route });
  if (live?.dest) lines.push({ kind: 'base', pts: live.dest.route }, { kind: 'done', pts: live.dest.route });
  if (live?.trip) lines.push({ kind: 'trip', pts: live.trip.route });
  const leg = live?.pickup || live?.dest;
  const info = ride.status === 'arrived'
    ? (me ? '🚕 الكابتن وصل لمكانك' : '📍 وصلت للعميل')
    : ride.status === 'started'
      ? (leg ? `🏁 فاضل للوجهة ${leg.km} كم • ${leg.minutes} دقيقة` : '🏁 الرحلة شغالة')
      : leg
        ? (me ? `🚕 الكابتن جاي ليك: ${leg.km} كم • ${leg.minutes} دقيقة` : `📍 للعميل: ${leg.km} كم • ${leg.minutes} دقيقة`)
        : (me ? '🚕 الكابتن في الطريق إليك' : '📍 روح للعميل');
  return (
    <View style={{ height, borderRadius: 16, overflow: 'hidden' }}>
      <MapView markers={markers} lines={lines} fitKey={`${ride.id}:${ride.status}`} height={height} />
      <View pointerEvents="none" style={{ position: 'absolute', top: 8, right: 8, backgroundColor: '#fff', borderRadius: 12, paddingVertical: 5, paddingHorizontal: 10, ...shadow }}>
        <T w="black" size={12}>{info}</T>
      </View>
    </View>
  );
}
const STEPS = ['بنبحث', 'الكابتن جاي', 'وصل', 'الرحلة'];
const stepOf = (s: string) => ({ searching: 0, assigned: 1, arrived: 2, started: 3 } as Record<string, number>)[s] ?? 0;
function RideSteps({ status }: { status: string }) {
  const at = stepOf(status);
  return (
    <View style={{ flexDirection: 'row', gap: 4 }}>
      {STEPS.map((l, i) => (
        <View key={l} style={{ flex: 1, paddingVertical: 5, borderRadius: 8, backgroundColor: i < at ? '#CFE8D9' : i === at ? C.green : '#EEE' }}>
          <T size={10.5} w={i === at ? 'black' : 'semi'} color={i === at ? '#fff' : i < at ? C.green : '#888'} align="center">{l}</T>
        </View>
      ))}
    </View>
  );
}

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

function TypeRow({ t, onPress }: { t: RideType; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: 20, padding: 10, ...shadow }}>
      <View style={{ width: 96, height: 62, alignItems: 'center', justifyContent: 'center' }}>
        {t.image ? <Image source={{ uri: rideImageUrl(t) }} style={{ width: 96, height: 62 }} resizeMode="contain" /> : <Text style={{ fontSize: 40 }}>🚕</Text>}
      </View>
      <View style={{ flex: 1 }}>
        <T w="black" size={16}>{t.name}</T>
        <T w="black" size={12} color={C.green}>من {t.minFee} ج</T>
      </View>
      <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: C.dark, alignItems: 'center', justifyContent: 'center' }}><Icon name="chevron-back" size={18} color={C.gold} /></View>
    </Pressable>
  );
}

const routePts = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, r?: [number, number][] | null): [number, number][] => (r && r.length > 1 ? r : [[a.lat, a.lng], [b.lat, b.lng]]);

/** a tap-to-choose row that opens a searchable list of every area */
function RegionPicker({ visible, title, regions, value, onPick, onClose }: { visible: boolean; title: string; regions: { id: any; name: string }[]; value: number | null; onPick: (id: number) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const list = regions.filter((r) => !q.trim() || String(r.name).includes(q.trim()));
  return (
    <Sheet visible={visible} onClose={() => { setQ(''); onClose(); }} title={title}>
      <T size={12.5} color={C.sub}>{regions.length} منطقة متاحة</T>
      <Field label="" value={q} onChangeText={setQ} placeholder="ابحث عن منطقة" />
      {list.length === 0 && <T color={C.sub} align="center">مفيش منطقة بالاسم ده</T>}
      {list.map((r) => {
        const on = value === Number(r.id);
        return (
          <Pressable key={String(r.id)} onPress={() => { setQ(''); onPick(Number(r.id)); }} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <T w="bold" size={15} color={on ? C.green : C.text} style={{ flex: 1 }}>{r.name}</T>
            {on && <Icon name="checkmark" size={20} color={C.green} />}
          </Pressable>
        );
      })}
    </Sheet>
  );
}

/** Fixed price between two areas: no map and no addresses, just the two areas, optional notes and the fixed price. */
function ZonesBooking({ typeId, onSent }: { typeId: number; onSent: () => void }) {
  const { db } = useStore();
  const regions = db.regions;
  const [fromReg, setFromReg] = useState<number | null>(null);
  const [toReg, setToReg] = useState<number | null>(null);
  const [pick, setPick] = useState<'from' | 'to' | null>(null);
  const [fromNote, setFromNote] = useState('');
  const [toNote, setToNote] = useState('');
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [est, setEst] = useState<RideEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const nameOf = (id: number | null) => (id ? (regions.find((r) => Number(r.id) === id)?.name || '') : '');
  useEffect(() => {
    setEst(null);
    if (!fromReg || !toReg) return;
    let live = true;
    apiRideEstimate(null, null, typeId, { byRegion: true, fromRegionId: fromReg, toRegionId: toReg }).then((r) => { if (live) setEst(r); }).catch((e) => { if (live) toast(errText(e), 'err'); });
    return () => { live = false; };
  }, [fromReg, toReg, typeId]);
  const share = async () => {
    if (pin) { setPin(null); return; }
    setLocating(true);
    try { const p = await getPosition(); setPin({ lat: p.lat, lng: p.lng }); }
    catch (e) { toast(errText(e), 'err'); }
    finally { setLocating(false); }
  };
  const send = async () => {
    if (!fromReg || !toReg || !est) return;
    setBusy(true);
    try { await apiRideCreateByRegion({ typeId, fromRegionId: fromReg, toRegionId: toReg, fromNote: fromNote.trim().slice(0, 120), toNote: toNote.trim().slice(0, 120), pin }); onSent(); toast('تم إرسال طلبك للكباتن 🚕'); }
    catch (e) { toast(errText(e), 'err'); }
    finally { setBusy(false); }
  };
  const row = (kind: 'from' | 'to') => {
    const id = kind === 'from' ? fromReg : toReg;
    return (
      <Pressable onPress={() => setPick(kind)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 }}>
        <View style={{ width: 12, height: 12, borderRadius: kind === 'from' ? 6 : 3, backgroundColor: kind === 'from' ? C.green : C.gold }} />
        <View style={{ flex: 1 }}>
          <T size={11.5} color={C.sub}>{kind === 'from' ? 'من' : 'إلى'}</T>
          <T w="black" size={16} color={id ? C.text : C.sub}>{id ? nameOf(id) : kind === 'from' ? 'اختار منطقتك' : 'اختار منطقة الوصول'}</T>
        </View>
        <Icon name="chevron-down" size={20} color={C.sub} />
      </Pressable>
    );
  };
  return (
    <>
      <Card style={{ paddingVertical: 2 }}>
        {row('from')}
        <View style={{ height: 1, backgroundColor: C.line, marginStart: 24 }} />
        {row('to')}
        <Pressable onPress={() => { const a = fromReg; setFromReg(toReg); setToReg(a); }} style={{ position: 'absolute', start: 8, top: '50%', marginTop: -18, width: 36, height: 36, borderRadius: 18, backgroundColor: C.greenSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="swap-vertical" size={20} color={C.green} /></Pressable>
      </Card>
      <T size={12} color={C.sub} align="center">{regions.length} منطقة — السعر ثابت حسب المنطقة</T>
      <Card style={{ gap: 8 }}>
        <T w="bold" size={13}>ملاحظات للكابتن (اختياري)</T>
        <Field label="" value={fromNote} onChangeText={setFromNote} placeholder="عن مكانك: عمارة، علامة مميزة..." />
        <Field label="" value={toNote} onChangeText={setToNote} placeholder="عن مكان الوصول" />
        <Pressable onPress={share} disabled={locating} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name={pin ? 'checkmark-circle' : 'locate'} size={22} color={C.green} />
          <T size={13} color={C.green} w="bold" style={{ flex: 1 }}>{locating ? 'بنحدد موقعك...' : pin ? 'تم تحديد موقعك بالظبط (دوس للإلغاء)' : 'شارك موقعي بالظبط (اختياري)'}</T>
        </Pressable>
      </Card>
      <View style={{ backgroundColor: '#fff', padding: 14, gap: 8, borderRadius: 18, ...shadow }}>
        {est ? (
          <>
            {est.mode === 'zones'
              ? <><T size={12} color={C.sub} align="center">السعر الثابت</T><T w="black" size={32} color={C.green} align="center">{est.price} ج</T><T size={12} color={C.sub} align="center">من {nameOf(fromReg)} إلى {nameOf(toReg)}</T></>
              : <T size={13} color={C.goldDeep} align="center">السعر مش محدد بين المنطقتين دول — الكباتن هيحددوه</T>}
            <Btn title={est.mode === 'zones' ? 'اطلب التوصيلة' : 'ابعت الطلب للكباتن'} icon="car" onPress={send} loading={busy} />
          </>
        ) : (
          <>
            <T size={13} color={C.sub} align="center">{!fromReg ? 'اختار منطقتك الأول' : !toReg ? 'اختار منطقة الوصول' : 'بنحسب السعر...'}</T>
            <Btn title="اطلب التوصيلة" icon="car" onPress={() => toast(!fromReg ? 'اختار منطقتك الأول' : 'اختار منطقة الوصول', 'err')} />
          </>
        )}
      </View>
      <RegionPicker visible={pick === 'from'} title="اختار منطقتك" regions={regions} value={fromReg} onPick={(id) => { setFromReg(id); setPick(null); }} onClose={() => setPick(null)} />
      <RegionPicker visible={pick === 'to'} title="اختار منطقة الوصول" regions={regions} value={toReg} onPick={(id) => { setToReg(id); setPick(null); }} onClose={() => setPick(null)} />
    </>
  );
}

/** The customer: choose a vehicle, point on the map, set a price near the suggested one, wait for offers. */
export function RideHomeScreen({ navigation }: any) {
  const { db } = useStore();
  const [types, setTypes] = useState<RideType[] | null>(null);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [step, setStep] = useState<'type' | 'trip'>('type');
  const [from, setFrom] = useState<RidePoint | null>(null);
  const [to, setTo] = useState<RidePoint | null>(null);
  const [est, setEst] = useState<{ km: number; minutes: number; price: number; lo: number; hi: number; route?: [number, number][] | null; bidding?: boolean; mode?: string; zoneMissing?: boolean; textDest?: boolean } | null>(null);
  const [textDest, setTextDest] = useState(false);
  const [fromReg, setFromReg] = useState<number | null>(null);
  const [toReg, setToReg] = useState<number | null>(null);
  const [target, setTarget] = useState<'from' | 'to'>('from');
  const { height: winH } = useWindowDimensions();
  const typing = useRef<any>(null);
  const [fromDetails, setFromDetails] = useState('');
  const [locating, setLocating] = useState(false);
  const [searching, setSearching] = useState(false);
  const [price, setPrice] = useState(0);
  const [busy, setBusy] = useState(false);
  const [cur, setCur] = useState<{ ride: Ride | null; offers: RideOffer[] } | null>(null);
  const [fromText, setFromText] = useState('');
  const [toText, setToText] = useState('');

  const loadCur = useCallback(async () => { try { setCur(await apiRideCurrent()); } catch { /* keep the last state */ } }, []);
  useEffect(() => { apiRideTypes().then((r) => { setTypes(r.types); if (r.types[0]) setTypeId(r.types[0].id); if (r.types.length === 1) setStep('trip'); }).catch(() => setTypes([])); loadCur(); }, [loadCur]);
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
  const findDest = async (q?: string) => {
    const txt = (q ?? toText).trim();
    if (!txt) return;
    setSearching(true);
    try {
      const r = await searchPlace(txt, from);
      if (r) { setTo({ lat: r.lat, lng: r.lng }); setTarget('to'); } else toast('ما لقيناش المكان بالاسم، حط الدبوس على الخريطة', 'err');
    } finally { setSearching(false); }
  };
  const onDestText = (t: string) => {
    setToText(t);
    if (typing.current) clearTimeout(typing.current);
    if (t.trim().length >= 3) typing.current = setTimeout(() => findDest(t), 1100);
  };
  useEffect(() => () => { if (typing.current) clearTimeout(typing.current); }, []);
  const curType = types?.find((t) => t.id === typeId) || null;
  const zonesMode = curType?.pricingMode === 'zones' && !textDest;
  const dest = textDest ? from : to;                 // a typed destination is not on the map: the captain gets the text and calls
  const destOk = textDest ? toText.trim().length >= 3 : !!to;
  const extra = { ...(textDest ? { textDest: true } : {}), ...(zonesMode && fromReg && toReg ? { fromRegionId: fromReg, toRegionId: toReg } : {}) };
  useEffect(() => {
    setEst(null);
    if (!from || !dest || !destOk || !typeId) return;
    let live = true;
    apiRideEstimate(from, dest, typeId, extra).then((r) => { if (live) { setEst(r); setPrice(r.price); } }).catch((e) => { if (live) toast(errText(e), 'err'); });
    return () => { live = false; };
  }, [from?.lat, from?.lng, to?.lat, to?.lng, typeId, textDest, destOk, fromReg, toReg]);

  if (!db.settings.features?.rides) return <View style={{ flex: 1, backgroundColor: C.bg }}><Header title="توصيلة" onBack={() => navigation.goBack()} /><Empty title="الخدمة غير متاحة الآن" /></View>;
  const ride = cur?.ride;
  const live = ride && ['searching', 'assigned', 'arrived', 'started'].includes(ride.status);
  const fixed = !live && step === 'trip';           // the booking screen never scrolls: the map takes what is left
  const mapH = Math.max(90, Math.min(300, winH - 560 - (zonesMode ? 140 : 0)));

  const request = async () => {
    if (!from || !dest || !typeId || !est) return;
    setBusy(true);
    try { await apiRideCreate({ ...from, text: [fromText, fromDetails.trim()].filter(Boolean).join(' — ').slice(0, 200) }, { ...dest, text: toText.trim().slice(0, 200) }, typeId, price, extra); await loadCur(); toast('تم إرسال طلبك للكباتن 🚕'); }
    catch (e) { toast(errText(e), 'err'); }
    finally { setBusy(false); }
  };
  const cancel = async () => { if (!ride) return; try { await apiRideCancel(ride.id); await loadCur(); } catch (e) { toast(errText(e), 'err'); } };
  const take = async (o: RideOffer) => { if (!ride) return; try { await apiRideAcceptOffer(ride.id, o.id); await loadCur(); } catch (e) { toast(errText(e), 'err'); } };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="توصيلة" subtitle={ride?.bidding || est?.bidding ? 'حدد وجهتك والكباتن يحددوا السعر' : 'حدد وجهتك واختار السعر اللي يناسبك'} onBack={() => navigation.goBack()} />
      {!live && step === 'type' && <Pressable onPress={() => navigation.navigate('Trips')} style={{ margin: 12, marginBottom: 0, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.dark, borderRadius: 16, padding: 12 }}><Text style={{ fontSize: 26 }}>🚌</Text><View style={{ flex: 1 }}><T w="black" color={C.gold}>رحلات المحافظات</T><T size={12} color="#DDEEE4">احجز كرسي في عربية رايحة محافظتك</T></View><Icon name="chevron-back" size={20} color={C.gold} /></Pressable>}
      {React.createElement(fixed ? View : ScrollView, fixed ? { style: { flex: 1, padding: 12, gap: 8, overflow: 'hidden' } } : { contentContainerStyle: { padding: 16, gap: 10, paddingBottom: 24 }, keyboardShouldPersistTaps: 'handled' },
      <>
        {!live && step === 'type' && <View style={{ marginHorizontal: -4, marginTop: -12 }}><SvcCover svc="rides" /></View>}
        {live && ride ? (
          <>
            <Card style={{ gap: 6 }}>
              <T w="black" size={17}>{STATUS_AR[ride.status] || ride.status}</T>
              {!ride.byRegion && <T size={13} color={C.sub}>{ride.km} كم تقريباً • {ride.minutes} دقيقة</T>}
              <T w="black" size={18} color={C.green}>{ride.finalPrice != null ? `${ride.finalPrice} ج` : ride.bidding ? 'السعر حسب عروض الكباتن' : `${ride.offered} ج`}</T>
            </Card>
            <RideSteps status={ride.status} />
            {(ride.status === 'assigned' || ride.status === 'arrived' || ride.status === 'started') && !(ride.byRegion && !ride.fromPin) && <RideLiveMap ride={ride} who="customer" height={300} />}
            {cur?.driver && (ride.status === 'assigned' || ride.status === 'arrived' || ride.status === 'started') && (
              <Card style={{ gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.greenSoft, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 22 }}>👤</Text></View>
                  <View style={{ flex: 1 }}>
                    <T w="black" size={14.5}>{cur.driver.name}</T>
                    <T size={12} color={C.sub}>{[cur.driver.model, cur.driver.color, cur.driver.plate].filter(Boolean).join(' • ')}</T>
                  </View>
                </View>
                <Btn title="اتصل بالكابتن" icon="call" small variant="soft" onPress={() => Linking.openURL(`tel:${cur.driver!.phone}`)} />
              </Card>
            )}
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
            {step === 'type' ? (
              <>
                <T w="black" size={18}>عايز تركب إيه؟</T>
                <T size={12.5} color={C.sub}>اختار المركبة الأول وبعدها حدد مشوارك</T>
                {types === null ? <T color={C.sub}>جاري التحميل...</T> : types.length === 0 ? <Empty title="لا توجد أنواع متاحة" /> : types.map((t) => <TypeRow key={t.id} t={t} onPress={() => { setTypeId(t.id); setStep('trip'); }} />)}
              </>
            ) : (
              <>
                {types && types.find((t) => t.id === typeId) && (
                  <Pressable onPress={() => types.length > 1 && setStep('type')} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderRadius: 16, paddingVertical: 6, paddingHorizontal: 10, ...shadow }}>
                    <View style={{ width: 56, height: 36, alignItems: 'center', justifyContent: 'center' }}>
                      {types.find((t) => t.id === typeId)!.image ? <Image source={{ uri: rideImageUrl(types.find((t) => t.id === typeId)!) }} style={{ width: 56, height: 36 }} resizeMode="contain" /> : <Text style={{ fontSize: 26 }}>🚕</Text>}
                    </View>
                    <T w="black" size={14} style={{ flex: 1 }}>{types.find((t) => t.id === typeId)!.name}</T>
                    {types.length > 1 && <View style={{ backgroundColor: C.greenSoft, borderRadius: 10, paddingVertical: 4, paddingHorizontal: 10 }}><T w="black" size={12} color={C.green}>تغيير</T></View>}
                  </Pressable>
                )}
            {curType?.pricingMode === 'zones' ? <ZonesBooking typeId={typeId!} onSent={loadCur} /> : (<>
            <Card style={{ gap: 8 }}>
              <Pressable onPress={() => setTarget('from')} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: C.green, borderWidth: target === 'from' ? 3 : 0, borderColor: C.greenSoft }} />
                <View style={{ flex: 1 }}><Field label="" value={fromText} onChangeText={setFromText} placeholder={from ? 'اكتب العنوان لو مش ظاهر' : 'مكان التحميل — دوس على أيقونة الموقع'} /></View>
                <Pressable onPress={locate} disabled={locating} style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: C.greenSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={locating ? 'hourglass' : 'locate'} size={22} color={C.green} /></Pressable>
              </Pressable>
              <View style={{ paddingStart: 18 }}><Field label="" value={fromDetails} onChangeText={setFromDetails} placeholder="تفاصيل مكانك (عمارة، دور، علامة مميزة، رقم شقة)" /></View>
              <Pressable onPress={() => setTarget('to')} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: C.gold, borderWidth: target === 'to' ? 3 : 0, borderColor: C.goldSoft || '#fbe7a6' }} />
                <View style={{ flex: 1 }}><Field label="" value={toText} onChangeText={onDestText} onSubmitEditing={() => findDest()} returnKeyType="search" placeholder="مكان الوصول — اكتب الاسم أو حط الدبوس" /></View>
                <Pressable onPress={() => findDest()} disabled={searching} style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: C.greenSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name={searching ? 'hourglass' : 'search'} size={22} color={C.green} /></Pressable>
              </Pressable>
            </Card>
            <Pressable onPress={() => { setTextDest((v) => !v); setEst(null); }} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
              <Icon name={textDest ? 'checkbox' : 'square-outline'} size={22} color={C.green} />
              <T size={13} style={{ flex: 1 }}>الوجهة مش على الخريطة؟ اكتبها والكابتن هيكلمك ويحدد السعر</T>
            </Pressable>
            {zonesMode && (
              <Card style={{ gap: 6 }}>
                <T size={12.5} color={C.sub}>السعر ثابت حسب المنطقة — اختار منطقتك ومنطقة الوصول</T>
                <T w="bold" size={12.5}>من:</T>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>{db.regions.map((r) => <Chip key={r.id} label={r.name} active={fromReg === Number(r.id)} onPress={() => setFromReg(Number(r.id))} />)}</ScrollView>
                <T w="bold" size={12.5}>إلى:</T>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>{db.regions.map((r) => <Chip key={r.id} label={r.name} active={toReg === Number(r.id)} onPress={() => setToReg(Number(r.id))} />)}</ScrollView>
              </Card>
            )}
            <MapView
              markers={[...(from ? [{ lat: from.lat, lng: from.lng, kind: 'me' as const }] : []), ...(to ? [{ lat: to.lat, lng: to.lng, kind: 'dest' as const }] : [])]}
              lines={from && to && !textDest ? [{ kind: 'base', pts: routePts(from, to, est?.route) }, { kind: 'done', pts: routePts(from, to, est?.route) }] : undefined}
              fitKey={from && to ? `${from.lat},${from.lng}|${to.lat},${to.lng}` : undefined}
              height={mapH} pickable focus={from && to ? null : (to || from)}
              onPick={(p) => { setPin(target, p); }}
            />
            {est ? (
        <View style={{ backgroundColor: '#fff', padding: 14, gap: 8, borderRadius: 18, shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 10, elevation: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <T size={12.5} color={C.sub}>{est.km} كم • حوالي {est.minutes} دقيقة</T>
            {est.bidding
              ? <T w="black" size={13} color={C.green}>{est.textDest ? 'الكابتن هيكلمك ويحدد السعر' : 'الكباتن هيحددوا السعر'}</T>
              : est.mode === 'zones'
              ? <T w="black" size={20} color={C.green}>{est.price} ج ثابت</T>
              : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <Pressable onPress={() => setPrice((v) => Math.max(est.lo, v - 5))} style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: C.greenSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="remove" size={18} color={C.green} /></Pressable>
                  <T w="black" size={20} color={C.green}>{price} ج</T>
                  <Pressable onPress={() => setPrice((v) => Math.min(est.hi, v + 5))} style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: C.greenSoft, alignItems: 'center', justifyContent: 'center' }}><Icon name="add" size={18} color={C.green} /></Pressable>
                </View>
              )}
          </View>
          {est.zoneMissing && <T size={11} color={C.goldDeep} align="center">السعر مش محدد بين المنطقتين دول — الكباتن هيحددوه</T>}
          {!est.bidding && est.mode !== 'zones' && <T size={11} color={C.sub} align="center">السعر المقترح {est.price} ج — من {est.lo} إلى {est.hi} ج</T>}
          <Btn title={est.bidding ? 'ابعت الطلب للكباتن' : 'اطلب توصيلة'} icon="car" onPress={request} loading={busy} />
        </View>
            ) : (
              <View style={{ backgroundColor: '#fff', padding: 14, gap: 8, borderRadius: 18, ...shadow }}>
                <T size={13} color={C.sub} align="center">{searching ? 'بندوّر على المكان...' : !from ? 'دوس على أيقونة الموقع عشان نحدد مكانك' : textDest ? 'اكتب اسم الوجهة في الخانة' : 'اكتب وجهتك أو دوس على الخريطة عشان يظهر السعر'}</T>
                <Btn title="اطلب توصيلة" icon="car" onPress={() => toast(!from ? 'حدد مكانك الأول' : 'حدد وجهتك الأول', 'err')} />
              </View>
            )}
            </>)}
              </>
            )}
          </>
        )}
      </>)}
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
  // while a trip is running the captain's position goes to the server every few seconds (the customer's map and the way to the customer follow it)
  useEffect(() => {
    if (!curRide) return;
    let dead = false;
    const send = async () => { try { const p = await getPosition(); if (!dead) await apiCourierPing({ lat: p.lat, lng: p.lng, ...(Number.isFinite(p.accuracy) ? { accuracy: p.accuracy } : {}) }); } catch { /* the next tick tries again */ } };
    send();
    const t = setInterval(send, 6000);
    return () => { dead = true; clearInterval(t); };
  }, [curRide?.id]);
  const [now, setNow] = useState(Date.now());
  const seen = useRef<Record<number, number>>({});   // when each request first reached this captain
  const skipped = useRef<Record<number, true>>({});
  const load = useCallback(async () => { try { setMe((await apiCaptainMe()).profile); } catch { setMe(null); } }, []);
  const account = useMe();
  // the vehicle the captain chose when signing up is ticked for him (only until he picks another)
  useEffect(() => { load(); apiRideTypes().then((r) => { setTypes(r.types); const v = String((account as any)?.vehicle || ''); const hit = r.types.find((t) => t.name === v); if (hit) setTypeId((cur) => cur ?? hit.id); }).catch(() => {}); }, [load]);
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
            {me.tripsAllowed !== false && <Btn title="رحلات المحافظات — أعلن عن رحلة" icon="bus" variant="soft" onPress={() => navigation.navigate('CaptainTrips')} />}
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
                <T size={13} color="#DDEEE4" align="center">{hot.byRegion ? 'توصيلة بين مناطق — سعر ثابت' : hot.textDest ? 'الوجهة مكتوبة (مش على الخريطة)' : `${hot.km} كم`}{hot.pickupKm != null ? ` • بعيد عنك ${hot.pickupKm} كم` : ''}</T>
                {hot.byRegion && !hot.fromPin ? null : <MapView markers={[{ lat: hot.from.lat, lng: hot.from.lng, kind: 'me', label: 'العميل' }, ...(hot.textDest || hot.byRegion ? [] : [{ lat: hot.to.lat, lng: hot.to.lng, kind: 'dest' as const, label: 'الوصول' }])]} fitKey={hot.id} height={150} />}
                {!!hot.from.text && <T size={12.5} color="#DDEEE4">من: {hot.from.text}</T>}{!!hot.to.text && <T size={12.5} color="#DDEEE4">{hot.textDest ? 'الوجهة (كلّم العميل): ' : 'إلى: '}{hot.to.text}</T>}
                {hot.bidding
                  ? <BidBox r={hot} value={counter[hot.id]} onChange={(v) => setCounter((c) => ({ ...c, [hot.id]: v }))} onSend={(v) => offer(hot, v)} dark />
                  : <Btn title={`اقبل بـ ${hot.offered} ج`} icon="checkmark-circle" onPress={() => offer(hot)} />}
                <Btn title="تخطّي" variant="soft" small onPress={() => { skipped.current[hot.id] = true; setNow(Date.now()); }} />
              </View>
            )}
            {me.canReceive && reqs.length === 0 && <Card><T color={C.sub} align="center">مفيش طلبات دلوقتي... هتظهر هنا أول ما تيجي</T></Card>}
            {me.canReceive && reqs.map((r) => (
              <Card key={r.id} style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T w="black" size={16}>{r.bidding ? 'حدد سعرك' : `${r.offered} ج`}</T><T size={12.5} color={C.sub}>{r.byRegion ? 'بين مناطق' : r.textDest ? 'وجهة مكتوبة' : `${r.km} كم`}{r.pickupKm != null ? ` • بعيد عنك ${r.pickupKm} كم` : ''}</T></View>
                {!!r.from.text && <T size={12.5}>من: {r.from.text}</T>}{!!r.to.text && <T size={12.5}>{r.textDest ? 'الوجهة (كلّم العميل): ' : 'إلى: '}{r.to.text}</T>}
                {r.bidding && <BidBox r={r} value={counter[r.id]} onChange={(v) => setCounter((c) => ({ ...c, [r.id]: v }))} onSend={(v) => offer(r, v)} />}
                {!r.bidding && <Btn title={`اقبل بـ ${r.offered} ج`} icon="checkmark-circle" small onPress={() => offer(r)} />}
                {!r.bidding && r.pricing !== 'zones' && <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                  <Pressable onPress={() => setCounter((c) => ({ ...c, [r.id]: (c[r.id] ?? r.offered) - 5 }))}><Icon name="remove-circle" size={30} color={C.green} /></Pressable>
                  <T w="black" size={16}>{counter[r.id] ?? r.offered} ج</T>
                  <Pressable onPress={() => setCounter((c) => ({ ...c, [r.id]: (c[r.id] ?? r.offered) + 5 }))}><Icon name="add-circle" size={30} color={C.green} /></Pressable>
                  <Btn title="اعرض السعر ده" variant="soft" small style={{ flex: 1 }} onPress={() => offer(r, counter[r.id] ?? r.offered)} />
                </View>}
                {!r.bidding && r.pricing === 'zones' && <T size={12} color={C.sub}>السعر ثابت بين المنطقتين</T>}
                {!r.bidding && r.myOffer != null && <T size={12} color={C.goldDeep}>عرضك الحالي: {r.myOffer} ج</T>}
              </Card>
            ))}
            {curRide && (
              <Card style={{ gap: 8, borderWidth: 2, borderColor: C.green }}>
                <T w="black" size={16}>🚕 رحلتك الحالية — {({ assigned: 'روح للعميل', arrived: 'وصلت للعميل', started: 'الرحلة شغالة' } as Record<string, string>)[curRide.status] || curRide.status}</T>
                {!(curRide.byRegion && !curRide.fromPin) && <RideLiveMap ride={curRide} who="captain" height={260} />}
                <T w="bold" size={13.5}>مكان العميل: {curRide.from.text || 'حسب الدبوس على الخريطة'}</T>
                {!!curRide.to.text && <T size={13} color={curRide.textDest ? C.goldDeep : C.sub} w={curRide.textDest ? 'bold' : undefined}>{curRide.textDest ? 'الوجهة (اسأل العميل واتفقوا): ' : 'إلى: '}{curRide.to.text}</T>}
                <T w="black" size={18} color={C.green}>{curRide.finalPrice ?? curRide.offered} ج{curRide.textDest || curRide.byRegion ? '' : ` • ${curRide.km} كم`}</T>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Btn title="اتصل بالعميل" icon="call" small variant="soft" style={{ flex: 1 }} onPress={() => Linking.openURL(`tel:${curRide.customer.phone}`)} />
                  {!(curRide.byRegion && !curRide.fromPin) && <Btn title="افتح في الخرائط" icon="navigate" small variant="soft" style={{ flex: 1 }} onPress={() => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${curRide.status === 'started' && !curRide.textDest ? curRide.to.lat + ',' + curRide.to.lng : curRide.from.lat + ',' + curRide.from.lng}`)} />}
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
