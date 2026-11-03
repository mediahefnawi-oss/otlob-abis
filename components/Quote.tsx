import React, { useEffect, useState } from 'react';
import { View, Image, ScrollView, Modal, Pressable, useWindowDimensions } from 'react-native';
import { C } from '../lib/theme';
import { T, Btn, Sheet, Field, Card, Chip, Icon, toast, confirmDialog } from './ui';
import { quoteOrder, courierQuote, orderImage, orderAction, useMe } from '../lib/store';
import { money, isoDay, prettyIso, readyLabel, isMakerTpl } from '../lib/format';
import { Order, Product } from '../lib/types';
import { ProductThumb } from './Brand';
import { productImageUrl } from '../lib/api';

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
  const [open, setOpen] = useState(false);
  if (!uri) return <T size={12} color={C.sub}>جاري تحميل الصورة…</T>;
  return (
    <View style={{ gap: 6 }}>
      <Pressable onPress={() => setOpen(true)}>
        <Image source={{ uri }} style={{ width: '100%', height: 320, borderRadius: 14, backgroundColor: C.line }} resizeMode="contain" />
      </Pressable>
      <Btn small variant="soft" icon="expand" title="فتح الصورة وتكبيرها" onPress={() => setOpen(true)} />
      <PhotoViewer uri={uri} visible={open} onClose={() => setOpen(false)} />
    </View>
  );
}

/** Full-screen photo: zoom with the + / − buttons (or pinch where the phone supports it) and scroll around to read the details. */
export function PhotoViewer({ uri, visible, onClose }: { uri: string; visible: boolean; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const [zoom, setZoom] = useState(1);
  useEffect(() => { if (visible) setZoom(1); }, [visible]);
  const w = width * zoom, h = (height - 120) * zoom;
  const step = (d: number) => setZoom((z) => Math.min(5, Math.max(1, Math.round((z + d) * 10) / 10)));
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ minHeight: height - 120, justifyContent: 'center' }} maximumZoomScale={4} minimumZoomScale={1} bouncesZoom>
          <ScrollView horizontal contentContainerStyle={{ minWidth: width, justifyContent: 'center' }}>
            <Image source={{ uri }} style={{ width: w, height: h }} resizeMode="contain" />
          </ScrollView>
        </ScrollView>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, paddingVertical: 18, paddingBottom: 30, backgroundColor: '#111' }}>
          <Pressable onPress={() => step(-0.5)} style={{ width: 54, height: 54, borderRadius: 27, backgroundColor: '#2a2a2a', alignItems: 'center', justifyContent: 'center' }}><Icon name="remove" size={28} color="#fff" /></Pressable>
          <T w="bold" size={14} color="#fff">{Math.round(zoom * 100)}%</T>
          <Pressable onPress={() => step(0.5)} style={{ width: 54, height: 54, borderRadius: 27, backgroundColor: '#2a2a2a', alignItems: 'center', justifyContent: 'center' }}><Icon name="add" size={28} color="#fff" /></Pressable>
          <Pressable onPress={onClose} style={{ paddingHorizontal: 22, height: 54, borderRadius: 27, backgroundColor: C.gold, alignItems: 'center', justifyContent: 'center', marginStart: 14 }}><T w="bold" size={14} color={C.dark}>إغلاق</T></Pressable>
        </View>
      </View>
    </Modal>
  );
}

/** A product picture the customer can tap to see it big (and zoom) before ordering. */
export function ProductPhoto({ p, size = 56, bg }: { p: Pick<Product, 'id' | 'emoji' | 'imageV'>; size?: number; bg: string }) {
  const [open, setOpen] = useState(false);
  if (!p.imageV) return <ProductThumb p={p} size={size} bg={bg} />;
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityLabel="عرض صورة المنتج">
        <ProductThumb p={p} size={size} bg={bg} />
        <View style={{ position: 'absolute', bottom: 3, left: 3, width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="expand" size={11} color="#fff" />
        </View>
      </Pressable>
      <PhotoViewer uri={productImageUrl(p)} visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

const nextDays = () => Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return isoDay(d); });
const HOURS = Array.from({ length: 32 }, (_, i) => `${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const hourLabel = (t: string) => { const h = Number(t.slice(0, 2)); return `${h % 12 || 12}:${t.slice(3)} ${h >= 12 ? 'م' : 'ص'}`; };

/** The shop (or maker) accepts the request and writes its price. A maker also picks the day and hour it will be ready. */
export function QuoteSheet({ o, visible, onClose }: { o: Order; visible: boolean; onClose: () => void }) {
  const [price, setPrice] = useState(o.status === 'quoted' ? String(o.subtotal) : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const isMaker = isMakerTpl(o.providerType);
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

/** «اطلب إيه نجيبهولك»: the courier who took the errand writes the price of the goods and his own delivery fee. */
export function ErrandQuoteSheet({ o, visible, onClose }: { o: Order; visible: boolean; onClose: () => void }) {
  const had = o.errandQuote === 'quoted';
  const [goods, setGoods] = useState(had ? String(o.subtotal) : '');
  const [fee, setFee] = useState(had ? String(o.deliveryFee) : '');
  const [busy, setBusy] = useState(false);
  const g = Number(toEn(goods)), f = Number(toEn(fee));
  const okGoods = Number.isFinite(g) && g > 0, okFee = fee.trim() !== '' && Number.isFinite(f) && f >= 0;
  const submit = async () => {
    if (!okGoods) return toast('اكتب سعر المشتريات', 'err');
    if (!okFee) return toast('اكتب رسوم التوصيل', 'err');
    setBusy(true);
    const r = await courierQuote(o.id, g, f);
    setBusy(false);
    if (!r.ok) return toast(r.error, 'err');
    onClose();
    toast('تم إرسال الفاتورة للعميل ✅');
  };
  return (
    <Sheet visible={visible} onClose={onClose} title="سعّر الطلب">
      <View style={{ backgroundColor: C.goldSoft, borderRadius: 14, padding: 12, gap: 6 }}>
        <T w="bold" size={12} color={C.goldDeep}>طلب العميل</T>
        <T size={13.5}>{o.customText}</T>
      </View>
      <Field label="سعر المشتريات (ج.م)" icon="cash" value={goods} onChangeText={setGoods} keyboardType="numeric" placeholder="مثال: 85" />
      <Field label="رسوم التوصيل (ج.م)" icon="bicycle" value={fee} onChangeText={setFee} keyboardType="numeric" placeholder="مثال: 20" />
      <Card style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row' }}><T color={C.sub} style={{ flex: 1 }}>المشتريات</T><T w="bold">{okGoods ? money(g) : '—'}</T></View>
        <View style={{ flexDirection: 'row' }}><T color={C.sub} style={{ flex: 1 }}>التوصيل</T><T w="bold">{okFee ? money(f) : '—'}</T></View>
        <View style={{ flexDirection: 'row' }}><T w="black" style={{ flex: 1 }}>الإجمالي على العميل</T><T w="black" color={C.goldDeep}>{okGoods && okFee ? money(g + f) : '—'}</T></View>
      </Card>
      <T size={12} color={C.sub}>العميل هيشوف الفاتورة ويوافق أو يرفض. لو رفض الطلب بيرجع للمناديب.</T>
      <Btn title="إرسال الفاتورة للعميل" icon="send" loading={busy} onPress={submit} />
    </Sheet>
  );
}

/** The courier's "price the errand" button (and the wait for the customer's answer). */
export function ErrandQuoteButton({ o, small }: { o: Order; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const quoted = o.errandQuote === 'quoted';
  return (
    <>
      <Btn small={small} icon="pricetag" variant={quoted ? 'soft' : undefined} title={quoted ? 'تعديل السعر (بانتظار العميل)' : 'سعّر الطلب'} onPress={() => setOpen(true)} style={small ? { flex: 1.3 } : undefined} />
      <ErrandQuoteSheet o={o} visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Buttons the shop sees on a written request that still needs a price. */
export function QuoteButtons({ o }: { o: Order }) {
  const [open, setOpen] = useState(false);
  if (!o.request || !['pending', 'quoted'].includes(o.status)) return null;
  const unavailable = () => confirmDialog({
    title: isMakerTpl(o.providerType) ? 'الاعتذار عن الطلب؟' : 'الأصناف غير متوفرة؟', message: isMakerTpl(o.providerType) ? 'سيصل العميل إشعار باعتذارك عن الطلب وينتهي الطلب.' : 'ستصل العميل فاتورة تفيد بعدم توفر الطلب وينتهي الطلب.', danger: true, confirmText: 'إرسال',
    onConfirm: async () => { const r = await quoteOrder(o.id, { unavailable: true }); if (!r.ok) toast(r.error, 'err'); else toast('تم إبلاغ العميل'); },
  });
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn small icon="pricetag" title={o.status === 'quoted' ? 'تعديل السعر والموعد' : (isMakerTpl(o.providerType) ? 'قبول وتحديد السعر والموعد' : 'قبول وتحديد السعر')} style={{ flex: 2 }} onPress={() => setOpen(true)} />
        <Btn small variant="danger" icon="close-circle" title={isMakerTpl(o.providerType) ? 'اعتذار' : 'غير متوفر'} style={{ flex: 1 }} onPress={unavailable} />
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
  if (!isMakerTpl(o.providerType) || o.request || o.status !== 'pending' || !me) return null;
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
