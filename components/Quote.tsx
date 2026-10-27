import React, { useEffect, useState } from 'react';
import { View, Image } from 'react-native';
import { C } from '../lib/theme';
import { T, Btn, Sheet, Field, Card, toast, confirmDialog } from './ui';
import { quoteOrder, orderImage } from '../lib/store';
import { money } from '../lib/format';
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

/** The shop accepts the request and writes its price. */
export function QuoteSheet({ o, visible, onClose }: { o: Order; visible: boolean; onClose: () => void }) {
  const [price, setPrice] = useState(o.status === 'quoted' ? String(o.subtotal) : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const p = Number(toEn(price));
  const valid = Number.isFinite(p) && p > 0;

  const submit = async () => {
    if (!valid) return toast('اكتب سعر الطلب', 'err');
    setBusy(true);
    const r = await quoteOrder(o.id, { price: p, note: note.trim() });
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
      <Field label="ملاحظة للعميل (اختياري)" icon="create" value={note} onChangeText={setNote} placeholder="مثال: بدلنا الصنف الفلاني بالصنف ده" />
      <Card style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row' }}><T color={C.sub} style={{ flex: 1 }}>سعر الطلب</T><T w="bold">{valid ? money(p) : '—'}</T></View>
        <View style={{ flexDirection: 'row' }}><T color={C.sub} style={{ flex: 1 }}>التوصيل (حسب منطقة العميل)</T><T w="bold">{money(o.deliveryFee)}</T></View>
        <View style={{ flexDirection: 'row' }}><T w="black" style={{ flex: 1 }}>الإجمالي على العميل</T><T w="black" color={C.goldDeep}>{valid ? money(p + o.deliveryFee) : '—'}</T></View>
      </Card>
      <Btn title="قبول الطلب وإرسال الفاتورة" icon="checkmark" loading={busy} onPress={submit} />
    </Sheet>
  );
}

/** Buttons the shop sees on a written request that still needs a price. */
export function QuoteButtons({ o }: { o: Order }) {
  const [open, setOpen] = useState(false);
  if (!o.request || !['pending', 'quoted'].includes(o.status)) return null;
  const unavailable = () => confirmDialog({
    title: 'الأصناف غير متوفرة؟', message: 'ستصل العميل فاتورة تفيد بعدم توفر الطلب وينتهي الطلب.', danger: true, confirmText: 'إرسال',
    onConfirm: async () => { const r = await quoteOrder(o.id, { unavailable: true }); if (!r.ok) toast(r.error, 'err'); else toast('تم إبلاغ العميل'); },
  });
  return (
    <>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn small icon="pricetag" title={o.status === 'quoted' ? 'تعديل السعر' : 'قبول وتحديد السعر'} style={{ flex: 2 }} onPress={() => setOpen(true)} />
        <Btn small variant="danger" icon="close-circle" title="غير متوفر" style={{ flex: 1 }} onPress={unavailable} />
      </View>
      {o.status === 'quoted' && <T size={12} color={C.goldDeep} w="semi">بانتظار موافقة العميل على السعر ({money(o.total)})</T>}
      <QuoteSheet o={o} visible={open} onClose={() => setOpen(false)} />
    </>
  );
}
