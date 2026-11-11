import React, { useMemo, useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { C } from '../lib/theme';
import { T, Card, Btn, Sheet, Field, Chip, Toggle, toast, confirmDialog } from './ui';
import { useStore, apptAction, proposeApptTime, acceptApptTime, setClinicBookMode } from '../lib/store';
import { Appointment, Provider } from '../lib/types';
import { isoDay, dayName } from '../lib/format';

/** Buttons for a visit whose time the clinic sets. Clinic: write the day and time. Customer: accept the proposed time or cancel. */
export function ClinicSetActions({ a, role }: { a: Appointment; role: 'customer' | 'provider' }) {
  const [open, setOpen] = useState(false);
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return isoDay(d); }), []);
  const [day, setDay] = useState(days[1]);
  const [time, setTime] = useState('18:00');
  const [busy, setBusy] = useState(false);
  if (!a.clinicSet || a.status !== 'pending') return null;
  const stage = a.clinicSet.stage;
  const send = async () => {
    setBusy(true);
    const r = await proposeApptTime(a.id, day, time.trim());
    setBusy(false);
    if (!r.ok) return toast(r.error, 'err');
    setOpen(false);
    toast('تم إرسال الميعاد للعميل ✅');
  };
  if (role === 'provider') {
    return (
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Btn small variant="green" icon="calendar" title={stage === 'proposed' ? 'غيّر الميعاد' : 'حدد اليوم والساعة'} style={{ flex: 2 }} onPress={() => setOpen(true)} />
        <Btn small variant="danger" icon="close" title="رفض" style={{ flex: 1 }} onPress={() => confirmDialog({ title: 'رفض الطلب؟', danger: true, confirmText: 'رفض', onConfirm: () => { apptAction(a.id, 'reject'); toast('تم رفض الطلب', 'info'); } })} />
        <Sheet visible={open} onClose={() => setOpen(false)} title="حدد ميعاد الكشف">
          <T size={12.5} color={C.sub}>اختر اليوم واكتب الساعة، والعميل هيوافق من التطبيق.</T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {days.map((d, i) => <Chip key={d} label={`${i === 0 ? 'اليوم' : dayName(d)} ${Number(d.split('-')[2])}/${Number(d.split('-')[1])}`} active={d === day} onPress={() => setDay(d)} />)}
          </ScrollView>
          <Field label="الساعة (مثال 18:30)" icon="time" value={time} onChangeText={setTime} keyboardType="numbers-and-punctuation" />
          <Btn title="إرسال الميعاد للعميل" icon="send" loading={busy} onPress={send} />
        </Sheet>
      </View>
    );
  }
  if (stage === 'proposed') {
    return (
      <View style={{ gap: 8 }}>
        <T w="bold" size={12.5} color={C.goldDeep}>العيادة حددت لك الميعاد ده. وافق عليه عشان يتأكد الحجز.</T>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Btn small variant="green" icon="checkmark" title="موافق" style={{ flex: 2 }} onPress={async () => { const r = await acceptApptTime(a.id); toast(r.ok ? 'تم تأكيد الحجز ✅' : r.error, r.ok ? 'ok' : 'err'); }} />
          <Btn small variant="danger" icon="close" title="مش مناسب" style={{ flex: 1 }} onPress={() => confirmDialog({ title: 'إلغاء الطلب؟', message: 'تقدر تقدّم طلب جديد وقت ما تحب', danger: true, confirmText: 'إلغاء', onConfirm: () => { apptAction(a.id, 'cancel'); toast('تم الإلغاء', 'info'); } })} />
        </View>
      </View>
    );
  }
  return <T size={12} color={C.sub}>بانتظار العيادة تحدد لك اليوم والساعة.</T>;
}

/** Clinic: choose who picks the time. Needs the owner's switch "clinicSchedule". */
export function ClinicModeCard({ prov }: { prov: Provider }) {
  const { db } = useStore();
  const [busy, setBusy] = useState(false);
  if (!db.settings.features?.clinicSchedule || prov.type !== 'clinic') return null;
  const on = prov.bookMode === 'clinic';
  return (
    <Card style={{ gap: 8, opacity: busy ? 0.6 : 1 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <T w="black" size={14.5}>العيادة تحدد الميعاد</T>
          <T size={12} color={C.sub}>{on ? 'العميل بيطلب الكشف وانتوا بتكتبوا له اليوم والساعة' : 'العميل بيختار اليوم والساعة بنفسه (الوضع الحالي)'}</T>
        </View>
        <Toggle value={on} onValueChange={async (v) => { setBusy(true); const r = await setClinicBookMode(prov.id, v ? 'clinic' : 'customer'); setBusy(false); if (!r.ok) toast(r.error, 'err'); }} />
      </View>
    </Card>
  );
}
