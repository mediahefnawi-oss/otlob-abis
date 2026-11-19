import React, { useCallback, useEffect, useState } from 'react';
import { View, Pressable } from 'react-native';
import { Image } from 'expo-image';
import { ScrollView } from './KScroll';
import { C } from '../lib/theme';
import { T, Icon, Card, Btn, Header, Empty, Field, toast, confirmDialog } from './ui';
import { pickImage } from '../lib/pickImage';
import { CourierVehicle, courierVehicleImageUrl, apiAdminCourierVehicles, apiAdminCourierVehicleAdd, apiAdminCourierVehicleSave, apiAdminCourierVehicleDelete, apiAdminCourierVehicleImage } from '../lib/api';

/** Owner only: the delivery means a courier picks when signing up. Add, rename, picture, order, hide and delete; couriers already signed up keep theirs. */
export function AdminCourierVehiclesScreen({ navigation }: any) {
  const [rows, setRows] = useState<CourierVehicle[] | null>(null);
  const [name, setName] = useState('');
  const [edit, setEdit] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { apiAdminCourierVehicles().then((r) => setRows(r.vehicles)).catch(() => setRows([])); }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<any>, ok?: string) => {
    if (busy) return; setBusy(true);
    try { await fn(); if (ok) toast(ok); load(); } catch (e: any) { toast(e?.message || 'تعذر التنفيذ', 'err'); } finally { setBusy(false); }
  };
  const move = (i: number, d: number) => {
    const list = rows || []; const a = list[i], b = list[i + d]; if (!a || !b) return;
    run(async () => { await apiAdminCourierVehicleSave(a.id, { sort: b.sort }); await apiAdminCourierVehicleSave(b.id, { sort: a.sort === b.sort ? a.sort + (d > 0 ? -1 : 1) : a.sort }); });
  };
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Header title="وسائل توصيل المندوب" subtitle="اللي بتظهر للمندوب وقت التسجيل" onBack={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: 8 }}>
          <Field label="إضافة وسيلة جديدة" value={name} onChangeText={setName} placeholder="مثال: توكتوك" />
          <Btn title="＋ إضافة وسيلة" loading={busy} onPress={() => { const n = name.trim(); if (n.length < 2) return toast('اكتب اسم الوسيلة', 'err'); run(async () => { await apiAdminCourierVehicleAdd(n); setName(''); }, 'تمت الإضافة ✅'); }} />
        </Card>
        {rows && !rows.length && <Empty icon="bicycle" title="مفيش وسائل" text="أضف وسيلة عشان تظهر للمندوب وقت التسجيل" />}
        {(rows || []).map((v, i) => (
          <Card key={v.id} style={{ gap: 8, opacity: v.active ? 1 : 0.65 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 64, height: 46, borderRadius: 12, backgroundColor: '#F1F3F0', alignItems: 'center', justifyContent: 'center' }}>
                {v.image ? <Image source={{ uri: courierVehicleImageUrl(v) }} style={{ width: 60, height: 42 }} contentFit="contain" /> : <Icon name="bicycle" size={26} color={C.sub} />}
              </View>
              <View style={{ flex: 1 }}>
                <T w="black" size={14}>{v.name}</T>
                <T size={11.5} color={C.sub}>{v.couriers || 0} مندوب{v.active ? '' : ' • مخفية'}</T>
              </View>
              <Pressable onPress={() => move(i, -1)} hitSlop={8}><Icon name="chevron-up" size={22} color={i === 0 ? C.line : C.dark3} /></Pressable>
              <Pressable onPress={() => move(i, 1)} hitSlop={8}><Icon name="chevron-down" size={22} color={i === (rows || []).length - 1 ? C.line : C.dark3} /></Pressable>
            </View>
            {edit === v.id ? (
              <View style={{ gap: 8 }}>
                <Field label="اسم الوسيلة" value={editName} onChangeText={setEditName} />
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Btn small style={{ flex: 1 }} title="حفظ" loading={busy} onPress={() => run(async () => { await apiAdminCourierVehicleSave(v.id, { name: editName }); setEdit(null); }, 'تم الحفظ ✅')} />
                  <Btn small variant="soft" style={{ flex: 1 }} title="إلغاء" onPress={() => setEdit(null)} />
                </View>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <Btn small variant="soft" style={{ flex: 1 }} title={v.active ? 'إخفاء' : 'إظهار'} onPress={() => run(() => apiAdminCourierVehicleSave(v.id, { active: !v.active }))} />
                <Btn small variant="soft" style={{ flex: 1 }} title="الاسم" onPress={() => { setEdit(v.id); setEditName(v.name); }} />
                <Btn small variant="soft" style={{ flex: 1 }} title="صورة" onPress={() => run(async () => { const img = await pickImage(900, true); if (img) await apiAdminCourierVehicleImage(v.id, img); }, 'تم رفع الصورة')} />
                <Btn small variant="soft" style={{ flex: 1 }} title="حذف" onPress={() => confirmDialog({ title: 'حذف الوسيلة؟', message: 'المناديب اللي مسجلين بيها مش هيتأثروا', confirmText: 'حذف', onConfirm: () => run(() => apiAdminCourierVehicleDelete(v.id), 'تم الحذف') })} />
              </View>
            )}
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}
