import React, { useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon, Card, Btn, Sheet, Field, Chip, SectionTitle, Toggle, toast, confirmDialog } from './ui';
import { useStore, addRegion, updateRegion, deleteRegion } from '../lib/store';
import { money } from '../lib/format';
import { Region } from '../lib/types';

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
  const [fee, setFee] = useState('10');
  const [busy, setBusy] = useState(false);

  const open = (r: Region | null) => {
    setEdit(r);
    setName(r?.name || '');
    setFee(String(r?.deliveryFee ?? 10));
    setSheet(true);
  };
  const save = async () => {
    const f = Number(fee);
    if (name.trim().length < 2) return toast('اكتب اسم المنطقة', 'err');
    if (!Number.isFinite(f) || f < 0) return toast('سعر التوصيل غير صالح', 'err');
    setBusy(true);
    const r = edit ? await updateRegion(edit.id, { name: name.trim(), deliveryFee: f }) : await addRegion(name, f);
    setBusy(false);
    if (!r.ok) return toast(r.error, 'err');
    setSheet(false);
    toast(edit ? 'تم تعديل المنطقة' : 'تمت إضافة المنطقة');
  };

  return (
    <Card style={{ gap: 10 }}>
      <SectionTitle title={`مناطق التوصيل (${db.regions.length})`} action="إضافة" onAction={() => open(null)} />
      <T size={11.5} color={C.sub}>التطبيق يعمل في هذه المناطق فقط. سعر التوصيل يُحسب حسب منطقة العميل.</T>
      {db.regions.map((r) => (
        <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, borderTopWidth: 1, borderTopColor: C.line }}>
          <Pressable onPress={() => open(r)} style={{ flex: 1 }}>
            <T w="bold" size={14} color={r.active ? C.text : C.sub}>{r.name}{r.active ? '' : ' (متوقفة)'}</T>
            <T size={12} color={C.sub}>التوصيل {money(r.deliveryFee)}</T>
          </Pressable>
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
      <Sheet visible={sheet} onClose={() => setSheet(false)} title={edit ? 'تعديل منطقة' : 'إضافة منطقة'}>
        <Field label="اسم المنطقة" icon="location" value={name} onChangeText={setName} placeholder="مثال: ابيس 3/8" />
        <Field label="سعر التوصيل (ج.م)" icon="bicycle" value={fee} onChangeText={setFee} keyboardType="numeric" />
        <Btn title="حفظ" icon="checkmark" loading={busy} onPress={save} />
      </Sheet>
    </Card>
  );
}
