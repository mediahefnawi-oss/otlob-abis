import React, { useEffect, useState } from 'react';
import { View, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Btn, Sheet, Field, Chip, toast } from './ui';
import { RegionPicker } from './Regions';
import { apiAdminAddCourier, apiAdminCourierVehicles } from '../lib/api';
import { refresh } from '../lib/store';

/** Owner: adds a delivery courier himself. The account is active at once; the owner gives the courier his phone and password. */
export function AddCourierSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [name, setName] = useState(''); const [phone, setPhone] = useState(''); const [pass, setPass] = useState('');
  const [vehicle, setVehicle] = useState(''); const [region, setRegion] = useState<string | null>(null);
  const [vehicles, setVehicles] = useState<string[]>([]); const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ name: string; phone: string; pass: string } | null>(null);
  useEffect(() => {
    if (!visible) return;
    apiAdminCourierVehicles().then((r) => setVehicles(r.vehicles.filter((v: any) => v.active !== false).map((v: any) => v.name))).catch(() => {});
  }, [visible]);
  const close = () => { setName(''); setPhone(''); setPass(''); setVehicle(''); setRegion(null); setDone(null); onClose(); };
  const save = async () => {
    const p = phone.replace(/\s+/g, '');
    if (name.trim().length < 3) return toast('اكتب الاسم بالكامل', 'err');
    if (!/^01[0-9]{9}$/.test(p)) return toast('رقم الموبايل لازم 11 رقم يبدأ بـ 01', 'err');
    if (pass.length < 8) return toast('كلمة المرور 8 أحرف على الأقل', 'err');
    setBusy(true);
    try {
      await apiAdminAddCourier({ name: name.trim(), phone: p, password: pass, vehicle: vehicle || undefined, regionId: region || undefined });
      setDone({ name: name.trim(), phone: p, pass });
      refresh().catch(() => {});
    } catch (e: any) { toast(String(e?.message || 'تعذر إضافة المندوب'), 'err'); }
    finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={close} title="إضافة مندوب توصيل">
      <ScrollView style={{ maxHeight: 520 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12, paddingBottom: 8 }}>
        {done ? (
          <View style={{ gap: 10 }}>
            <T w="black" size={16} color={C.green}>تم إنشاء حساب المندوب ✅</T>
            <T size={13}>الاسم: {done.name}</T>
            <T size={13}>الموبايل: {done.phone}</T>
            <T size={13}>كلمة المرور: {done.pass}</T>
            <T size={12} color={C.sub}>الحساب شغال فوراً. سلّم المندوب الموبايل وكلمة المرور (كلمة المرور مش هتظهر تاني).</T>
            <Btn title="تم" onPress={close} />
          </View>
        ) : (
          <>
            <Field label="الاسم بالكامل" value={name} onChangeText={setName} placeholder="مثال: محمود أحمد" />
            <Field label="رقم الموبايل" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="01xxxxxxxxx" />
            <Field label="كلمة المرور (8 أحرف على الأقل)" value={pass} onChangeText={setPass} placeholder="اكتب كلمة المرور" />
            {vehicles.length > 0 && (
              <View style={{ gap: 6 }}>
                <T w="semi" size={13} color={C.dark3}>وسيلة التوصيل</T>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {vehicles.map((v) => <Chip key={v} label={v} active={vehicle === v} onPress={() => setVehicle(vehicle === v ? '' : v)} />)}
                </View>
              </View>
            )}
            <RegionPicker value={region} onChange={setRegion} />
            <Btn title="إنشاء الحساب" icon="person-add" loading={busy} onPress={save} />
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}
