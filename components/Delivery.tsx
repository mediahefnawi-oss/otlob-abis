import React, { useEffect, useState } from 'react';
import { View, Image, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Btn, Sheet, Field, Card, Chip, toast } from './ui';
import { useStore, useMe, courierSetFee, orderAction, setCartVehicle, setCourierVehicle } from '../lib/store';
import { apiDeliveryOptions, apiPublicCourierVehicles, apiAdminRideTypes, apiAdminMakeCaptain, DeliveryOption, courierVehicleImageUrl } from '../lib/api';
import { money } from '../lib/format';
import { Order, User } from '../lib/types';

const toEn = (s: string) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[٫,]/g, '.');
const imgUrl = (u: string | null) => (u ? courierVehicleImageUrl({ image: u }) : null);

/** Customer, at checkout: which delivery means brings the order (the owner's price for each, and whether one is on duty). Renders nothing when there is nothing to choose. */
export function VehiclePicker({ providerIds }: { providerIds: string[] }) {
  const { db } = useStore();
  const me = useMe();
  const [opts, setOpts] = useState<DeliveryOption[]>([]);
  const [mode, setMode] = useState<'region' | 'km' | 'courier'>('region');
  const [pick, setPick] = useState('');
  const key = providerIds.join(',') + '|' + JSON.stringify(db.routeVehiclePrices || {}) + '|' + (me?.regionId || '') + '|' + (db.settings.delivery?.mode || '');
  useEffect(() => {
    let live = true;
    if (!providerIds.length || me?.role !== 'customer') { setOpts([]); setCartVehicle('', false); return; }
    apiDeliveryOptions(providerIds).then((r) => {
      if (!live) return;
      setOpts(r.options || []); setMode(r.mode);
      setPick((cur) => { const keep = (r.options || []).find((o) => o.name === cur && o.available); const next = keep ? keep.name : ''; // the customer must choose: nothing is picked for him setCartVehicle(next, (r.options || []).length > 0); return next; });
    }).catch(() => { if (live) { setOpts([]); setCartVehicle('', false); } });
    return () => { live = false; };
  }, [key]);
  useEffect(() => () => { setCartVehicle('', false); }, []);
  if (!opts.length) return null;
  return (
    <Card style={{ gap: 8 }}>
      <T w="black" size={14.5}>🛵 اختر وسيلة التوصيل</T>
      {mode === 'courier' && <T size={11.5} color={C.sub}>سعر التوصيل بيحدده المندوب وإنت بتوافق عليه قبل ما يستلم الطلب.</T>}
      {opts.map((o) => {
        const on = pick === o.name && o.available;
        const u = imgUrl(o.image);
        return (
          <Pressable key={o.id} onPress={() => { if (!o.available) return toast(`وسيلة ${o.name} مش متوفرة، اختر وسيلة تانية`, 'err'); setPick(o.name); setCartVehicle(o.name, true); }}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 2, borderColor: on ? C.gold : C.line, backgroundColor: on ? C.goldSoft : '#fff', borderRadius: 14, padding: 10, opacity: o.available ? 1 : 0.45 }}>
            {u ? <Image source={{ uri: u }} style={{ width: 38, height: 38, borderRadius: 10 }} /> : <T size={24}>🛵</T>}
            <View style={{ flex: 1 }}>
              <T w="black" size={14}>{o.name}</T>
              <T size={11} color={C.sub}>{o.available ? (o.price == null ? 'السعر يحدده المندوب' : 'متاح') : o.reason}</T>
            </View>
            {o.price != null && o.available && <T w="black" size={14} color={C.green}>{money(o.price)}</T>}
          </Pressable>
        );
      })}
      {!opts.some((o) => o.available) && <T size={12} color={C.red}>مفيش وسيلة توصيل متاحة دلوقتي لمنطقتك، جرّب بعد شوية.</T>}
      {opts.some((o) => o.available) && !pick && <T size={12} color={C.goldDeep}>اختر وسيلة التوصيل عشان تكمّل الطلب.</T>}
    </Card>
  );
}

/** Courier: writes the delivery price (between the owner's limits); the customer approves before pickup. */
export function CourierFeeButton({ o, small }: { o: Order; small?: boolean }) {
  const { db } = useStore();
  const d = db.settings.delivery;
  const lo = d?.courierMin ?? 5, hi = d?.courierMax ?? 50;
  const [open, setOpen] = useState(false);
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  if (!o.feeByCourier || !['accepted', 'ready'].includes(o.status) || o.feeState === 'approved') return null;
  const goods = o.total - o.deliveryFee;
  const n = Number(toEn(v));
  const ok = Number.isFinite(n) && n >= lo && n <= hi;
  const send = async () => {
    if (!ok) return toast(`اكتب سعر من ${lo} إلى ${hi} ج.م`, 'err');
    setBusy(true); const r = await courierSetFee(o.id, n); setBusy(false);
    if (!r.ok) return toast(r.error, 'err');
    toast('تم إرسال السعر للعميل'); setOpen(false);
  };
  const waiting = o.feeState === 'proposed';
  return (
    <>
      <Btn small={small} icon="cash" variant={waiting ? 'soft' : undefined} title={waiting ? 'تعديل السعر (بانتظار العميل)' : 'حدد سعر التوصيل'} onPress={() => setOpen(true)} style={small ? { flex: 1.3 } : undefined} />
      <Sheet visible={open} onClose={() => setOpen(false)} title="سعر التوصيل">
        <T size={12.5} color={C.sub}>اكتب سعر بين {lo} و {hi} ج.م. العميل بيوافق عليه قبل ما تستلم الطلب.</T>
        <Field label="سعر التوصيل (ج.م)" value={v} onChangeText={setV} keyboardType="decimal-pad" icon="cash" />
        <Card style={{ gap: 4 }}>
          <View style={{ flexDirection: 'row' }}><T style={{ flex: 1 }}>المنتجات</T><T w="bold">{money(goods)}</T></View>
          <View style={{ flexDirection: 'row' }}><T style={{ flex: 1 }}>التوصيل</T><T w="bold">{ok ? money(n) : '—'}</T></View>
          <View style={{ flexDirection: 'row' }}><T w="black" style={{ flex: 1 }}>إجمالي العميل</T><T w="black" color={C.goldDeep}>{ok ? money(goods + n) : '—'}</T></View>
        </Card>
        <Btn title="إرسال السعر للعميل" icon="send" loading={busy} onPress={send} />
      </Sheet>
    </>
  );
}

/** Customer: the courier's delivery price waits for a yes or a no. */
export function FeeApprovalCard({ o }: { o: Order }) {
  const me = useMe();
  if (!me || me.role !== 'customer' || !o.feeByCourier || o.feeState !== 'proposed' || !['accepted', 'ready'].includes(o.status)) return null;
  return (
    <Card style={{ gap: 8, borderWidth: 2, borderColor: C.gold }}>
      <T w="black" size={14.5}>🛵 {o.courierName || 'المندوب'} حدد سعر التوصيل</T>
      <View style={{ flexDirection: 'row' }}><T style={{ flex: 1 }}>المنتجات</T><T w="bold">{money(o.total - o.deliveryFee)}</T></View>
      <View style={{ flexDirection: 'row' }}><T style={{ flex: 1 }}>التوصيل{o.vehicle ? ` (${o.vehicle})` : ''}</T><T w="bold">{money(o.deliveryFee)}</T></View>
      <View style={{ flexDirection: 'row' }}><T w="black" style={{ flex: 1 }}>الإجمالي</T><T w="black" color={C.goldDeep}>{money(o.total)}</T></View>
      <Btn variant="green" icon="checkmark-circle" title="موافق على السعر" onPress={() => { const r = orderAction(o.id, 'approve_fee', me); if (!r.ok) toast(r.error, 'err'); }} />
      <Btn variant="danger" icon="close-circle" title="رفض (يتحول لمندوب تاني)" onPress={() => { const r = orderAction(o.id, 'decline_fee', me); if (!r.ok) toast(r.error, 'err'); }} />
    </Card>
  );
}
/** Courier: the status line while the customer has not agreed yet. */
export function FeeWaitNote({ o }: { o: Order }) {
  const me = useMe();
  if (!me || me.role !== 'courier' || !o.feeByCourier || o.feeState === 'approved' || !['accepted', 'ready'].includes(o.status)) return null;
  return <T size={12} color={C.goldDeep} w="semi">{o.feeState === 'proposed' ? `بانتظار موافقة العميل على ${money(o.deliveryFee)}` : 'حدد سعر التوصيل عشان تقدر تستلم الطلب'}</T>;
}

/** Owner / manager: change a courier's delivery means. */
export function CourierVehicleButton({ courier }: { courier: User }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ id: number; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) apiPublicCourierVehicles().then((r) => setList(r.vehicles)).catch(() => setList([])); }, [open]);
  const pick = async (name: string) => {
    if (name === courier.vehicle) return setOpen(false);
    setBusy(true); const r = await setCourierVehicle(courier.id, name); setBusy(false);
    if (!r.ok) return toast(r.error, 'err');
    toast('تم تغيير وسيلة المندوب ✅'); setOpen(false);
  };
  return (
    <>
      <Btn small variant="dark" icon="swap-horizontal" title="تغيير وسيلة التوصيل" onPress={() => setOpen(true)} />
      <Sheet visible={open} onClose={() => setOpen(false)} title={`وسيلة ${courier.name}`}>
        {list.map((v) => {
          const on = v.name === courier.vehicle;
          return (
            <Pressable key={v.id} disabled={busy} onPress={() => pick(v.name)} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 2, borderColor: on ? C.gold : C.line, backgroundColor: on ? C.goldSoft : '#fff', borderRadius: 14, padding: 12 }}>
              <T w="black" size={14} style={{ flex: 1 }}>{v.name}</T>
              {on && <T size={11.5} color={C.goldDeep} w="bold">الحالية</T>}
            </Pressable>
          );
        })}
        <T size={11.5} color={C.sub}>الأنواع هي اللي ضفتها في «وسائل توصيل المندوب». التغيير مش بيتم لو معاه طلب شغال.</T>
      </Sheet>
    </>
  );
}

/** Owner / manager: makes this delivery courier a captain too (he keeps taking delivery orders). */
export function MakeCaptainButton({ courier }: { courier: User }) {
  const [open, setOpen] = useState(false);
  const [types, setTypes] = useState<{ id: number; name: string }[]>([]);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [f, setF] = useState({ model: '', color: '', plate: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open && !types.length) apiAdminRideTypes().then((r) => { setTypes(r.types); if (r.types[0]) setTypeId(r.types[0].id); }).catch(() => {}); }, [open, types.length]);
  const save = async () => {
    if (!typeId) return toast('اختر نوع المركبة', 'err');
    setBusy(true);
    try { await apiAdminMakeCaptain(courier.id, { typeId, ...f }); toast('تم تفعيله كابتن توصيلة ✅'); setOpen(false); }
    catch (e: any) { toast(e?.message || 'تعذر التنفيذ', 'err'); } finally { setBusy(false); }
  };
  return (
    <>
      <Btn small variant="soft" icon="car" title="إضافة كابتن توصيلة" onPress={() => setOpen(true)} />
      <Sheet visible={open} onClose={() => setOpen(false)} title={`كابتن توصيلة: ${courier.name}`}>
        <T size={12.5} color={C.sub}>هيتفعّل كابتن فوراً ويفضل يستقبل طلبات التوصيل كمان (الاتنين). تقدر تغيّر ده بعدين من تبويب الكباتن.</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {types.map((t) => <Chip key={t.id} label={t.name} active={typeId === t.id} onPress={() => setTypeId(t.id)} />)}
        </View>
        <Field label="موديل المركبة (اختياري)" value={f.model} onChangeText={(v) => setF((x) => ({ ...x, model: v }))} />
        <Field label="اللون (اختياري)" value={f.color} onChangeText={(v) => setF((x) => ({ ...x, color: v }))} />
        <Field label="رقم اللوحة (اختياري)" value={f.plate} onChangeText={(v) => setF((x) => ({ ...x, plate: v }))} />
        <Btn title="تفعيل كابتن" icon="checkmark" loading={busy} onPress={save} />
      </Sheet>
    </>
  );
}
