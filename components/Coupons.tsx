import React, { useEffect, useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Header, Empty, Field, Icon, Chip, Sheet, toast, confirmDialog } from './ui';
import { useStore } from '../lib/store';
import { money, fmtDate } from '../lib/format';
import { apiCoupons, apiCouponCreate, apiCouponActive, apiCouponDelete, apiCouponCheck, apiMyCoupons, Coupon } from '../lib/api';

const what = (c: Pick<Coupon, 'kind' | 'value' | 'maxDiscount'>) =>
  c.kind === 'amount' ? `خصم ${c.value} ج.م` : `خصم ${c.value}%${c.maxDiscount ? ` (حتى ${c.maxDiscount} ج.م)` : ''}`;
const state = (c: Coupon) => {
  const now = Date.now();
  if (!c.active) return { t: 'متوقف', fg: '#6B7A74', bg: '#EEEEEE' };
  if (c.endsAt <= now) return { t: 'منتهي', fg: '#6B7A74', bg: '#EEEEEE' };
  if (c.startsAt > now) return { t: 'لم يبدأ', fg: '#8a6200', bg: '#FFF3CF' };
  if (c.maxUses != null && c.uses >= c.maxUses) return { t: 'اكتمل', fg: '#6B7A74', bg: '#EEEEEE' };
  return { t: 'شغال', fg: '#0B6B4D', bg: '#E2F3EA' };
};

/** Owner only: make discount codes, stop them, delete the unused ones. */
export function AdminCouponsScreen({ navigation }: any) {
  const { db } = useStore();
  const [list, setList] = useState<Coupon[] | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'amount' | 'percent'>('amount');
  const [value, setValue] = useState('');
  const [cap, setCap] = useState('');
  const [later, setLater] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [days, setDays] = useState('7');
  const [shops, setShops] = useState<string[]>([]);
  const [perUser, setPerUser] = useState<number | null>(1);
  const [maxUses, setMaxUses] = useState('');
  const shopList = db.providers.filter((p) => p.status === 'active' && p.type !== 'clinic' && p.type !== 'lab').slice(0, 80);
  useEffect(() => { apiCoupons().then((r) => setList(r.coupons)).catch((e) => { setList([]); toast(e?.message || 'تعذر التحميل', 'err'); }); }, []);

  const run = async (f: () => Promise<{ coupons: Coupon[] }>, okMsg?: string) => {
    setBusy(true);
    try { const r = await f(); setList(r.coupons); if (okMsg) toast(okMsg); return true; }
    catch (e: any) { toast(e?.message || 'تعذر التنفيذ', 'err'); return false; }
    finally { setBusy(false); }
  };
  const reset = () => { setCode(''); setKind('amount'); setValue(''); setCap(''); setLater(false); setStartDate(''); setDays('7'); setShops([]); setPerUser(1); setMaxUses(''); };
  const publish = async () => {
    const ok = await run(() => apiCouponCreate({
      code: code.trim() || undefined, kind, value: Number(value), maxDiscount: kind === 'percent' && cap ? Number(cap) : undefined,
      days: Number(days), startDate: later ? startDate.trim() : undefined, providerIds: shops.length ? shops : undefined,
      perUser, maxUses: maxUses ? Number(maxUses) : undefined,
    }), 'تم نشر الكود ✅');
    if (ok) { setOpen(false); reset(); }
  };
  const del = (c: Coupon) => confirmDialog({ title: 'حذف الكود؟', message: `«${c.code}» سيُحذف نهائياً`, danger: true, confirmText: 'حذف', onConfirm: () => { run(() => apiCouponDelete(c.id), 'تم الحذف'); } });
  const toggleShop = (id: string) => setShops((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="أكواد الخصم" subtitle="أنشئ كوداً وحدد أيامه ومتاجره" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Btn title="＋ كود جديد" icon="ticket" onPress={() => { reset(); setOpen(true); }} />
        {list && !list.length && <Empty icon="ticket" title="لا توجد أكواد" text="أنشئ أول كود ويستخدمه العميل في سلة الطلب" />}
        {(list || []).map((c) => {
          const st = state(c);
          const live = st.t === 'شغال';
          return (
            <Card key={c.id} style={{ gap: 6, opacity: live ? 1 : 0.7 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T w="black" size={17} style={{ flex: 1, letterSpacing: 1 }}>{c.code}</T>
                <View style={{ backgroundColor: st.bg, borderRadius: 10, paddingHorizontal: 9, paddingVertical: 2 }}><T w="black" size={11} color={st.fg}>{st.t}</T></View>
              </View>
              <T w="bold" size={13.5}>{what(c)}{c.userName ? ` • للعميل ${c.userName} فقط` : ''}{c.source === 'gift' ? ' • هدية' : ''}</T>
              <T size={12} color={C.sub}>
                {fmtDate(c.startsAt)} ← {fmtDate(c.endsAt)} • {c.providerIds ? `${c.providerIds.length} متجر محدد` : 'كل المتاجر'}
              </T>
              <T size={12} color={C.sub}>
                استُخدم {c.uses}{c.maxUses ? ` / ${c.maxUses}` : ''} مرة • {c.perUser ? (c.perUser === 1 ? 'مرة لكل عميل' : `${c.perUser} مرات لكل عميل`) : 'بدون حد لكل عميل'}
                {c.given > 0 ? ` • إجمالي الخصم ${money(c.given)}` : ''}
              </T>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                <Btn small variant="soft" title={c.active ? 'إيقاف' : 'تشغيل'} onPress={() => run(() => apiCouponActive(c.id, !c.active))} style={{ flex: 1 }} />
                {c.uses === 0 && <Btn small variant="danger" title="حذف" onPress={() => del(c)} style={{ flex: 1 }} />}
              </View>
            </Card>
          );
        })}
      </ScrollView>

      <Sheet visible={open} onClose={() => setOpen(false)} title="كود جديد">
        <ScrollView style={{ maxHeight: 520 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
          <Field label="الكود (اتركه فارغاً ليتولد تلقائياً)" icon="ticket" value={code} onChangeText={(t) => setCode(t.toUpperCase())} autoCapitalize="characters" placeholder="مثال: RAMADAN20" />
          <T w="bold" size={12.5}>نوع الخصم</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Chip label="مبلغ ثابت" active={kind === 'amount'} onPress={() => setKind('amount')} />
            <Chip label="نسبة %" active={kind === 'percent'} onPress={() => setKind('percent')} />
          </View>
          <Field label={kind === 'amount' ? 'قيمة الخصم (جنيه)' : 'نسبة الخصم %'} icon="trending-down" value={value} onChangeText={setValue} keyboardType="number-pad" />
          {kind === 'percent' && <Field label="أقصى خصم بالجنيه (اختياري)" icon="shield" value={cap} onChangeText={setCap} keyboardType="number-pad" />}
          <T w="bold" size={12.5}>يبدأ</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Chip label="من الآن" active={!later} onPress={() => setLater(false)} />
            <Chip label="من تاريخ" active={later} onPress={() => setLater(true)} />
          </View>
          {later && <Field label="تاريخ البداية (سنة-شهر-يوم)" icon="calendar" value={startDate} onChangeText={setStartDate} placeholder="2026-12-01" keyboardType="numbers-and-punctuation" />}
          <Field label="مدة الصلاحية بالأيام" icon="time" value={days} onChangeText={setDays} keyboardType="number-pad" />
          <T w="bold" size={12.5}>يشتغل على</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Chip label="كل المتاجر" active={!shops.length} onPress={() => setShops([])} />
            {shopList.map((p) => <Chip key={p.id} label={p.name} active={shops.includes(p.id)} onPress={() => toggleShop(p.id)} />)}
          </View>
          <T w="bold" size={12.5}>مرات الاستخدام لكل عميل</T>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Chip label="مرة" active={perUser === 1} onPress={() => setPerUser(1)} />
            <Chip label="مرتين" active={perUser === 2} onPress={() => setPerUser(2)} />
            <Chip label="بدون حد" active={perUser === null} onPress={() => setPerUser(null)} />
          </View>
          <Field label="إجمالي الاستخدامات لكل العملاء (اختياري)" icon="people" value={maxUses} onChangeText={setMaxUses} keyboardType="number-pad" />
          <Btn title="نشر الكود" icon="checkmark-circle" loading={busy} disabled={!Number(value) || !Number(days) || (later && !startDate.trim())} onPress={publish} />
        </ScrollView>
      </Sheet>
    </View>
  );
}

/** The customer's code box in the cart: type a code (or tap a saved gift) and see what it takes off before he confirms. */
export function CouponBox({ lines, applied, onApplied }: {
  lines: { productId: string; qty: number }[];
  applied: { code: string; discount: number } | null;
  onApplied: (a: { code: string; discount: number } | null) => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<Coupon[]>([]);
  const key = JSON.stringify(lines);
  useEffect(() => { apiMyCoupons().then((r) => setMine(r.coupons)).catch(() => {}); }, []);
  // the cart changed: ask again, the discount may be different now (or the code no longer fits)
  useEffect(() => {
    if (!applied) return;
    let dead = false;
    apiCouponCheck(applied.code, lines).then((r) => { if (!dead && r.discount !== applied.discount) onApplied({ code: r.code, discount: r.discount }); })
      .catch((e) => { if (!dead) { onApplied(null); toast(e?.message || 'لم يعد الكود صالحاً', 'err'); } });
    return () => { dead = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const apply = async (c?: string) => {
    const v = (c ?? text).trim();
    if (!v) return;
    setBusy(true);
    try { const r = await apiCouponCheck(v, lines); onApplied({ code: r.code, discount: r.discount }); setText(''); toast(`تم تطبيق الكود: خصم ${money(r.discount)}`); }
    catch (e: any) { toast(e?.message || 'الكود غير صالح', 'err'); }
    finally { setBusy(false); }
  };
  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="ticket" size={18} color={C.goldDeep} />
        <T w="black" size={15}>كود الخصم</T>
      </View>
      {applied ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#E2F3EA', borderRadius: 14, padding: 12 }}>
          <View style={{ flex: 1 }}>
            <T w="black" size={14} color="#0B6B4D">✔ {applied.code}</T>
            <T size={12} color="#0B6B4D">خصم {money(applied.discount)} على المنتجات</T>
          </View>
          <Pressable onPress={() => onApplied(null)}><T w="bold" size={12.5} color={C.red}>إزالة</T></Pressable>
        </View>
      ) : (
        <>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            <View style={{ flex: 1 }}><Field value={text} onChangeText={(t) => setText(t.toUpperCase())} autoCapitalize="characters" placeholder="اكتب الكود هنا" /></View>
            <Btn title="تطبيق" small loading={busy} disabled={!text.trim()} onPress={() => apply()} />
          </View>
          {mine.map((c) => (
            <Pressable key={c.id} onPress={() => apply(c.code)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.goldSoft, borderRadius: 14, padding: 11 }}>
              <T size={18}>🎁</T>
              <View style={{ flex: 1 }}>
                <T w="bold" size={13}>لديك {what(c)}</T>
                <T size={11.5} color={C.sub}>ينتهي {fmtDate(c.endsAt)} • اضغط للتطبيق</T>
              </View>
              <T w="black" size={12.5} color={C.goldDeep}>{c.code}</T>
            </Pressable>
          ))}
        </>
      )}
    </Card>
  );
}

/** The customer's saved codes (gifts): "you have a discount of ...". */
export function MyCouponsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [list, setList] = useState<Coupon[] | null>(null);
  useEffect(() => { if (visible) { setList(null); apiMyCoupons().then((r) => setList(r.coupons)).catch(() => setList([])); } }, [visible]);
  return (
    <Sheet visible={visible} onClose={onClose} title="أكواد الخصم الخاصة بي">
      {list === null ? <T size={13} color={C.sub}>جاري التحميل...</T> : list.length === 0 ? <Empty icon="ticket" title="لا توجد أكواد حالياً" text="أي كود خصم يخصك سيظهر هنا" /> : list.map((c) => (
        <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderColor: C.line }}>
          <T size={22}>🎁</T>
          <View style={{ flex: 1 }}>
            <T w="bold" size={14}>{what(c)}</T>
            <T size={12} color={C.sub}>ينتهي {fmtDate(c.endsAt)} • يُكتب في سلة الطلب</T>
          </View>
          <T w="black" size={14} color={C.goldDeep}>{c.code}</T>
        </View>
      ))}
    </Sheet>
  );
}
