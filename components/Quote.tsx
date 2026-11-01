import React, { useEffect, useState } from 'react';
import { View, Image, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Btn, Sheet, Field, Card, Chip, toast, confirmDialog } from './ui';
import { quoteOrder, orderImage, orderAction, useMe } from '../lib/store';
import { money, isoDay, prettyIso, readyLabel } from '../lib/format';
import { Order } from '../lib/types';

// accepts Arabic-Indic digits too (٣٥ → 35)
const toEn = (s: string) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[٫,]/g, '.');

/** The photo (prescription) that came with a written request. */
export function RequestPhoto({ o }: { o: Order }) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    if (o.request?.hasImage) orderImage(o.id).then((u) => { if (live) setUri(u); });
    return () => { live = false; };
  }, [o.id, o.request?.hasImage]);
  if (!o.request?.hasImage) return null;
  return uri
    ? <Image source={{ uri }} style={{ width: '100%', height: 320, borderRadius: 14, backgroundColor: C.line }} resizeMode="contain" />
    : <T size={12} color={C.sub}>جاري تحميل الصورة…</T>;
}

const nextDays = () => Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return isoDay(d); });
const HOURS = Array.from({ length: 32 }, (_, i) => `${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const hourLabel = (t: string) => { const h = Number(t.slice(0, 2)); return `${h % 12 || 12}:${t.slice(3)} ${h >= 12 ? 'م' : 'ص'}`; };

/** The shop (or maker) accepts the request and writes its price. A maker also picks the day and hour it will be ready. */
export function QuoteSheet({ o, visible, onClose }: { o: Order; visible: boolean; onClose: () => void }) {
  const [price, setPrice] = useState(o.status === 'quoted' ? String(o.subtotal) : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const isMaker = o.providerType === 'maker';
  const days = nextDays();
  const [day, setDay] = useState(o.readyDate && days.includes(o.readyDate) ? o.readyDate : '');
  const [hour, setHour] = useState(o.readyTime || '');
  const p = Number(toEn(price));
  const valid = Number.isFinite(p) && p > 0;

  const submit = async () => {
    if (!valid) return toast('اكتب سعر الطلب', 'err');
    if (isMaker && (!day || !hour)) return toast('حدد يوم وساعة جاهزية الطلب للتسليم', 'err');
    setBusy(true);
    const r = await quoteOrder(o.id, { price: p, note: note.trim(), ...(isMaker ? { readyDate: day, readyTime: hour } : {}) });
    setBusy(false);
    if (!r.ok) return toast(r.error, 'err');
    onClose();
    toast('تم قبول الطلب وإرسال الفاتورة للعميل ✅');
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="قبول الطلب وتحديد السعر">
      <View style={{ backgroundColor: C.goldSoft, borderRadius: 14, padding: 12, gap: 8 }}>
        <T w="bold" size={12} color={C.goldDeep}>طلب العميل</T>
        {!!o.request?.text && <T size={13.5}>{o.request.text}</T>}
        <RequestPhoto o={o} />
      </View>
      <Field label="سعر الطلب (ج.م)" icon="cash" value={price} onChangeText={setPrice} keyboardType="numeric" placeholder="مثال: 135" />
      {isMaker && (
        <View style={{ gap: 8 }}>
          <T w="bold" size={13}>يوم التسليم (جاهز للمندوب)</T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {days.map((d) => <Chip key={d} label={d === days[0] ? 'اليوم' : prettyIso(d).split(' ').slice(0, 2).join(' ')} active={day === d} onPress={() => setDay(d)} />)}
          </ScrollView>
          <T w="bold" size={13}>الساعة</T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {HOURS.map((h) => <Chip key={h} label={hourLabel(h)} active={hour === h} onPress={() => setHour(h)} />)}
          </ScrollView>
          {!!day && !!hour && <T size={12.5} color={C.goldDeep} w="semi">جاهز للتسليم: {readyLabel(day, hour)}</T>}
        </View>
      )}
      <Field label="ملاحظة للعميل (اختياري)" icon="create" value={note} onChangeText={setNote} placeholder="مثال: بدلنا الصنف الفلاني بالصنف ده" />
      <Card style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row' }}><T color={C.sub} style={{ flex: 1 }}>سعر الطلب</T><T w="bold">{valid ? money(p) : '—'}</T></View>
        <View style={{ flexDirection: 'row' }}><T color={C.sub} style={{ flex: 1 }}>التوصيل (حسب منطقة العميل)</T><T w="bold">{money(o.deliveryFee)}</T></View>
        <View style={{ flexDirection: 'row' }}><T w="black" style={{ flex: 1 }}>الإجمالي على العميل</T><T w="black" color={C.goldDeep}>{valid ? money(p + o.deliveryFee) : '—'}</T></View>
      </Card>
      <Btn title={isMaker ? 'قبول الطلب وتأكيد الموعد' : 'قبول الطلب وإرسال الفاتورة'} icon="checkmark" loading={busy} onPress={submit} />
    </Sheet>
  );
}

/** Buttons the shop sees on a written request that still needs a price. */
export function QuoteButtons({ o }: { o: Order }) {
  const [open, setOpen] = useState(false);
  if (!o.request || !['pending', 'quoted'].includes(o.status)) return null;
  const unavailable = () => confirmDialog({
    title: o.providerType === 'maker' ? 'الاعتذار عن الطلب؟' : 'الأصناف غير متوفرة؟', message: o.providerType === 'maker' ? 'سيصل العميل إشعار باعتذارك عن الطلب وينتهي الطلب.' : 'ستصل العميل فاتورة تفيد بعدم توفر الطلب وينتهي الطلب.', danger: true, confirmText: 'إرسال',
    onConfirm: async () => { const r = await quoteOrder(o.id, { unavailable: true }); if (!r.ok) toast(r.error, 'err'); else toast('تم إبلاغ العميل'); },
  });
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn small icon="pricetag" title={o.status === 'quoted' ? 'تعديل السعر والموعد' : (o.providerType === 'maker' ? 'قبول وتحديد السعر والموعد' : 'قبول وتحديد السعر')} style={{ flex: 2 }} onPress={() => setOpen(true)} />
        <Btn small variant="danger" icon="close-circle" title={o.providerType === 'maker' ? 'اعتذار' : 'غير متوفر'} style={{ flex: 1 }} onPress={unavailable} />
      </View>
      {o.status === 'quoted' && <T size={12} color={C.goldDeep} w="semi">بانتظار موافقة العميل على السعر ({money(o.total)})</T>}
      <QuoteSheet o={o} visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** A maker receives an order for products from the shop page: ready now, ready on a day and hour he chooses, or apologise. */
export function MakerOrderButtons({ o }: { o: Order }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const days = nextDays();
  const [day, setDay] = useState('');
  const [hour, setHour] = useState('');
  if (o.providerType !== 'maker' || o.request || o.status !== 'pending' || !me) return null;
  const done = (r: { ok: boolean; error?: string }, msg: string) => { if (!r.ok) toast(r.error || 'حدث خطأ', 'err'); else toast(msg); };
  const readyNow = () => done(orderAction(o.id, 'accept', me, undefined, { ready: true }), 'تم إبلاغ العميل والمندوب بأن الطلب جاهز ✅');
  const schedule = () => {
    if (!day || !hour) return toast('حدد يوم وساعة جاهزية الطلب للتسليم', 'err');
    done(orderAction(o.id, 'accept', me, undefined, { readyDate: day, readyTime: hour }), 'تم قبول الطلب وتحديد الموعد ✅');
    setOpen(false);
  };
  const apologise = () => confirmDialog({
    title: 'الاعتذار عن الطلب؟', message: 'سيصل العميل إشعار باعتذارك عن الطلب وينتهي الطلب.', danger: true, confirmText: 'اعتذار',
    onConfirm: () => done(orderAction(o.id, 'reject', me, 'اعتذر الصانع عن تنفيذ الطلب'), 'تم إبلاغ العميل'),
  });
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn small variant="green" icon="checkmark" title="جاهز" style={{ flex: 1 }} onPress={readyNow} />
        <Btn small icon="calendar" title="تحديد موعد" style={{ flex: 1.3 }} onPress={() => setOpen(true)} />
        <Btn small variant="danger" icon="close-circle" title="اعتذار" style={{ flex: 1 }} onPress={apologise} />
      </View>
      <Sheet visible={open} onClose={() => setOpen(false)} title="موعد جاهزية الطلب">
        <T w="bold" size={13}>يوم التسليم (جاهز للمندوب)</T>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {days.map((d) => <Chip key={d} label={d === days[0] ? 'اليوم' : prettyIso(d).split(' ').slice(0, 2).join(' ')} active={day === d} onPress={() => setDay(d)} />)}
        </ScrollView>
        <T w="bold" size={13}>الساعة</T>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {HOURS.map((h) => <Chip key={h} label={hourLabel(h)} active={hour === h} onPress={() => setHour(h)} />)}
        </ScrollView>
        {!!day && !!hour && <T size={12.5} color={C.goldDeep} w="semi">جاهز للتسليم: {readyLabel(day, hour)}</T>}
        <Btn title="قبول الطلب وتأكيد الموعد" icon="checkmark" onPress={schedule} />
      </Sheet>
    </>
  );
}
