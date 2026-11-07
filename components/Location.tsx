import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Header, Empty, toast, callPhone, IconBubble, IconBtn } from './ui';
import MapView from './MapView';
import { getPosition, startCourierTracking, stopCourierTracking } from '../lib/location';
import { apiMyLocation, apiSetMyLocation, apiSetShopLocation, apiOrderTracking, apiStaffCourierLocations, GeoPoint, OrderTracking, StaffCourierPos } from '../lib/api';
import type { MapMarker } from '../lib/mapHtml';
import { setMyHome } from '../lib/store';

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
  if (!ready) return null;
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

/** Inside the order screen: appears once a courier has the order, then follows him live until delivery. */
export function OrderMapCard({ orderId, active, role, courierName, courierPhone }: { orderId: string; active: boolean; role: string; courierName?: string; courierPhone?: string }) {
  const [t, setT] = useState<OrderTracking | null>(null);
  usePoll(async () => { if (active) setT(await apiOrderTracking(orderId)); }, 8000, [orderId, active]);
  if (!active || !t) return null;
  const markers: MapMarker[] = [];
  if (t.shop) markers.push({ ...t.shop, kind: 'shop' });
  if (t.dest) markers.push({ ...t.dest, kind: 'dest' });
  if (t.courier) markers.push({ lat: t.courier.lat, lng: t.courier.lng, kind: 'courier', label: courierName });
  if (!markers.length) return null;
  const toShop = !['picked_up', 'on_the_way', 'arrived'].includes(t.status);
  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <IconBubble icon="map" color={C.orange} bg={C.orangeSoft} size={40} />
        <View style={{ flex: 1 }}>
          <T w="black" size={15}>تتبع الطلب على الخريطة</T>
          <T size={12} color={C.sub}>
            {t.courier
              ? (t.courier.fresh ? (t.distanceKm != null ? `${role === 'customer' && toShop ? 'المندوب في طريقه للمحل' : toShop ? 'المندوب في طريقه للمحل' : 'المندوب في الطريق إليك'} • ${t.distanceKm} كم • حوالي ${t.etaMin} دقيقة` : 'المندوب على الخريطة') : `آخر ظهور للمندوب ${ago(t.courier.at)}`)
              : 'موقع المندوب غير متاح الآن'}
          </T>
        </View>
        {!!courierPhone && role !== 'courier' && <IconBtn icon="call" bg={C.greenSoft} color={C.green} onPress={() => callPhone(courierPhone)} />}
      </View>
      <MapView markers={markers} height={240} />
      <T size={10.5} color={C.sub}>الوقت تقديري بخط مستقيم، وقد يختلف حسب الطريق</T>
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
