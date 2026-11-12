import React, { useEffect, useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon, Card, Btn, Sheet, Field, Chip, SectionTitle, Toggle, toast, confirmDialog } from './ui';
import { useStore, addRegion, updateRegion, deleteRegion, saveRoutePrices } from '../lib/store';
import { Region } from '../lib/types';

/** Customer: a red notice while the owner has closed the delivery of his area (switch "regionClose"). */
export function RegionClosedBanner({ regionId }: { regionId?: string | null }) {
  const { db } = useStore();
  const r = db.regions.find((x) => x.id === regionId);
  if (!db.settings.features?.regionClose || !r || !r.closed) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 10, backgroundColor: '#FDECEC', borderRadius: 16, padding: 12, alignItems: 'center', marginBottom: 14 }}>
      <Icon name="alert-circle" size={22} color={C.red} />
      <View style={{ flex: 1, gap: 2 }}>
        <T w="black" size={13} color={C.red}>التوصيل متوقف مؤقتًا في {r.name}</T>
        <T size={12} color={C.dark3}>{r.closedMessage || 'هنرجع قريب إن شاء الله'}</T>
      </View>
    </View>
  );
}

/** A field that shows the chosen area and opens the list of areas the owner enabled. */
export function RegionPicker({ value, onChange, label = 'المنطقة' }: { value?: string | null; onChange: (id: string) => void; label?: string }) {
  const { db } = useStore();
  const [open, setOpen] = useState(false);
  const list = db.regions.filter((r) => r.active);
  const cur = db.regions.find((r) => r.id === value);
  return (
    <View style={{ gap: 6 }}>
      <T w="semi" size={13} color={C.dark3}>{label}</T>
      <Pressable
        onPress={() => setOpen(true)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1.5, borderColor: C.line, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 14, backgroundColor: '#fff' }}
      >
        <Icon name="location" size={19} color={C.goldDeep} />
        <T w={cur ? 'bold' : 'regular'} size={14.5} color={cur ? C.text : C.sub} style={{ flex: 1 }}>{cur ? cur.name : 'اضغط لاختيار المنطقة'}</T>
        <Icon name="chevron-down" size={18} color={C.sub} />
      </Pressable>
      <Sheet visible={open} onClose={() => setOpen(false)} title="اختر المنطقة">
        {list.length === 0 ? (
          <T size={13} color={C.sub}>جاري تحميل المناطق… تأكد من اتصالك بالإنترنت.</T>
        ) : (
          <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 4 }}>
            {list.map((r) => (
              <Pressable
                key={r.id}
                onPress={() => { onChange(r.id); setOpen(false); }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: C.line }}
              >
                <Icon name="location" size={18} color={value === r.id ? C.goldDeep : C.sub} />
                <T w={value === r.id ? 'black' : 'regular'} size={14.5} style={{ flex: 1 }}>{r.name}</T>
                {value === r.id && <Icon name="checkmark-circle" size={20} color={C.green} />}
              </Pressable>
            ))}
          </ScrollView>
        )}
      </Sheet>
    </View>
  );
}

/** Owner: add / rename / price / switch off / delete delivery areas. */
export function RegionsManager() {
  const { db } = useStore();
  const [sheet, setSheet] = useState(false);
  const [edit, setEdit] = useState<Region | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const closeOn = !!db.settings.features?.regionClose;
  const [cl, setCl] = useState<Region | null>(null);
  const [clMsg, setClMsg] = useState('');
  const [clHours, setClHours] = useState(0); // 0 = until I reopen it
  const HOURS = [{ h: 0, t: 'لحد ما أفتحها' }, { h: 1, t: 'ساعة' }, { h: 3, t: '3 ساعات' }, { h: 6, t: '6 ساعات' }, { h: 24, t: 'يوم' }];
  const doClose = async () => {
    if (!cl) return;
    setBusy(true);
    const x = await updateRegion(cl.id, { closed: true, closedMessage: clMsg.trim(), closedUntil: clHours ? Date.now() + clHours * 3600000 : null });
    setBusy(false);
    if (!x.ok) return toast(x.error, 'err');
    setCl(null); toast('اتقفلت المنطقة، العملاء فيها هيشوفوا رسالتك');
  };
  const doOpen = (r: Region) => confirmDialog({
    title: `فتح ${r.name}؟`, message: 'العملاء في المنطقة هيوصلهم إشعار إن التوصيل رجع.', confirmText: 'افتح',
    onConfirm: async () => { const x = await updateRegion(r.id, { closed: false }); if (!x.ok) toast(x.error, 'err'); else toast('اتفتحت المنطقة ✅'); },
  });

  const open = (r: Region | null) => {
    setEdit(r);
    setName(r?.name || '');
    setSheet(true);
  };
  const save = async () => {
    if (name.trim().length < 2) return toast('اكتب اسم المنطقة', 'err');
    setBusy(true);
    const r = edit ? await updateRegion(edit.id, { name: name.trim() }) : await addRegion(name);
    setBusy(false);
    if (!r.ok) return toast(r.error, 'err');
    setSheet(false);
    toast(edit ? 'تم تعديل المنطقة' : 'تمت إضافة المنطقة. حدد أسعار التوصيل لها من «أسعار التوصيل»');
  };

  return (
    <Card style={{ gap: 10 }}>
      <SectionTitle title={`مناطق التوصيل (${db.regions.length})`} action="إضافة" onAction={() => open(null)} />
      <T size={11.5} color={C.sub}>التطبيق يعمل في هذه المناطق فقط. أسعار التوصيل بين المناطق تُحدد من «أسعار التوصيل».</T>
      {db.regions.map((r) => (
        <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderTopWidth: 1, borderTopColor: C.line }}>
          <Pressable onPress={() => open(r)} style={{ flex: 1 }}>
            <T w="bold" size={14} color={r.active ? C.text : C.sub}>{r.name}{r.active ? '' : ' (متوقفة)'}</T>
            {closeOn && r.closed && <T size={11.5} color={C.red}>🔒 التوصيل مقفول{r.closedUntil ? ` لحد ${new Date(r.closedUntil).toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' })}` : ''}</T>}
          </Pressable>
          {closeOn && (r.closed
            ? <Btn small variant="green" title="فتح" onPress={() => doOpen(r)} />
            : <Btn small variant="soft" title="إغلاق مؤقت" onPress={() => { setCl(r); setClMsg(''); setClHours(0); }} />)}
          <Toggle value={r.active} onValueChange={async (v) => { const x = await updateRegion(r.id, { active: v }); if (!x.ok) toast(x.error, 'err'); }} />
          <Pressable
            onPress={() => confirmDialog({
              title: `حذف ${r.name}؟`, message: 'العملاء المسجلون في هذه المنطقة سيحتاجون لاختيار منطقة جديدة.', danger: true, confirmText: 'حذف',
              onConfirm: async () => { const x = await deleteRegion(r.id); if (!x.ok) toast(x.error, 'err'); else toast('تم حذف المنطقة'); },
            })}
            hitSlop={8}
          >
            <Icon name="trash" size={19} color={C.red} />
          </Pressable>
        </View>
      ))}
      <Sheet visible={!!cl} onClose={() => setCl(null)} title={`إغلاق التوصيل في ${cl?.name || ''}`}>
        <T size={12.5} color={C.sub}>العملاء في المنطقة دي مش هيقدروا يبعتوا طلب توصيل لحد ما تفتحها (أو يخلص الوقت). حسابهم وأسعارهم ما بيتأثروش، وكمان الحجوزات مش بتتأثر.</T>
        <Field label="رسالة للعملاء (اختياري)" icon="chatbubble" value={clMsg} onChangeText={setClMsg} placeholder="مثال: مفيش مناديب النهارده، هنرجع بكرة الصبح" maxLength={200} />
        <T w="bold" size={12.5}>لمدة</T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {HOURS.map((x) => <Chip key={x.h} label={x.t} active={clHours === x.h} onPress={() => setClHours(x.h)} />)}
        </View>
        <Btn title="إغلاق المنطقة" icon="lock-closed" variant="danger" loading={busy} onPress={doClose} />
      </Sheet>
      <Sheet visible={sheet} onClose={() => setSheet(false)} title={edit ? 'تعديل منطقة' : 'إضافة منطقة'}>
        <Field label="اسم المنطقة" icon="location" value={name} onChangeText={setName} placeholder="مثال: ابيس 3/8" />
        {!edit && <T size={11.5} color={C.sub}>بعد الحفظ حدد سعر التوصيل من وإلى هذه المنطقة من «أسعار التوصيل». أي طريق بدون سعر لا يُقبل عليه طلب.</T>}
        <Btn title="حفظ" icon="checkmark" loading={busy} onPress={save} />
      </Sheet>
    </Card>
  );
}

const toEn = (s: string) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[٫,]/g, '.');

/** Owner: the delivery price from a shop's area to each customer area. A route without a price uses the customer area's normal price. */
export function RoutePricesManager() {
  const { db } = useStore();
  const areas = db.regions.filter((r) => r.active);
  const [from, setFrom] = useState('');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const prices = db.routePrices || {};
  useEffect(() => {
    if (!from) return setVals({});
    const v: Record<string, string> = {};
    for (const r of areas) { const p = prices[`${from}:${r.id}`]; v[r.id] = p === undefined ? '' : String(p); }
    setVals(v);
  }, [from, JSON.stringify(prices), areas.length]);
  const count = (id: string) => areas.filter((r) => prices[`${id}:${r.id}`] !== undefined).length;
  const save = async () => {
    const list: { toId: string; price: number | null }[] = [];
    for (const r of areas) {
      const raw = toEn((vals[r.id] || '').trim());
      if (raw === '') { list.push({ toId: r.id, price: null }); continue; }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return toast(`سعر غير صحيح في ${r.name}`, 'err');
      list.push({ toId: r.id, price: n });
    }
    setBusy(true);
    const r = await saveRoutePrices(from, list);
    setBusy(false);
    toast(r.ok ? 'تم حفظ الأسعار' : r.error, r.ok ? 'ok' : 'err');
  };
  return (
    <Card style={{ gap: 10 }}>
      <T w="black" size={15}>أسعار التوصيل بين المناطق</T>
      <T size={11.5} color={C.sub}>اختر منطقة المتجر، واكتب سعر التوصيل لكل منطقة عميل. كل اتجاه له سعره. أي خط تتركه فاضياً غير متاح للطلب (لا يقدر عميل تلك المنطقة يطلب من متاجر هذه المنطقة).</T>
      <RegionPicker value={from} onChange={setFrom} label="من منطقة المتجر" />
      {!!from && (
        <>
          {areas.map((r) => (
            <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <T w="bold" size={13.5} style={{ flex: 1 }}>إلى {r.name}</T>
              <View style={{ width: 120 }}>
                <Field value={vals[r.id] ?? ''} onChangeText={(t) => setVals((v) => ({ ...v, [r.id]: t }))} keyboardType="decimal-pad" placeholder="بدون سعر" />
              </View>
            </View>
          ))}
          <Btn title="حفظ الأسعار" icon="checkmark" loading={busy} onPress={save} />
        </>
      )}
      {areas.length > 0 && <T size={11.5} color={C.sub}>{areas.map((r) => `${r.name}: ${count(r.id)} من ${areas.length}`).join(' • ')}</T>}
    </Card>
  );
}
