import React, { useState } from 'react';
import { View } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Field, toast } from './ui';
import { useStore, setDeliveryMode } from '../lib/store';

/** Owner only: delivery price by area (the current system) or by kilometre. */
export function DeliveryModeCard() {
  const { db } = useStore();
  const d = db.settings.delivery || { mode: 'region' as const, perKm: 5, min: 10, max: 40, factor: 1.3 };
  const [mode, setMode] = useState<'region' | 'km' | 'courier'>(d.mode);
  const [cMin, setCMin] = useState(String(d.courierMin ?? 5));
  const [cMax, setCMax] = useState(String(d.courierMax ?? 50));
  const [perKm, setPerKm] = useState(String(d.perKm));
  const [min, setMin] = useState(String(d.min));
  const [max, setMax] = useState(String(d.max));
  const [factor, setFactor] = useState(String(d.factor));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await setDeliveryMode({ mode, perKm: Number(perKm), min: Number(min), max: Number(max), factor: Number(factor), courierMin: Number(cMin), courierMax: Number(cMax) });
    setBusy(false);
    toast(r.ok ? 'تم حفظ نظام التوصيل ✅' : r.error, r.ok ? 'ok' : 'err');
  };
  const Opt = ({ id, title, sub }: { id: 'region' | 'km' | 'courier'; title: string; sub: string }) => (
    <Card onPress={() => setMode(id)} style={{ flex: 1, gap: 2, borderWidth: 2, borderColor: mode === id ? C.gold : C.line, padding: 12 }}>
      <T w="black" size={13.5}>{title}</T>
      <T size={11} color={C.sub}>{sub}</T>
    </Card>
  );
  return (
    <Card style={{ gap: 12 }}>
      <View>
        <T w="black" size={15}>نظام سعر التوصيل</T>
        <T size={12} color={C.sub}>اختر طريقة حساب التوصيل لكل الطلبات</T>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Opt id="region" title="بالمناطق" sub="الأسعار اللي ضبطتها بين المناطق (زي الآن)" />
        <Opt id="km" title="بالكيلو" sub="سعر الكيلو × المسافة بين المحل والعميل" />
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Opt id="courier" title="المندوب يحدده 🆕" sub="المندوب يكتب سعر التوصيل بين حدّين، والعميل يوافق قبل الاستلام" />
      </View>
      {mode === 'courier' && (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label="أقل سعر يكتبه المندوب (ج.م)" value={cMin} onChangeText={setCMin} keyboardType="decimal-pad" icon="arrow-down" /></View>
            <View style={{ flex: 1 }}><Field label="أعلى سعر يكتبه المندوب (ج.م)" value={cMax} onChangeText={setCMax} keyboardType="decimal-pad" icon="arrow-up" /></View>
          </View>
          <T size={11.5} color={C.sub}>1) العميل يختار الوسيلة ويأكد الطلب بدون سعر توصيل. 2) المندوب يقبل الطلب ويكتب السعر. 3) العميل يوافق أو يرفض (لو رفض المندوب بيتشال والطلب يروح لغيره). المندوب مش بيستلم قبل الموافقة.</T>
        </View>
      )}
      {mode === 'km' && (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label="سعر الكيلو (ج.م)" value={perKm} onChangeText={setPerKm} keyboardType="decimal-pad" icon="cash" /></View>
            <View style={{ flex: 1 }}><Field label="معامل الطريق" value={factor} onChangeText={setFactor} keyboardType="decimal-pad" icon="trail-sign" /></View>
          </View>
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <View style={{ flex: 1 }}><Field label="الحد الأدنى (ج.م)" value={min} onChangeText={setMin} keyboardType="decimal-pad" icon="arrow-down" /></View>
            <View style={{ flex: 1 }}><Field label="الحد الأقصى (ج.م)" value={max} onChangeText={setMax} keyboardType="decimal-pad" icon="arrow-up" /></View>
          </View>
          <T size={11.5} color={C.sub}>المسافة بخط مستقيم × معامل الطريق (1.3 يقرّبها لمسافة الطريق). لو العميل أو المحل ماحددش موقعه يتحسب بسعر المناطق.</T>
        </View>
      )}
      <Btn title="حفظ" icon="checkmark-circle" onPress={save} loading={busy} />
    </Card>
  );
}
