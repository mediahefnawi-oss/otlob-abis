import React, { useState } from 'react';
import { View, Pressable } from 'react-native';
import { C } from '../lib/theme';
import { T, Icon, Toggle, Card, Btn, Chip, Field, toast } from './ui';
import { useStore, updateHours, useAppGate } from '../lib/store';
import { DEFAULT_CLOSED_MESSAGE, fmtTime, normDays, renderMessage, timeLabel, toMin } from '../lib/hours';

// Egyptian week: Saturday first. The number is the day (0 = Sunday ... 6 = Saturday).
const WEEK: Array<[number, string]> = [[6, 'السبت'], [0, 'الأحد'], [1, 'الاثنين'], [2, 'الثلاثاء'], [3, 'الأربعاء'], [4, 'الخميس'], [5, 'الجمعة']];
const GRACE = [0, 15, 30, 45, 60, 90];

function TimeStep({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const min = toMin(value) ?? 0;
  const step = (d: number) => onChange(fmtTime((min + d + 1440) % 1440));
  const Btn2 = ({ icon, d }: { icon: string; d: number }) => (
    <Pressable onPress={() => step(d)} style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: C.goldSoft, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={icon} size={20} color={C.goldDeep} />
    </Pressable>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <T w="bold" size={14} style={{ flex: 1 }}>{label}</T>
      <Btn2 icon="remove" d={-30} />
      <View style={{ minWidth: 116, alignItems: 'center', paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.card }}>
        <T w="black" size={16}>{timeLabel(min)}</T>
      </View>
      <Btn2 icon="add" d={30} />
    </View>
  );
}

export function HoursSettings() {
  const { db } = useStore();
  const h = db.settings.hours;
  const [enabled, setEnabled] = useState(!!h?.enabled);
  const [openTime, setOpenTime] = useState(h?.openTime || '10:00');
  const [closeTime, setCloseTime] = useState(h?.closeTime || '00:00');
  const [days, setDays] = useState<number[]>(h ? normDays(h.days) : [0, 1, 2, 3, 4, 5, 6]);
  const [grace, setGrace] = useState<number>(h ? h.graceMin : 30);
  const [msg, setMsg] = useState(h?.message || DEFAULT_CLOSED_MESSAGE);
  const [busy, setBusy] = useState(false);
  const gate = useAppGate('customer');

  const toggleDay = (d: number) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort((a, b) => a - b)));
  const insert = (token: string) => setMsg((m) => `${m}${m && !m.endsWith(' ') ? ' ' : ''}${token}`);
  const preview = renderMessage({ message: msg }, { dayDiff: 1, minuteOfDay: toMin(openTime) ?? 600, dow: 0 });
  // what the customers see right now with the SAVED settings
  const state = !db.settings.appEnabled ? 'التطبيق موقوف يدوياً' : gate.blocked ? 'مغلق الآن للعملاء' : 'مفتوح الآن';

  const save = async () => {
    if (enabled && !days.length) return toast('اختر يوم تشغيل واحد على الأقل', 'err');
    if (enabled && openTime === closeTime) return toast('ساعة الفتح والغلق متطابقتان، التطبيق سيعمل 24 ساعة', 'info');
    if (msg.trim().length < 3) return toast('اكتب رسالة الغلق', 'err');
    setBusy(true);
    const r: any = await updateHours({ hoursEnabled: enabled, openTime, closeTime, openDays: days, graceMin: grace, closedMessage: msg.trim() });
    setBusy(false);
    if (r.ok) toast('تم حفظ مواعيد التشغيل', 'ok');
    else toast(r.error || 'تعذر الحفظ', 'err');
  };

  return (
    <Card style={{ gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <T w="black" size={15}>تشغيل المواعيد</T>
          <T size={11.5} color={C.sub}>عند التفعيل يُغلق التطبيق أمام العملاء خارج المواعيد، وتستريح قاعدة البيانات</T>
        </View>
        <Toggle value={enabled} onValueChange={setEnabled} />
      </View>
      <T size={12} color={C.sub}>الحالة الآن: {state}</T>
      {enabled ? (
        <>
          <View style={{ height: 1, backgroundColor: C.line }} />
          <TimeStep label="ساعة الفتح" value={openTime} onChange={setOpenTime} />
          <TimeStep label="ساعة الغلق" value={closeTime} onChange={setCloseTime} />
          <T size={11.5} color={C.sub}>بتوقيت القاهرة. إذا كانت ساعة الغلق قبل ساعة الفتح يعني الغلق بعد منتصف الليل (مثلاً الفتح 10 صباحاً والغلق 12 منتصف الليل).</T>
          <View style={{ gap: 8 }}>
            <T w="bold" size={14}>أيام التشغيل</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {WEEK.map(([d, l]) => <Chip key={d} label={l} active={days.includes(d)} onPress={() => toggleDay(d)} />)}
            </View>
          </View>
          <View style={{ gap: 8 }}>
            <T w="bold" size={14}>مهلة للمحلات والمناديب بعد الغلق</T>
            <T size={11.5} color={C.sub}>العملاء يتوقفون عند الغلق، والمحلات والمناديب يكملون الطلبات الجارية خلال هذه المدة.</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {GRACE.map((g) => <Chip key={g} label={g === 0 ? 'بدون' : `${g} دقيقة`} active={grace === g} onPress={() => setGrace(g)} />)}
            </View>
          </View>
          <Field label="رسالة الغلق التي تظهر للعميل" value={msg} onChangeText={setMsg} multiline icon="moon" />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Chip label="+ وقت الفتح" onPress={() => insert('{وقت_الفتح}')} />
            <Chip label="+ يوم الفتح (اليوم / غداً)" onPress={() => insert('{يوم_الفتح}')} />
            <Chip label="الرسالة الافتراضية" onPress={() => setMsg(DEFAULT_CLOSED_MESSAGE)} />
          </View>
          <View style={{ backgroundColor: '#FFF8E1', borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: C.gold, padding: 12, gap: 4 }}>
            <T size={11.5} color={C.sub}>معاينة (كما ستظهر للعميل)</T>
            <T w="bold" size={14}>{preview}</T>
          </View>
          <T size={11.5} color={C.sub}>ملاحظة: التطبيقات المغلقة لا تتصل بالسيرفر حتى موعد الفتح، فأي تعديل على المواعيد يصل لها عند فتحها التالي. يفضل ضبط المواعيد مسبقاً.</T>
        </>
      ) : null}
      <Btn title="حفظ مواعيد التشغيل" icon="checkmark" onPress={save} loading={busy} />
    </Card>
  );
}
