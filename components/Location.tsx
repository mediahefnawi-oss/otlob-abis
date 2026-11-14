import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Header, Empty, toast, callPhone, IconBubble, IconBtn, Toggle } from './ui';
import MapView from './MapView';
import { getPosition, startCourierTracking, stopCourierTracking } from '../lib/location';
import { apiMyLocation, apiSetMyLocation, apiSetShopLocation, apiOrderTracking, apiStaffCourierLocations, GeoPoint, OrderTracking, StaffCourierPos } from '../lib/api';
import type { MapMarker, MapLine } from '../lib/mapHtml';
import { fetchRoute, travelled, arrivalAt, RouteRes } from '../lib/route';
import { setMyHome, useStore, setCartDest, useMapOn, setMapMode } from '../lib/store';
import { Pressable, Linking } from 'react-native';

function usePoll(fn: () => Promise<void>, ms: number, deps: unknown[] = []) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => {
    let dead = false; let busy = false;
    const run = async () => { if (busy || dead) return; busy = true; try { await ref.current(); } catch { /* next round retries */ } busy = false; };
    run(); const t = setInterval(run, ms);
    return () => { dead = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** "حدد موقعي" (customer) / "حدد موقع المحل" (shop owner): optional, saved once, can be removed. */
export function MyLocationCard({ kind }: { kind: 'customer' | 'shop' }) {
  const mapOn = useMapOn();
  const [loc, setLoc] = useState<GeoPoint | null>(null);
  const [ready, setReady] = useState(kind === 'shop' ? true : false);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [draft, setDraft] = useState<GeoPoint | null>(null);
  const save = kind === 'customer' ? apiSetMyLocation : apiSetShopLocation;
  useEffect(() => { if (kind === 'customer') apiMyLocation().then((r) => { setLoc(r.location); setReady(true); }).catch(() => setReady(true)); }, [kind]);

  const here = async () => {
    setBusy(true);
    try {
      const p = await getPosition();
      const r = await save({ lat: p.lat, lng: p.lng });
      setLoc(r.location); if (kind === 'customer') setMyHome(r.location); setPicking(false); toast('تم حفظ الموقع ✅');
    } catch (e: any) { toast(e?.message || 'تعذر تحديد الموقع', 'err'); }
    setBusy(false);
  };
  const saveDraft = async () => {
    if (!draft) return;
    setBusy(true);
    try { const r = await save(draft); setLoc(r.location); if (kind === 'customer') setMyHome(r.location); setPicking(false); setDraft(null); toast('تم حفظ الموقع ✅'); }
    catch (e: any) { toast(e?.message || 'تعذر الحفظ', 'err'); }
    setBusy(false);
  };
  const clear = async () => { setBusy(true); try { await save(null); setLoc(null); if (kind === 'customer') setMyHome(null); toast('تم حذف الموقع'); } catch (e: any) { toast(e?.message || 'تعذر الحذف', 'err'); } setBusy(false); };
  const title = kind === 'customer' ? 'موقعي على الخريطة' : 'موقع المحل على الخريطة';
  const sub = kind === 'customer' ? 'اختياري — يساعد المندوب يوصلك أسرع' : 'يظهر للعميل والمندوب على الخريطة';
  const marker: MapMarker[] = loc ? [{ lat: loc.lat, lng: loc.lng, kind: kind === 'customer' ? 'dest' : 'shop' }] : [];
  if (!ready || !mapOn) return null;
  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <IconBubble icon="navigate" color={C.green} bg={C.greenSoft} size={42} />
        <View style={{ flex: 1 }}>
          <T w="bold" size={14.5}>{title}</T>
          <T size={12} color={C.sub}>{loc ? 'تم حفظ موقعك ✓' : sub}</T>
        </View>
      </View>
      {!!loc && !picking && <MapView markers={marker} height={150} />}
      {picking && (
        <View style={{ gap: 8 }}>
          <T size={12} color={C.sub}>اضغط على الخريطة مكان {kind === 'customer' ? 'بيتك' : 'المحل'} بالظبط</T>
          <MapView markers={loc ? marker : [{ lat: 31.0, lng: 29.95, kind: 'me' }]} height={230} pickable onPick={(p) => setDraft(p)} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn title="حفظ" onPress={saveDraft} disabled={!draft} loading={busy} style={{ flex: 1 }} />
            <Btn title="إلغاء" variant="soft" onPress={() => { setPicking(false); setDraft(null); }} style={{ flex: 1 }} />
          </View>
        </View>
      )}
      {!picking && (
        <View style={{ gap: 8 }}>
          <Btn title={loc ? 'تحديث بموقعي الحالي' : 'حدد موقعي الحالي'} icon="locate" onPress={here} loading={busy} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Btn title="اختر من الخريطة" variant="soft" small onPress={() => setPicking(true)} style={{ flex: 1 }} />
            {!!loc && <Btn title="حذف الموقع" variant="soft" small onPress={clear} style={{ flex: 1 }} />}
          </View>
        </View>
      )}
    </Card>
  );
}

const ago = (t: number) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 1 ? 'الآن' : m < 60 ? `منذ ${m} د` : 'منذ فترة'; };

/** Inside the order screen: appears once a courier has the order, then follows him live until delivery.
 *  Customer and courier see the same road line (shop → home), the travelled part in green, the time left, the distance and the arrival time. */
export function OrderMapCard({ orderId, active, role, courierName, courierPhone }: { orderId: string; active: boolean; role: string; courierName?: string; courierPhone?: string }) {
  const [t, setT] = useState<OrderTracking | null>(null);
  const [full, setFull] = useState<RouteRes | null>(null);
  const [live, setLive] = useState<RouteRes | null>(null);
  const [fit, setFit] = useState(0);
  const mapOn = useMapOn();
  usePoll(async () => { if (active && mapOn) setT(await apiOrderTracking(orderId)); }, 8000, [orderId, active, mapOn]);

  const toShop = !!t && !['picked_up', 'on_the_way', 'arrived'].includes(t.status);
  const target: GeoPoint | null = t ? (toShop ? (t.shop || t.dest) : t.dest) : null;
  const shopK = t?.shop ? `${t.shop.lat},${t.shop.lng}` : '';
  const destK = t?.dest ? `${t.dest.lat},${t.dest.lng}` : '';
  // the planned road from the shop to the customer (once)
  useEffect(() => {
    let dead = false;
    if (t?.shop && t?.dest) fetchRoute(t.shop, t.dest).then((r) => { if (!dead) { setFull(r); setFit((x) => x + 1); } });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shopK, destK]);
  // what is left for the courier (again after every new position)
  const cLat = t?.courier ? Math.round(t.courier.lat * 20000) : null; const cLng = t?.courier ? Math.round(t.courier.lng * 20000) : null;
  const tgtK = target ? `${target.lat},${target.lng}` : '';
  useEffect(() => {
    let dead = false;
    if (t?.courier && t.courier.fresh && target) fetchRoute(t.courier, target).then((r) => { if (!dead) setLive(r); });
    else setLive(null);
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cLat, cLng, tgtK, t?.courier?.fresh]);

  if (!active || !mapOn || !t) return null;
  const markers: MapMarker[] = [];
  if (t.shop) markers.push({ ...t.shop, kind: 'shop' });
  if (t.dest) markers.push({ ...t.dest, kind: 'dest' });
  if (t.courier) markers.push({ lat: t.courier.lat, lng: t.courier.lng, kind: 'courier', label: role === 'courier' ? 'أنت' : courierName });
  if (!markers.length) return null;

  const lines: MapLine[] = [];
  if (full) lines.push({ kind: 'base', pts: full.pts });
  else if (t.shop && t.dest) lines.push({ kind: 'base', pts: [[t.shop.lat, t.shop.lng], [t.dest.lat, t.dest.lng]] });
  if (t.courier && t.courier.fresh && target) {
    if (!toShop && full) lines.push({ kind: 'done', pts: travelled(full.pts, t.courier) });
    lines.push({ kind: 'todo', pts: live ? [[t.courier.lat, t.courier.lng], ...live.pts] : [[t.courier.lat, t.courier.lng], [target.lat, target.lng]] });
  }

  const fresh = !!t.courier && t.courier.fresh;
  const min = fresh ? (live ? live.min : t.etaMin) : null;
  const dist = fresh ? (live ? live.km : t.distanceKm) : null;
  const progress = !toShop && full && live && full.km > 0 ? Math.max(0.03, Math.min(1, 1 - live.km / full.km)) : null;
  const who = role === 'courier' ? (toShop ? 'رايح للمحل' : 'رايح للعميل') : (toShop ? 'المندوب في طريقه للمحل' : 'المندوب في الطريق إليك');
  const lead = role === 'courier' ? 'وصولك المتوقع' : 'يوصل';
  const directions = () => { if (target) Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${target.lat},${target.lng}&travelmode=driving`).catch(() => toast('تعذر فتح الخرائط', 'err')); };
  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <IconBubble icon="map" color={C.orange} bg={C.orangeSoft} size={40} />
        <View style={{ flex: 1 }}>
          <T w="black" size={15}>تتبع الطلب على الخريطة</T>
          <T size={12} color={C.sub}>{t.courier ? (fresh ? who : `آخر ظهور ${role === 'courier' ? 'لموقعك' : 'للمندوب'} ${ago(t.courier.at)}`) : 'موقع المندوب غير متاح الآن'}</T>
        </View>
        {!!courierPhone && role !== 'courier' && <IconBtn icon="call" bg={C.greenSoft} color={C.green} onPress={() => callPhone(courierPhone)} />}
      </View>
      <MapView markers={markers} lines={lines} fitKey={fit} height={290} focus={t.dest ? { lat: t.dest.lat, lng: t.dest.lng } : null} />
      {min != null && (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 4 }}>
              <T w="black" size={30} color={C.green}>{min}</T>
              <T w="bold" size={13} style={{ marginBottom: 4 }}>دقيقة</T>
            </View>
            <View style={{ flex: 1 }}>
              <T size={12.5} color={C.sub}>{lead} <T w="black" size={12.5}>{arrivalAt(min)}</T></T>
              {dist != null && <T size={12.5} color={C.sub}>باقي {dist} كم{live ? '' : ' (بخط مستقيم)'}</T>}
            </View>
          </View>
          {progress != null && (
            <View style={{ height: 6, borderRadius: 3, backgroundColor: C.line, overflow: 'hidden' }}>
              <View style={{ height: 6, width: `${Math.round(progress * 100)}%`, backgroundColor: C.green, borderRadius: 3, alignSelf: 'flex-end' }} />
            </View>
          )}
        </View>
      )}
      {role === 'courier' && !!target && <Btn title="افتح الاتجاهات في خرائط جوجل" icon="navigate" variant="soft" onPress={directions} />}
      {!live && fresh && <T size={10.5} color={C.sub}>الوقت تقديري، وقد يختلف حسب الطريق</T>}
    </Card>
  );
}

/** A courier's phone reports its position while he is available (or carrying an order). */
export function useCourierTracking(isCourier: boolean, on: boolean) {
  useEffect(() => {
    if (!isCourier) return;
    if (on) { startCourierTracking().then((ok) => { if (!ok) toast('فعّل صلاحية الموقع ليظهر موقعك للعملاء', 'err'); }); }
    else stopCourierTracking();
  }, [isCourier, on]);
}

/** Owner / supervisor: every working courier on one map. */
export function CouriersMapScreen({ navigation }: any) {
  const [list, setList] = useState<StaffCourierPos[]>([]);
  const [loaded, setLoaded] = useState(false);
  usePoll(async () => { setList((await apiStaffCourierLocations()).couriers); setLoaded(true); }, 10000, []);
  const markers: MapMarker[] = list.map((c) => ({ lat: c.lat, lng: c.lng, kind: 'courier', label: c.name }));
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="المناديب على الخريطة" subtitle={`${list.length} مندوب ظاهر الآن`} onBack={() => navigation.goBack()} />
      <View style={{ padding: 16, gap: 12, flex: 1 }}>
        {loaded && !list.length ? <Empty title="لا يوجد مناديب ظاهرون الآن" text="يظهر المندوب هنا وهو متاح أو معه طلب ومفعّل الموقع" /> : <MapView markers={markers} height={330} />}
        {list.map((c) => (
          <Card key={c.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: c.fresh ? (c.busy ? C.orange : C.green) : C.sub }} />
            <View style={{ flex: 1 }}>
              <T w="bold" size={14}>{c.name}</T>
              <T size={11.5} color={C.sub}>{c.busy ? `معه ${c.busy} طلب` : 'متاح'} • {ago(c.at)}</T>
            </View>
            <IconBtn icon="call" bg={C.greenSoft} color={C.green} onPress={() => callPhone(c.phone)} />
          </Card>
        ))}
      </View>
    </View>
  );
}

/**
 * On the order screens: the delivery pin of THIS order. It is found automatically when the screen opens (after the customer allows the location),
 * and he can move it by tapping the map or press "find me again". Without the permission he picks the spot by hand.
 */
export function DeliveryPin() {
  const { cartDest, db, userId } = useStore();
  const on = useMapOn();
  const me = db.users.find((u) => u.id === userId);
  const [state, setState] = useState<'idle' | 'finding' | 'auto' | 'manual' | 'denied'>('idle');
  const find = async () => {
    setState('finding');
    try { const p = await getPosition(); setCartDest({ pin: { lat: p.lat, lng: p.lng } }); setState('auto'); }
    catch (e: any) {
      // no permission / no GPS: use the saved spot when there is one, otherwise the customer picks it on the map
      if (me?.homeLat != null && me?.homeLng != null && !cartDest.pin) setCartDest({ pin: { lat: me.homeLat, lng: me.homeLng } });
      setState('denied');
      toast(e?.message || 'تعذر تحديد موقعك، اختر المكان من الخريطة', 'err');
    }
  };
  useEffect(() => { if (on && !cartDest.pin) find(); /* once, when the screen opens */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  if (!on) return null;
  const pin = cartDest.pin;
  const line = state === 'finding' ? 'جاري تحديد موقعك...' : pin ? (state === 'manual' ? 'تم تحديد المكان على الخريطة ✓' : state === 'auto' ? 'تم تحديد موقعك تلقائياً ✓' : 'تم تحديد المكان ✓') : 'اضغط على الخريطة لتحديد مكان التوصيل';
  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <IconBubble icon="location" color={C.green} bg={C.greenSoft} size={40} />
        <View style={{ flex: 1 }}>
          <T w="bold" size={14.5}>موقع التوصيل</T>
          <T size={12} color={pin ? C.green : C.sub}>{line}</T>
        </View>
      </View>
      <MapView markers={pin ? [{ lat: pin.lat, lng: pin.lng, kind: 'dest' }] : [{ lat: 31.0, lng: 29.95, kind: 'me' }]} height={210} pickable focus={pin ? { lat: pin.lat, lng: pin.lng } : null} onPick={(p) => { setCartDest({ pin: p }); setState('manual'); }} />
      <T size={11.5} color={C.sub}>مش مكانك؟ اضغط على الخريطة وحرّك الدبوس للمكان الصح</T>
      <Btn title="حدّد موقعي تاني" icon="locate" variant="soft" small onPress={find} loading={state === 'finding'} />
    </Card>
  );
}

/** Owner only: one switch for maps and live location, and whether a delivery pin is required. */
export function MapModeCard() {
  const { db } = useStore();
  const m = db.settings.map || { enabled: true, required: true };
  const [busy, setBusy] = useState(false);
  const save = async (enabled: boolean, required: boolean) => {
    setBusy(true);
    const r = await setMapMode({ enabled, required });
    setBusy(false);
    toast(r.ok ? 'تم الحفظ ✅' : r.error, r.ok ? 'ok' : 'err');
  };
  return (
    <Card style={{ gap: 12, opacity: busy ? 0.6 : 1 }}>
      <View>
        <T w="black" size={15}>الخريطة وتحديد الموقع</T>
        <T size={12} color={C.sub}>تشغيل أو إيقاف الخرائط وتتبع المندوب لكل المستخدمين (فوري، من غير تحديث للتطبيق)</T>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <View style={{ flex: 1 }}>
          <T w="bold" size={14}>الخريطة شغّالة</T>
          <T size={11.5} color={C.sub}>{m.enabled ? 'الخريطة وتتبع المندوب ودبوس التوصيل ظاهرين' : 'مقفولة: عنوان مكتوب فقط وتوصيل بسعر المناطق، زي الأول'}</T>
        </View>
        <Toggle value={m.enabled} onValueChange={(v) => save(v, m.required)} />
      </View>
      {m.enabled && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1 }}>
            <T w="bold" size={14}>تحديد الموقع إجباري</T>
            <T size={11.5} color={C.sub}>{m.required ? 'العميل لازم يحدد دبوس على الخريطة ليؤكد الطلب' : 'العميل يقدر يطلب بالعنوان المكتوب بس'}</T>
          </View>
          <Toggle value={m.required} onValueChange={(v) => save(m.enabled, v)} />
        </View>
      )}
    </Card>
  );
}

/** Owner only (inside a customer's page): the spot the customer saved himself. Not live tracking. */
export function CustomerLocationCard({ lat, lng }: { lat?: number; lng?: number }) {
  const on = useMapOn();
  if (!on) return null;
  const has = lat != null && lng != null;
  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <IconBubble icon="location" color={C.green} bg={C.greenSoft} size={40} />
        <View style={{ flex: 1 }}>
          <T w="bold" size={14.5}>موقع العميل على الخريطة</T>
          <T size={12} color={C.sub}>{has ? 'الموقع اللي حدده العميل بنفسه' : 'لم يحدد موقعه بعد'}</T>
        </View>
      </View>
      {has && <MapView markers={[{ lat: lat!, lng: lng!, kind: 'dest' }]} height={200} />}
      {has && <Btn title="افتح في خرائط جوجل" icon="navigate" variant="green" small onPress={() => Linking.openURL(`https://www.google.com/maps?q=${lat},${lng}`)} />}
    </Card>
  );
}
